#!/usr/bin/env python3
"""
run_server.py - peluncur Quiz Platform V3 (Windows / macOS / Linux)

Dipanggil oleh run_server.bat, tapi bisa juga dijalankan langsung:
    python run_server.py                 server biasa (bisa dibuka dari HP di WiFi yang sama)
    python run_server.py --reload        mode pengembangan (restart otomatis saat file .py berubah)
    python run_server.py --port 9000     pakai port lain
    python run_server.py --local-only    hanya bisa dibuka dari komputer ini (127.0.0.1)
    python run_server.py --no-browser    jangan buka browser otomatis

Yang dikerjakan skrip ini:
  1. memasang dependency otomatis jika belum ada (butuh internet hanya saat pertama kali)
  2. memilih port yang kosong (jika 8000 terpakai, otomatis pakai 8001, dst.)
  3. menjalankan server di 0.0.0.0 supaya HP bisa mengaksesnya, dan menampilkan alamat IP-nya
  4. membuka browser SETELAH server benar-benar siap
"""

import argparse
import hashlib
import importlib.util
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
os.chdir(BASE_DIR)
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

# Console Windows (cp1252/cp437) bisa menolak karakter tertentu -> jangan sampai print() membuat server crash
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

MIN_PYTHON = (3, 10)
DEFAULT_PORT = 8000
MAX_PORT_TRIES = 20

# nama paket pip -> nama modul yang di-import
REQUIRED_MODULES = {
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
    "pydantic": "pydantic",
    "python-dotenv": "dotenv",
    "httpx": "httpx",
    "openpyxl": "openpyxl",          # import soal dari Excel
    "python-multipart": "multipart",  # upload file Excel dari browser
}
OPTIONAL_PACKAGES = ("psycopg2-binary",)  # hanya untuk PostgreSQL; tanpa ini aplikasi memakai SQLite

DEPS_MARKER = BASE_DIR / ".deps-ok"


def say(message: str = ""):
    print(message, flush=True)


# ─────────────────────────────────────────────
# .env (dibaca manual agar tidak butuh python-dotenv sebelum dependency terpasang)
# ─────────────────────────────────────────────

def read_dotenv(path: Path) -> dict:
    values = {}
    try:
        text = path.read_text(encoding="utf-8-sig")  # utf-8-sig: aman untuk file .env buatan Notepad (ada BOM)
    except OSError:
        return values
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        if key:
            values[key] = value
    return values


# ─────────────────────────────────────────────
# DEPENDENCY
# ─────────────────────────────────────────────

def _requirements_fingerprint() -> str:
    req = BASE_DIR / "requirements.txt"
    digest = hashlib.sha256(req.read_bytes() if req.exists() else b"").hexdigest()[:16]
    return f"{digest}|py{sys.version_info.major}.{sys.version_info.minor}|{Path(sys.executable)}"


def _missing_modules() -> list:
    return [pkg for pkg, module in REQUIRED_MODULES.items() if importlib.util.find_spec(module) is None]


def _pip_install(requirements_file: Path) -> bool:
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "-r", str(requirements_file)]
    return subprocess.call(cmd) == 0


def _requirements_variants() -> list:
    """
    Daftar percobaan instalasi, dari yang lengkap sampai yang paling minimal.
    Di Windows dengan Python yang sangat baru, paket yang butuh kompilasi (psycopg2-binary, httptools, watchfiles)
    kadang belum punya wheel dan membuat SELURUH pip install gagal. Aplikasi tidak membutuhkannya untuk berjalan.
    """
    text = (BASE_DIR / "requirements.txt").read_text(encoding="utf-8-sig")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    without_pg = [ln for ln in lines if not any(ln.lower().startswith(pkg) for pkg in OPTIONAL_PACKAGES)]
    # uvicorn[standard] menarik httptools/watchfiles/PyYAML; uvicorn + websockets sudah cukup untuk HTTP & WebSocket
    minimal = ["uvicorn>=0.30.6" if ln.lower().startswith("uvicorn[") else ln for ln in without_pg]
    minimal.append("websockets>=12.0")
    return [
        ("lengkap", lines, None),
        ("tanpa PostgreSQL", without_pg, "Berhasil tanpa PostgreSQL. Aplikasi akan memakai database SQLite lokal."),
        ("minimal", minimal, "Berhasil dengan paket minimal (tanpa uvicorn[standard]). Server tetap berfungsi penuh."),
    ]


