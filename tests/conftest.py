"""
Konfigurasi test.

Secara default test memakai database SQLite sementara (TIDAK menyentuh quizdb.db).
Untuk menguji PostgreSQL:   set TEST_DATABASE_URL=postgresql://user:pass@host/dbname
"""
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
if TEST_DATABASE_URL:
    os.environ["DATABASE_URL"] = TEST_DATABASE_URL
    os.environ.pop("DB_BACKEND", None)
else:
    os.environ["DB_BACKEND"] = "sqlite"
    os.environ["SQLITE_FILE"] = os.path.join(tempfile.mkdtemp(prefix="quiz-test-"), "test.db")

# Tanpa kunci API -> penilaian essay memakai fallback kata kunci (deterministik, tanpa internet)
os.environ.pop("GEMINI_API_KEY", None)
os.environ.pop("PUBLIC_URL", None)
