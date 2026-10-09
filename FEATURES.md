# Rincian Fitur Quiz Platform V3

Quiz Platform V3 adalah aplikasi kuis *real-time* berbasis web yang menggunakan **FastAPI** di sisi *backend*. Database bawaan adalah **SQLite** (`quizdb.db`, tanpa instalasi apa pun); **PostgreSQL** bisa dipakai sebagai alternatif cukup dengan mengisi `DATABASE_URL` di `.env`. Semua interaksi *real-time* dibangun secara *native* menggunakan *WebSockets*, tanpa bergantung pada layanan eksternal pihak ketiga (seperti Supabase). Aplikasi dirancang agar nyaman dipakai di **HP** (lihat bagian 7).

## 1. Autentikasi & Manajemen Pengguna (Role-Based: Admin / Host / Member)
Aplikasi mendukung tiga *role* dengan akses ke fitur spesifik:
- **Halaman awal = login saja**: halaman utama (`index.html`) hanya menampilkan form login — tidak ada lagi form "gabung langsung" atau daftar mandiri. Semua akses berawal dari login sebagai **Host**, **Member** (peserta), atau **Admin**.
- **Role Member (peserta terdaftar)**: Admin (atau Host lewat form cepat di halaman buat kuis) membuat akun Member. Member login lalu **scan barcode room** (atau ketik kode room di portal member) untuk mengerjakan kuis. Login mengembalikan **token sesi** yang menghubungkan peserta yang scan dengan akunnya (dipakai untuk roster, level, dan anti-nyontek).
- **Admin Dashboard — akses penuh**: Admin mengelola seluruh pengguna (lihat **User ID**, username, role; tambah Host/Admin/Member; hapus — sesi login & roster ikut dibersihkan) **dan** seluruh kuis (bank soal, buat kuis, monitoring, riwayat/laporan) lewat Dashboard Kuis.
- **Role Permissions**: Halaman Host/Admin dijaga oleh utilitas frontend (`Auth.requireRole()`). Catatan: API backend belum memakai token sesi di sisi server (lihat bagian *Keamanan* di `README.md`), jadi aplikasi cocok untuk jaringan internal yang dipercaya.
- **Login ramah HP**: username tidak peka huruf besar/kecil saat login (keyboard HP sering mengkapitalkan huruf pertama), kolom login memakai atribut `autocapitalize`/`autocorrect` yang benar, ada tombol lihat/sembunyikan password, dan pesan error tampil di dalam form.

## 2. Bank Soal Terpusat (Question Bank)
- **Manajemen Soal (CRUD)**: Host dapat menambah, mengedit, melihat, dan menghapus soal kuis.
- **Import Soal dari Excel (.xlsx)**: Host/Admin mengimpor banyak soal sekaligus dari file Excel — jauh lebih cepat daripada mengetik satu per satu. Kolom: Pertanyaan, Pilihan A–D, Kunci Jawaban, Kategori, Tipe (mcq/essay), Level. Baris bermasalah dilaporkan (nomor baris + alasan) dan tidak di-import; soal valid langsung masuk bank soal.
- **Download Template Excel**: tombol *Template Excel* mengunduh file `.xlsx` berisi judul kolom + contoh soal + sheet *Petunjuk*, sehingga Admin/Host tahu persis cara pengisiannya.
- **Kategorisasi**: Soal kuis dapat difilter berdasarkan "Kategori" tertentu (misal: Umum, IT, HR).
- **Level Soal (Easy / Normal / Hard)**: level tiap soal **ditentukan Host/Admin** saat menambah atau mengubah soal (bawaan Normal). Bank Soal menampilkan badge level, rekap jumlah soal per level, dan filter level. Soal yang sudah ada sebelum fitur ini otomatis berlevel Normal.
- **Dinamis & Fleksibel**: Pilihan ganda didesain dinamis dengan 4 opsi (A, B, C, D) dengan satu pilihan benar.

## 3. Manajemen Ruang Kuis (Room Management)
- **Pembuatan Kuis Kustom**: Host dapat merancang kuis dengan memilih kumpulan soal dari Bank Soal, menentukan durasi waktu (dalam menit), dan menetapkan Nilai Kelulusan (Passing Grade).
- **Soal Acak Berbeda untuk Tiap Peserta**: saat membuat kuis, Host mencentang soal sebagai bahan soal lalu memilih cara pembagiannya:
  - **Acak berbeda untuk tiap peserta** (bawaan): Host menentukan **jumlah soal per level** untuk setiap peserta, mis. 3 Easy + 3 Normal + 2 Hard. Begitu peserta memindai QR dan bergabung, server mengundi soalnya secara acak dari soal terpilih (urutannya juga diacak) dan berusaha agar tidak ada dua peserta dengan kombinasi soal yang sama. Hasil undian disimpan, jadi refresh/lanjut sesi tetap mendapat soal yang sama. Untuk kuis khusus level tertentu (mis. Hard saja), isi jumlah 0 pada level lain.
  - **Sama untuk semua peserta**: semua peserta mengerjakan soal terpilih dengan urutan yang sama (perilaku lama).
  - Layar pembuatan kuis memberi tahu jumlah soal tersedia per level dan seberapa bervariasi soal antar peserta (jika jumlah per level sama dengan soal yang dicentang, semua peserta akan mendapat soal yang sama dan Host diperingatkan).
