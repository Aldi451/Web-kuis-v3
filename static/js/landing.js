// js/landing.js - halaman utama: HANYA login (Host / Member / Admin) + lanjutkan sesi kuis lama.
//
// Alur barcode: Host menampilkan link & QR room -> Member scan -> halaman ini terbuka (?room=KODE)
// -> login sebagai Member -> otomatis diarahkan untuk bergabung ke room kuis tersebut.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function showError(id, message) {
    const box = $(id);
    box.textContent = message;
    box.classList.remove('hidden');
  }
  function clearError(id) {
    const box = $(id);
    box.textContent = '';
    box.classList.add('hidden');
  }

  // Kode room dari barcode (link /?room=KODE)
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  if (roomFromUrl) {
    $('room-hint-code').textContent = roomFromUrl;
    $('room-hint').classList.remove('hidden');
  }

  // ───────────── Arahkan sesuai role setelah login ─────────────
  function homeFor(user) {
    if (user.role === 'Admin') return 'admin.html';
    if (user.role === 'Host') return 'host.html';
    // Member: jika hasil scan barcode, langsung siapkan untuk gabung ke room itu
    return roomFromUrl ? `member.html?room=${encodeURIComponent(roomFromUrl)}` : 'member.html';
  }

  // Sudah login? Langsung ke portalnya (tidak perlu isi form lagi).
  // Kecuali ada pesan flash (mis. akses ditolak karena salah role) -> tampilkan dulu di halaman login.
  let pendingFlash = null;
  try { pendingFlash = sessionStorage.getItem('flash_message'); } catch (e) { /* mode privat */ }
  const currentUser = window.Auth.getCurrentUser();
  if (currentUser && currentUser.role && !pendingFlash) {
    if (currentUser.role === 'Member' && !roomFromUrl && localStorage.getItem('client_room_code')) {
      // Member dengan sesi kuis tersimpan -> lanjutkan kuisnya
      window.location.replace('client.html');
    } else {
      window.location.replace(homeFor(currentUser));
    }
    return;
  }

  // ───────────── Lanjutkan sesi kuis (halaman kuis tertutup / ter-refresh di HP) ─────────────
  async function setupResumeCard() {
    const savedCode = localStorage.getItem('client_room_code');
    const savedName = localStorage.getItem('client_participant_name');
    if (!savedCode || !savedName) return;
    if (roomFromUrl && roomFromUrl !== savedCode) return; // sedang membuka QR room lain

    try {
      const room = await window.API.getRoom(savedCode);
      $('resume-room').textContent = room.room_code;
      $('resume-name').textContent = savedName;
      $('btn-resume').textContent = room.status === 'Finished' ? 'Lihat Hasil' : 'Lanjutkan';
      $('resume-card').classList.remove('hidden');
    } catch (err) {
      if (err.status === 404) clearSavedSession(); // room sudah tidak ada -> buang sesi basi
    }
  }

  function clearSavedSession() {
    ['client_room_code', 'client_room_id', 'client_participant_name', 'client_department', 'client_session_v2']
      .forEach((key) => localStorage.removeItem(key));
  }

  $('btn-resume').addEventListener('click', () => { window.location.href = 'client.html'; });
  $('btn-resume-clear').addEventListener('click', async () => {
    const ok = await window.UI.confirm({
      title: 'Keluar dari sesi ini?',
      message: 'Jawaban yang tersimpan di HP ini akan dihapus dan kamu tidak bisa melanjutkan kuis yang sedang berjalan.',
      confirmText: 'Keluar', cancelText: 'Batal', danger: true
    });
    if (!ok) return;
    clearSavedSession();
    $('resume-card').classList.add('hidden');
  });
  setupResumeCard();

  // ───────────── Tombol "LIHAT / SEMBUNYIKAN" password (membantu mengetik di keyboard HP yang kecil) ─────────────
  document.querySelectorAll('[data-toggle-password]').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const input = $(toggle.getAttribute('data-toggle-password'));
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'SEMBUNYI' : 'LIHAT';
      toggle.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
    });
  });

  // ───────────── Login (Host / Member / Admin) ─────────────
  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('login-error');
    const userVal = $('login-username').value.trim();
    const passVal = $('login-password').value;
    if (!userVal || !passVal) {
      showError('login-error', 'Username dan password wajib diisi.');
      return;
    }

    const button = $('btn-login-submit');
    window.UI.setBusy(button, true, 'Memeriksa...');
    try {
      const user = await window.Auth.login(userVal, passVal);
      window.location.href = homeFor(user);
    } catch (err) {
      showError('login-error', err.message);
      window.UI.setBusy(button, false);
      $('login-password').select();
    }
  });
})();
