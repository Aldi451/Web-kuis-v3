"""
database.py — PostgreSQL & SQLite layer untuk QuizApp V3
Menggunakan psycopg2 dengan PostgreSQL atau SQLite sebagai fallback lokal.
"""

import sqlite3
import random
import string
from datetime import datetime
from dotenv import load_dotenv
import os
import urllib.parse as urlparse

try:
    import psycopg2
    import psycopg2.extras
    HAS_PSYCOPG2 = True
except ImportError:
    HAS_PSYCOPG2 = False

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/quizdb")
SQLITE_FILE = "quizdb.db"

# Tentukan tipe database secara dinamis
DB_TYPE = "postgres"

if not HAS_PSYCOPG2:
    DB_TYPE = "sqlite"
    print("[DB] psycopg2 tidak terpasang. Menggunakan SQLite lokal (quizdb.db).")
else:
    # Uji koneksi ke PostgreSQL
    try:
        # Tambahkan timeout agar tidak menggantung jika server PG mati
        conn_str = DATABASE_URL
        if "connect_timeout" not in conn_str:
            if "?" in conn_str:
                conn_str += "&connect_timeout=2"
            else:
                conn_str += "?connect_timeout=2"
        
        test_conn = psycopg2.connect(conn_str)
        test_conn.close()
        DB_TYPE = "postgres"
        print("[DB] Berhasil terhubung ke PostgreSQL. Menggunakan database PostgreSQL.")
    except Exception as e:
        print(f"[DB] Gagal terhubung ke PostgreSQL ({e}). Beralih ke SQLite lokal (quizdb.db).")
        DB_TYPE = "sqlite"

if HAS_PSYCOPG2:
    UniqueViolationException = psycopg2.errors.UniqueViolation
else:
    class UniqueViolationException(Exception):
        pass

# ─────────────────────────────────────────────
# SQLITE WRAPPERS UNTUK MENJAGA KOMPATIBILITAS
# ─────────────────────────────────────────────

class SQLiteCursorWrapper:
    def __init__(self, sqlite_cursor):
        self.cursor = sqlite_cursor

    def execute(self, query, params=None):
        # Konversi query dari PostgreSQL-style ke SQLite-style
        query = query.replace("%s", "?")
        query = query.replace("SERIAL PRIMARY KEY", "INTEGER PRIMARY KEY AUTOINCREMENT")
        query = query.replace("NOW()", "CURRENT_TIMESTAMP")
        
        if params is not None:
            if not isinstance(params, (list, tuple)):
                params = (params,)
            return self.cursor.execute(query, params)
        else:
            return self.cursor.execute(query)

    def fetchone(self):
        row = self.cursor.fetchone()
        if row is not None:
            return dict(row)
        return None

    def fetchall(self):
        rows = self.cursor.fetchall()
        return [dict(r) for r in rows]

    def close(self):
        self.cursor.close()

    @property
    def lastrowid(self):
        return self.cursor.lastrowid

    def __getattr__(self, name):
        return getattr(self.cursor, name)


class SQLiteConnectionWrapper:
    def __init__(self, sqlite_conn):
        self.conn = sqlite_conn
        # Aktifkan Foreign Keys di SQLite
        self.conn.execute("PRAGMA foreign_keys = ON;")

    def cursor(self, cursor_factory=None):
        self.conn.row_factory = sqlite3.Row
        return SQLiteCursorWrapper(self.conn.cursor())

    def commit(self):
        self.conn.commit()

    def rollback(self):
        self.conn.rollback()

    def close(self):
        self.conn.close()

    def __getattr__(self, name):
        return getattr(self.conn, name)

import json
import httpx

def simple_similarity_fallback(user_answer: str, correct_answer: str) -> bool:
    """Menggunakan rasio kecocokan kata kunci sederhana sebagai fallback."""
    u_words = set(user_answer.lower().strip().split())
    c_words = set(correct_answer.lower().strip().split())
    if not c_words:
        return False
    intersection = u_words.intersection(c_words)
    ratio = len(intersection) / len(c_words)
    # Jika kecocokan kata kunci >= 40%, dianggap benar secara konsep sederhana
    return ratio >= 0.4

