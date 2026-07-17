# Rincian Fitur Quiz Platform V3

Quiz Platform V3 adalah aplikasi kuis *real-time* berbasis web yang menggunakan **FastAPI** di sisi *backend* dan **PostgreSQL** sebagai database utama. Semua interaksi *real-time* dibangun secara *native* menggunakan *WebSockets*, tanpa bergantung pada layanan eksternal pihak ketiga (seperti Supabase).

## 1. Autentikasi & Manajemen Pengguna (Role-Based)
Aplikasi mendukung multi-level *role* dengan akses ke fitur spesifik:
- **Login / Register**: Pengguna dapat masuk dan mendaftar dengan *role* tertentu (Admin atau Host).
- **Admin Dashboard**: Admin dapat mengelola (*create, read, delete*) daftar semua pengguna (Host/Admin lain) di dalam sistem.
- **Role Permissions**: Setiap aksi vital di-guard oleh utilitas frontend (`Auth.requireRole()`) dan API backend untuk memastikan hanya entitas yang berhak yang bisa membuat kuis atau mengakses halaman pengaturan.

## 2. Bank Soal Terpusat (Question Bank)
- **Manajemen Soal (CRUD)**: Host dapat menambah, mengedit, melihat, dan menghapus soal kuis.
- **Kategorisasi**: Soal kuis dapat difilter berdasarkan "Kategori" tertentu (misal: Umum, IT, HR).
- **Dinamis & Fleksibel**: Pilihan ganda didesain dinamis dengan 4 opsi (A, B, C, D) dengan satu pilihan benar.

## 3. Manajemen Ruang Kuis (Room Management)
- **Pembuatan Kuis Kustom**: Host dapat merancang kuis dengan memilih kumpulan soal dari Bank Soal, menentukan durasi waktu (dalam menit), dan menetapkan Nilai Kelulusan (Passing Grade).
- **Room Code & QR Code**: Setiap kuis *generate* kode ruang unik 6 karakter dan mencetak QR code secara otomatis. Peserta dapat memindai QR code ini untuk langsung masuk.
- **Siklus Status Kuis**: Room memiliki 3 transisi status terpadu:
  - `Waiting` : Menunggu peserta masuk.
  - `On Progress`: Kuis sedang berjalan.
  - `Finished` : Kuis telah selesai dan ditutup.

## 4. Partisipasi Kuis *Real-Time* (Client & Host Monitoring)
Fungsionalitas ini dipersenjatai oleh **WebSockets** asli (`app.py`), menghasilkan interaksi dua arah tanpa *polling* ke database.
- **Waiting Room Live Update**: Saat peserta baru (Klien) memasukkan kode room dan bergabung, nama mereka langsung muncul di layar proyektor Host tanpa perlu memuat ulang (*refresh*).
- **Auto-Sync Kuis Dimulai**: Ketika Host menekan "Mulai Kuis", layar *Waiting Room* peserta secara otomatis berubah menjadi lembar pengerjaan kuis.
- **Live Leaderboard & Progress Monitoring**: Setiap peserta yang menjawab soal dan menekan "Submit" akan tercermin pada halaman Monitor Kuis di sisi Host secara seketika (*real-time*). Host bisa melihat siapa yang sudah selesai, jumlah skor, dan status kelulusan (PASS/FAIL).

## 5. Pengerjaan Kuis Klien (Client Interface)
- **Interface Intuitif**: UI kuis bersih dan tidak memecah konsentrasi. Soal dan pilihan ganda ditampilkan secara dinamis tanpa jeda pindah halaman (*Single Page Application*).
- **Live Timer**: Waktu pengerjaan akan terus berjalan mundur. Saat waktu mendekati habis, UI memberikan notifikasi berkedip. Apabila durasi kuis (*Timer*) habis, maka sistem klien akan secara otomatis melakukan *submit* dan mengunci layar kuis.
- **Auto-Finalize Score**: Backend secara otomatis membandingkan jawaban klien dengan kunci di *Question Bank*, menghitung skor (1-100), dan menentukan kelulusan berdasarkan *Passing Grade*.

## 6. Laporan, Riwayat, dan Cetak PDF (Analytics & Reporting)
- **Quiz History Dashboard**: Kuis yang telah selesai (*Finished*) otomatis direkam dalam tabel riwayat beserta ringkasan keseluruhan (rata-rata skor, jumlah lulus, dan jumlah gagal).
- **Review Jawaban (Peserta)**: Di akhir kuis, peserta disajikan ringkasan hasil mereka. Klien dapat melihat kunci jawaban yang benar dan evaluasi setiap nomor (Benar/Salah).
- **Generate Laporan Peserta (PDF)**: Peserta dapat mengunduh rapor mereka sendiri (*Review Jawaban*) dalam format PDF berkualitas tinggi.
- **Generate Laporan HRD (PDF)**: Host dapat mengunduh laporan asesmen *batch* seluruh peserta dalam satu kuis beserta parameter lengkap (Nama, Departemen, Skor, Tanggal). Ini sangat efisien untuk rekapitulasi data HRD/Training.

---
**Teknologi Utama yang Digunakan**: FastAPI (Python), PostgreSQL + Psycopg2, Native WebSockets, HTML/JS/CSS (Tailwind UI styles), html2pdf.js (Export PDF), qrcode.js (Generate QR).