def _pip_available() -> bool:
    return subprocess.call(
        [sys.executable, "-m", "pip", "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    ) == 0


def _ensure_pip() -> bool:
    """Python yang dipasang tanpa opsi 'pip' (atau venv tanpa pip) tidak bisa memasang library: perbaiki dulu."""
    if _pip_available():
        return True
    say("[SETUP] pip belum tersedia. Memasangnya (ensurepip) ...")
    subprocess.call([sys.executable, "-m", "ensurepip", "--upgrade"])
    if _pip_available():
        return True
    say("[ERROR] pip tidak tersedia pada Python ini.")
    say("        Pasang ulang Python dari python.org, centang 'Add python.exe to PATH',")
    say("        dan pastikan opsi 'pip' ikut terpasang. Lalu hapus folder .venv dan jalankan lagi.")
    return False


def ensure_dependencies() -> bool:
    """Pasang dependency jika ada yang belum terpasang atau requirements.txt berubah."""
    fingerprint = _requirements_fingerprint()
    try:
        marker_ok = DEPS_MARKER.read_text(encoding="utf-8").strip() == fingerprint
    except OSError:
        marker_ok = False

    missing = _missing_modules()
    if not missing and marker_ok:
        return True

    if missing:
        say(f"[SETUP] Library belum lengkap ({', '.join(missing)}). Memasang dari requirements.txt ...")
    else:
        say("[SETUP] requirements.txt berubah. Memperbarui library ...")
    say("        (butuh koneksi internet, hanya sekali. Mohon tunggu 1-2 menit)")
    say()

    if not _ensure_pip():
        return False

    installed = False
    for index, (label, lines, success_note) in enumerate(_requirements_variants()):
        if index:
            say()
            say(f"[SETUP] Instalasi gagal. Mencoba lagi dengan set paket '{label}' ...")
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tmp:
            tmp.write("\n".join(lines) + "\n")
            tmp_path = Path(tmp.name)
        try:
            installed = _pip_install(tmp_path)
        finally:
            tmp_path.unlink(missing_ok=True)
        if installed:
            if success_note:
                say(f"[SETUP] {success_note}")
            break

    still_missing = _missing_modules()
    if not installed or still_missing:
        say()
        say("[ERROR] Gagal memasang library yang dibutuhkan.")
        say("        - Pastikan komputer terhubung ke internet, lalu jalankan ulang.")
        say("        - Atau pasang manual:  python -m pip install -r requirements.txt")
        say("        - Jika masih gagal, coba Python 3.12 (https://www.python.org/downloads/release/python-3120/)")
        if still_missing:
            say(f"        - Library yang masih kurang: {', '.join(still_missing)}")
        return False

    try:
        DEPS_MARKER.write_text(fingerprint, encoding="utf-8")
    except OSError:
        pass
    say()
    say("[SETUP] Library siap dipakai.")
    return True


# ─────────────────────────────────────────────
# PORT & ALAMAT
# ─────────────────────────────────────────────

def choose_port(preferred: int, host: str) -> int:
    from netutils import is_port_free

    for offset in range(MAX_PORT_TRIES):
        port = preferred + offset
        if port > 65535:
            break
        if is_port_free(port, host):
            if offset:
                say(f"[INFO] Port {preferred} sedang dipakai program lain. Memakai port {port} sebagai gantinya.")
            return port
    raise SystemExit(
        f"[ERROR] Tidak ada port kosong di rentang {preferred}-{preferred + MAX_PORT_TRIES - 1}. "
        "Tutup server lama (jendela hitam sebelumnya) atau ubah APP_PORT di file .env."
    )


def print_banner(host: str, port: int, reload: bool):
    from netutils import get_lan_ips

    line = "=" * 66
    say()
    say(line)
    say("  QUIZ PLATFORM V3 - SERVER AKTIF")
    say(line)
    say(f"  Di komputer ini : http://localhost:{port}")

    if host in ("0.0.0.0", "::", ""):
        ips = get_lan_ips()
        if ips:
            say(f"  Di HP (WiFi sama): http://{ips[0]}:{port}   <-- buka / scan QR dari alamat ini")
            for ip in ips[1:]:
                say(f"  Alamat lain      : http://{ip}:{port}")
        else:
            say("  Di HP            : IP jaringan tidak terdeteksi. Pastikan komputer tersambung ke WiFi/LAN.")
    else:
        say("  Di HP            : TIDAK bisa (server hanya untuk komputer ini).")

    say(f"  Mode             : {'pengembangan (auto-reload)' if reload else 'normal'}")
    say("  Hentikan server  : tekan CTRL+C, atau tutup jendela ini")
    say(line)
    if host in ("0.0.0.0", "::", ""):
        say("  Jika HP tidak bisa membuka alamat di atas:")
        say("   1) Pastikan HP & komputer di WiFi yang SAMA (bukan WiFi tamu / data seluler)")
        say("   2) Saat muncul peringatan Windows Firewall, klik 'Allow access' (Private network)")
        say("   3) Beberapa router punya 'AP/Client Isolation' - matikan jika ada")
        say(line)
    say()


def open_browser_when_ready(port: int, timeout: float = 45.0):
    """Buka browser hanya setelah server benar-benar menjawab (bukan menebak 'beberapa detik')."""
    health_url = f"http://127.0.0.1:{port}/api/health"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(health_url, timeout=1) as response:
                if response.status == 200:
                    break
        except Exception:
            time.sleep(0.4)
    else:
        return
    try:
        webbrowser.open(f"http://localhost:{port}")
    except Exception:
        pass


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────

def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Jalankan Quiz Platform V3")
    parser.add_argument("--port", type=int, help=f"port server (default {DEFAULT_PORT}, atau APP_PORT di .env)")
    parser.add_argument("--host", help="alamat bind (default 0.0.0.0 supaya bisa diakses HP)")
    parser.add_argument("--local-only", action="store_true", help="hanya bisa dibuka dari komputer ini")
    parser.add_argument("--reload", action="store_true", help="restart otomatis saat file .py berubah (pengembangan)")
    parser.add_argument("--no-browser", action="store_true", help="jangan buka browser otomatis")
    parser.add_argument("--skip-install", action="store_true", help="lewati pengecekan/instalasi library")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    if sys.version_info < MIN_PYTHON:
        say(f"[ERROR] Python {sys.version_info.major}.{sys.version_info.minor} terlalu lama. "
            f"Dibutuhkan Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]} atau lebih baru.")
        return 1

    # Nilai dari .env tersedia sebagai environment variable (variabel sistem tetap diprioritaskan)
    for key, value in read_dotenv(BASE_DIR / ".env").items():
        os.environ.setdefault(key, value)

    if not args.skip_install and not ensure_dependencies():
        return 1

    host = "127.0.0.1" if args.local_only else (args.host or os.getenv("APP_HOST") or "0.0.0.0")
    try:
        preferred = args.port or int(os.getenv("APP_PORT") or DEFAULT_PORT)
        if not 1 <= preferred <= 65535:
            raise ValueError
    except ValueError:
        say(f"[WARN] APP_PORT tidak valid ({os.getenv('APP_PORT')!r}). Memakai port {DEFAULT_PORT}.")
        preferred = DEFAULT_PORT

    reload_mode = args.reload or os.getenv("RELOAD", "").strip().lower() in ("1", "true", "yes")
    port = choose_port(preferred, host)
    print_banner(host, port, reload_mode)

    if not args.no_browser and os.getenv("NO_BROWSER", "").strip().lower() not in ("1", "true", "yes"):
        threading.Thread(target=open_browser_when_ready, args=(port,), daemon=True).start()

    import uvicorn

    try:
        uvicorn.run(
            "app:app",
            host=host,
            port=port,
            reload=reload_mode,
            reload_dirs=[str(BASE_DIR)] if reload_mode else None,
            timeout_keep_alive=30,   # HP di WiFi sering memakai ulang koneksi; 5 detik bawaan terlalu singkat
            log_level="info",
        )
    except KeyboardInterrupt:
        pass
    except OSError as e:
        say(f"[ERROR] Server gagal berjalan: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