def evaluate_essay_answer_ai(user_answer: str, correct_answer: str) -> bool:
    """Mengevaluasi kesamaan makna essay menggunakan Gemini API (atau fallback)."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("[AI] GEMINI_API_KEY tidak ditemukan. Menggunakan fallback similarity.")
        return simple_similarity_fallback(user_answer, correct_answer)

    prompt = f"""Anda adalah asisten korektor jawaban ujian essay otomatis.
Tugas Anda adalah membandingkan "Jawaban Peserta" dengan "Kunci Jawaban" untuk menentukan apakah maknanya sama atau sangat mirip secara konseptual, meskipun penyampaian kalimatnya berbeda.

Kriteria penilaian:
- Jika jawaban peserta menyampaikan konsep inti yang sama dengan kunci jawaban, nyatakan sebagai BENAR.
- Jika jawaban peserta salah secara konsep atau tidak menjawab inti dari kunci jawaban, nyatakan sebagai SALAH.

Berikan output dalam format JSON mentah sebagai berikut:
{{
  "is_correct": true atau false,
  "explanation": "Penjelasan singkat dalam bahasa Indonesia mengapa jawaban tersebut dinilai benar atau salah"
}}

Kunci Jawaban: "{correct_answer}"
Jawaban Peserta: "{user_answer}"
"""

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json"
        }
    }
    
    try:
        response = httpx.post(url, json=payload, timeout=10.0)
        if response.status_code == 200:
            data = response.json()
            text_response = data["candidates"][0]["content"]["parts"][0]["text"]
            res_json = json.loads(text_response.strip())
            print(f"[AI Evaluation] Hasil: {res_json.get('is_correct')} | Penjelasan: {res_json.get('explanation')}")
            return bool(res_json.get("is_correct"))
        else:
            print(f"[AI] API Error: {response.status_code} - {response.text}")
            return simple_similarity_fallback(user_answer, correct_answer)
    except Exception as e:
        print(f"[AI] Gagal melakukan evaluasi AI: {e}")
        return simple_similarity_fallback(user_answer, correct_answer)

# ─────────────────────────────────────────────
# DATABASE CONNECTION FUNCTIONS
# ─────────────────────────────────────────────

def get_db_connection():
    """Membuat koneksi ke PostgreSQL atau SQLite."""
    if DB_TYPE == "sqlite":
        conn = sqlite3.connect(SQLITE_FILE)
        return SQLiteConnectionWrapper(conn)

    try:
        conn = psycopg2.connect(DATABASE_URL)
        conn.autocommit = False
        return conn
    except psycopg2.OperationalError as e:
        if "does not exist" in str(e):
            try:
                parsed = urlparse.urlparse(DATABASE_URL)
                dbname = parsed.path[1:]
                default_url = urlparse.urlunparse(parsed._replace(path='/postgres'))
                
                print(f"[DB] Database '{dbname}' tidak ditemukan. Mencoba membuat database...")
                temp_conn = psycopg2.connect(default_url)
                temp_conn.autocommit = True
                temp_cursor = temp_conn.cursor()
                temp_cursor.execute(f'CREATE DATABASE "{dbname}"')
                temp_cursor.close()
                temp_conn.close()
                print(f"[DB] Database '{dbname}' berhasil dibuat.")
                
                conn = psycopg2.connect(DATABASE_URL)
                conn.autocommit = False
                return conn
            except Exception as create_err:
                print(f"[DB] Gagal membuat database otomatis: {create_err}")
                raise e
        else:
            raise e


def init_db():
    """Membuat semua tabel jika belum ada."""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # Tabel rooms
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS rooms (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            duration INTEGER NOT NULL,
            passing_grade INTEGER NOT NULL DEFAULT 70,
            status TEXT NOT NULL DEFAULT 'Waiting',
            created_by TEXT DEFAULT 'Host',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """)

        # Tabel questions (bank soal permanen)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS questions (
            id SERIAL PRIMARY KEY,
            question_text TEXT NOT NULL,
            option_a TEXT NOT NULL,
            option_b TEXT NOT NULL,
            option_c TEXT NOT NULL,
            option_d TEXT NOT NULL,
            correct_answer TEXT NOT NULL,
            category TEXT DEFAULT 'Umum',
            question_type TEXT DEFAULT 'mcq',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """)

        # Tabel room_questions (many-to-many: room → questions)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS room_questions (
            room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
            sort_order INTEGER DEFAULT 0,
            PRIMARY KEY (room_id, question_id)
        )
        """)

        # Tabel participants
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS participants (
            id SERIAL PRIMARY KEY,
            room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            department TEXT DEFAULT '-',
            score INTEGER DEFAULT 0,
            status TEXT DEFAULT 'ON_PROGRESS',
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            submitted_at TIMESTAMP,
            UNIQUE(room_id, name)
        )
        """)

        # Tabel answers
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS answers (
            id SERIAL PRIMARY KEY,
            participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
            question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
            answer TEXT NOT NULL,
            is_correct BOOLEAN NOT NULL DEFAULT FALSE,
            UNIQUE(participant_id, question_id)
        )
        """)

        # Tabel user_roles (Auth dari Repo2)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS user_roles (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'Host',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """)

        # Insert default admin jika belum ada
        cursor.execute("""
        INSERT INTO user_roles (username, password, role)
        VALUES ('admin', 'admin123', 'Admin')
        ON CONFLICT (username) DO NOTHING
        """)

        conn.commit()
        
        # Tambahkan kolom question_type ke tabel questions jika belum ada (untuk database yang sudah ada)
        try:
            cursor.execute("ALTER TABLE questions ADD COLUMN question_type TEXT DEFAULT 'mcq'")
            conn.commit()
        except Exception:
            conn.rollback()

        print("[DB] Database initialized successfully.")
    except Exception as e:
        conn.rollback()
        print(f"[DB] Error initializing database: {e}")
        raise e
    finally:
        cursor.close()
        conn.close()


