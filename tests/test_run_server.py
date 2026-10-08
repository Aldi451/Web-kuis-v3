"""Tes peluncur run_server.py: .env, pemilihan port, banner alamat HP, dan instalasi dependency otomatis."""
import socket

import pytest

import netutils
import run_server


# ───────────── .env ─────────────

def test_read_dotenv_handles_bom_quotes_comments_and_export(tmp_path):
    env = tmp_path / ".env"
    # \ufeff = BOM yang ditambahkan Notepad Windows saat menyimpan UTF-8
    env.write_text(
        "\ufeffAPP_PORT=9001\n"
        "# komentar\n"
        "\n"
        'PUBLIC_URL="https://kuis.contoh.com"\n'
        "export GEMINI_MODEL = gemini-flash-latest   # model\n"
        "DATABASE_URL=postgresql://u:p@host/db?sslmode=require\n"
        "RUSAK_TANPA_SAMA_DENGAN\n",
        encoding="utf-8",
    )
    values = run_server.read_dotenv(env)
    assert values["APP_PORT"] == "9001"              # kunci pertama tidak rusak oleh BOM
    assert values["PUBLIC_URL"] == "https://kuis.contoh.com"
    assert values["GEMINI_MODEL"] == "gemini-flash-latest"
    assert values["DATABASE_URL"] == "postgresql://u:p@host/db?sslmode=require"   # '=' di dalam nilai aman
    assert "RUSAK_TANPA_SAMA_DENGAN" not in values


def test_read_dotenv_missing_file_returns_empty(tmp_path):
    assert run_server.read_dotenv(tmp_path / "tidak-ada.env") == {}


# ───────────── port ─────────────

def test_choose_port_skips_busy_port(capsys):
    blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    blocker.bind(("0.0.0.0", 0))
    blocker.listen(1)
    busy = blocker.getsockname()[1]
    try:
        chosen = run_server.choose_port(busy, "0.0.0.0")
    finally:
        blocker.close()
    assert chosen != busy and chosen > busy
    assert f"Port {busy} sedang dipakai" in capsys.readouterr().out


def test_choose_port_returns_preferred_when_free():
    probe = socket.socket()
    probe.bind(("0.0.0.0", 0))
    free_port = probe.getsockname()[1]
    probe.close()
    assert run_server.choose_port(free_port, "0.0.0.0") == free_port


def test_choose_port_gives_clear_error_when_nothing_free(monkeypatch):
    monkeypatch.setattr(netutils, "is_port_free", lambda port, host="0.0.0.0": False)
    with pytest.raises(SystemExit) as exc:
        run_server.choose_port(8000, "0.0.0.0")
    assert "Tidak ada port kosong" in str(exc.value)


# ───────────── banner ─────────────

def test_banner_shows_phone_url_and_firewall_hint(monkeypatch, capsys):
    monkeypatch.setattr(netutils, "get_lan_ips", lambda: ["192.168.1.23", "192.168.56.1"])
    run_server.print_banner("0.0.0.0", 8000, reload=False)
    out = capsys.readouterr().out
    assert "http://localhost:8000" in out
    assert "http://192.168.1.23:8000" in out and "http://192.168.56.1:8000" in out
    assert "Firewall" in out and "WiFi yang SAMA" in out
    assert out.isascii(), "banner harus ASCII agar aman di console Windows lama"


def test_banner_local_only_mode_warns_phones_cannot_connect(monkeypatch, capsys):
    monkeypatch.setattr(netutils, "get_lan_ips", lambda: ["192.168.1.23"])
    run_server.print_banner("127.0.0.1", 8000, reload=True)
    out = capsys.readouterr().out
    assert "192.168.1.23" not in out and "TIDAK bisa" in out and "auto-reload" in out


def test_banner_without_network_explains_problem(monkeypatch, capsys):
    monkeypatch.setattr(netutils, "get_lan_ips", lambda: [])
    run_server.print_banner("0.0.0.0", 8000, reload=False)
    assert "tidak terdeteksi" in capsys.readouterr().out


# ───────────── argumen ─────────────

def test_parse_args():
    args = run_server.parse_args(["--port", "9000", "--reload", "--no-browser", "--local-only"])
    assert (args.port, args.reload, args.no_browser, args.local_only) == (9000, True, True, True)
    defaults = run_server.parse_args([])
    assert defaults.port is None and not defaults.reload and not defaults.skip_install


# ───────────── instalasi dependency ─────────────

@pytest.fixture
def isolated_marker(tmp_path, monkeypatch):
    marker = tmp_path / ".deps-ok"
    monkeypatch.setattr(run_server, "DEPS_MARKER", marker)
    return marker


def test_dependencies_ok_skips_pip(isolated_marker, monkeypatch):
    monkeypatch.setattr(run_server, "_missing_modules", lambda: [])
    isolated_marker.write_text(run_server._requirements_fingerprint(), encoding="utf-8")
    monkeypatch.setattr(run_server.subprocess, "call", lambda *a, **k: pytest.fail("pip tidak boleh dijalankan"))
    assert run_server.ensure_dependencies() is True