- **Roster Member & Level per Peserta**: saat membuat kuis, Host/Admin memilih akun **Member** yang ikut kuis ini dan **level** untuk masing-masing (Easy/Normal/Hard). Level roster dipakai saat member scan: soal yang muncul diundi dari level tersebut. Roster bisa diubah lagi di Waiting Room selama kuis belum dimulai. Jika roster kosong, semua peserta bisa gabung; jika terisi, hanya member terdaftar yang bisa gabung (peserta tanpa akun ditolak dengan pesan jelas).
- **Room Code & QR Code (link & barcode sesi)**: Setiap kuis *generate* kode ruang unik 4 huruf. Saat Host/Admin **siap memulai pertanyaan**, halaman Waiting Room menampilkan **link yang sudah digenerate + QR code (barcode)** yang bisa langsung di-scan; link & barcode yang sama juga tampil di layar Monitoring selama kuis berjalan. QR code berisi alamat **jaringan** komputer host (mis. `http://192.168.1.10:8000/?room=ABCD`), bukan `localhost`, sehingga bisa dipindai dari HP. Member yang scan (login lebih dulu) langsung masuk dengan kode room terisi otomatis — termasuk saat kuis **sudah berjalan** (member roster boleh menyusul; soalnya langsung diundi). Tersedia tombol *Salin Link* / *Bagikan* dan pilihan alamat jika komputer host punya beberapa jaringan.
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
- **Level per Member terlihat**: Waiting Room member menampilkan badge level yang ditetapkan Host — peserta tahu bahwa soalnya diacak khusus untuknya dari level tersebut.

## 4b. Anti-Nyontek (Soal Acak per Level & Tidak Berulang)
- **Level dari roster member**: level soal seorang member diambil dari level yang dipilih Host saat membuat kuis (bukan dari level soal campuran) — contoh: Budi level Easy, Ani level Hard.
- **Undian diutamakan non-tumpang-tindih**: dalam satu room, kombinasi soal antar peserta diutamakan yang **tidak tumpang tindih sama sekali** (anti contek antar peserta); jika pool tidak memungkinkan, minimal dijamin tidak sama persis.
- **Tidak mengulang soal yang pernah dikerjakan**: setiap soal yang pernah ditugaskan ke sebuah akun Member dicatat (lintas semua kuis). Saat member ikut kuis berikutnya, soal-soal itu tidak diundi lagi — walau tema pembahasannya mirip/sama. Pengecualian hanya jika soal baru yang belum pernah dilihat tidak mencukupi jumlahnya (maka soal lama baru dipakai lagi), dan pencatatannya tetap menutup celah keluar–gabung ulang (leave/rejoin tidak mereset riwayat soal).

## 5. Pengerjaan Kuis Klien (Client Interface)
- **Interface Intuitif**: UI kuis bersih dan tidak memecah konsentrasi. Soal dan pilihan ganda ditampilkan secara dinamis tanpa jeda pindah halaman (*Single Page Application*).
- **Level terlihat**: setiap soal menampilkan badge level (Easy / Normal / Hard), dan waiting room memberi tahu jumlah soal untuk peserta tersebut.
- **Live Timer**: Waktu pengerjaan berjalan mundur berdasarkan **batas waktu dari server**, bukan hitungan lokal, sehingga adil untuk semua peserta, tetap akurat walau layar HP terkunci, dan tidak terpengaruh jam HP yang salah. Saat waktu mendekati habis, UI memberikan notifikasi berkedip. Apabila durasi kuis habis, sistem klien otomatis melakukan *submit* dan mengunci layar kuis.
- **Auto-Finalize Score**: Backend secara otomatis membandingkan jawaban klien dengan kunci di *Question Bank*, menghitung skor (0-100), dan menentukan kelulusan berdasarkan *Passing Grade*. Penilaian selalu dihitung ulang di server, hanya soal milik peserta itu yang dihitung (di room acak, soal peserta lain tidak ikut dihitung), dan pengiriman ulang tidak mengubah nilai. Skor = benar dibagi jumlah soal peserta itu; semua peserta di satu room mengerjakan jumlah soal yang sama.
- **Koreksi Essay**: soal essay dinilai oleh AI Gemini jika `GEMINI_API_KEY` diisi (model dapat diatur lewat `GEMINI_MODEL`, bawaan `gemini-flash-latest`); tanpa kunci API dipakai pencocokan kata kunci sederhana.