# ─────────────────────────────────────────────
# ROOM FUNCTIONS
# ─────────────────────────────────────────────

def generate_room_code():
    """Generate kode room 4 huruf kapital unik."""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        while True:
            code = "".join(random.choices(string.ascii_uppercase, k=4))
            cursor.execute("SELECT id FROM rooms WHERE id = %s", (code,))
            if cursor.fetchone() is None:
                return code
    finally:
        cursor.close()
        conn.close()


def create_room(title: str, duration: int, question_ids: list, passing_grade: int = 70, created_by: str = "Host"):
    """
    Membuat room baru dengan soal-soal dari question bank.
    question_ids: list[int] — ID soal dari tabel questions.
    """
    code = generate_room_code()
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO rooms (id, title, duration, passing_grade, status, created_by) VALUES (%s, %s, %s, %s, 'Waiting', %s)",
            (code, title, duration, passing_grade, created_by)
        )
        for i, q_id in enumerate(question_ids):
            cursor.execute(
                "INSERT INTO room_questions (room_id, question_id, sort_order) VALUES (%s, %s, %s)",
                (code, q_id, i)
            )
        conn.commit()
        return code
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        cursor.close()
        conn.close()


def get_room(room_id: str):
    """Ambil data room berdasarkan room_id/room_code."""
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute("SELECT * FROM rooms WHERE id = %s", (room_id.upper(),))
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        cursor.close()
        conn.close()


