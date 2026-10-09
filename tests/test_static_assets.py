"""
Penjaga frontend (statis, tanpa browser):
  * semua file yang dirujuk <script>/<link> benar-benar ada
  * semua id yang dicari JavaScript (getElementById / $) ada di halaman HTML yang memuat script itu
    (bug lama: host.js menulis ke 'report-total-participants' yang tidak ada -> laporan HRD crash)
  * baseline Tailwind lokal (static/css/tailwind.local.css) memuat semua class Tailwind yang dipakai,
    supaya HP tanpa internet tidak melihat tampilan berantakan
  * semua halaman memakai viewport yang benar untuk HP
  * semua file JS lolos pemeriksaan sintaks (jika Node terpasang)
"""
import re
import shutil
import subprocess
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parent.parent / "static"
PAGES = {
    "index.html": ["js/landing.js"],
    "member.html": ["js/member.js"],
    "client.html": ["js/room.js", "js/result.js"],
    "host.html": ["js/host.js", "js/question-bank.js"],
    "admin.html": ["js/admin.js"],
}
# id yang dibuat/dicari secara dinamis dan memang tidak ada di HTML
DYNAMIC_ID_ALLOWLIST = set()


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# ───────────── file yang dirujuk ada ─────────────

@pytest.mark.parametrize("page", sorted(PAGES))
def test_referenced_local_files_exist(page):
    html = read(STATIC / page)
    refs = re.findall(r'(?:src|href)="([^"#?]+)"', html)
    local = [r for r in refs if not re.match(r"^(https?:)?//", r) and not r.startswith(("mailto:", "data:", "javascript:"))]
    assert local, "halaman tidak merujuk file lokal apa pun?"
    missing = [r for r in local if not (STATIC / r).exists()]
    assert not missing, f"{page} merujuk file yang tidak ada: {missing}"


@pytest.mark.parametrize("page", sorted(PAGES))
def test_page_loads_its_scripts_after_common_js(page):
    html = read(STATIC / page)
    scripts = re.findall(r'<script src="([^"]+)"', html)
    for script in PAGES[page]:
        assert script in scripts, f"{page} tidak memuat {script}"
    assert "js/common.js" in scripts and scripts.index("js/common.js") < scripts.index(PAGES[page][0]), \
        f"{page}: common.js harus dimuat sebelum script halaman"


# ───────────── id yang dicari JS harus ada di HTML ─────────────

def referenced_ids(js: str) -> set:
    ids = set()
    for match in re.finditer(r"""(?:getElementById|\$)\(\s*(['"`])([^'"`]+)\1\s*\)""", js):
        value = match.group(2)
        if "${" not in value:
            ids.add(value)
    return ids


@pytest.mark.parametrize("page", sorted(PAGES))
def test_every_id_used_by_js_exists_in_html(page):
    html = read(STATIC / page)
    html_ids = set(re.findall(r'\bid="([^"]+)"', html))
    problems = []
    for script in PAGES[page]:
        for element_id in sorted(referenced_ids(read(STATIC / script)) - DYNAMIC_ID_ALLOWLIST):
            if element_id not in html_ids:
                problems.append(f"{script}: '{element_id}'")
    assert not problems, f"id dipakai JS tetapi tidak ada di {page}: {problems}"


def test_original_report_bug_is_covered():
    """Regresi: elemen yang dulu hilang sehingga laporan HRD crash."""
    assert 'id="report-total-participants"' in read(STATIC / "host.html")


# ───────────── baseline Tailwind lokal ─────────────

# awalan utilitas Tailwind: hanya token berawalan ini yang diperiksa (class buatan sendiri diabaikan)
TAILWIND_PREFIXES = (
    "p-", "px-", "py-", "pt-", "pb-", "pl-", "pr-", "m-", "mx-", "my-", "mt-", "mb-", "ml-", "mr-",
    "w-", "h-", "min-w-", "min-h-", "max-w-", "max-h-", "text-", "bg-", "border-", "rounded-", "gap-", "space-",
    "items-", "justify-", "font-", "tracking-", "leading-", "grid-cols-", "col-span-", "opacity-", "shadow-",
    "overflow-", "z-", "top-", "bottom-", "left-", "right-", "inset-", "flex-", "animate-", "divide-", "ring-",
    "rotate-", "scale-", "translate-", "transition-", "duration-", "ease-", "whitespace-", "break-", "object-",
    "align-", "select-", "pointer-events-", "order-", "self-", "place-", "from-", "to-", "via-", "backdrop-",
    "blur-", "line-clamp-", "list-", "underline-", "decoration-", "outline-", "cursor-", "placeholder-",
)
TAILWIND_EXACT = {
    "flex", "grid", "block", "inline-flex", "inline-block", "relative", "absolute", "fixed", "sticky", "truncate",
    "uppercase", "rounded", "border", "transition", "transform", "italic", "underline", "cursor-pointer", "shadow",
}
VARIANTS = ("sm:", "md:", "lg:", "xl:", "hover:", "focus:", "active:", "disabled:")


def css_defines(css: str, token: str) -> bool:
    selector = "." + token.replace(":", "\\:").replace("/", "\\/").replace(".", "\\.")
    return any(selector + ch in css for ch in "{ :,>.)[")