## 6. Laporan, Riwayat, dan Cetak PDF (Analytics & Reporting)
- **Quiz History Dashboard**: Kuis yang telah selesai (*Finished*) otomatis direkam dalam tabel riwayat beserta ringkasan keseluruhan (rata-rata skor, jumlah lulus, dan jumlah gagal).
- **Review Jawaban (Peserta)**: Di akhir kuis, peserta disajikan ringkasan hasil mereka. Klien dapat melihat kunci jawaban yang benar dan evaluasi setiap nomor (Benar/Salah), lengkap dengan level soal dan rekap benar/total per level (mis. Easy 3/3, Normal 2/3, Hard 1/2).
- **Generate Laporan Peserta (PDF)**: Peserta dapat mengunduh rapor mereka sendiri (*Review Jawaban*) dalam format PDF berkualitas tinggi. PDF dirender pada lebar kertas A4 yang tetap sehingga hasilnya sama di HP maupun desktop.
- **Susunan soal di laporan**: laporan HRD memuat baris *Question Set* (mis. "Acak berbeda per peserta: 2 Easy + 2 Normal + 2 Hard = 6 soal/peserta") sebagai bukti cara soal dibagikan.
- **Generate Laporan HRD (PDF)**: Host dapat mengunduh laporan asesmen *batch* seluruh peserta dalam satu kuis beserta parameter lengkap (Nama, Departemen, Skor, Tanggal). Peserta yang tidak pernah mengirim jawaban ditandai *TIDAK SUBMIT*. Ini sangat efisien untuk rekapitulasi data HRD/Training.
- Modul PDF (html2pdf.js) diunduh hanya saat tombol PDF ditekan, jadi tidak membebani HP peserta yang tidak membutuhkannya (membutuhkan internet).

## 7. Dukungan HP (Mobile)
Peserta (Member), Host, dan Admin semua bisa memakai HP. Yang disiapkan khusus untuk HP:
- **Bisa dibuka dari HP**: server berjalan di `0.0.0.0` dan menampilkan alamat jaringan di jendela server. QR code memakai alamat tersebut.
- **Alur Member di HP**: scan barcode room → halaman login terbuka (`/?room=KODE`) → login sebagai Member → otomatis diarahkan gabung ke kuis (portal member juga bisa dipakai untuk mengetik kode room manual). Jika sudah login, hasil scan langsung masuk tanpa form tambahan.
- **Tata letak responsif & ramah jari**: tombol minimal 44 px, input 16 px (iOS tidak memperbesar halaman sendiri), `100dvh` dan *safe-area* untuk HP berponi, tabel berubah menjadi kartu di layar sempit, menu Host menjadi bilah atas yang bisa digeser, modal muncul sebagai lembar dari bawah.
- **Layar kuis**: header + timer dan tombol navigasi menempel (sticky) di atas/bawah layar, navigator nomor soal (hijau = sudah dijawab), dialog konfirmasi sebelum mengirim, serta tombol Back yang tidak sengaja ditekan tidak membuang peserta dari kuis.
- **Tahan refresh & restart browser**: peserta mendapat token sesi; setelah halaman ter-refresh atau browser dimatikan sistem, peserta otomatis melanjutkan (jawaban, nomor soal, dan sisa waktu dipulihkan). Setelah selesai, refresh menampilkan hasil dari server.
- **Tahan sinyal putus**: WebSocket menyambung ulang otomatis dengan jeda bertahap + *heartbeat*; saat layar menyala lagi status room langsung disinkronkan; jika jaringan memblokir WebSocket, polling cadangan tetap memulai kuis. Jika pengiriman jawaban gagal, jawaban tetap tersimpan di HP dan dikirim ulang otomatis saat internet kembali.
- **Salah ketik nama?** Peserta bisa keluar dari waiting room dan bergabung ulang dengan nama yang benar.
- **Berfungsi tanpa internet di jaringan lokal**: QR code dan gaya Tailwind disimpan lokal (`static/vendor`, `static/css`), jadi halaman tetap tampil benar di WiFi tanpa internet. Hanya font cantik dan ekspor PDF yang membutuhkan internet.

---
**Teknologi Utama yang Digunakan**: FastAPI (Python), SQLite (bawaan) / PostgreSQL + Psycopg2 (opsional), Native WebSockets, HTML/JS/CSS (Tailwind 2.2.19: build lokal + CDN), html2pdf.js (Export PDF, dimuat saat dibutuhkan), qrcode.js (Generate QR, lokal), openpyxl (Import soal dari Excel .xlsx + template).