def update_room_status(room_id: str, status: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("UPDATE rooms SET status = %s WHERE id = %s", (status, room_id.upper()))
        conn.commit()
    finally:
        cursor.close()
        conn.close()


def get_room_history():
    """Ambil semua room yang sudah FINISHED."""
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute("SELECT * FROM rooms WHERE status = 'Finished' ORDER BY created_at DESC")
        return [dict(r) for r in cursor.fetchall()]
    finally:
        cursor.close()
        conn.close()


def reset_room(room_id: str):
    """Reset room ke status WAITING dan hapus semua peserta."""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("UPDATE rooms SET status = 'Waiting' WHERE id = %s", (room_id.upper(),))
        cursor.execute("DELETE FROM participants WHERE room_id = %s", (room_id.upper(),))
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        cursor.close()
        conn.close()


# ─────────────────────────────────────────────
# QUESTION BANK FUNCTIONS
# ─────────────────────────────────────────────

def get_all_questions():
    """Ambil semua soal dari bank soal."""
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute("SELECT * FROM questions ORDER BY created_at DESC")
        return [dict(r) for r in cursor.fetchall()]
    finally:
        cursor.close()
        conn.close()


def get_questions_by_room(room_id: str):
    """Ambil soal-soal yang terkait dengan room tertentu (tanpa correct_answer)."""
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute("""
            SELECT q.id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.category
            FROM questions q
            JOIN room_questions rq ON q.id = rq.question_id
            WHERE rq.room_id = %s
            ORDER BY rq.sort_order
        """, (room_id.upper(),))
        return [dict(r) for r in cursor.fetchall()]
    finally:
        cursor.close()
        conn.close()


def get_questions_with_answers_by_room(room_id: str):
    """Ambil soal beserta correct_answer (untuk hasil akhir)."""
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute("""
            SELECT q.*
            FROM questions q
            JOIN room_questions rq ON q.id = rq.question_id
            WHERE rq.room_id = %s
            ORDER BY rq.sort_order
        """, (room_id.upper(),))
        return [dict(r) for r in cursor.fetchall()]
    finally:
        cursor.close()
        conn.close()


def create_question(question_text, option_a, option_b, option_c, option_d, correct_answer, category="Umum", question_type="mcq"):
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        ans_val = correct_answer.upper() if question_type == "mcq" else correct_answer
        cursor.execute("""
            INSERT INTO questions (question_text, option_a, option_b, option_c, option_d, correct_answer, category, question_type)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING *
        """, (question_text, option_a, option_b, option_c, option_d, ans_val, category, question_type))
        row = cursor.fetchone()
        conn.commit()
        return dict(row)
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        cursor.close()
        conn.close()


def update_question(q_id: int, question_text, option_a, option_b, option_c, option_d, correct_answer, category="Umum", question_type="mcq"):
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        ans_val = correct_answer.upper() if question_type == "mcq" else correct_answer
        cursor.execute("""
            UPDATE questions SET question_text=%s, option_a=%s, option_b=%s, option_c=%s, option_d=%s,
            correct_answer=%s, category=%s, question_type=%s WHERE id=%s RETURNING *
        """, (question_text, option_a, option_b, option_c, option_d, ans_val, category, question_type, q_id))
        row = cursor.fetchone()
        conn.commit()
        return dict(row) if row else None
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        cursor.close()
        conn.close()


def delete_question(q_id: int):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM questions WHERE id = %s", (q_id,))
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        cursor.close()
        conn.close()


# ─────────────────────────────────────────────
# PARTICIPANT FUNCTIONS
# ─────────────────────────────────────────────

def add_participant(room_id: str, name: str, department: str = "-"):
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute("SELECT status FROM rooms WHERE id = %s", (room_id.upper(),))
        room = cursor.fetchone()
        if not room:
            return None, "Room tidak ditemukan"
        if room["status"] not in ("Waiting", "WAITING"):
            return None, "Kuis sudah berjalan atau selesai"

        cursor.execute(
            "INSERT INTO participants (room_id, name, department) VALUES (%s, %s, %s) RETURNING id",
            (room_id.upper(), name, department)
        )
        row = cursor.fetchone()
        conn.commit()
        return row["id"], None
    except (UniqueViolationException, sqlite3.IntegrityError):
        conn.rollback()
        return None, "Nama sudah digunakan dalam room ini"
    except Exception as e:
        conn.rollback()
        return None, str(e)
    finally:
        cursor.close()
        conn.close()


def get_participants(room_id: str):
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute(
            "SELECT * FROM participants WHERE room_id = %s ORDER BY score DESC, joined_at ASC",
            (room_id.upper(),)
        )
        return [dict(r) for r in cursor.fetchall()]
    finally:
        cursor.close()
        conn.close()


def submit_answer(participant_id: int, question_id: int, answer: str):
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute("SELECT correct_answer FROM questions WHERE id = %s", (question_id,))
        q = cursor.fetchone()
        if not q:
            return False, "Soal tidak ditemukan"

        is_correct = answer.upper() == q["correct_answer"].upper()

        cursor.execute(
            "INSERT INTO answers (participant_id, question_id, answer, is_correct) VALUES (%s, %s, %s, %s)",
            (participant_id, question_id, answer.upper(), is_correct)
        )
        conn.commit()
        return True, None
    except (UniqueViolationException, sqlite3.IntegrityError):
        conn.rollback()
        return False, "Jawaban sudah dikirim"
    except Exception as e:
        conn.rollback()
        return False, str(e)
    finally:
        cursor.close()
        conn.close()


def finalize_participant_score(participant_id: int, room_id: str, passing_grade: int):
    """Hitung skor akhir peserta dan update status PASS/FAIL."""
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        # Count total questions in room
        cursor.execute("""
            SELECT COUNT(*) as total FROM room_questions WHERE room_id = %s
        """, (room_id.upper(),))
        total = cursor.fetchone()["total"]

        # Count correct answers
        cursor.execute("""
            SELECT COUNT(*) as correct FROM answers
            WHERE participant_id = %s AND is_correct = TRUE
        """, (participant_id,))
        correct = cursor.fetchone()["correct"]

        score = round((correct / total) * 100) if total > 0 else 0
        status = "PASS" if score >= passing_grade else "FAIL"

        cursor.execute("""
            UPDATE participants SET score = %s, status = %s, submitted_at = NOW()
            WHERE id = %s
        """, (score, status, participant_id))
        conn.commit()
        return score, status
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        cursor.close()
        conn.close()


def get_participant_progress(room_id: str):
    """Progress tiap peserta: berapa soal sudah dijawab."""
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute("SELECT COUNT(*) as total FROM room_questions WHERE room_id = %s", (room_id.upper(),))
        total_q = cursor.fetchone()["total"]

        cursor.execute("""
            SELECT p.id, p.name, p.department, p.score, p.status, p.submitted_at,
                   COUNT(a.id) as answered_count
            FROM participants p
            LEFT JOIN answers a ON p.id = a.participant_id
            WHERE p.room_id = %s
            GROUP BY p.id
            ORDER BY p.score DESC, p.joined_at ASC
        """, (room_id.upper(),))
        rows = cursor.fetchall()
        return {
            "total_questions": total_q,
            "participants": [dict(r) for r in rows]
        }
    finally:
        cursor.close()
        conn.close()


def get_room_summary(room_id: str):
    """Hitung ringkasan hasil kuis: total, avg score, pass/fail count."""
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute("""
            SELECT
                COUNT(*) as total_participants,
                COALESCE(AVG(score), 0) as average_score,
                SUM(CASE WHEN status = 'PASS' THEN 1 ELSE 0 END) as pass_count,
                SUM(CASE WHEN status = 'FAIL' THEN 1 ELSE 0 END) as fail_count
            FROM participants WHERE room_id = %s
        """, (room_id.upper(),))
        return dict(cursor.fetchone())
    finally:
        cursor.close()
        conn.close()


# ─────────────────────────────────────────────
# AUTH FUNCTIONS
# ─────────────────────────────────────────────

def get_user_by_credentials(username: str, password: str):
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute(
            "SELECT id, username, role FROM user_roles WHERE username = %s AND password = %s",
            (username, password)
        )
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        cursor.close()
        conn.close()


def get_all_users():
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute("SELECT id, username, role, created_at FROM user_roles ORDER BY username")
        return [dict(r) for r in cursor.fetchall()]
    finally:
        cursor.close()
        conn.close()


def create_user(username: str, password: str, role: str = "Host"):
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute(
            "INSERT INTO user_roles (username, password, role) VALUES (%s, %s, %s) RETURNING id, username, role",
            (username, password, role)
        )
        row = cursor.fetchone()
        conn.commit()
        return dict(row), None
    except (UniqueViolationException, sqlite3.IntegrityError):
        conn.rollback()
        return None, "Username sudah digunakan"
    except Exception as e:
        conn.rollback()
        return None, str(e)
    finally:
        cursor.close()
        conn.close()


def delete_user(user_id: int):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM user_roles WHERE id = %s AND username != 'admin'", (user_id,))
        conn.commit()
    finally:
        cursor.close()
        conn.close()


def get_participant_answers(participant_id: int):
    """Ambil semua jawaban peserta beserta info soal."""
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute("""
            SELECT a.question_id, a.answer, a.is_correct,
                   q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_answer
            FROM answers a
            JOIN questions q ON a.question_id = q.id
            WHERE a.participant_id = %s
        """, (participant_id,))
        return [dict(r) for r in cursor.fetchall()]
    finally:
        cursor.close()
        conn.close()
