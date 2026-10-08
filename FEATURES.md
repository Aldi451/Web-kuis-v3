# Rincian Fitur Quiz Platform V3

Quiz Platform V3 adalah aplikasi kuis *real-time* berbasis web yang menggunakan **FastAPI** di sisi *backend*. Database bawaan adalah **SQLite** (`quizdb.db`, tanpa instalasi apa pun); **PostgreSQL** bisa dipakai sebagai alternatif cukup dengan mengisi `DATABASE_URL` di `.env`. Semua interaksi *real-time* dibangun secara *native* menggunakan *WebSockets*, tanpa bergantung pada layanan eksternal pihak ketiga (seperti Supabase). Aplikasi dirancang agar nyaman dipakai di **HP** (lihat bagian 7).

## 1. Autentikasi & Manajemen Pengguna (Role-Based)
Aplikasi mendukung multi-level *role* dengan akses ke fitur spesifik:
- **Login / Register**: Pengguna dapat masuk dan mendaftar dengan *role* tertentu (Admin atau Host).
- **Admin Dashboard**: Admin dapat mengelola (*create, read, delete*) daftar semua pengguna (Host/Admin lain) di dalam sistem.
- **Role Permissions**: Halaman Host/Admin dijaga oleh utilitas frontend (`Auth.requireRole()`). Catatan: API backend belum memakai token sesi di sisi server (lihat bagian *Keamanan* di `README.md`), jadi aplikasi cocok untuk jaringan internal yang dipercaya.
- **Login ramah HP**: username tidak peka huruf besar/kecil saat login (keyboard HP sering mengkapitalkan huruf pertama), kolom login memakai atribut `autocapitalize`/`autocorrect` yang benar, ada tombol lihat/sembunyikan password, dan pesan error tampil di dalam form.

## 2. Bank Soal Terpusat (Question Bank)
- **Manajemen Soal (CRUD)**: Host dapat menambah, mengedit, melihat, dan menghapus soal kuis.
- **Kategorisasi**: Soal kuis dapat difilter berdasarkan "Kategori" tertentu (misal: Umum, IT, HR).
- **Dinamis & Fleksibel**: Pilihan ganda didesain dinamis dengan 4 opsi (A, B, C, D) dengan satu pilihan benar.

## 3. Manajemen Ruang Kuis (Room Management)
- **Pembuatan Kuis Kustom**: Host dapat merancang kuis dengan memilih kumpulan soal dari Bank Soal, menentukan durasi waktu (dalam menit), dan menetapkan Nilai Kelulusan (Passing Grade).
- **Room Code & QR Code**: Setiap kuis *generate* kode ruang unik 4 huruf dan mencetak QR code secara otomatis. QR code berisi alamat **jaringan** komputer host (mis. `http://192.168.1.10:8000/?room=ABCD`), bukan `localhost`, sehingga bisa dipindai dari HP. Peserta yang memindai langsung masuk dengan kode room terisi otomatis. Tersedia tombol *Salin Link* / *Bagikan* dan pilihan alamat jika komputer host punya beberapa jaringan.
- **Room dipulihkan**: jika halaman Host di-refresh atau browser ditutup, room yang belum selesai dibuka kembali otomatis. Room yang tidak jadi dipakai bisa dibatalkan lewat tombol *Batalkan room*.
- **Siklus Status Kuis**: Room memiliki 3 transisi status terpadu:
  - `Waiting` : Menunggu peserta masuk.
  - `On Progress`: Kuis sedang berjalan.
  - `Finished` : Kuis telah selesai dan ditutup.

## 4. Partisipasi Kuis *Real-Time* (Client & Host Monitoring)
Fungsionalitas ini dipersenjatai oleh **WebSockets** asli (`app.py`), menghasilkan interaksi dua arah. WebSocket menyambung ulang otomatis (HP terkunci / sinyal putus) dan ada *polling* ringan sebagai cadangan jika jaringan memblokir WebSocket.
- **Waiting Room Live Update**: Saat peserta baru (Klien) memasukkan kode room dan bergabung, nama mereka langsung muncul di layar proyektor Host tanpa perlu memuat ulang (*refresh*).
- **Auto-Sync Kuis Dimulai**: Ketika Host menekan "Mulai Kuis", layar *Waiting Room* peserta secara otomatis berubah menjadi lembar pengerjaan kuis.
- **Live Leaderboard & Progress Monitoring**: Setiap peserta yang menjawab soal dan menekan "Submit" akan tercermin pada halaman Monitor Kuis di sisi Host secara seketika (*real-time*). Host bisa melihat siapa yang sudah selesai, jumlah skor, dan status kelulusan (PASS/FAIL).