def used_tailwind_tokens() -> set:
    tokens = set()
    sources = [read(STATIC / p) for p in PAGES] + [read(path) for path in (STATIC / "js").glob("*.js")]
    for text in sources:
        for chunk in re.findall(r"""class(?:Name)?\s*=\s*(['"`])(.*?)\1""", text, flags=re.S):
            tokens.update(chunk[1].split())
        for chunk in re.findall(r"""classList\.(?:add|remove|toggle)\(([^)]*)\)""", text):
            tokens.update(re.findall(r"['\"]([\w:/.-]+)['\"]", chunk))
        # kelas di dalam string JS (mis. ternary ${ok ? 'a-b' : 'c-d'} atau className = '...')
        for literal in re.findall(r"""['"`]([a-z0-9: /.\-\[\]%]+)['"`]""", text):
            if re.search(r"(?:^|\s)(?:sm:|md:|lg:|hover:)?(?:p|m|w|h|text|bg|border|gap|flex|grid|rounded)[a-z]*-", literal):
                tokens.update(literal.split())
    cleaned = set()
    for token in tokens:
        if "${" in token or not re.fullmatch(r"[a-z0-9:/.\-\[\]%]+", token):
            continue
        base = token
        for variant in VARIANTS:
            if base.startswith(variant):
                base = base[len(variant):]
        if base in TAILWIND_EXACT or base.startswith(TAILWIND_PREFIXES):
            cleaned.add(token)
    return cleaned


def test_tailwind_baseline_covers_all_used_classes():
    local = read(STATIC / "css" / "tailwind.local.css")
    own = read(STATIC / "index.css")
    missing = sorted(t for t in used_tailwind_tokens() if not css_defines(local, t) and not css_defines(own, t))
    assert not missing, (
        "Class berikut dipakai di HTML/JS tetapi belum ada di css/tailwind.local.css maupun index.css: "
        f"{missing}\n"
        "Perbaiki dengan:  cd tools/tailwind && npm install && npm run build   (atau definisikan di index.css). "
        "Tanpa ini, HP yang tidak punya internet tidak akan menerapkan class tersebut."
    )


def test_baseline_is_small_and_pages_load_it_before_index_css():
    local = STATIC / "css" / "tailwind.local.css"
    assert 2_000 < local.stat().st_size < 120_000
    for page in PAGES:
        html = read(STATIC / page)
        assert html.index("css/tailwind.local.css") < html.index('href="index.css"'), f"{page}: urutan CSS salah"
        # CDN penuh harus tidak memblokir tampilan
        cdn = re.search(r'<link[^>]*tailwind\.min\.css[^>]*>', html)
        assert cdn and 'media="print"' in cdn.group(0), f"{page}: CDN Tailwind tidak boleh memblokir render"


# ───────────── ekspor PDF ─────────────

def test_pdf_export_pins_the_html2pdf_container_to_the_left_with_the_same_width():
    """
    Regresi (hanya bisa dilihat dengan merender halaman PDF): html2pdf menaruh salinan di container selebar area cetak
    (190 mm = 718 px) dan MEMUSATKANNYA (margin: auto). Di layar yang lebih lebar dari kertas posisi container di halaman
    asli berbeda dengan di iframe html2canvas, sehingga isi PDF terpotong di kiri (laptop) atau bergeser (HP); salinan
    selebar 794 px juga terpotong 76 px di kanan. Penjaga ini memastikan perbaikannya tidak hilang.
    """
    js = read(STATIC / "js" / "pdf.js")
    assert "CONTENT_WIDTH_PX: Math.round((210 - 2 * 10) * 96 / 25.4)" in js        # 718 px = A4 dikurangi margin 10 mm
    assert "clone.style.width = `${this.CONTENT_WIDTH_PX}px`" in js                # salinan selebar container
    assert ".toContainer().then(function ()" in js                                  # container dimodifikasi sebelum difoto
    assert "box.style.margin = '0'" in js and "box.style.width = `${contentWidth}px`" in js
    assert "margin: this.MARGIN_MM" in js and "MARGIN_MM: 10" in js                 # margin kertas dan hitungan lebar sinkron


def test_hrd_report_rows_are_not_split_across_pdf_pages():
    assert "row.className = 'pdf-avoid-break'" in read(STATIC / "js" / "host.js")
    assert "avoid: ['.pdf-avoid-break']" in read(STATIC / "js" / "pdf.js")


# ───────────── viewport & sintaks ─────────────

@pytest.mark.parametrize("page", sorted(PAGES))
def test_viewport_meta_is_mobile_friendly(page):
    html = read(STATIC / page)
    viewport = re.search(r'<meta name="viewport" content="([^"]+)"', html)
    assert viewport, f"{page} tidak punya meta viewport"
    content = viewport.group(1)
    assert "width=device-width" in content and "initial-scale=1" in content and "viewport-fit=cover" in content
    # jangan mengunci zoom: merusak aksesibilitas
    assert "user-scalable=no" not in content and "maximum-scale" not in content


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js tidak terpasang")
@pytest.mark.parametrize("script", sorted(p.name for p in (STATIC / "js").glob("*.js")))
def test_javascript_syntax(script):
    result = subprocess.run(["node", "--check", str(STATIC / "js" / script)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
