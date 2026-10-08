// js/host.js - Dashboard Host: buat kuis (soal acak per level), waiting room (QR), monitoring realtime, riwayat & laporan PDF
//
// Catatan untuk Host yang memakai HP:
//   * room aktif disimpan & dipulihkan otomatis saat halaman di-refresh / browser ditutup
//   * QR code memakai alamat JARINGAN (mis. http://192.168.1.10:8000), bukan localhost
//   * daftar peserta/monitoring diperbarui lewat WebSocket + polling cadangan

const $ = (id) => document.getElementById(id);

let activeRoom = null;
let selectedRoomHistory = null;
let joinBases = [];            // alamat dasar yang bisa dibuka peserta (urutan pertama = terbaik)
let joinBaseIndex = 0;
let loopbackOnly = false;      // true jika tidak ada alamat jaringan yang terdeteksi
let hostPollTimer = null;
let countdownTimer = null;
let hostClockOffsetMs = 0;
let timeUpAnnounced = false;
const ACTIVE_ROOM_KEY = 'host_active_room';
// Level yang jumlahnya sudah diubah Host secara manual (yang belum diubah mengikuti saran otomatis)
const countTouched = { easy: false, normal: false, hard: false };

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

document.addEventListener('DOMContentLoaded', () => {
  // Guard page for Host role only
  const currentUser = window.Auth.requireRole(['Host', 'Admin']);
  setText('host-welcome', `${currentUser.username} (${currentUser.role})`);

  // Initialize Question Bank
  loadQuestionBank();
  loadHistoryList();

  // Create Quiz Event
  $('btn-generate-quiz').addEventListener('click', createQuizRoom);
  $('btn-generate-quiz-bottom').addEventListener('click', createQuizRoom);

  // Start / Finish Quiz Event
  $('btn-start-quiz').addEventListener('click', startQuiz);
  $('btn-finish-quiz').addEventListener('click', finishQuiz);
  $('btn-cancel-room').addEventListener('click', cancelRoom);

  // PDF Download Event
  $('btn-download-hrd-pdf').addEventListener('click', downloadHRDPDF);

  // Link peserta
  $('btn-copy-join').addEventListener('click', copyJoinLink);
  $('btn-share-join').addEventListener('click', shareJoinLink);
  $('join-url-select').addEventListener('change', (event) => {
    joinBaseIndex = Number(event.target.value) || 0;
    renderJoinInfo();
  });

  // Kartu "Pembagian Soal ke Peserta": mode acak/sama + jumlah soal per level
  document.querySelectorAll('input[name="quiz-question-mode"]').forEach((radio) => {
    radio.addEventListener('change', refreshQuestionSetCard);
  });
  window.Levels.order.forEach((level) => {
    $(`count-${level}`).addEventListener('input', () => {
      countTouched[level] = true;
      refreshQuestionSetCard();
    });
  });
  refreshQuestionSetCard();

  // Pilih semua soal / kosongkan (berguna di HP: tidak perlu mengetuk puluhan checkbox)
  $('btn-select-all-questions').addEventListener('click', () => setAllQuestionsSelected(true));
  $('btn-clear-questions').addEventListener('click', () => setAllQuestionsSelected(false));

  // HP yang baru menyala / internet kembali: sinkron ulang segera
  document.addEventListener('visibilitychange', () => { if (!document.hidden && activeRoom) syncActiveRoom(); });
  window.addEventListener('online', () => { if (activeRoom) syncActiveRoom(); });

  restoreActiveRoom(currentUser);
});

