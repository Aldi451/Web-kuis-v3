# Quiz Platform V3

Aplikasi kuis *real-time* (FastAPI + WebSocket + HTML/JS) untuk training / asesmen. Peserta mengerjakan kuis
dari **HP** dengan memindai QR code; Host mengendalikan kuis dan melihat skor secara langsung.

Daftar fitur lengkap ada di [`FEATURES.md`](FEATURES.md).

---

## 1. Menjalankan server

### Windows (cara termudah)

1. **Klik dua kali `run_server.bat`**.
2. Pertama kali, file ini otomatis: mencari Python → membuat folder `.venv` → memasang library
   (butuh internet, sekitar 1-2 menit, hanya sekali).
3. Browser terbuka sendiri **setelah server benar-benar siap**. Jendela hitam menampilkan alamat untuk HP.
4. Hentikan server dengan `CTRL+C` atau tutup jendela hitam.

Syarat: **Python 3.10 atau lebih baru** dari <https://www.python.org/downloads/>.
Saat instalasi, centang **"Add python.exe to PATH"**.

Opsi tambahan (ketik setelah nama file di Command Prompt):

| Perintah | Fungsi |
| --- | --- |
| `run_server.bat --reload` | Mode pengembangan: server restart otomatis saat file `.py` berubah |
| `run_server.bat --port 9000` | Pakai port lain (bawaan 8000; jika terpakai, otomatis pindah ke 8001, dst.) |
| `run_server.bat --local-only` | Hanya bisa dibuka dari komputer ini (HP tidak bisa) |
| `run_server.bat --no-browser` | Jangan buka browser otomatis |

### macOS / Linux

```bash
python3 run_server.py            # library dipasang otomatis jika belum ada
```

Opsi yang sama berlaku (`--reload`, `--port 9000`, dst.).

---

## 2. Membuka dari HP

1. Pastikan **HP dan komputer ada di WiFi yang sama** (bukan WiFi tamu / data seluler).
2. Jendela server menampilkan baris seperti ini:

   ```
   Di HP (WiFi sama): http://192.168.1.23:8000   <-- buka / scan QR dari alamat ini
   ```
3. **Peserta**: Host membuat kuis → halaman *Waiting Room* menampilkan **QR code**. Peserta memindainya dengan
   kamera HP, mengisi nama + departemen, dan masuk. (Atau buka alamat di atas dan ketik kode room 4 huruf.)
4. **Host / Admin**: buka alamat yang sama di HP, tekan *Masuk Sebagai Host / Admin*.

Akun bawaan: `admin` / `admin123` (**segera ganti**, lihat bagian Keamanan).

> QR code berisi alamat **jaringan** (`http://192.168.x.x:8000/?room=ABCD`), bukan `localhost`, walaupun
> Host membuka halaman lewat `localhost`. Di HP, `localhost` berarti HP itu sendiri.

### HP tidak bisa membuka alamatnya?

| Gejala | Penyebab & solusi |
| --- | --- |
| Halaman tidak mau terbuka di HP, di komputer bisa | **Windows Firewall.** Saat server pertama kali jalan, Windows menampilkan "Allow access". Klik **Allow** untuk *Private networks*. Jika terlewat: buka Command Prompt **sebagai Administrator**, jalankan `netsh advfirewall firewall add rule name="Quiz Platform" dir=in action=allow protocol=TCP localport=8000 profile=private` |
| Tetap tidak bisa | Router mengaktifkan **AP / Client Isolation** (sering di WiFi tamu). Matikan, atau pakai WiFi lain. |
| Alamat IP di jendela server berbeda dengan IP WiFi | Komputer punya beberapa jaringan (VirtualBox, WSL, VPN). Di Waiting Room, pilih alamat yang sesuai pada dropdown di bawah QR. |
| Di Waiting Room muncul peringatan "alamat jaringan tidak terdeteksi" | Komputer belum tersambung ke WiFi/LAN. Sambungkan, lalu buka ulang Host Portal. |
| Ingin peserta di luar jaringan (rumah / kantor lain) | Pakai tunnel (ngrok, Cloudflare Tunnel) lalu isi `PUBLIC_URL=https://alamat-tunnel` di `.env`. |

---

## 3. Pengaturan (`.env`)

Semua opsional. Salin `.env.example` menjadi `.env` lalu ubah yang diperlukan.

| Variabel | Bawaan | Keterangan |
| --- | --- | --- |
| `APP_PORT` | `8000` | Port server |
| `APP_HOST` | `0.0.0.0` | `127.0.0.1` = hanya komputer ini |
| `PUBLIC_URL` | kosong | Alamat publik (domain/tunnel) untuk QR code |
| `DATABASE_URL` | kosong | Isi untuk memakai PostgreSQL (mis. `postgresql://user:pass@localhost:5432/quizdb`) |
| `DB_BACKEND` | `auto` | `sqlite` = paksa SQLite |
| `SQLITE_FILE` | `quizdb.db` | Lokasi file SQLite (relatif terhadap folder proyek) |
| `GEMINI_API_KEY` | kosong | Aktifkan koreksi essay oleh AI |
| `GEMINI_MODEL` | `gemini-flash-latest` | Model Gemini. (Model lama `gemini-1.5-flash` sudah dimatikan Google.) |