## 5. Pengerjaan Kuis Klien (Client Interface)
- **Interface Intuitif**: UI kuis bersih dan tidak memecah konsentrasi. Soal dan pilihan ganda ditampilkan secara dinamis tanpa jeda pindah halaman (*Single Page Application*).
- **Live Timer**: Waktu pengerjaan berjalan mundur berdasarkan **batas waktu dari server**, bukan hitungan lokal, sehingga adil untuk semua peserta, tetap akurat walau layar HP terkunci, dan tidak terpengaruh jam HP yang salah. Saat waktu mendekati habis, UI memberikan notifikasi berkedip. Apabila durasi kuis habis, sistem klien otomatis melakukan *submit* dan mengunci layar kuis.
- **Auto-Finalize Score**: Backend secara otomatis membandingkan jawaban klien dengan kunci di *Question Bank*, menghitung skor (0-100), dan menentukan kelulusan berdasarkan *Passing Grade*. Penilaian selalu dihitung ulang di server, hanya soal milik room yang dihitung, dan pengiriman ulang tidak mengubah nilai.
- **Koreksi Essay**: soal essay dinilai oleh AI Gemini jika `GEMINI_API_KEY` diisi (model dapat diatur lewat `GEMINI_MODEL`, bawaan `gemini-flash-latest`); tanpa kunci API dipakai pencocokan kata kunci sederhana.

## 6. Laporan, Riwayat, dan Cetak PDF (Analytics & Reporting)
- **Quiz History Dashboard**: Kuis yang telah selesai (*Finished*) otomatis direkam dalam tabel riwayat beserta ringkasan keseluruhan (rata-rata skor, jumlah lulus, dan jumlah gagal).
- **Review Jawaban (Peserta)**: Di akhir kuis, peserta disajikan ringkasan hasil mereka. Klien dapat melihat kunci jawaban yang benar dan evaluasi setiap nomor (Benar/Salah).
- **Generate Laporan Peserta (PDF)**: Peserta dapat mengunduh rapor mereka sendiri (*Review Jawaban*) dalam format PDF berkualitas tinggi. PDF dirender pada lebar kertas A4 yang tetap sehingga hasilnya sama di HP maupun desktop.
- **Generate Laporan HRD (PDF)**: Host dapat mengunduh laporan asesmen *batch* seluruh peserta dalam satu kuis beserta parameter lengkap (Nama, Departemen, Skor, Tanggal). Peserta yang tidak pernah mengirim jawaban ditandai *TIDAK SUBMIT*. Ini sangat efisien untuk rekapitulasi data HRD/Training.
- Modul PDF (html2pdf.js) diunduh hanya saat tombol PDF ditekan, jadi tidak membebani HP peserta yang tidak membutuhkannya (membutuhkan internet).

## 7. Dukungan HP (Mobile)
Peserta, Host, dan Admin semua bisa memakai HP. Yang disiapkan khusus untuk HP:
- **Bisa dibuka dari HP**: server berjalan di `0.0.0.0` dan menampilkan alamat jaringan di jendela server. QR code memakai alamat tersebut.
- **Tata letak responsif & ramah jari**: tombol minimal 44 px, input 16 px (iOS tidak memperbesar halaman sendiri), `100dvh` dan *safe-area* untuk HP berponi, tabel berubah menjadi kartu di layar sempit, menu Host menjadi bilah atas yang bisa digeser, modal muncul sebagai lembar dari bawah.
- **Layar kuis**: header + timer dan tombol navigasi menempel (sticky) di atas/bawah layar, navigator nomor soal (hijau = sudah dijawab), dialog konfirmasi sebelum mengirim, serta tombol Back yang tidak sengaja ditekan tidak membuang peserta dari kuis.
- **Tahan refresh & restart browser**: peserta mendapat token sesi; setelah halaman ter-refresh atau browser dimatikan sistem, peserta otomatis melanjutkan (jawaban, nomor soal, dan sisa waktu dipulihkan). Setelah selesai, refresh menampilkan hasil dari server.
- **Tahan sinyal putus**: WebSocket menyambung ulang otomatis dengan jeda bertahap + *heartbeat*; saat layar menyala lagi status room langsung disinkronkan; jika jaringan memblokir WebSocket, polling cadangan tetap memulai kuis. Jika pengiriman jawaban gagal, jawaban tetap tersimpan di HP dan dikirim ulang otomatis saat internet kembali.
- **Salah ketik nama?** Peserta bisa keluar dari waiting room dan bergabung ulang dengan nama yang benar.
- **Berfungsi tanpa internet di jaringan lokal**: QR code dan gaya Tailwind disimpan lokal (`static/vendor`, `static/css`), jadi halaman tetap tampil benar di WiFi tanpa internet. Hanya font cantik dan ekspor PDF yang membutuhkan internet.

---
**Teknologi Utama yang Digunakan**: FastAPI (Python), SQLite (bawaan) / PostgreSQL + Psycopg2 (opsional), Native WebSockets, HTML/JS/CSS (Tailwind 2.2.19: build lokal + CDN), html2pdf.js (Export PDF, dimuat saat dibutuhkan), qrcode.js (Generate QR, lokal).