// Switch Dashboard Tab Views
function switchTab(tabId) {
  document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach((section) => section.classList.add('hidden'));

  const activeBtn = $(`tab-${tabId}`);
  if (activeBtn) {
    activeBtn.classList.add('active');
    // Di HP tab digeser ke samping: pastikan tab aktif terlihat
    if (activeBtn.scrollIntoView) activeBtn.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  const activeSection = $(`section-${tabId}`);
  if (activeSection) activeSection.classList.remove('hidden');
  window.scrollTo({ top: 0 });

  // Reload history when entering history tab
  if (tabId === 'quiz-history') {
    loadHistoryList();
  }
}

// ───────────────────────── Buat kuis ─────────────────────────

// ── Kartu "Pembagian Soal ke Peserta" ──
// Soal yang dicentang = bahan soal. Mode "acak": Host menentukan berapa soal per level (Easy/Normal/Hard) untuk
// SETIAP peserta; server mengundi kombinasi berbeda untuk tiap peserta yang scan QR dan bergabung.

// Dipanggil question-bank.js setiap pilihan soal berubah
window.onQuizSelectionChanged = refreshQuestionSetCard;

function selectedQuestionMode() {
  const checked = document.querySelector('input[name="quiz-question-mode"]:checked');
  return checked ? checked.value : 'random';
}

// Jumlah soal terpilih per level
function levelAvailability() {
  const available = { easy: 0, normal: 0, hard: 0 };
  getSelectedQuestions().forEach((q) => { available[window.Levels.normalize(q.level)] += 1; });
  return available;
}

function readLevelCounts() {
  const counts = {};
  window.Levels.order.forEach((level) => {
    const value = parseInt($(`count-${level}`).value, 10);
    counts[level] = Number.isFinite(value) && value > 0 ? value : 0;
  });
  return counts;
}

function sumCounts(counts) {
  return window.Levels.order.reduce((total, level) => total + (counts[level] || 0), 0);
}

// C(n, k) - dibatasi 1 miliar karena hanya dipakai untuk memperkirakan variasi soal antar peserta
function combinations(n, k) {
  if (k < 0 || k > n) return 0;
  const m = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= m; i++) {
    result = (result * (n - m + i)) / i;
    if (result > 1e9) return 1e9;
  }
  return Math.round(result);
}

// Berapa kombinasi soal berbeda yang mungkin untuk satu peserta
function countCombinations(available, counts) {
  let total = 1;
  window.Levels.order.forEach((level) => {
    total *= combinations(available[level], counts[level]);
    if (total > 1e9) total = 1e9;
  });
  return total;
}

function refreshQuestionSetCard() {
  const panel = $('level-count-panel');
  if (!panel) return;
  const random = selectedQuestionMode() === 'random';
  panel.classList.toggle('hidden', !random);

  const available = levelAvailability();
  window.Levels.order.forEach((level) => {
    const input = $(`count-${level}`);
    const max = available[level];
    input.max = String(max);
    input.disabled = max === 0;
    if (max === 0) {
      input.value = '0';
    } else if (!countTouched[level]) {
      input.value = String(Math.ceil(max / 2)); // saran awal: separuh soal tiap level, supaya soal antar peserta berbeda
    } else if (input.value !== '') {
      const typed = parseInt(input.value, 10);
      const clamped = Math.min(Math.max(Number.isFinite(typed) ? typed : 0, 0), max);
      if (String(clamped) !== input.value) input.value = String(clamped);
    }
    setText(`avail-${level}`, `dari ${max} soal`);
  });
  renderQuestionSetSummary(random, available);
}

function renderQuestionSetSummary(random, available) {
  const box = $('quiz-set-summary');
  const selected = sumCounts(available);
  let tone = '';
  let text;

  if (selected === 0) {
    text = 'Belum ada soal terpilih. Centang soal pada daftar di atas.';
  } else if (!random) {
    text = `Semua peserta mengerjakan ${selected} soal terpilih dengan urutan yang sama.`;
  } else {
    const counts = readLevelCounts();
    const perPerson = sumCounts(counts);
    if (perPerson === 0) {
      text = 'Isi jumlah soal minimal pada satu level.';
      tone = 'is-error';
    } else {
      const combos = countCombinations(available, counts);
      let variety;
      if (combos <= 1) {
        variety = 'Semua peserta akan mendapat soal yang SAMA (hanya urutannya diacak). Kurangi jumlah per level atau centang lebih banyak soal agar soal tiap peserta berbeda.';
        tone = 'is-warning';
      } else if (combos < 50) {
        variety = `Variasi terbatas: hanya ${combos} kombinasi soal yang berbeda.`;
        tone = 'is-warning';
      } else {
        variety = combos >= 1e9
          ? 'Variasi sangat tinggi: soal tiap peserta hampir pasti berbeda.'
          : `Variasi tinggi: ${combos.toLocaleString('id-ID')} kombinasi soal yang berbeda.`;
      }
      text = `Tiap peserta mengerjakan ${perPerson} soal (${window.Levels.countsText(counts)}), diacak dari ${selected} soal terpilih. ${variety}`;
    }
  }
  box.textContent = text;
  box.classList.remove('is-warning', 'is-error');
  if (tone) box.classList.add(tone);
}

