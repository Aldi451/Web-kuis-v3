// js/landing.js - halaman utama: gabung kuis (peserta) + login / daftar (Host & Admin)
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

  // ───────────── Gabung sebagai peserta ─────────────

  const roomInput = $('join-room-code');
  const nameInput = $('join-name');
  const deptInput = $('join-department');

  roomInput.addEventListener('input', () => {
    // Kode room hanya huruf/angka (HP sering menyisipkan spasi saat paste / autocorrect)
    const cleaned = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned !== roomInput.value) roomInput.value = cleaned;
  });

  // QR code mengarah ke  /?room=KODE  -> isi otomatis
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  if (roomFromUrl) {
    roomInput.value = roomFromUrl;
    $('join-room-hint').classList.remove('hidden');
    // Pindahkan fokus ke kolom berikutnya yang masih kosong
    setTimeout(() => (nameInput.value ? deptInput : nameInput).focus({ preventScroll: false }), 150);
  }

  // Sesi sebelumnya (halaman kuis tertutup / ter-refresh)
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

  $('form-join').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('join-error');

    const roomCode = roomInput.value.trim().toUpperCase();
    const name = nameInput.value.trim().replace(/\s+/g, ' ');
    const department = deptInput.value.trim().replace(/\s+/g, ' ');

    if (!roomCode || !name || !department) {
      showError('join-error', 'Mohon masukkan Kode Room, Nama, dan Departemen Anda!');
      (!roomCode ? roomInput : !name ? nameInput : deptInput).focus();
      return;
    }

    const button = $('btn-join-room');
    window.UI.setBusy(button, true, 'Memeriksa room...');
    try {
      const room = await window.API.getRoom(roomCode);

      const savedSession = localStorage.getItem('client_room_code') === room.id;
      if (room.status === 'Finished' && !savedSession) {
        showError('join-error', 'Kuis di room ini sudah selesai!');
        return;
      }

      // Save selection to localStorage and redirect to client.html
      localStorage.setItem('client_room_code', roomCode);
      localStorage.setItem('client_room_id', room.id);
      localStorage.setItem('client_participant_name', name);
      localStorage.setItem('client_department', department);

      window.location.href = 'client.html';
    } catch (err) {
      if (err.status === 404) {
        showError('join-error', `Room "${roomCode}" tidak ditemukan. Periksa lagi kodenya.`);
      } else {
        showError('join-error', err.message);
      }
    } finally {
      window.UI.setBusy(button, false);
    }
  });

  // ───────────── Login & daftar (Host / Admin) ─────────────

  const loginModal = $('login-modal');
  const loginSection = $('login-section');
  const registerSection = $('register-section');

  function openModal() {
    loginModal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    showLoginView();
  }
  function closeModal() {
    loginModal.classList.add('hidden');
    document.body.classList.remove('modal-open');
    $('btn-show-login').focus();
  }
  function showLoginView() {
    clearError('login-error');
    loginSection.classList.remove('hidden');
    registerSection.classList.add('hidden');
    setTimeout(() => $('login-username').focus(), 50);
  }
  function showRegisterView() {
    clearError('register-error');
    loginSection.classList.add('hidden');
    registerSection.classList.remove('hidden');
    setTimeout(() => $('register-username').focus(), 50);
  }

  $('btn-show-login').addEventListener('click', openModal);
  $('btn-close-login').addEventListener('click', closeModal);
  $('btn-close-register').addEventListener('click', closeModal);
  loginModal.addEventListener('click', (e) => { if (e.target === loginModal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !loginModal.classList.contains('hidden') && !document.querySelector('.ui-modal-backdrop')) {
      closeModal();
    }
  });
  $('link-show-register').addEventListener('click', (e) => { e.preventDefault(); showRegisterView(); });
  $('link-show-login').addEventListener('click', (e) => { e.preventDefault(); showLoginView(); });

  // Tombol "LIHAT / SEMBUNYIKAN" password (membantu mengetik di keyboard HP yang kecil)
  document.querySelectorAll('[data-toggle-password]').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const input = $(toggle.getAttribute('data-toggle-password'));
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'SEMBUNYI' : 'LIHAT';
      toggle.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
    });
  });

  // Handle Login
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
      if (user.role === 'Admin') {
        window.location.href = 'admin.html';
      } else if (user.role === 'Host') {
        window.location.href = 'host.html';
      } else {
        showError('login-error', 'Role akun tidak dikenali.');
        window.UI.setBusy(button, false);
      }
    } catch (err) {
      showError('login-error', err.message);
      window.UI.setBusy(button, false);
      $('login-password').select();
    }
  });

  // Handle Registration (Daftar Akun Baru)
  $('form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('register-error');
    const username = $('register-username').value.trim();
    const password = $('register-password').value;
    const role = $('register-role').value;

    if (!username || !password) {
      showError('register-error', 'Username dan password wajib diisi.');
      return;
    }

    const button = $('btn-register-submit');
    window.UI.setBusy(button, true, 'Mendaftarkan...');
    try {
      await window.API.register(username, password, role);
      window.UI.toast('Akun berhasil didaftarkan! Silakan log in.', 'success');
      showLoginView();
      $('login-username').value = username;
      $('login-password').value = password;
      $('login-password').focus();
    } catch (err) {
      showError('register-error', 'Pendaftaran gagal: ' + err.message);
    } finally {
      window.UI.setBusy(button, false);
    }
  });
})();
