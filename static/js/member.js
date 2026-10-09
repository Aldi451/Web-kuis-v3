// js/member.js - portal Member (peserta): gabung kuis dengan kode room (hasil scan barcode Host).
//
// Member login dari halaman utama. Setelah login, member bisa:
//   * scan barcode room (link /?room=KODE -> otomatis diarahkan ke halaman ini lalu join), atau
//   * mengetik kode room langsung di sini.
// Saat join, token sesi login dikirim ke server sehingga soal yang muncul diacak sesuai level
// yang ditetapkan Host untuk member ini (anti-nyontek: soal antar member tidak sama dan soal yang
// pernah dikerjakan tidak diulang).
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function showError(message) {
    const box = $('member-join-error');
    box.textContent = message;
    box.classList.remove('hidden');
  }
  function clearError() {
    const box = $('member-join-error');
    box.textContent = '';
    box.classList.add('hidden');
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Halaman ini hanya untuk Member
    const user = window.Auth.requireRole(['Member']);
    $('member-username').textContent = user.username;

    const roomInput = $('member-room-code');

    // Kode room hanya huruf/angka (HP sering menyisipkan spasi saat paste / autocorrect)
    roomInput.addEventListener('input', () => {
      const cleaned = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (cleaned !== roomInput.value) roomInput.value = cleaned;
    });

    // Barcode: link /?room=KODE -> kode terisi otomatis
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    if (roomFromUrl) {
      roomInput.value = roomFromUrl;
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

    // ───────────── Gabung ke room ─────────────
    async function joinRoom() {
      clearError();
      const roomCode = roomInput.value.trim().toUpperCase();
      if (!roomCode) {
        showError('Masukkan kode room dari barcode Host.');
        roomInput.focus();
        return;
      }

      const button = $('btn-member-join');
      window.UI.setBusy(button, true, 'Memeriksa room...');
      try {
        const room = await window.API.getRoom(roomCode);

        const savedSession = localStorage.getItem('client_room_code') === room.id;
        if (room.status === 'Finished' && !savedSession) {
          showError('Kuis di room ini sudah selesai!');
          return;
        }

        // Simpan sesi peserta (client.html yang membuka waiting room / kuis) lalu pindah halaman.
        // Nama peserta = username akun Member (dipakai server untuk menghubungkan ke akun ini).
        localStorage.setItem('client_room_code', room.room_code);
        localStorage.setItem('client_room_id', room.id);
        localStorage.setItem('client_participant_name', user.username);
        localStorage.setItem('client_department', '-');

        window.location.href = 'client.html';
      } catch (err) {
        if (err.status === 404) {
          showError(`Room "${roomCode}" tidak ditemukan. Periksa lagi kode pada barcode Host.`);
        } else {
          showError(err.message);
        }
      } finally {
        window.UI.setBusy(button, false);
      }
    }

    $('form-member-join').addEventListener('submit', (e) => {
      e.preventDefault();
      joinRoom();
    });

    $('btn-logout').addEventListener('click', () => window.Auth.logout());

    // Scan barcode -> join otomatis tanpa perlu menekan tombol
    if (roomFromUrl) {
      joinRoom();
    } else {
      setTimeout(() => roomInput.focus({ preventScroll: false }), 150);
    }
  });
})();