// Create Quiz Room Action
async function createQuizRoom() {
  const name = $('quiz-name').value.trim();
  const duration = parseInt($('quiz-duration').value, 10);
  const passingGrade = parseInt($('quiz-passing-grade').value, 10);
  const questionIds = getSelectedQuestionIds();

  if (!name || isNaN(duration) || isNaN(passingGrade)) {
    window.UI.alert('Mohon lengkapi semua parameter kuis!');
    return;
  }
  if (duration < 1 || passingGrade < 0 || passingGrade > 100) {
    window.UI.alert('Durasi minimal 1 menit dan passing grade harus antara 0 sampai 100.');
    return;
  }
  if (questionIds.length === 0) {
    window.UI.alert('Pilih minimal 1 soal dari daftar bank soal untuk kuis!');
    return;
  }

  // Mode acak: jumlah per level harus terisi dan tidak melebihi soal terpilih di level itu
  const questionMode = selectedQuestionMode();
  let levelCounts = null;
  if (questionMode === 'random') {
    levelCounts = readLevelCounts();
    const available = levelAvailability();
    if (sumCounts(levelCounts) < 1) {
      window.UI.alert('Mode acak: isi jumlah soal per peserta minimal pada satu level (Easy / Normal / Hard).');
      return;
    }
    const tooMany = window.Levels.order.find((level) => levelCounts[level] > available[level]);
    if (tooMany) {
      window.UI.alert(`Soal ${window.Levels.label(tooMany)} yang Anda centang hanya ${available[tooMany]}, ` +
        `tetapi jumlah per peserta diisi ${levelCounts[tooMany]}. Centang lebih banyak soal ${window.Levels.label(tooMany)} atau kurangi jumlahnya.`);
      return;
    }
  }

  const buttons = [$('btn-generate-quiz'), $('btn-generate-quiz-bottom')];
  buttons.forEach((button) => window.UI.setBusy(button, true, 'Membuat room...'));

  // Save room details to API
  try {
    const room = await window.API.createRoom({
      title: name,
      duration: duration,
      passing_grade: passingGrade,
      question_ids: questionIds,
      question_mode: questionMode,
      level_counts: levelCounts,
      created_by: window.Auth.getCurrentUser().username
    });
    await activateRoom(room);
  } catch (error) {
    window.UI.alert('Gagal membuat room kuis: ' + error.message);
  } finally {
    buttons.forEach((button) => window.UI.setBusy(button, false));
  }
}

// ───────────────────────── Room aktif (waiting room & monitoring) ─────────────────────────

async function activateRoom(room, options = {}) {
  const { switchToTab = true } = options;
  activeRoom = room;
  timeUpAnnounced = false;
  syncHostClock(room);
  try { localStorage.setItem(ACTIVE_ROOM_KEY, room.room_code); } catch (e) { /* mode privat */ }

  renderRoomHeader(room);
  $('active-rooms-chooser').classList.add('hidden');
  await prepareJoinInfo();

  // Subscribe to realtime updates (peserta masuk/keluar, jawaban terkirim) + sinkron ulang saat tersambung kembali
  window.RealtimeManager.connect(room.id, {
    onParticipantJoined: refreshParticipants,
    onParticipantLeft: refreshParticipants,
    onAnswerSubmitted: (message) => { handleNewAnswer(message); refreshParticipants(); },
    onReconnect: () => syncActiveRoom()
  });
  startHostPolling();

  if (room.status === 'On Progress') {
    startCountdown();
    if (switchToTab) switchTab('active-monitoring');
  } else if (switchToTab) {
    switchTab('waiting-room');
  }
  refreshParticipants();
}

function clearActiveRoom() {
  window.RealtimeManager.unsubscribeAll();
  clearInterval(hostPollTimer);
  clearInterval(countdownTimer);
  activeRoom = null;
  try { localStorage.removeItem(ACTIVE_ROOM_KEY); } catch (e) { /* abaikan */ }

  setText('wait-quiz-title', 'Pilih/Buat Kuis Terlebih Dahulu');
  setText('wait-room-code', '-');
  setText('wait-quiz-status', 'STATUS : WAITING FOR START...');
  setText('wait-quiz-config', '');
  $('wait-qrcode').textContent = 'QR Code';
  $('join-box').classList.add('hidden');
  $('btn-start-quiz').disabled = true;
  setText('btn-start-quiz', 'START QUIZ');
  $('btn-cancel-room').classList.add('hidden');
  setText('wait-participants-count', '0 Peserta');
  $('wait-participants-list').innerHTML = '<li class="text-gray-500 text-sm text-center py-4">Menunggu peserta masuk...</li>';
  setText('monitor-room-info', 'Room: -');
  setText('monitor-countdown', '--:--');
}

