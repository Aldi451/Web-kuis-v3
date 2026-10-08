"""
Penjaga untuk run_server.bat.

cmd.exe sangat sensitif. Versi lama run_server.bat gagal jalan karena:
  * baris berakhiran LF saja (bukan CRLF)
  * tanda ')' di dalam teks echo yang berada di dalam blok ( ... ) menutup blok lebih awal
Tes ini membuat kesalahan semacam itu langsung ketahuan, walau dijalankan di Linux/macOS.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BAT = ROOT / "run_server.bat"

BUILTIN_VARS = {"CD", "ERRORLEVEL"}


def _lines():
    text = BAT.read_bytes().decode("ascii")  # gagal jika ada karakter non-ASCII
    return text.split("\r\n")


def test_pure_ascii_and_crlf_only():
    raw = BAT.read_bytes()
    raw.decode("ascii")
    assert raw.endswith(b"\r\n"), "file harus diakhiri CRLF"
    assert raw.count(b"\r\n") == raw.count(b"\n"), "ada baris yang hanya berakhiran LF (harus CRLF)"
    assert raw.count(b"\r") == raw.count(b"\r\n"), "ada karakter CR liar"
    assert b"\t" not in raw or True  # tab tidak masalah, hanya dicatat


def test_starts_with_echo_off():
    first = next(line for line in _lines() if line.strip())
    assert first.strip().lower() == "@echo off"


def test_no_parenthesis_outside_quotes():
    """Tanpa blok ( ... ) sama sekali: tidak ada tanda kurung di luar tanda kutip pada baris perintah."""
    problems = []
    for number, line in enumerate(_lines(), 1):
        stripped = line.strip()
        if not stripped or stripped.lower().startswith("rem ") or stripped.lower() == "rem":
            continue
        unquoted = re.sub(r'"[^"]*"', "", line)
        if "(" in unquoted or ")" in unquoted:
            problems.append(f"baris {number}: {line.strip()}")
    assert not problems, "tanda kurung di luar kutip merusak parsing cmd.exe:\n" + "\n".join(problems)


def test_labels_and_jumps_are_consistent():
    labels = {}
    for number, line in enumerate(_lines(), 1):
        match = re.match(r"^:([A-Za-z_][A-Za-z0-9_]*)\s*$", line)
        if match:
            name = match.group(1).lower()
            assert name not in labels, f"label ganda :{name} (baris {number})"
            labels[name] = number

    targets = []
    for number, line in enumerate(_lines(), 1):
        if line.strip().lower().startswith("rem"):
            continue
        for match in re.finditer(r"\b(?:goto|call)\s+:?([A-Za-z_][A-Za-z0-9_]*)", line, flags=re.I):
            targets.append((number, match.group(1).lower()))
    assert targets, "tidak ada goto/call ditemukan - parser tes bermasalah"
    missing = [(n, t) for n, t in targets if t != "eof" and t not in labels]
    assert not missing, f"goto/call menuju label yang tidak ada: {missing}"


def test_variables_are_defined_before_use_names():
    text = "\r\n".join(_lines())
    defined = {m.group(1).upper() for m in re.finditer(r'set\s+"([A-Za-z_][A-Za-z0-9_]*)=', text, flags=re.I)}
    used = {m.group(1).upper() for m in re.finditer(r"%([A-Za-z_][A-Za-z0-9_]*)%", text)}
    unknown = used - defined - BUILTIN_VARS
    assert not unknown, f"variabel dipakai tapi tidak pernah di-set (typo?): {sorted(unknown)}"


def test_main_flow_never_falls_into_subroutine():
    """Subrutin :try_python hanya boleh dimasuki lewat 'call' - alur utama harus selesai (exit /b) sebelumnya."""
    lines = _lines()
    sub_index = next(i for i, line in enumerate(lines) if line.strip().lower() == ":try_python")
    previous = [l.strip().lower() for l in lines[:sub_index] if l.strip() and not l.strip().lower().startswith("rem")]
    assert previous[-1].startswith("exit /b"), f"baris sebelum :try_python adalah {previous[-1]!r}"


def test_launcher_uses_pushd_and_passes_arguments():
    text = BAT.read_text(encoding="ascii")
    assert 'pushd "%~dp0"' in text          # selalu bekerja dari folder file ini (mis. 'Run as administrator')
    assert "run_server.py %*" in text        # opsi seperti --reload diteruskan
    assert "0.0.0.0" not in text.replace("rem", "")  # alamat bind diatur di run_server.py, bukan di sini


def test_gitattributes_forces_crlf_for_bat():
    attrs = (ROOT / ".gitattributes").read_text(encoding="utf-8")
    assert re.search(r"^\*\.bat\s+text\s+eol=crlf\s*$", attrs, flags=re.M)
