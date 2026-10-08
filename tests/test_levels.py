"""
Tes fitur level soal (easy / normal / hard) dan soal ACAK per peserta.

Yang dijaga:
  * level tersimpan, divalidasi, dan tidak ter-reset oleh klien lama
  * room "random": jumlah per level divalidasi terhadap soal yang dipilih Host
  * tiap peserta mendapat soal berbeda, komposisi level sesuai pengaturan Host, dan TETAP sama saat sesi dilanjutkan
  * penilaian / hasil / finalisasi memakai soal milik peserta itu sendiri (bukan seluruh pool room)
  * room "fixed" dan database lama (tanpa kolom level) berperilaku seperti sebelumnya
"""
import sqlite3
import uuid

import pytest
from fastapi.testclient import TestClient

import app as quiz_app
import database

LEVELS = ("easy", "normal", "hard")
KEYS = {"easy": "A", "normal": "B", "hard": "C"}  # kunci jawaban berbeda per level -> penilaian harus memakai kunci tiap soal


@pytest.fixture(scope="module")
def client():
    with TestClient(quiz_app.app) as c:
        yield c


def uniq(prefix="x"):
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def make_question(client, level=None, text=None, correct=None, **extra):
    body = {
        "question_text": text or f"Soal {level or 'tanpa level'} {uuid.uuid4().hex[:6]}",
        "option_a": "a", "option_b": "b", "option_c": "c", "option_d": "d",
        "correct_option": correct or KEYS.get(level, "A"), "category": "Tes level", "question_type": "mcq",
    }
    if level is not None:
        body["level"] = level
    body.update(extra)
    r = client.post("/api/questions", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def make_pool(client, easy=0, normal=0, hard=0):
    """Buat soal dengan level tertentu. Return {level: [question_json, ...]}."""
    return {
        level: [make_question(client, level) for _ in range(count)]
        for level, count in zip(LEVELS, (easy, normal, hard))
    }


def pool_ids(pool):
    return [q["id"] for level in LEVELS for q in pool[level]]


def level_of(pool):
    return {q["id"]: level for level in LEVELS for q in pool[level]}


def create_room(client, ids, mode="random", counts=None, passing=50, expect=200):
    body = {"title": "Kuis Level", "duration": 10, "passing_grade": passing, "question_ids": ids,
            "created_by": "admin", "question_mode": mode}
    if counts is not None:
        body["level_counts"] = counts
    r = client.post("/api/rooms", json=body)
    assert r.status_code == expect, r.text
    return r.json()


def join(client, code, name, token=None):
    body = {"room_id": code, "name": name, "department": "QA"}
    if token:
        body["token"] = token
    r = client.post("/api/rooms/join", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def start(client, code):
    r = client.put(f"/api/rooms/{code}/status", json={"status": "On Progress"})
    assert r.status_code == 200, r.text
    return r.json()


def finish(client, code):
    r = client.put(f"/api/rooms/{code}/status", json={"status": "Finished"})
    assert r.status_code == 200, r.text


def submit(client, code, who, answers):
    """answers: {question_id: 'A'|...}. Mengirim lewat /api/answers/batch seperti browser peserta."""
    payload = [{"room_id": code, "participant_name": who["participant_name"], "participant_id": who["participant_id"],
                "question_id": qid, "answer_user": ans} for qid, ans in answers.items()]
    r = client.post("/api/answers/batch", json=payload, headers={"X-Participant-Token": who["token"]})
    assert r.status_code == 200, r.text
    return r.json()


def composition(ids, levels):
    counts = {level: 0 for level in LEVELS}
    for qid in ids:
        counts[levels[qid]] += 1
    return counts


# ───────────── level pada bank soal ─────────────

def test_question_level_defaults_to_normal_and_is_normalized(client):
    assert make_question(client)["level"] == "normal"                         # tidak dikirim -> normal
    assert make_question(client, level="easy")["level"] == "easy"
    assert make_question(client, level=" HARD ")["level"] == "hard"           # huruf besar/spasi dari keyboard HP
    assert make_question(client, level="")["level"] == "normal"               # kosong -> normal


def test_invalid_level_is_rejected_with_a_readable_message(client):
    r = client.post("/api/questions", json={
        "question_text": "Q", "option_a": "a", "option_b": "b", "option_c": "c", "option_d": "d",
        "correct_option": "A", "category": "Tes", "question_type": "mcq", "level": "ultra"})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "Level soal tidak valid" in detail and "easy" in detail and "Value error" not in detail


def test_update_changes_level_but_an_old_client_without_level_keeps_it(client):
    q = make_question(client, level="hard")
    base = {"question_text": "Baru", "option_a": "a", "option_b": "b", "option_c": "c", "option_d": "d",
            "correct_option": "A", "category": "Tes", "question_type": "mcq"}

    kept = client.put(f"/api/questions/{q['id']}", json=base)                 # klien lama: tanpa field level
    assert kept.status_code == 200 and kept.json()["level"] == "hard"

    changed = client.put(f"/api/questions/{q['id']}", json={**base, "level": "easy"})
    assert changed.status_code == 200 and changed.json()["level"] == "easy"

    bad = client.put(f"/api/questions/{q['id']}", json={**base, "level": "sulit"})
    assert bad.status_code == 422
    assert client.get("/api/questions").json()                                # daftar tetap terbaca
    listed = {x["id"]: x for x in client.get("/api/questions").json()}
    assert listed[q["id"]]["level"] == "easy"


def test_question_lookup_by_ids_includes_level(client):
    pool = make_pool(client, easy=1, hard=1)
    ids = pool_ids(pool)
    got = client.get("/api/questions", params={"ids": ",".join(map(str, ids))}).json()
    assert [(x["id"], x["level"]) for x in got] == [(ids[0], "easy"), (ids[1], "hard")]


# ───────────── pembuatan room ─────────────

def test_random_room_requires_valid_level_counts(client):
    pool = make_pool(client, easy=3, normal=2, hard=1)
    ids = pool_ids(pool)

    # tanpa jumlah per level
    r = client.post("/api/rooms", json={"title": "T", "duration": 5, "passing_grade": 50, "question_ids": ids,
                                        "question_mode": "random"})
    assert r.status_code == 422 and "per level" in r.json()["detail"]

    # semuanya 0, level tidak dikenal, negatif
    assert create_room(client, ids, counts={"easy": 0, "normal": 0, "hard": 0}, expect=422)
    assert "minimal 1" in client.post("/api/rooms", json={
        "title": "T", "duration": 5, "passing_grade": 50, "question_ids": ids, "question_mode": "random",
        "level_counts": {"easy": 0}}).json()["detail"]
    assert "tidak dikenal" in create_room(client, ids, counts={"expert": 1}, expect=422)["detail"]
    assert create_room(client, ids, counts={"easy": -1, "normal": 2}, expect=422)

    # mode tidak dikenal
    bad_mode = create_room(client, ids, mode="shuffle", counts={"easy": 1}, expect=422)
    assert "Mode soal tidak valid" in bad_mode["detail"]


def test_random_room_cannot_ask_more_than_the_selected_pool_has(client):
    pool = make_pool(client, easy=3, normal=2, hard=1)
    ids = pool_ids(pool)
    err = create_room(client, ids, counts={"easy": 2, "normal": 2, "hard": 2}, expect=400)
    assert "Hard" in err["detail"] and "hanya 1" in err["detail"] and "diminta 2" in err["detail"]
    # level yang tidak dipilih sama sekali tetapi diminta
    only_easy = [q["id"] for q in pool["easy"]]
    err = create_room(client, only_easy, counts={"easy": 1, "hard": 1}, expect=400)
    assert "Hard" in err["detail"] and "hanya 0" in err["detail"]


def test_room_payload_describes_the_question_set(client):
    pool = make_pool(client, easy=3, normal=3, hard=2)
    ids = pool_ids(pool)

    rnd = create_room(client, ids, counts={"easy": 2, "hard": 1})
    assert rnd["question_mode"] == "random"
    assert rnd["level_counts"] == {"easy": 2, "normal": 0, "hard": 1}         # selalu lengkap
    assert rnd["questions_per_participant"] == 3
    assert rnd["question_ids"] == ids                                         # pool room
    assert client.get(f"/api/rooms/{rnd['room_code']}").json()["level_counts"] == rnd["level_counts"]

    fixed = create_room(client, ids, mode="fixed")
    assert fixed["question_mode"] == "fixed" and fixed["level_counts"] is None
    assert fixed["questions_per_participant"] == len(ids)

    # klien lama tidak mengirim question_mode sama sekali -> tetap room biasa
    legacy = client.post("/api/rooms", json={"title": "Lama", "duration": 5, "passing_grade": 50,
                                             "question_ids": ids, "created_by": "admin"})
    assert legacy.status_code == 200 and legacy.json()["question_mode"] == "fixed"


# ───────────── undian soal per peserta ─────────────

def test_every_participant_gets_a_different_random_set(client):
    pool = make_pool(client, easy=6, normal=6, hard=4)                       # 15 * 15 * 4 = 900 kombinasi
    levels = level_of(pool)
    room = create_room(client, pool_ids(pool), counts={"easy": 2, "normal": 2, "hard": 1})

    joined = [join(client, room["room_code"], f"Peserta {i}") for i in range(12)]
    sets = []
    for who in joined:
        ids = who["question_ids"]
        assert len(ids) == 5 and len(set(ids)) == 5                          # tanpa duplikat
        assert set(ids) <= set(levels)                                       # semua dari pool room
        assert composition(ids, levels) == {"easy": 2, "normal": 2, "hard": 1}
        sets.append(frozenset(ids))
    assert len(set(sets)) == len(joined)                                     # tidak ada dua peserta dengan soal yang sama
    assert len({tuple(who["question_ids"]) for who in joined}) == len(joined)  # urutan pun berbeda


def test_distinct_sets_are_guaranteed_while_unused_combinations_remain(client):
    pool = make_pool(client, easy=3)                                         # C(3,2) = 3 kombinasi
    room = create_room(client, pool_ids(pool), counts={"easy": 2})
    sets = [frozenset(join(client, room["room_code"], f"P{i}")["question_ids"]) for i in range(3)]
    assert len(set(sets)) == 3                                               # 3 peserta -> 3 kombinasi berbeda

    fourth = join(client, room["room_code"], "P4")                           # kombinasi habis -> boleh sama, tetap jalan
    assert len(fourth["question_ids"]) == 2 and frozenset(fourth["question_ids"]) in sets


def test_when_pool_equals_count_everyone_gets_the_same_questions_in_their_own_order(client):
    pool = make_pool(client, easy=4)
    room = create_room(client, pool_ids(pool), counts={"easy": 4})
    results = [join(client, room["room_code"], f"S{i}")["question_ids"] for i in range(6)]
    assert all(sorted(r) == sorted(pool_ids(pool)) for r in results)
    assert len({tuple(r) for r in results}) > 1                              # urutannya diacak per peserta


def test_random_draw_only_uses_requested_levels(client):
    pool = make_pool(client, easy=3, normal=3, hard=3)
    levels = level_of(pool)
    room = create_room(client, pool_ids(pool), counts={"hard": 2})           # level lain tidak disebut = 0
    for i in range(5):
        ids = join(client, room["room_code"], f"H{i}")["question_ids"]
        assert composition(ids, levels) == {"easy": 0, "normal": 0, "hard": 2}


def test_all_questions_of_a_level_get_used_across_participants(client):
    pool = make_pool(client, easy=6, normal=6)
    room = create_room(client, pool_ids(pool), counts={"easy": 2, "normal": 2})
    seen = set()
    for i in range(40):
        seen.update(join(client, room["room_code"], f"U{i}")["question_ids"])
    assert seen == set(pool_ids(pool))                                       # undian tidak berat sebelah ke soal tertentu


def test_resuming_keeps_the_same_questions_in_the_same_order(client):
    pool = make_pool(client, easy=5, normal=5)
    room = create_room(client, pool_ids(pool), counts={"easy": 2, "normal": 2})
    first = join(client, room["room_code"], "Budi")
    again = join(client, room["room_code"], "Budi", token=first["token"])
    assert again["resumed"] is True
    assert again["question_ids"] == first["question_ids"]

    start(client, room["room_code"])                                         # setelah kuis berjalan pun sama
    later = join(client, room["room_code"], "Budi", token=first["token"])
    assert later["question_ids"] == first["question_ids"]

    # orang lain memakai nama yang sama tanpa token: ditolak, tidak mendapat soal Budi
    thief = client.post("/api/rooms/join", json={"room_id": room["room_code"], "name": "budi", "department": "-"})
    assert thief.status_code == 400


def test_fixed_room_gives_everyone_the_same_list(client):
    pool = make_pool(client, easy=2, hard=2)
    room = create_room(client, pool_ids(pool), mode="fixed")
    a = join(client, room["room_code"], "A")
    b = join(client, room["room_code"], "B")
    assert a["question_ids"] == b["question_ids"] == pool_ids(pool)


def test_leaving_removes_the_assignment_and_rejoining_draws_again(client):
    pool = make_pool(client, easy=6)
    levels = level_of(pool)
    room = create_room(client, pool_ids(pool), counts={"easy": 3})
    first = join(client, room["room_code"], "Salah Ketik")

    r = client.post(f"/api/participants/{first['participant_id']}/leave", headers={"X-Participant-Token": first["token"]})
    assert r.status_code == 200
    with database._transaction() as cursor:
        cursor.execute("SELECT COUNT(*) AS n FROM participant_questions WHERE participant_id = %s", (first["participant_id"],))
        assert cursor.fetchone()["n"] == 0                                   # ikut terhapus bersama peserta

    second = join(client, room["room_code"], "Salah Ketik")
    assert second["participant_id"] != first["participant_id"]
    assert composition(second["question_ids"], levels) == {"easy": 3, "normal": 0, "hard": 0}


# ───────────── penilaian per peserta ─────────────

def test_score_and_result_follow_the_participants_own_questions(client):
    pool = make_pool(client, easy=3, normal=3, hard=2)
    levels = level_of(pool)
    keys = {q["id"]: q["correct_option"] for level in LEVELS for q in pool[level]}
    room = create_room(client, pool_ids(pool), counts={"easy": 2, "normal": 1, "hard": 1}, passing=75)
    code = room["room_code"]

    perfect = join(client, code, "Pintar")
    half = join(client, code, "Setengah")
    start(client, code)

    # Peserta "Pintar" mengirim jawaban BENAR untuk SEMUA soal pool (termasuk yang bukan miliknya)
    result = submit(client, code, perfect, {qid: keys[qid] for qid in keys})
    assert result["total"] == 4 and result["correct"] == 4 and result["score"] == 100 and result["status"] == "PASS"
    assert [a["question_id"] for a in result["answers"]] == perfect["question_ids"]   # urutan sesuai undian peserta
    assert result["by_level"] == {"easy": {"total": 2, "correct": 2}, "normal": {"total": 1, "correct": 1},
                                  "hard": {"total": 1, "correct": 1}}
    assert all(a["level"] == levels[a["question_id"]] for a in result["answers"])

    # "Setengah" hanya benar pada 2 dari 4 soalnya; jawaban untuk soal yang bukan miliknya tidak dihitung
    own = half["question_ids"]
    foreign = [qid for qid in keys if qid not in own]
    answers = {own[0]: keys[own[0]], own[1]: keys[own[1]], own[2]: "D", own[3]: "D"}
    answers.update({qid: keys[qid] for qid in foreign})
    result = submit(client, code, half, answers)
    assert result["total"] == 4 and result["correct"] == 2 and result["incorrect"] == 2
    assert result["score"] == 50 and result["status"] == "FAIL"                       # 50 < passing grade 75
    assert {a["question_id"] for a in result["answers"]} == set(own)

    # hasil dibuka lagi setelah refresh: isi & urutan sama
    again = client.get(f"/api/participants/{half['participant_id']}/result",
                       headers={"X-Participant-Token": half["token"]}).json()
    assert [a["question_id"] for a in again["answers"]] == own and again["score"] == 50

    # peringkat & rekap room memakai skor masing-masing
    summary = client.get(f"/api/rooms/{code}/summary").json()
    assert summary["pass_count"] == 1 and summary["fail_count"] == 1 and summary["average_score"] == 75.0


def test_autosave_accepts_only_assigned_questions_and_finalize_uses_the_own_total(client):
    pool = make_pool(client, easy=5)
    keys = {q["id"]: q["correct_option"] for q in pool["easy"]}
    room = create_room(client, pool_ids(pool), counts={"easy": 2}, passing=50)
    code = room["room_code"]
    who = join(client, code, "Autosave")
    start(client, code)
    headers = {"X-Participant-Token": who["token"]}

    own = who["question_ids"]
    foreign = next(qid for qid in keys if qid not in own)
    base = {"room_id": code, "participant_name": "Autosave", "participant_id": who["participant_id"]}

    denied = client.post("/api/answers", json={**base, "question_id": foreign, "answer_user": keys[foreign]}, headers=headers)
    assert denied.status_code == 400 and "bukan bagian" in denied.json()["detail"]

    ok = client.post("/api/answers", json={**base, "question_id": own[0], "answer_user": keys[own[0]]}, headers=headers)
    assert ok.status_code == 200 and ok.json()["saved"] is True

    # waktu habis sebelum sempat submit: finalisasi dari jawaban tersimpan -> 1 benar dari 2 soal miliknya = 50
    done = client.post(f"/api/participants/{who['participant_id']}/finalize", json={}, headers=headers)
    assert done.status_code == 200
    body = done.json()
    assert body["total"] == 2 and body["correct"] == 1 and body["score"] == 50 and body["status"] == "PASS"


def test_unanswered_participant_is_graded_against_own_total_not_the_pool(client):
    pool = make_pool(client, easy=8)
    room = create_room(client, pool_ids(pool), counts={"easy": 3})
    who = join(client, room["room_code"], "Diam")
    start(client, room["room_code"])
    done = client.post(f"/api/participants/{who['participant_id']}/finalize", json={},
                       headers={"X-Participant-Token": who["token"]}).json()
    assert done["total"] == 3 and done["correct"] == 0 and done["score"] == 0


def test_finished_history_exposes_mode_and_counts_for_the_report(client):
    pool = make_pool(client, easy=2, normal=2)
    room = create_room(client, pool_ids(pool), counts={"easy": 1, "normal": 2})
    finish(client, room["room_code"])
    history = {r["room_code"]: r for r in client.get("/api/rooms/finished").json()}
    entry = history[room["room_code"]]
    assert entry["question_mode"] == "random" and entry["level_counts"] == {"easy": 1, "normal": 2, "hard": 0}
    assert entry["questions_per_participant"] == 3


# ───────────── database lama ─────────────

LEGACY_SCHEMA = """
CREATE TABLE rooms (id TEXT PRIMARY KEY, title TEXT NOT NULL, duration INTEGER NOT NULL,
    passing_grade INTEGER NOT NULL DEFAULT 70, status TEXT NOT NULL DEFAULT 'Waiting',
    created_by TEXT DEFAULT 'Host', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, started_at TIMESTAMP);
CREATE TABLE questions (id INTEGER PRIMARY KEY AUTOINCREMENT, question_text TEXT NOT NULL, option_a TEXT NOT NULL,
    option_b TEXT NOT NULL, option_c TEXT NOT NULL, option_d TEXT NOT NULL, correct_answer TEXT NOT NULL,
    category TEXT DEFAULT 'Umum', question_type TEXT DEFAULT 'mcq', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE room_questions (room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE, sort_order INTEGER DEFAULT 0,
    PRIMARY KEY (room_id, question_id));
CREATE TABLE participants (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL, department TEXT DEFAULT '-', score INTEGER DEFAULT 0, status TEXT DEFAULT 'ON_PROGRESS',
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, submitted_at TIMESTAMP, token TEXT, UNIQUE(room_id, name));
CREATE TABLE answers (id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE, answer TEXT NOT NULL,
    is_correct BOOLEAN NOT NULL DEFAULT FALSE, UNIQUE(participant_id, question_id));
CREATE TABLE user_roles (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'Host', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);

INSERT INTO questions (question_text, option_a, option_b, option_c, option_d, correct_answer, category)
    VALUES ('Soal lama 1', 'a', 'b', 'c', 'd', 'A', 'K3'), ('Soal lama 2', 'a', 'b', 'c', 'd', 'B', 'K3');
INSERT INTO rooms (id, title, duration, passing_grade, status, created_by) VALUES ('OLDR', 'Kuis lama', 10, 50, 'Finished', 'admin');
INSERT INTO room_questions VALUES ('OLDR', 1, 0), ('OLDR', 2, 1);
INSERT INTO participants (room_id, name, department, score, status, submitted_at)
    VALUES ('OLDR', 'Peserta Lama', 'HK', 50, 'PASS', '2025-01-01 10:00:00');
INSERT INTO answers (participant_id, question_id, answer, is_correct) VALUES (1, 1, 'A', 1), (1, 2, 'C', 0);
"""


@pytest.mark.skipif(database.DB_TYPE != "sqlite", reason="migrasi diuji dengan file SQLite sementara")
def test_old_database_is_migrated_and_old_data_still_works(tmp_path, monkeypatch):
    legacy = tmp_path / "legacy.db"
    connection = sqlite3.connect(legacy)
    connection.executescript(LEGACY_SCHEMA)
    connection.commit()
    connection.close()
    monkeypatch.setattr(database, "SQLITE_FILE", str(legacy))

    database.init_db()
    database.init_db()                                                        # dijalankan lagi: aman (idempoten)

    # soal & room lama otomatis normal / fixed
    assert [q["level"] for q in database.get_all_questions()] == ["normal", "normal"]
    room = database.get_room("OLDR")
    assert room["question_mode"] == "fixed" and room["level_counts"] is None and room["question_ids"] == [1, 2]
    assert database.questions_per_participant(room) == 2

    # peserta lama: hasil lama tetap terbaca dengan soal room
    with database._transaction() as cursor:
        cursor.execute("SELECT * FROM participants WHERE id = 1")
        result = database._build_result(cursor, dict(cursor.fetchone()))
    assert result["total"] == 2 and result["correct"] == 1 and [a["level"] for a in result["answers"]] == ["normal"] * 2

    # soal baru bisa diberi level, dan room acak baru bisa dibuat di database hasil migrasi
    hard = database.create_question("Soal baru", "a", "b", "c", "d", "A", "K3", "mcq", "hard")
    assert hard["level"] == "hard"
    code = database.create_room("Kuis baru", 5, [1, 2, hard["id"]], 50, "admin", "random", {"normal": 1, "hard": 1})
    who, error, _ = database.join_participant(code, "Baru", "HK")
    assert error is None and len(who["question_ids"]) == 2 and hard["id"] in who["question_ids"]
