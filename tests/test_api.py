"""Tes alur lengkap API: login -> bank soal -> room -> join -> submit -> hasil, + WebSocket."""
import re
import time
import uuid

import pytest
from fastapi.testclient import TestClient

import app as quiz_app
import database

ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


@pytest.fixture(scope="module")
def client():
    # 'with' memakai satu event loop untuk semua request + websocket (mirip server asli)
    with TestClient(quiz_app.app) as c:
        yield c


def wait_until(condition, timeout=3.0):
    """Server memproses connect/disconnect secara asinkron -> beri waktu singkat, jangan assert instan."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if condition():
            return True
        time.sleep(0.02)
    return condition()


def uniq(prefix="x"):
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def make_mcq(client, text="Berapa 1+1?", correct="B"):
    r = client.post("/api/questions", json={
        "question_text": text, "option_a": "1", "option_b": "2", "option_c": "3", "option_d": "4",
        "correct_option": correct, "category": "Tes", "question_type": "mcq"})
    assert r.status_code == 200, r.text
    return r.json()


def make_essay(client, text="Jelaskan proses reservasi", key="Masuk modul FO lalu klik reservation dan save"):
    r = client.post("/api/questions", json={
        "question_text": text, "correct_option": key, "category": "Tes", "question_type": "essay"})
    assert r.status_code == 200, r.text
    return r.json()


def make_room(client, question_ids, duration=10, passing=50):
    r = client.post("/api/rooms", json={"title": "Kuis Tes", "duration": duration, "passing_grade": passing,
                                        "question_ids": question_ids, "created_by": "admin"})
    assert r.status_code == 200, r.text
    return r.json()


def join(client, code, name, dept="HK", token=None):
    body = {"room_id": code, "name": name, "department": dept}
    if token:
        body["token"] = token
    return client.post("/api/rooms/join", json=body)


# ───────────── sistem ─────────────

def test_health_and_server_info(client):
    assert client.get("/api/health").json()["status"] == "ok"
    info = client.get("/api/server-info").json()
    assert isinstance(info["lan_urls"], list) and info["port"] > 0
    assert ISO_Z.match(info["server_time"])


def test_static_frontend_served_without_stale_cache(client):
    r = client.get("/")
    assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    assert r.headers["cache-control"] == "no-cache"
    assert client.get("/js/api.js").status_code == 200
    assert "cache-control" not in client.get("/api/health").headers


# ───────────── auth ─────────────

def test_login_variants(client):
    ok = client.post("/api/auth/login", json={"username": "admin", "password": "admin123"})
    assert ok.status_code == 200 and ok.json()["role"] == "Admin"
    # keyboard HP mengubah huruf pertama jadi kapital + spasi di ujung
    assert client.post("/api/auth/login", json={"username": " Admin ", "password": "admin123"}).status_code == 200
    bad = client.post("/api/auth/login", json={"username": "admin", "password": "salah"})
    assert bad.status_code == 401 and "salah" in bad.json()["detail"]


def test_register_validation(client):
    name = uniq("host")
    ok = client.post("/api/auth/register", json={"username": name, "password": "pw1", "role": "Host"})
    assert ok.status_code == 200 and ok.json()["role"] == "Host"
    # username sama walau beda huruf besar/kecil ditolak
    dup = client.post("/api/auth/register", json={"username": name.upper(), "password": "pw1", "role": "Host"})
    assert dup.status_code == 400 and "sudah" in dup.json()["detail"]
    # role sembarang (termasuk payload XSS) ditolak
    evil = client.post("/api/auth/register", json={"username": uniq("e"), "password": "pw", "role": "<img onerror=1>"})
    assert evil.status_code == 400
    # login dengan huruf kapital berbeda -> tetap masuk
    assert client.post("/api/auth/login", json={"username": name.upper(), "password": "pw1"}).status_code == 200
    users = client.get("/api/auth/users").json()
    assert any(u["username"] == name for u in users) and all(ISO_Z.match(u["created_at"]) for u in users)


# ───────────── bank soal ─────────────

def test_question_crud_and_validation(client):
    q = make_mcq(client)
    assert q["correct_option"] == "B" and ISO_Z.match(q["created_at"])
    assert any(x["id"] == q["id"] for x in client.get("/api/questions").json())

    upd = client.put(f"/api/questions/{q['id']}", json={
        "question_text": "Baru", "option_a": "a", "option_b": "b", "option_c": "c", "option_d": "d",
        "correct_option": "c", "category": "Tes", "question_type": "mcq"})
    assert upd.status_code == 200 and upd.json()["correct_option"] == "C"

    # 404 harus tetap 404 (dulu berubah jadi 500)
    assert client.put("/api/questions/999999", json={
        "question_text": "x", "option_a": "a", "option_b": "b", "option_c": "c", "option_d": "d",
        "correct_option": "A", "category": "T", "question_type": "mcq"}).status_code == 404

    bad = client.post("/api/questions", json={"question_text": "x", "option_a": "a", "option_b": "", "option_c": "c",
                                              "option_d": "d", "correct_option": "A", "question_type": "mcq"})
    assert bad.status_code == 422 and isinstance(bad.json()["detail"], str)
    bad_key = client.post("/api/questions", json={"question_text": "x", "option_a": "a", "option_b": "b", "option_c": "c",
                                                  "option_d": "d", "correct_option": "Z", "question_type": "mcq"})
    assert bad_key.status_code == 422

    assert client.delete(f"/api/questions/{q['id']}").status_code == 200


def test_questions_by_ids_keeps_requested_order(client):
    a, b, c = make_mcq(client, "A?"), make_mcq(client, "B?"), make_mcq(client, "C?")
    got = client.get(f"/api/questions?ids={c['id']},{a['id']},{b['id']}").json()
    assert [q["id"] for q in got] == [c["id"], a["id"], b["id"]]


# ───────────── room & status ─────────────

def test_room_lifecycle_and_timer_fields(client):
    q = make_mcq(client)
    room = make_room(client, [q["id"], q["id"]])  # duplikat id tidak boleh bikin error
    assert room["status"] == "Waiting" and room["question_ids"] == [q["id"]]
    assert re.fullmatch(r"[A-Z]{4}", room["room_code"])
    assert room["started_at"] is None and room["ends_at"] is None

    code = room["room_code"]
    assert client.get(f"/api/rooms/{code.lower()} ").status_code in (200, 404)  # kode tidak peka huruf
    assert client.get(f"/api/rooms/{code.lower()}").json()["id"] == code
    assert client.get("/api/rooms/ZZZZ9").status_code == 404

    assert client.put(f"/api/rooms/{code}/status", json={"status": "Bogus"}).status_code == 400
    assert client.put("/api/rooms/NOPE/status", json={"status": "On Progress"}).status_code == 404

    started = client.put(f"/api/rooms/{code}/status", json={"status": "On Progress"}).json()
    assert started["status"] == "On Progress" and ISO_Z.match(started["started_at"]) and ISO_Z.match(started["ends_at"])
    # start kedua (klik dobel) tidak boleh menggeser waktu mulai
    again = client.put(f"/api/rooms/{code}/status", json={"status": "On Progress"}).json()
    assert again["started_at"] == started["started_at"]
    assert client.put(f"/api/rooms/{code}/status", json={"status": "Waiting"}).status_code == 409

    assert client.put(f"/api/rooms/{code}/status", json={"status": "Finished"}).json()["status"] == "Finished"
    assert client.put(f"/api/rooms/{code}/status", json={"status": "On Progress"}).status_code == 409

    assert any(r["id"] == code for r in client.get("/api/rooms/finished").json())


def test_room_requires_existing_questions(client):
    r = client.post("/api/rooms", json={"title": "x", "duration": 5, "passing_grade": 70, "question_ids": [987654]})
    assert r.status_code == 400 and "tidak ditemukan" in r.json()["detail"]
    assert client.post("/api/rooms", json={"title": "x", "duration": 0, "passing_grade": 70,
                                           "question_ids": [1]}).status_code == 422


def test_active_rooms_listing(client):
    q = make_mcq(client)
    host = uniq("hostx")
    room = client.post("/api/rooms", json={"title": "Aktif", "duration": 5, "passing_grade": 70,
                                           "question_ids": [q["id"]], "created_by": host}).json()
    active = client.get("/api/rooms/active", params={"created_by": host}).json()
    assert [r["id"] for r in active] == [room["id"]]
    client.put(f"/api/rooms/{room['id']}/status", json={"status": "Finished"})
    assert client.get("/api/rooms/active", params={"created_by": host}).json() == []


# ───────────── join / resume ─────────────

def test_join_resume_and_duplicates(client):
    q = make_mcq(client)
    code = make_room(client, [q["id"]])["room_code"]

    first = join(client, code, "  Budi   Santoso ")
    assert first.status_code == 200, first.text
    p = first.json()
    assert p["participant_name"] == "Budi Santoso" and p["token"] and p["resumed"] is False
    assert ISO_Z.match(p["join_time"])

    dup = join(client, code, "budi santoso")
    assert dup.status_code == 400 and "sudah" in dup.json()["detail"]
    wrong = join(client, code, "Budi Santoso", token="tebakan")
    assert wrong.status_code == 400

    resumed = join(client, code, "Budi Santoso", token=p["token"])
    assert resumed.status_code == 200 and resumed.json()["resumed"] is True and resumed.json()["id"] == p["id"]

    assert join(client, "ZZZZ", "Andi").status_code == 404
    assert join(client, code, "   ").status_code in (400, 422)

    # participants list tidak boleh membocorkan token
    plist = client.get(f"/api/rooms/{code}/participants").json()
    assert len(plist) == 1 and "token" not in plist[0]

    client.put(f"/api/rooms/{code}/status", json={"status": "On Progress"})
    late = join(client, code, "Orang Baru")
    assert late.status_code == 400 and "berjalan" in late.json()["detail"]
    # peserta lama tetap bisa melanjutkan walau kuis sudah berjalan (HP ter-refresh di tengah kuis)
    assert join(client, code, "Budi Santoso", token=p["token"]).status_code == 200


# ───────────── submit & penilaian ─────────────

def test_batch_submit_scoring_and_security(client):
    q1, q2 = make_mcq(client, "Satu?", "B"), make_mcq(client, "Dua?", "C")
    essay = make_essay(client)
    outsider = make_mcq(client, "Di luar room?", "A")
    code = make_room(client, [q1["id"], q2["id"], essay["id"]], passing=60)["room_code"]
    p = join(client, code, "Siti").json()
    client.put(f"/api/rooms/{code}/status", json={"status": "On Progress"})

    def payload(answers):
        return [{"room_id": code, "participant_name": "Siti", "question_id": qid, "answer_user": ans}
                for qid, ans in answers]

    headers = {"X-Participant-Token": p["token"]}

    # tanpa token / token salah -> ditolak
    assert client.post("/api/answers/batch", json=payload([(q1["id"], "B")])).status_code == 403
    assert client.post("/api/answers/batch", json=payload([(q1["id"], "B")]),
                       headers={"X-Participant-Token": "salah"}).status_code == 403

    # q1 benar, q2 salah, essay benar (kata kunci), + jawaban soal di luar room (harus diabaikan)
    r = client.post("/api/answers/batch", headers=headers, json=payload([
        (q1["id"], "b"), (q2["id"], "A"), (essay["id"], "masuk modul FO klik reservation lalu save"),
        (outsider["id"], "A")]))
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["score"] == 67 and res["status"] == "PASS" and res["rank"] == 1
    assert res["total"] == 3 and res["correct"] == 2 and res["incorrect"] == 1
    assert [a["question_id"] for a in res["answers"]] == [q1["id"], q2["id"], essay["id"]]
    assert [a["is_correct"] for a in res["answers"]] == [True, False, True]
    assert res["answers"][1]["correct_answer"] == "C" and ISO_Z.match(res["submit_time"])

    # kirim ulang (retry saat sinyal putus) / curang mengubah jawaban -> hasil pertama dipertahankan
    again = client.post("/api/answers/batch", headers=headers, json=payload([(q2["id"], "C"), (q1["id"], "A")])).json()
    assert again["already_submitted"] is True and again["score"] == 67

    # hasil bisa diambil lagi setelah refresh (header atau query token)
    got = client.get(f"/api/participants/{p['id']}/result", headers=headers).json()
    assert got["score"] == 67 and got["submitted"] is True and len(got["answers"]) == 3
    assert client.get(f"/api/participants/{p['id']}/result", params={"token": p["token"]}).status_code == 200
    assert client.get(f"/api/participants/{p['id']}/result").status_code == 403
    assert client.get("/api/participants/987654/result").status_code == 404

    summary = client.get(f"/api/rooms/{code}/summary").json()
    assert summary["total_participants"] == 1 and summary["pass_count"] == 1 and summary["average_score"] == 67.0


def test_ranking_and_unanswered(client):
    q1, q2 = make_mcq(client, "Q1?", "A"), make_mcq(client, "Q2?", "A")
    code = make_room(client, [q1["id"], q2["id"]], passing=50)["room_code"]
    names = ["Ani", "Budi", "Caca"]
    tokens = {n: join(client, code, n).json() for n in names}
    client.put(f"/api/rooms/{code}/status", json={"status": "On Progress"})

    def submit(name, answers):
        return client.post("/api/answers/batch", headers={"X-Participant-Token": tokens[name]["token"]}, json=[
            {"room_id": code, "participant_name": name, "question_id": qid, "answer_user": a} for qid, a in answers]).json()

    assert submit("Budi", [(q1["id"], "A"), (q2["id"], "A")])["rank"] == 1   # 100
    assert submit("Ani", [(q1["id"], "A")])["rank"] == 2                      # 50, belum jawab soal 2
    caca = submit("Caca", [(q1["id"], "-"), (q2["id"], "")])                  # kosong semua
    assert caca["score"] == 0 and caca["status"] == "FAIL" and caca["rank"] == 3
    assert all(a["answer_user"] == "" and a["is_correct"] is False for a in caca["answers"])


def test_finalize_participant_who_never_started(client):
    q = make_mcq(client)
    code = make_room(client, [q["id"]])["room_code"]
    p = join(client, code, "Dodo").json()
    client.put(f"/api/rooms/{code}/status", json={"status": "Finished"})
    r = client.post(f"/api/participants/{p['id']}/finalize", headers={"X-Participant-Token": p["token"]},
                    json={"score": 100, "status": "PASS"})  # nilai dari klien tidak dipercaya
    assert r.status_code == 200, r.text
    assert r.json()["score"] == 0 and r.json()["status"] == "FAIL" and r.json()["submitted"] is True
    assert client.post(f"/api/participants/{p['id']}/finalize").status_code == 403


def test_single_answer_autosave_is_graded_by_server(client):
    q = make_mcq(client, "Auto?", "D")
    code = make_room(client, [q["id"]])["room_code"]
    p = join(client, code, "Eka").json()
    r = client.post("/api/answers", headers={"X-Participant-Token": p["token"]}, json={
        "room_id": code, "participant_name": "Eka", "question_id": q["id"], "answer_user": "d",
        "is_correct": False})
    assert r.status_code == 200 and r.json()["saved"] is True
    final = client.post(f"/api/participants/{p['id']}/finalize", headers={"X-Participant-Token": p["token"]}).json()
    assert final["score"] == 100 and final["answers"][0]["is_correct"] is True   # klien bilang False, server benar


# ───────────── WebSocket ─────────────

def test_websocket_events_and_heartbeat(client):
    q = make_mcq(client)
    code = make_room(client, [q["id"]])["room_code"]

    with client.websocket_connect(f"/ws/{code}") as ws:
        ws.send_text("ping")
        assert ws.receive_json()["type"] == "PONG"

        p = join(client, code, "Fani").json()
        evt = ws.receive_json()
        assert evt["type"] == "PARTICIPANT_JOINED" and evt["participant"]["participant_name"] == "Fani"
        assert "token" not in evt["participant"]

        # resume (refresh HP) tidak boleh menyiarkan "peserta baru" lagi
        join(client, code, "Fani", token=p["token"])

        client.put(f"/api/rooms/{code}/status", json={"status": "On Progress"})
        evt = ws.receive_json()
        assert evt["type"] == "ROOM_STATUS_CHANGED" and evt["status"] == "On Progress"
        assert ISO_Z.match(evt["started_at"]) and ISO_Z.match(evt["ends_at"]) and ISO_Z.match(evt["server_time"])

        client.post("/api/answers/batch", headers={"X-Participant-Token": p["token"]}, json=[
            {"room_id": code, "participant_name": "Fani", "question_id": q["id"], "answer_user": "A"}])
        evt = ws.receive_json()
        assert evt["type"] == "ANSWER_SUBMITTED" and evt["participant_id"] == p["id"]


def test_dead_websocket_is_pruned(client):
    q = make_mcq(client)
    code = make_room(client, [q["id"]])["room_code"]
    with client.websocket_connect(f"/ws/{code}"):
        assert wait_until(lambda: len(quiz_app.manager.active_connections.get(code, [])) == 1)
    # setelah klien menutup koneksi, tidak boleh tersisa di daftar
    assert wait_until(lambda: code not in quiz_app.manager.active_connections)


def test_database_backend_reported(client):
    assert client.get("/api/health").json()["db"] == database.DB_TYPE


# ───────────── keluar dari room ─────────────

def test_participant_can_leave_only_while_waiting(client):
    q = make_mcq(client)
    code = make_room(client, [q["id"]])["room_code"]
    typo = join(client, code, "Buudi").json()      # salah ketik nama di HP

    with client.websocket_connect(f"/ws/{code}") as ws:
        # token salah / tanpa token ditolak
        assert client.post(f"/api/participants/{typo['id']}/leave").status_code == 403
        assert client.post(f"/api/participants/{typo['id']}/leave", headers={"X-Participant-Token": "x"}).status_code == 403

        ok = client.post(f"/api/participants/{typo['id']}/leave", headers={"X-Participant-Token": typo["token"]})
        assert ok.status_code == 200
        evt = ws.receive_json()
        assert evt["type"] == "PARTICIPANT_LEFT" and evt["participant_id"] == typo["id"]

    assert client.get(f"/api/rooms/{code}/participants").json() == []
    assert client.post("/api/participants/987654/leave").status_code == 404

    budi = join(client, code, "Budi").json()               # gabung ulang dengan nama yang benar
    assert budi["participant_name"] == "Budi"

    client.put(f"/api/rooms/{code}/status", json={"status": "On Progress"})
    # setelah kuis berjalan tidak boleh keluar (data peserta tidak boleh hilang di tengah kuis)
    late = client.post(f"/api/participants/{budi['id']}/leave", headers={"X-Participant-Token": budi["token"]})
    assert late.status_code == 409 and "berjalan" in late.json()["detail"]
    assert len(client.get(f"/api/rooms/{code}/participants").json()) == 1