function renderRoomHeader(room) {
  // Render Waiting Room Details
  setText('wait-quiz-title', room.quiz_name);
  setText('wait-room-code', room.room_code);
  setText('wait-quiz-config', `Soal: ${window.Levels.describeRoomSet(room)}`);
  setText('monitor-room-info', `Kuis: ${room.quiz_name} | Kode: ${room.room_code}`);

  const startBtn = $('btn-start-quiz');
  $('btn-cancel-room').classList.toggle('hidden', room.status !== 'Waiting');
  if (room.status === 'On Progress') {
    setText('wait-quiz-status', 'STATUS : ON PROGRESS - KUIS SEDANG BERJALAN');
    startBtn.disabled = true;
    startBtn.textContent = 'KUIS SEDANG BERJALAN';
  } else {
    setText('wait-quiz-status', 'STATUS : WAITING FOR START...');
    startBtn.disabled = false;
    startBtn.textContent = 'START QUIZ';
  }
}

function syncHostClock(room) {
  const serverMs = Date.parse(room && room.server_time);
  if (!isNaN(serverMs)) hostClockOffsetMs = serverMs - Date.now();
}

// Jika Host membuka ulang halaman (refresh / HP restart), lanjutkan room yang belum selesai
async function restoreActiveRoom(user) {
  let rooms = [];
  try {
    rooms = await window.API.getActiveRooms(user.username);
  } catch (err) {
    console.error('Gagal memeriksa room aktif:', err);
    return;
  }
  if (rooms.length === 0) {
    try { localStorage.removeItem(ACTIVE_ROOM_KEY); } catch (e) { /* abaikan */ }
    return;
  }

  const savedCode = localStorage.getItem(ACTIVE_ROOM_KEY);
  const room = rooms.find((r) => r.id === savedCode) || rooms[0];
  if (rooms.length > 1) renderActiveRoomsChooser(rooms, room.id);

  await activateRoom(room);
  window.UI.toast(`Melanjutkan room ${room.room_code} (${room.quiz_name}).`, 'info', 4500);
}