---

## 4. Database

- **SQLite** (bawaan): file `quizdb.db`, tanpa instalasi. Jika PostgreSQL tidak terjangkau, aplikasi otomatis memakai SQLite.
- **PostgreSQL** (opsional): isi `DATABASE_URL`. Database dibuat otomatis jika belum ada.
- Semua waktu disimpan dalam **UTC** dan ditampilkan sesuai zona waktu perangkat.
- Database lama otomatis dimigrasi saat server start (menambah kolom `rooms.started_at` dan `participants.token`).

> `quizdb.db` ikut ter-commit di repositori ini dan berisi akun + soal Anda. Sebaiknya jangan dibagikan; lepaskan
> dari Git dengan `git rm --cached quizdb.db` lalu tambahkan `quizdb.db` ke `.gitignore`.

---

## 5. Pemecahan masalah

| Masalah | Solusi |
| --- | --- |
| Jendela hitam langsung menutup | Buka **Command Prompt**, ketik `cd` ke folder proyek lalu `run_server.bat` agar pesan error tetap terlihat. File ini selalu berhenti dengan `pause`, jadi biasanya pesan sudah terbaca. |
| "Python 3.10 atau lebih baru tidak ditemukan" | Pasang Python dari python.org dan centang **Add python.exe to PATH**. (Jika Microsoft Store terbuka saat mengetik `python`, itu bukan Python asli.) |
| Gagal memasang library | Pastikan internet aktif lalu jalankan lagi. Kegagalan `psycopg2-binary` (khusus PostgreSQL) diabaikan otomatis: aplikasi tetap jalan dengan SQLite. |
| "Port 8000 sedang dipakai" | Otomatis pindah ke port berikutnya (lihat alamat di jendela). Atau tutup server lama. |
| Tampilan HP berantakan | Seharusnya tidak terjadi walau tanpa internet. Jika menambah class Tailwind baru, jalankan ulang build CSS (bagian 6). |
| Tombol PDF gagal | Modul PDF diunduh dari internet saat dibutuhkan. Pastikan perangkat online. |
| Soal essay tidak dinilai AI | Isi `GEMINI_API_KEY`. Tanpa itu dipakai pencocokan kata kunci sederhana. |

---

## 6. Pengembangan

```bash
pip install -r requirements-dev.txt
python -m pytest tests            # tes API, SQLite, WebSocket, run_server.bat, frontend statis
```

Tes memakai database sementara (tidak menyentuh `quizdb.db`). Untuk menguji PostgreSQL:
`TEST_DATABASE_URL=postgresql://user:pass@localhost/quiztest python -m pytest tests`.

**Build CSS lokal.** Halaman memuat `static/css/tailwind.local.css`, yaitu Tailwind 2.2.19 yang hanya berisi class
yang dipakai (sekitar 10 KB) agar tampilan benar tanpa internet. Setelah menambah class Tailwind baru di HTML/JS:

```bash
cd tools/tailwind
npm install
npm run build
```

(`tests/test_static_assets.py` akan gagal dan memberi tahu jika ada class yang belum ter-build.)

### Struktur proyek

```
run_server.bat      peluncur Windows (CRLF, ASCII)
run_server.py       peluncur lintas platform: dependency, port, alamat HP, buka browser
app.py              FastAPI: REST + WebSocket + file statis
database.py         SQLite / PostgreSQL (satu set fungsi)
netutils.py         deteksi IP jaringan
static/             index (peserta+login), client, host, admin, js/, css/, vendor/
tests/              pytest
tools/tailwind/     build CSS lokal
```

---

## 7. Keamanan (baca sebelum dipakai di jaringan umum)

Aplikasi ini ditujukan untuk jaringan internal yang dipercaya (ruang training / kantor). Catatan:

- Akun bawaan `admin` / `admin123`. **Ganti passwordnya.**
- Password disimpan apa adanya (belum di-hash).
- Halaman Host/Admin dijaga di sisi browser; endpoint API belum memakai token sesi di server. Peserta yang paham
  teknis bisa memanggil API Host secara langsung.
- Form pendaftaran di halaman utama membolehkan siapa pun mendaftar sebagai Host/Admin.
- Kunci jawaban ikut terkirim ke browser peserta saat kuis berjalan (dipakai untuk halaman review).

Jika aplikasi akan dibuka ke internet, tambahkan autentikasi berbasis token + hash password terlebih dahulu.