def test_missing_dependencies_trigger_install_and_write_marker(isolated_marker, monkeypatch):
    calls = []
    state = {"installed": False}
    monkeypatch.setattr(run_server, "_missing_modules", lambda: [] if state["installed"] else ["fastapi"])

    def fake_pip(cmd, **kwargs):
        if "--version" in cmd:
            return 0                      # pip tersedia
        calls.append(cmd)
        state["installed"] = True
        return 0

    monkeypatch.setattr(run_server.subprocess, "call", fake_pip)
    assert run_server.ensure_dependencies() is True
    assert len(calls) == 1 and calls[0][1:5] == ["-m", "pip", "install", "--disable-pip-version-check"]
    assert isolated_marker.read_text(encoding="utf-8") == run_server._requirements_fingerprint()


def test_pip_failure_retries_without_postgres_driver(isolated_marker, monkeypatch, capsys):
    """psycopg2-binary adalah penyebab paling umum pip gagal di Windows; SQLite tidak membutuhkannya."""
    seen_requirements = []
    state = {"installed": False}
    monkeypatch.setattr(run_server, "_missing_modules", lambda: [] if state["installed"] else ["fastapi"])

    def fake_pip(cmd, **kwargs):
        if "--version" in cmd:
            return 0
        req_path = cmd[-1]
        content = open(req_path, encoding="utf-8").read()
        seen_requirements.append(content)
        if "psycopg2" in content:
            return 1                      # gagal karena psycopg2-binary tidak bisa dipasang
        state["installed"] = True
        return 0

    monkeypatch.setattr(run_server.subprocess, "call", fake_pip)
    assert run_server.ensure_dependencies() is True
    assert len(seen_requirements) == 2
    assert "psycopg2" in seen_requirements[0] and "psycopg2" not in seen_requirements[1]
    assert "fastapi" in seen_requirements[1]
    assert "SQLite" in capsys.readouterr().out


def test_third_fallback_uses_minimal_uvicorn_when_standard_extras_cannot_build(isolated_marker, monkeypatch, capsys):
    """httptools/watchfiles tanpa wheel di Python terbaru: set minimal (uvicorn + websockets) tetap menjalankan server."""
    seen = []
    state = {"installed": False}
    monkeypatch.setattr(run_server, "_missing_modules", lambda: [] if state["installed"] else ["fastapi"])

    def fake_pip(cmd, **kwargs):
        if "--version" in cmd:
            return 0
        content = open(cmd[-1], encoding="utf-8").read()
        seen.append(content)
        if "uvicorn[standard]" in content:
            return 1                      # extras (httptools, watchfiles, ...) gagal dibangun
        state["installed"] = True
        return 0

    monkeypatch.setattr(run_server.subprocess, "call", fake_pip)
    assert run_server.ensure_dependencies() is True
    assert len(seen) == 3
    assert "psycopg2" in seen[0] and "uvicorn[standard]" in seen[0]
    assert "psycopg2" not in seen[1] and "uvicorn[standard]" in seen[1]
    assert "uvicorn[standard]" not in seen[2] and "uvicorn>=" in seen[2] and "websockets" in seen[2]
    assert "fastapi" in seen[2] and "psycopg2" not in seen[2]
    assert "minimal" in capsys.readouterr().out


def test_missing_pip_is_bootstrapped_with_ensurepip(isolated_marker, monkeypatch, capsys):
    """Python Windows yang dipasang tanpa opsi pip: launcher memasang pip sendiri sebelum memasang library."""
    state = {"pip": False, "installed": False, "calls": []}
    monkeypatch.setattr(run_server, "_missing_modules", lambda: [] if state["installed"] else ["fastapi"])

    def fake_call(cmd, **kwargs):
        state["calls"].append(cmd[1:4])
        if cmd[1:3] == ["-m", "pip"] and "--version" in cmd:
            return 0 if state["pip"] else 1
        if cmd[1:3] == ["-m", "ensurepip"]:
            state["pip"] = True
            return 0
        state["installed"] = True      # pip install -r ...
        return 0

    monkeypatch.setattr(run_server.subprocess, "call", fake_call)
    assert run_server.ensure_dependencies() is True
    assert ["-m", "ensurepip", "--upgrade"] in state["calls"]
    assert "pip belum tersedia" in capsys.readouterr().out


def test_pip_impossible_to_bootstrap_gives_actionable_message(isolated_marker, monkeypatch, capsys):
    monkeypatch.setattr(run_server, "_missing_modules", lambda: ["fastapi"])
    monkeypatch.setattr(run_server.subprocess, "call", lambda cmd, **kw: 1)
    assert run_server.ensure_dependencies() is False
    out = capsys.readouterr().out
    assert "pip tidak tersedia" in out and "opsi 'pip'" in out


def test_total_pip_failure_reports_clear_error(isolated_marker, monkeypatch, capsys):
    monkeypatch.setattr(run_server, "_missing_modules", lambda: ["fastapi"])
    monkeypatch.setattr(run_server.subprocess, "call", lambda cmd, **k: 0 if "--version" in cmd else 1)
    assert run_server.ensure_dependencies() is False
    out = capsys.readouterr().out
    assert "internet" in out and "pip install -r requirements.txt" in out
    assert not isolated_marker.exists()


def test_requirements_file_lists_every_module_the_launcher_checks():
    text = (run_server.BASE_DIR / "requirements.txt").read_text(encoding="utf-8").lower()
    for package in run_server.REQUIRED_MODULES:
        assert package in text, f"{package} dicek launcher tetapi tidak ada di requirements.txt"
    assert "psycopg2-binary" in text