// Beberapa room aktif sekaligus: tampilkan pilihan supaya Host bisa berpindah
function renderActiveRoomsChooser(rooms, currentId) {
  const box = $('active-rooms-chooser');
  box.innerHTML = '<div class="text-xs text-gray-400 font-bold mb-2 uppercase">Room aktif Anda</div>';
  const list = document.createElement('div');
  list.className = 'flex flex-wrap gap-2';
  rooms.forEach((room) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn text-xs ${room.id === currentId ? 'btn-primary' : 'btn-secondary'}`;
    button.textContent = `${room.room_code} - ${room.quiz_name} (${room.status === 'On Progress' ? 'berjalan' : 'menunggu'})`;
    button.addEventListener('click', async () => {
      window.RealtimeManager.unsubscribeAll();
      await activateRoom(room);
      renderActiveRoomsChooser(rooms, room.id);
      $('active-rooms-chooser').classList.remove('hidden');
    });
    list.appendChild(button);
  });
  box.appendChild(list);
  box.classList.remove('hidden');
}

// ───────────────────────── Link & QR code peserta ─────────────────────────

// Alamat yang akan dibuka peserta. Jika Host membuka lewat localhost, QR TIDAK boleh berisi localhost
// (di HP, localhost = HP itu sendiri), jadi diganti dengan alamat jaringan yang dilaporkan server.
async function resolveJoinBases() {
  let info = {};
  try {
    info = await window.API.getServerInfo();
  } catch (err) {
    console.error('Gagal mengambil info server:', err);
  }

  const bases = [];
  if (info.public_url) bases.push(info.public_url); // domain / tunnel yang diatur di PUBLIC_URL
  if (window.UI.isLoopbackHost(window.location.hostname)) {
    (info.lan_urls || []).forEach((url) => bases.push(url));
  } else {
    bases.push(window.location.origin); // sudah dibuka lewat alamat yang bisa dijangkau perangkat lain
  }

  const unique = Array.from(new Set(bases));
  if (unique.length === 0) {
    return { bases: [window.location.origin], loopback: true };
  }
  return { bases: unique, loopback: false };
}

async function prepareJoinInfo() {
  const { bases, loopback } = await resolveJoinBases();
  joinBases = bases;
  joinBaseIndex = 0;
  loopbackOnly = loopback;

  const select = $('join-url-select');
  select.innerHTML = '';
  bases.forEach((base, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = base;
    select.appendChild(option);
  });
  select.classList.toggle('hidden', bases.length < 2);
  renderJoinInfo();
}

function currentJoinUrl() {
  return `${joinBases[joinBaseIndex]}/?room=${encodeURIComponent(activeRoom.room_code)}`;
}

function renderJoinInfo() {
  if (!activeRoom || joinBases.length === 0) return;
  const url = currentJoinUrl();

  $('join-box').classList.remove('hidden');
  setText('join-url-text', url);
  window.QRHelper.render($('wait-qrcode'), url, 200);
  $('btn-share-join').classList.toggle('hidden', typeof navigator.share !== 'function');

  const warning = $('join-url-warning');
  const hint = $('join-url-hint');
  const isPublic = /^https:\/\//i.test(joinBases[joinBaseIndex]) && !loopbackOnly;
  if (loopbackOnly) {
    warning.textContent = 'Alamat jaringan komputer ini tidak terdeteksi, jadi QR hanya bisa dibuka di komputer ini. ' +
      'Sambungkan komputer ke WiFi/LAN, lalu buka Host Portal lewat alamat IP komputer (contoh: http://192.168.1.10:8000).';
    warning.classList.remove('hidden');
  } else {
    warning.classList.add('hidden');
  }
  hint.textContent = isPublic
    ? 'Peserta bisa membuka link ini dari jaringan mana pun, atau mengetik kode room di halaman utama.'
    : joinBases.length > 1
      ? 'Peserta harus di WiFi yang sama dengan komputer ini. Jika QR tidak bisa dibuka di HP, pilih alamat lain di atas.'
      : 'Peserta harus di WiFi yang sama dengan komputer ini. Atau ketik kode room di halaman utama.';
}

async function copyJoinLink() {
  if (!activeRoom) return;
  const ok = await window.UI.copyText(currentJoinUrl());
  window.UI.toast(ok ? 'Link peserta disalin.' : 'Gagal menyalin. Tekan lama pada link lalu pilih Salin.', ok ? 'success' : 'error');
}

async function shareJoinLink() {
  if (!activeRoom || typeof navigator.share !== 'function') return;
  try {
    await navigator.share({
      title: `Gabung kuis: ${activeRoom.quiz_name}`,
      text: `Gabung kuis "${activeRoom.quiz_name}". Kode room: ${activeRoom.room_code}`,
      url: currentJoinUrl()
    });
  } catch (err) {
    // pengguna membatalkan: abaikan
  }
}

// ───────────────────────── Peserta & monitoring ─────────────────────────

// Fetch and Render Participants (waiting room list + monitoring table) dengan SATU permintaan
const refreshParticipants = debounce(async () => {
  if (!activeRoom) return;
  try {
    const participants = await window.API.getRoomParticipants(activeRoom.id);
    renderWaitingList(participants);
    renderMonitoring(participants);
  } catch (error) {
    console.error('Gagal mengambil data peserta:', error);
  }
}, 250);

// Kompatibel dengan nama fungsi lama
function updateWaitingRoomParticipants() { return refreshParticipants(); }
function updateActiveMonitoring() { return refreshParticipants(); }

function renderWaitingList(participants) {
  setText('wait-participants-count', `${participants.length} Peserta`);

  const list = $('wait-participants-list');
  if (participants.length === 0) {
    list.innerHTML = '<li class="text-gray-500 text-sm text-center py-4">Menunggu peserta masuk...</li>';
    return;
  }

  list.innerHTML = '';
  participants.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'glass-panel p-3 flex justify-between items-center bg-opacity-30 border-gray-800';
    li.innerHTML = `
      <span class="font-semibold text-gray-200" style="min-width:0; overflow-wrap:anywhere;">✓ ${window.escapeHTML(p.participant_name)}
        <span class="text-xs text-gray-500 font-normal">${window.escapeHTML(p.department)}</span></span>
      <span class="text-xs text-green-400">Ready</span>
    `;
    list.appendChild(li);
  });
}

function handleNewAnswer(answer) {
  console.log('Realtime answer received:', answer);
  // Optional animation or small sound helper
}

function renderMonitoring(participants) {
  // Calculate stats
  const total = participants.length;
  const submitted = participants.filter((p) => p.submit_time !== null).length;
  const passed = participants.filter((p) => p.status === 'PASS').length;
  const failed = participants.filter((p) => p.status === 'FAIL').length;

  setText('monitor-stat-total', total);
  setText('monitor-stat-submitted', submitted);
  setText('monitor-stat-pass', passed);
  setText('monitor-stat-fail', failed);

  // Render Table
  const tbody = $('monitor-table-tbody');
  if (participants.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-500 py-4">Belum ada peserta terdaftar.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  participants.forEach((p) => {
    const row = document.createElement('tr');
    const statusBadge = p.submit_time
      ? (p.status === 'PASS' ? '<span class="badge badge-pass">PASS</span>' : '<span class="badge badge-fail">FAIL</span>')
      : '<span class="badge badge-waiting">ON PROGRESS</span>';

    row.innerHTML = `
      <td data-label="Nama" class="font-medium"><div class="cell-name">${window.escapeHTML(p.participant_name)}<div class="text-xs text-gray-500">${window.escapeHTML(p.department)}</div></div></td>
      <td data-label="Nilai" class="font-bold text-gray-200">${p.submit_time ? p.score : '-'}</td>
      <td data-label="Status">${statusBadge}</td>
      <td data-label="Waktu Join" class="text-xs text-gray-400">${window.UI.formatTime(p.join_time)}</td>
      <td data-label="Waktu Submit" class="text-xs text-gray-400">${p.submit_time ? window.UI.formatTime(p.submit_time) : '-'}</td>
    `;
    tbody.appendChild(row);
  });
}

// Polling cadangan: WebSocket bisa terputus (sinyal HP / WiFi memblokir) -> data tetap segar
function startHostPolling() {
  clearInterval(hostPollTimer);
  hostPollTimer = setInterval(() => { syncActiveRoom(); }, 6000);
}

async function syncActiveRoom() {
  if (!activeRoom) return;
  try {
    const room = await window.API.getRoom(activeRoom.id);
    syncHostClock(room);
    const wasWaiting = activeRoom.status !== 'On Progress';
    activeRoom = Object.assign({}, activeRoom, room);

    if (room.status === 'Finished') {
      // Room diakhiri dari tab/perangkat lain
      window.UI.toast('Kuis ini sudah diakhiri.', 'info');
      clearActiveRoom();
      switchTab('quiz-history');
      return;
    }
    renderRoomHeader(activeRoom);
    if (room.status === 'On Progress' && wasWaiting) startCountdown();
    refreshParticipants();
  } catch (err) {
    // jaringan sedang putus: dicoba lagi pada putaran berikutnya
  }
}

// Hitung mundur sisa waktu kuis untuk Host (berdasarkan jam server)
function startCountdown() {
  clearInterval(countdownTimer);
  const tick = () => {
    const box = $('monitor-countdown');
    if (!box || !activeRoom || !activeRoom.ends_at) {
      if (box) box.textContent = '--:--';
      return;
    }
    const remaining = Math.ceil((Date.parse(activeRoom.ends_at) - hostClockOffsetMs - Date.now()) / 1000);
    box.textContent = remaining > 0 ? window.UI.formatDuration(remaining) : '00:00 (waktu habis)';
    box.classList.toggle('text-red-400', remaining <= 60);
    if (remaining <= 0 && !timeUpAnnounced) {
      timeUpAnnounced = true;
      window.UI.toast('Waktu kuis telah habis. Peserta dikirim otomatis. Tekan "Akhiri Kuis" untuk menutup.', 'warning', 8000);
    }
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

// Start Quiz Action
async function startQuiz() {
  if (!activeRoom) return;

  let count = 0;
  try {
    count = (await window.API.getRoomParticipants(activeRoom.id)).length;
  } catch (e) { /* lanjutkan ke konfirmasi */ }

  const ok = await window.UI.confirm({
    title: 'Mulai kuis sekarang?',
    message: (count === 0
      ? 'Belum ada peserta yang bergabung. '
      : `${count} peserta sudah bergabung. `) +
      'Setelah dimulai, peserta baru tidak bisa bergabung dan waktu langsung berjalan.',
    confirmText: 'Mulai Kuis',
    cancelText: 'Belum'
  });
  if (!ok) return;

  const button = $('btn-start-quiz');
  window.UI.setBusy(button, true, 'Memulai...');
  try {
    // Change room status to On Progress
    const room = await window.API.updateRoomStatus(activeRoom.id, 'On Progress');
    activeRoom = room;
    syncHostClock(room);
    timeUpAnnounced = false;
    renderRoomHeader(room);

    // Switch to monitoring tab
    switchTab('active-monitoring');
    startCountdown();
    refreshParticipants();
  } catch (error) {
    window.UI.alert('Gagal memulai kuis: ' + error.message);
  } finally {
    window.UI.setBusy(button, false);
    if (activeRoom) renderRoomHeader(activeRoom);
  }
}

// Batalkan room yang belum dimulai (mis. salah buat kuis, atau room basi sisa sesi sebelumnya)
async function cancelRoom() {
  if (!activeRoom || activeRoom.status !== 'Waiting') return;

  const ok = await window.UI.confirm({
    title: 'Batalkan room ini?',
    message: `Room ${activeRoom.room_code} akan ditutup. Peserta yang sudah bergabung tidak bisa mengerjakan kuis ini. ` +
      'Untuk mengulang, buat room baru.',
    confirmText: 'Batalkan Room',
    cancelText: 'Kembali',
    danger: true
  });
  if (!ok) return;

  const button = $('btn-cancel-room');
  window.UI.setBusy(button, true, 'Membatalkan...');
  try {
    await window.API.updateRoomStatus(activeRoom.id, 'Finished');
    window.UI.toast('Room dibatalkan.', 'success');
    clearActiveRoom();
    // Jika masih ada room aktif lain, tawarkan; jika tidak, kembali ke pembuatan kuis
    restoreActiveRoom(window.Auth.getCurrentUser()).then(() => {
      if (!activeRoom) switchTab('create-quiz');
    });
  } catch (error) {
    window.UI.alert('Gagal membatalkan room: ' + error.message);
  } finally {
    window.UI.setBusy(button, false);
  }
}

// Finish Quiz Action
async function finishQuiz() {
  if (!activeRoom) return;

  const ok = await window.UI.confirm({
    title: 'Akhiri kuis sekarang?',
    message: 'Semua peserta yang masih mengerjakan akan dikirim otomatis. Kuis yang sudah diakhiri tidak bisa dibuka kembali.',
    confirmText: 'Akhiri Kuis',
    cancelText: 'Batal',
    danger: true
  });
  if (!ok) return;

  const button = $('btn-finish-quiz');
  window.UI.setBusy(button, true, 'Mengakhiri...');
  try {
    // Update room status to Finished
    await window.API.updateRoomStatus(activeRoom.id, 'Finished');
    window.UI.toast('Kuis berhasil diakhiri! Hasil akhir dapat dilihat di tab Riwayat Kuis & Laporan.', 'success', 6000);

    clearActiveRoom();
    switchTab('quiz-history');
  } catch (error) {
    window.UI.alert('Gagal mengakhiri kuis: ' + error.message);
  } finally {
    window.UI.setBusy(button, false);
  }
}

// ───────────────────────── Riwayat & laporan ─────────────────────────

// Load history list in the history tab
async function loadHistoryList() {
  const container = $('history-rooms-list');
  if (!container) return;

  try {
    const rooms = await window.API.getFinishedRooms();

    if (rooms.length === 0) {
      container.innerHTML = '<p class="text-gray-500 text-sm text-center py-4">Belum ada riwayat kuis.</p>';
      return;
    }

    container.innerHTML = '';
    rooms.forEach((room) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'w-full text-left p-3 glass-panel bg-opacity-20 border-gray-800 hover:border-indigo-500 hover:bg-gray-900 transition mb-2 rounded-lg flex flex-col gap-1';
      btn.innerHTML = `
        <div class="font-bold text-gray-200 text-sm truncate">${window.escapeHTML(room.quiz_name)}</div>
        <div class="flex justify-between items-center w-full mt-1">
          <span class="text-xs text-indigo-400 font-semibold">${window.escapeHTML(room.room_code)}</span>
          <span class="text-xs text-gray-400">${window.UI.formatDate(room.created_at)}</span>
        </div>
      `;
      btn.addEventListener('click', () => selectHistoryRoom(room));
      container.appendChild(btn);
    });
  } catch (error) {
    container.innerHTML = '<p class="text-red-500 text-sm">Gagal memuat riwayat.</p>';
  }
}

// Peserta yang tidak pernah submit: status database masih ON_PROGRESS -> tampilkan "TIDAK SUBMIT" di laporan
function reportStatusOf(p) {
  if (p.status === 'PASS' || p.status === 'FAIL') return p.status;
  return 'TIDAK SUBMIT';
}

// Fetch details of selected history room and render HRD report
async function selectHistoryRoom(room) {
  selectedRoomHistory = room;

  // Hide placeholder, show print container
  $('history-placeholder-msg').classList.add('hidden');
  const printContainer = $('hrd-report-print-container');
  printContainer.classList.remove('hidden');
  $('btn-download-hrd-pdf').disabled = false;
  setText('history-summary-title', room.quiz_name);

  try {
    const participants = await window.API.getRoomParticipants(room.id);
    const summary = await window.API.getRoomSummary(room.id).catch(() => null);

    // Populate data
    setText('report-date-created', `Tanggal: ${window.UI.formatDate(room.created_at)}`);
    setText('report-quiz-name', room.quiz_name);
    setText('report-room-code', room.room_code);
    setText('report-passing-grade', `${room.passing_grade}%`);
    setText('report-total-participants', participants.length);
    setText('report-time-duration', `${room.duration_minutes} Menit`);
    setText('report-initiator', room.created_by || 'Host');
    setText('report-question-set', window.Levels.describeRoomSet(room));

    const tbody = $('report-participants-tbody');
    tbody.innerHTML = '';

    if (participants.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-500 py-4">Tidak ada peserta berpartisipasi.</td></tr>';
    } else {
      participants.forEach((p, idx) => {
        const label = reportStatusOf(p);
        const palette = label === 'PASS'
          ? { color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' }
          : label === 'FAIL'
            ? { color: '#dc2626', bg: '#fef2f2', border: '#fecaca' }
            : { color: '#6b7280', bg: '#f3f4f6', border: '#d1d5db' };
        const row = document.createElement('tr');
        row.className = 'pdf-avoid-break'; // PDF: satu baris peserta tidak boleh terbelah di antara dua halaman
        row.setAttribute('style', 'border-bottom: 1px solid #e2e8f0;');
        row.innerHTML = `
          <td style="padding: 8px 0; color: #4b5563;">${idx + 1}</td>
          <td style="padding: 8px 0; font-weight: 600; color: #111827;">${window.escapeHTML(p.participant_name)}
            <div style="font-size: 10px; font-weight: 400; color: #6b7280;">${window.escapeHTML(p.department)}</div></td>
          <td style="padding: 8px 0; color: #111827; font-weight: bold;">${p.submit_time ? p.score : '-'}</td>
          <td style="padding: 8px 0; text-align: right;">
            <span style="font-weight: bold; padding: 2px 8px; border-radius: 4px; font-size: 11px;
              color: ${palette.color}; background: ${palette.bg}; border: 1px solid ${palette.border};">
              ${label}
            </span>
          </td>
        `;
        tbody.appendChild(row);
      });
    }

    if (summary) {
      setText('report-average-score', summary.average_score);
      setText('report-pass-count', summary.pass_count);
      setText('report-fail-count', summary.fail_count);
    } else {
      // Recalculate dynamically if summary record was missing
      const submittedList = participants.filter((p) => p.submit_time);
      const totalScoreSum = submittedList.reduce((sum, p) => sum + (p.score || 0), 0);
      setText('report-average-score', submittedList.length > 0 ? (totalScoreSum / submittedList.length).toFixed(2) : 0);
      setText('report-pass-count', participants.filter((p) => p.status === 'PASS').length);
      setText('report-fail-count', participants.filter((p) => p.status === 'FAIL').length);
    }
  } catch (error) {
    console.error('Gagal memuat detail riwayat kuis:', error);
    window.UI.toast('Gagal memuat detail laporan: ' + error.message, 'error');
  }
}

// Download Assessment Report PDF using html2pdf.js (dimuat saat dibutuhkan, dirender di lebar A4 tetap)
async function downloadHRDPDF() {
  if (!selectedRoomHistory) return;

  const button = $('btn-download-hrd-pdf');
  window.UI.setBusy(button, true, 'Menyiapkan PDF...');
  try {
    await window.PDFExport.fromElement(
      $('hrd-report-print-container'),
      `HRD_Assessment_Report_${window.PDFExport.safeFilename(selectedRoomHistory.quiz_name)}.pdf`
    );
  } catch (error) {
    console.error('Gagal membuat PDF:', error);
    window.UI.toast('Gagal membuat PDF: ' + error.message, 'error', 7000);
  } finally {
    window.UI.setBusy(button, false);
  }
}
