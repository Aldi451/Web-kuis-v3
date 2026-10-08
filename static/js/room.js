// js/room.js - alur peserta di HP: gabung -> tunggu -> kerjakan -> kirim hasil
//
// Dirancang untuk kondisi nyata di HP:
//   * layar terkunci / pindah aplikasi / browser dimatikan sistem -> sesi dilanjutkan otomatis (token + jawaban tersimpan)
//   * sinyal putus -> WebSocket menyambung ulang sendiri, status room di-sinkron lewat REST (polling cadangan
//     juga jalan jika jaringan memblokir WebSocket)
//   * timer memakai batas waktu dari SERVER, jadi adil walau jam HP salah dan tidak melambat saat layar mati
//   * jawaban dikirim dengan percobaan ulang; jika tetap gagal, jawaban tidak hilang dan bisa dikirim ulang

const SESSION_KEY = 'client_session_v2';
const $ = (id) => document.getElementById(id);

let clientRoom = null;
let clientParticipant = null;   // { id, participant_name, department, token, question_ids }
let clientQuestions = [];
let userAnswers = {};           // { questionId: 'A' | 'teks essay' }
let currentQuestionIndex = 0;

let quizStarted = false;
let quizFinished = false;       // hasil sudah ditampilkan
let isSubmitting = false;
let sessionKey = '';
let serverOffsetMs = 0;         // jam server - jam HP
let bestRttMs = Infinity;       // RTT terkecil yang pernah diukur (pengukuran paling akurat)
let pollTimer = null;
let persistTimer = null;
let wakeLock = null;
let backGuardInstalled = false;
let lifecycleBound = false;
let wasDisconnected = false;
let retryAction = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

// ───────────────────────── Penyimpanan sesi di HP ─────────────────────────

const Session = {
  makeKey(roomId, name) {
    return `${String(roomId).toUpperCase()}|${String(name).trim().replace(/\s+/g, ' ').toLowerCase()}`;
  },
  load() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || {}; } catch (e) { return {}; }
  },
  // Mulai sesi untuk key tertentu. Jika key berbeda dari yang tersimpan, data lama dibuang.
  begin(key, data) {
    const current = this.load();
    const base = current.key === key ? current : {};
    return this.save(Object.assign(base, data, { key }), true);
  },
  save(patch, replace = false) {
    try {
      const next = replace ? patch : Object.assign({}, this.load(), patch);
      localStorage.setItem(SESSION_KEY, JSON.stringify(next));
      return next;
    } catch (e) {
      return patch; // penyimpanan penuh / mode privat: tidak fatal, hanya tidak bisa dilanjutkan setelah refresh
    }
  },
  forKey(key) {
    const session = this.load();
    return session.key === key ? session : null;
  },
  clearAll() {
    ['client_room_code', 'client_room_id', 'client_participant_name', 'client_department', SESSION_KEY]
      .forEach((key) => localStorage.removeItem(key));
  }
};

// ID soal yang harus dikerjakan peserta INI, berurutan. Room acak: hasil undian khusus peserta (dari respons join,
// berbeda tiap peserta). Room biasa / server lama: seluruh soal room.
function myQuestionIds() {
  if (clientParticipant && Array.isArray(clientParticipant.question_ids) && clientParticipant.question_ids.length) {
    return clientParticipant.question_ids;
  }
  return (clientRoom && clientRoom.question_ids) || [];
}

function flushProgress() {
  clearTimeout(persistTimer);
  if (!sessionKey || quizFinished) return;
  Session.save({ answers: userAnswers, qIndex: currentQuestionIndex });
}
const persistSoon = () => {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(flushProgress, 400);
};

// ───────────────────────── Awal halaman ─────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  bindStaticEvents();
  startSession();
});

function startSession() {
  const roomCode = localStorage.getItem('client_room_code');
  const participantName = localStorage.getItem('client_participant_name');
  const department = localStorage.getItem('client_department') || '-';

  if (!roomCode || !participantName) {
    leaveWithMessage('Informasi room atau nama tidak ditemukan. Silakan gabung lewat halaman utama.');
    return;
  }

  // Link lama berbentuk client.html?room=KODE
  const params = new URLSearchParams(window.location.search);
  const paramRoom = (params.get('room') || '').toUpperCase();
  if (paramRoom && paramRoom !== roomCode) {
    localStorage.setItem('client_room_code', paramRoom);
    window.location.replace('client.html');
    return;
  }

  initializeClientSession(roomCode, participantName, department);
}

function bindStaticEvents() {
  document.querySelectorAll('#client-mcq-container .option-btn').forEach((button) => {
    button.addEventListener('click', () => selectOption(button.dataset.option));
  });
  $('btn-prev-question').addEventListener('click', prevQuestion);
  $('btn-next-question').addEventListener('click', nextQuestion);
  $('client-essay-answer').addEventListener('input', saveEssayAnswer);
  $('btn-leave-room').addEventListener('click', leaveRoomFlow);
  $('btn-retry-init').addEventListener('click', () => {
    const action = retryAction; // setInitError(null) menghapus retryAction, jadi simpan dulu
    setInitError(null);
    if (action) action(); else startSession();
  });
  $('btn-submit-retry').addEventListener('click', () => submitQuizAnswers(true));
  $('btn-submit-home').addEventListener('click', () => { window.location.href = 'index.html'; });

  // Pintasan keyboard untuk peserta yang memakai laptop: A-D memilih jawaban, panah kiri/kanan berpindah soal
  document.addEventListener('keydown', (event) => {
    if (!quizStarted || quizFinished || isSubmitting || event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.querySelector('.ui-modal-backdrop')) return;
    const tag = (event.target && event.target.tagName) || '';
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    const key = event.key.toUpperCase();
    if (['A', 'B', 'C', 'D'].includes(key)) selectOption(key);
    else if (event.key === 'ArrowRight') nextQuestion();
    else if (event.key === 'ArrowLeft') prevQuestion();
  });

  // HP bisa mematikan halaman kapan saja setelah pindah aplikasi -> simpan jawaban SEKARANG
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushProgress(); });
  window.addEventListener('pagehide', flushProgress);
}

// ───────────────────────── Masuk ke room ─────────────────────────

function setWaitStatus(text) {
  $('client-wait-status-text').textContent = text;
}

function setInitError(message, canRetry = false, action = null) {
  const box = $('client-init-error');
  const button = $('btn-retry-init');
  retryAction = action;
  if (!message) {
    box.classList.add('hidden');
    button.classList.add('hidden');
    return;
  }
  box.textContent = message;
  box.classList.remove('hidden');
  button.classList.toggle('hidden', !canRetry);
}

// Selisih jam server dan jam HP. Jika waktu kirim/terima diketahui, latensi jaringan dikoreksi (tengah-tengah
// perjalanan) dan hanya pengukuran dengan RTT terbaik yang dipakai, supaya batas waktu tidak "bergoyang"
// di jaringan seluler yang lambat.
function syncServerClock(serverTimeIso, sentAt, receivedAt) {
  const serverMs = Date.parse(serverTimeIso || '');
  if (isNaN(serverMs)) return;
  if (sentAt && receivedAt) {
    const rtt = receivedAt - sentAt;
    if (rtt > bestRttMs * 1.5 + 50) return;
    bestRttMs = Math.min(bestRttMs, rtt);
    serverOffsetMs = serverMs - (sentAt + receivedAt) / 2;
  } else if (bestRttMs === Infinity) {
    serverOffsetMs = serverMs - Date.now(); // pesan WebSocket: latensi tidak diketahui, hanya dipakai bila belum ada ukuran lain
  }
}

async function fetchRoomWithClockSync(code) {
  const sentAt = Date.now();
  const room = await window.API.getRoom(code);
  syncServerClock(room.server_time, sentAt, Date.now());
  return room;
}

async function initializeClientSession(roomCode, name, department) {
  setInitError(null);
  setWaitStatus('Menghubungkan ke room...');

  let room;
  try {
    // 1. Fetch Room details
    room = await fetchRoomWithClockSync(roomCode);
  } catch (err) {
    if (err.status === 404) {
      leaveWithMessage(`Room ${roomCode} tidak ditemukan. Periksa kembali kode room.`);
    } else {
      setWaitStatus('Belum tersambung');
      setInitError(err.message, true);
    }
    return;
  }
  clientRoom = room;
  $('client-wait-quiz-title').textContent = room.quiz_name;
  $('client-wait-room-code').textContent = room.room_code;

  // 2. Join Room (Participant). Token dari sesi sebelumnya membuat refresh/restart browser tetap bisa lanjut.
  sessionKey = Session.makeKey(room.id, name);
  const saved = Session.forKey(sessionKey);

  let joined;
  try {
    joined = await window.API.joinRoom(room.id, name, department, saved && saved.token);
  } catch (err) {
    if (err.network || err.status >= 500) {
      setWaitStatus('Belum tersambung');
      setInitError(err.message, true);
    } else {
      // Ditolak server: nama sudah dipakai, kuis sudah berjalan, atau sudah selesai
      leaveWithMessage(room.status === 'Finished' ? 'Kuis sudah selesai.' : err.message);
    }
    return;
  }

  clientParticipant = {
    id: joined.id,
    participant_name: joined.participant_name,
    department: joined.department,
    token: joined.token,
    question_ids: Array.isArray(joined.question_ids) ? joined.question_ids : null
  };
  const resumedSaved = joined.resumed && saved;
  userAnswers = (resumedSaved && saved.answers) || {};
  currentQuestionIndex = resumedSaved && Number.isInteger(saved.qIndex) ? saved.qIndex : 0;
  const sessionData = {
    participantId: joined.id,
    token: joined.token,
    answers: userAnswers,
    qIndex: currentQuestionIndex
  };
  // Peserta baru = undian soal baru: buang cache soal milik peserta sebelumnya (nama sama, room sama)
  if (!joined.resumed) sessionData.questions = null;
  Session.begin(sessionKey, sessionData);
  console.log('Registered participant:', clientParticipant, joined.resumed ? '(melanjutkan sesi)' : '');
  $('client-wait-me').textContent = `${clientParticipant.participant_name} • ${clientParticipant.department}`;
  showQuestionSetInfo();

  bindLifecycleOnce();

  // Sudah pernah submit (halaman di-refresh setelah selesai) -> tampilkan hasil dari server
  if (joined.submitted) {
    try {
      await showResultFromServer();
    } catch (err) {
      setWaitStatus('Belum tersambung');
      setInitError('Gagal memuat hasil: ' + err.message, true, () => initializeClientSession(roomCode, name, department));
    }
    return;
  }

  // 3. Render participants in waiting room
  updateWaitingParticipants();

  // 4. Connect to WebSocket (+ polling cadangan)
  connectRealtime();
  schedulePoll();

  if (room.status === 'On Progress') {
    // Host sudah memulai kuis sebelum halaman ini dibuka (atau halaman di-refresh di tengah kuis)
    await startActiveQuiz();
  } else if (room.status === 'Finished') {
    await handleQuizEnded();
  } else {
    setWaitStatus('Waiting Host to Start Quiz...');
  }
}

// Waiting room: beri tahu peserta berapa soalnya (dan bahwa soal diacak khusus untuknya)
function showQuestionSetInfo() {
  const box = $('client-wait-set');
  const total = myQuestionIds().length;
  if (!box || !total) return;
  box.textContent = clientRoom.question_mode === 'random'
    ? `Soal diacak khusus untukmu: ${total} soal (${window.Levels.countsText(clientRoom.level_counts)})`
    : `Jumlah soal: ${total}`;
  box.classList.remove('hidden');
}

function leaveWithMessage(message) {
  window.RealtimeManager.disconnect();
  window.Timer.stop();
  Session.clearAll();
  window.UI.flash(message);
  window.location.href = 'index.html';
}

async function leaveRoomFlow() {
  const ok = await window.UI.confirm({
    title: 'Keluar dari room?',
    message: 'Namamu akan dihapus dari daftar peserta. Kamu bisa gabung lagi dengan nama yang benar selama kuis belum dimulai.',
    confirmText: 'Keluar', cancelText: 'Batal', danger: true
  });
  if (!ok) return;

  try {
    if (clientParticipant) await window.API.leaveRoom(clientParticipant.id, clientParticipant.token);
  } catch (err) {
    if (err.status === 409) { // kuis sudah berjalan
      window.UI.alert(err.message);
      return;
    }
    // kesalahan lain (mis. peserta sudah terhapus): tetap keluar
  }
  window.RealtimeManager.disconnect();
  Session.clearAll();
  window.location.href = 'index.html';
}

// ───────────────────────── Realtime, polling, siklus hidup halaman ─────────────────────────

function connectRealtime() {
  window.RealtimeManager.connect(clientRoom.id, {
    onParticipantJoined: () => refreshWaitingList(),
    onParticipantLeft: () => refreshWaitingList(),
    onRoomStatusChanged: (status, message) => {
      const patch = { status };
      ['started_at', 'ends_at'].forEach((field) => { if (message && message[field]) patch[field] = message[field]; });
      if (message && message.server_time) syncServerClock(message.server_time);
      applyRoomState(patch);
    },
    onConnectionChange: updateConnectionBanner,
    onReconnect: () => syncRoomState() // event yang terlewat saat terputus tidak dikirim ulang server
  });
}

function updateConnectionBanner(state) {
  const banner = $('conn-banner');
  if (state === 'open') {
    if (wasDisconnected) {
      banner.textContent = 'Tersambung kembali';
      banner.classList.add('ok');
      banner.classList.remove('hidden');
      setTimeout(() => { banner.classList.add('hidden'); banner.classList.remove('ok'); }, 2000);
    }
    wasDisconnected = false;
  } else if (state === 'reconnecting') {
    wasDisconnected = true;
    banner.textContent = 'Koneksi terputus. Menyambungkan ulang...';
    banner.classList.remove('ok');
    banner.classList.remove('hidden');
  }
}

function applyRoomState(patch) {
  if (!clientRoom || quizFinished) return;
  clientRoom = Object.assign({}, clientRoom, patch);

  if (clientRoom.status === 'On Progress') {
    if (!quizStarted) {
      startActiveQuiz();
    } else if (clientRoom.ends_at) {
      window.Timer.setDeadline(Date.parse(clientRoom.ends_at) - serverOffsetMs);
    }
  } else if (clientRoom.status === 'Finished') {
    handleQuizEnded();
  }
}

async function syncRoomState() {
  if (!clientRoom || quizFinished || isSubmitting) return;
  try {
    applyRoomState(await fetchRoomWithClockSync(clientRoom.id));
    if (!quizStarted) refreshWaitingList();
  } catch (err) {
    // jaringan sedang putus: dicoba lagi pada putaran berikutnya / saat tersambung kembali
  }
}

// Polling cadangan: sebagian WiFi/proxy memblokir WebSocket, dan HP yang baru menyala butuh sinkron cepat
function schedulePoll() {
  clearTimeout(pollTimer);
  if (quizFinished) return;
  pollTimer = setTimeout(async () => {
    await syncRoomState();
    schedulePoll();
  }, quizStarted ? 15000 : 5000);
}

function bindLifecycleOnce() {
  if (lifecycleBound) return;
  lifecycleBound = true;
  const onForeground = () => {
    syncRoomState();
    requestWakeLock();
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onForeground(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) onForeground(); });
  window.addEventListener('online', () => {
    onForeground();
    // jika sedang menunggu "Kirim Ulang", coba kirim otomatis begitu internet kembali
    if (!$('submit-overlay').classList.contains('hidden') && !$('submit-actions').classList.contains('hidden')) {
      submitQuizAnswers(true);
    }
  });
}

async function requestWakeLock() {
  // Menjaga layar tetap menyala selama kuis. Hanya tersedia di HTTPS; di http://IP-LAN diabaikan.
  try {
    if (quizStarted && !quizFinished && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (err) { /* tidak didukung / ditolak: abaikan */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// Tombol Back / geser tepi layar yang tidak sengaja saat mengetuk jawaban tidak boleh membuang peserta dari kuis
function installBackGuard() {
  if (backGuardInstalled) return;
  backGuardInstalled = true;
  history.pushState({ quiz: true }, '', window.location.href);
  window.addEventListener('popstate', () => {
    if (!quizStarted || quizFinished) return;
    history.pushState({ quiz: true }, '', window.location.href);
    window.UI.toast('Kuis sedang berjalan. Gunakan tombol Kembali / Selanjutnya di layar.', 'warning');
  });
}

// ───────────────────────── Waiting room ─────────────────────────

const refreshWaitingList = debounce(() => updateWaitingParticipants(), 300);

async function updateWaitingParticipants() {
  if (!clientRoom || quizStarted) return;

  try {
    const participants = await window.API.getRoomParticipants(clientRoom.id);
    const list = $('client-waiting-participants-list');
    list.innerHTML = '';
    participants.forEach((p) => {
      const mine = clientParticipant && p.id === clientParticipant.id;
      const li = document.createElement('li');
      li.className = 'glass-panel p-2 flex items-center bg-opacity-20 border-gray-800 text-xs';
      li.innerHTML = `<span class="font-semibold ${mine ? 'text-indigo-300' : 'text-gray-300'}">✓ ${window.escapeHTML(p.participant_name)}${mine ? ' (kamu)' : ''}</span>`;
      list.appendChild(li);
    });
  } catch (err) {
    console.error('Failed to load participants:', err);
  }
}

// ───────────────────────── Mengerjakan kuis ─────────────────────────

async function loadQuestions(ids) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const questions = await window.API.getQuestions(ids);
      if (questions.length) return questions;
      lastError = new Error('Soal tidak ditemukan di server.');
    } catch (err) {
      lastError = err;
      await sleep(800 * (attempt + 1));
    }
  }
  // Server tidak terjangkau: pakai soal yang tersimpan dari pemuatan sebelumnya (refresh saat sinyal hilang)
  const cached = Session.forKey(sessionKey);
  if (cached && Array.isArray(cached.questions) && cached.questions.length === ids.length &&
      cached.questions.every((q, i) => q.id === ids[i])) {
    return cached.questions;
  }
  throw lastError;
}

function computeDeadlineMs() {
  // Batas waktu dari server (sudah dikoreksi selisih jam HP)
  if (clientRoom.ends_at) return Date.parse(clientRoom.ends_at) - serverOffsetMs;

  // Room yang dimulai sebelum fitur ini ada tidak punya ends_at: pakai batas lokal yang disimpan,
  // supaya refresh tidak mengulang durasi dari awal.
  const saved = Session.forKey(sessionKey);
  if (saved && saved.localDeadline) return saved.localDeadline;
  const deadline = Date.now() + clientRoom.duration_minutes * 60 * 1000;
  Session.save({ localDeadline: deadline });
  return deadline;
}

// Start Active Quiz view
async function startActiveQuiz() {
  if (!clientRoom || quizStarted || quizFinished) return;

  // 1. Ambil soal milik peserta ini (room acak: soal hasil undian, bukan seluruh pool room)
  const qIds = myQuestionIds();
  if (!qIds || qIds.length === 0) {
    window.UI.alert('Room kuis ini tidak memiliki soal!');
    return;
  }

  quizStarted = true; // cegah start ganda: WebSocket, polling, dan layar menyala bisa datang bersamaan
  setWaitStatus('Memuat soal...');
  try {
    clientQuestions = await loadQuestions(qIds);
    Session.save({ questions: clientQuestions });
  } catch (error) {
    quizStarted = false;
    setWaitStatus('Gagal memuat soal');
    setInitError('Gagal memuat soal kuis: ' + error.message, true, startActiveQuiz);
    return;
  }
  setInitError(null);

  // 2. Transition View
  $('client-waiting-section').classList.add('hidden');
  $('client-quiz-section').classList.remove('hidden');
  document.body.classList.add('in-quiz');
  buildNavigator();
  window.scrollTo(0, 0);

  if (!Number.isInteger(currentQuestionIndex) || currentQuestionIndex < 0 || currentQuestionIndex >= clientQuestions.length) {
    currentQuestionIndex = 0;
  }

  // 3. Render soal, lalu jalankan timer berbasis batas waktu server
  renderQuestion(currentQuestionIndex);
  window.Timer.startUntil(computeDeadlineMs(), handleTimerTick, handleTimerExpired);

  installBackGuard();
  requestWakeLock();
  schedulePoll();
}

function hasAnswer(questionId) {
  const value = userAnswers[questionId];
  return typeof value === 'string' && value.trim() !== '';
}

function answeredCount() {
  return clientQuestions.filter((q) => hasAnswer(q.id)).length;
}

function buildNavigator() {
  const nav = $('quiz-navigator');
  nav.innerHTML = '';
  clientQuestions.forEach((q, index) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'q-chip';
    chip.textContent = String(index + 1);
    chip.setAttribute('aria-label', `Soal ${index + 1}`);
    chip.addEventListener('click', () => goToQuestion(index));
    nav.appendChild(chip);
  });
}

function updateProgressUI() {
  const total = clientQuestions.length;
  const answered = answeredCount();
  $('quiz-progress-bar').style.width = total ? `${Math.round((answered / total) * 100)}%` : '0%';
  $('quiz-answered-count').textContent = `${answered} dari ${total} soal terjawab`;

  Array.from($('quiz-navigator').children).forEach((chip, index) => {
    const q = clientQuestions[index];
    chip.classList.toggle('answered', !!q && hasAnswer(q.id));
    chip.classList.toggle('current', index === currentQuestionIndex);
    if (index === currentQuestionIndex) chip.setAttribute('aria-current', 'true');
    else chip.removeAttribute('aria-current');
  });
}

function renderQuestion(index) {
  if (index < 0 || index >= clientQuestions.length) return;

  const q = clientQuestions[index];
  $('quiz-progress-text').textContent = `Soal ${index + 1} dari ${clientQuestions.length}`;
  $('quiz-active-title').textContent = clientRoom.quiz_name;
  $('quiz-question-text').textContent = q.question_text;
  const levelBox = $('quiz-level-badge');
  levelBox.innerHTML = window.Levels.badge(q.level);
  levelBox.classList.remove('hidden');

  const qType = q.question_type || 'mcq';
  const mcqContainer = $('client-mcq-container');
  const essayContainer = $('client-essay-container');

  if (qType === 'essay') {
    mcqContainer.classList.add('hidden');
    essayContainer.classList.remove('hidden');
    $('client-essay-answer').value = userAnswers[q.id] || '';
  } else {
    mcqContainer.classList.remove('hidden');
    essayContainer.classList.add('hidden');

    $('text-opt-A').textContent = q.option_a;
    $('text-opt-B').textContent = q.option_b;
    $('text-opt-C').textContent = q.option_c;
    $('text-opt-D').textContent = q.option_d;

    // Highlight previously selected answer if exists
    const selected = userAnswers[q.id];
    document.querySelectorAll('#client-mcq-container .option-btn').forEach((button) => {
      const isSelected = button.dataset.option === selected;
      button.classList.toggle('selected', isSelected);
      button.setAttribute('aria-pressed', String(isSelected));
    });
  }

  // Handle navigation buttons
  $('btn-prev-question').classList.toggle('hidden', index === 0); // soal pertama: tombol Selanjutnya melebar penuh

  const nextBtn = $('btn-next-question');
  if (index === clientQuestions.length - 1) {
    nextBtn.innerHTML = 'Submit';
    nextBtn.className = 'btn btn-success';
  } else {
    nextBtn.innerHTML = 'Selanjutnya &rsaquo;';
    nextBtn.className = 'btn btn-primary';
  }

  updateProgressUI();
  persistSoon();
}

function goToQuestion(index) {
  if (isSubmitting || quizFinished) return;
  if (index < 0 || index >= clientQuestions.length) return;
  currentQuestionIndex = index;
  renderQuestion(index);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function selectOption(option) {
  if (isSubmitting || quizFinished) return;
  const q = clientQuestions[currentQuestionIndex];
  if (!q || (q.question_type || 'mcq') === 'essay') return;

  userAnswers[q.id] = option;
  document.querySelectorAll('#client-mcq-container .option-btn').forEach((button) => {
    const isSelected = button.dataset.option === option;
    button.classList.toggle('selected', isSelected);
    button.setAttribute('aria-pressed', String(isSelected));
  });
  updateProgressUI();
  flushProgress(); // pilihan ganda langsung disimpan
  if (navigator.vibrate) navigator.vibrate(8);
}

function saveEssayAnswer() {
  if (isSubmitting || quizFinished) return;
  const q = clientQuestions[currentQuestionIndex];
  if (!q) return;
  userAnswers[q.id] = $('client-essay-answer').value;
  updateProgressUI();
  persistSoon();
}
window.saveEssayAnswer = saveEssayAnswer;

function prevQuestion() {
  goToQuestion(currentQuestionIndex - 1);
}

function nextQuestion() {
  if (currentQuestionIndex < clientQuestions.length - 1) {
    goToQuestion(currentQuestionIndex + 1);
  } else {
    // Submit Quiz
    submitQuizAnswers(false);
  }
}

function handleTimerTick(timeStr, isLow) {
  const timerSpan = $('quiz-timer');
  timerSpan.textContent = timeStr;
  timerSpan.classList.toggle('low', !!isLow);
}

function handleTimerExpired() {
  window.UI.toast('Waktu habis! Jawaban Anda dikirim otomatis.', 'warning', 6000);
  submitQuizAnswers(true);
}

async function handleQuizEnded() {
  if (quizFinished || isSubmitting || !clientParticipant) return;
  window.UI.toast('Kuis telah diakhiri oleh host. Jawaban Anda dikirim otomatis.', 'warning', 6000);
  await submitQuizAnswers(true);
}

// ───────────────────────── Mengirim jawaban ─────────────────────────

function showSubmitOverlay(mode, message, detail = '') {
  $('submit-overlay').classList.remove('hidden');
  $('submit-spinner').classList.toggle('hidden', mode === 'error');
  $('submit-message').textContent = message;
  const detailBox = $('submit-detail');
  detailBox.textContent = detail;
  detailBox.classList.toggle('hidden', !detail);
  $('submit-actions').classList.toggle('hidden', mode !== 'error');
}

function hideSubmitOverlay() {
  $('submit-overlay').classList.add('hidden');
}

function lockQuizUI(locked) {
  $('btn-next-question').disabled = locked;
  $('btn-prev-question').disabled = locked;
  $('client-essay-answer').disabled = locked;
  document.querySelectorAll('.option-btn, .q-chip').forEach((button) => { button.disabled = locked; });
}

// Semua soal milik peserta ini dikirim (yang kosong dihitung salah oleh server). Berdasarkan userAnswers, jadi tetap
// bisa dikirim walau halaman baru dibuka ulang dan daftar soal belum sempat dimuat.
function buildAnswerPayload() {
  const questionIds = clientQuestions.length ? clientQuestions.map((q) => q.id) : myQuestionIds();
  return questionIds.map((qid) => ({
    room_id: clientRoom.id,
    participant_name: clientParticipant.participant_name,
    participant_id: clientParticipant.id,
    question_id: qid,
    answer_user: hasAnswer(qid) ? String(userAnswers[qid]) : ''
  }));
}

function sendAnswers() {
  const payload = buildAnswerPayload();
  if (payload.length === 0) {
    return window.API.finalizeParticipant(clientParticipant.id, clientParticipant.token);
  }
  return window.API.submitAnswersBatch(payload, clientParticipant.token);
}

async function submitWithRetry() {
  const waits = [0, 1500, 4000];
  let lastError;
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) {
      showSubmitOverlay('loading', 'Mengirim jawaban...', `Koneksi bermasalah, mencoba lagi (${attempt + 1}/${waits.length})...`);
      await sleep(waits[attempt]);
    }
    try {
      return await sendAnswers();
    } catch (err) {
      lastError = err;
      if (!(err.network || err.status >= 500)) break; // 4xx: mengulang tidak membantu
    }
  }
  throw lastError;
}

async function submitQuizAnswers(isAutoSubmit = false) {
  if (isSubmitting || quizFinished || !clientParticipant) return;

  if (!isAutoSubmit) {
    const total = clientQuestions.length;
    const unanswered = clientQuestions.filter((q) => !hasAnswer(q.id)).length;
    const ok = await window.UI.confirm({
      title: 'Kirim jawaban sekarang?',
      message: (unanswered > 0
        ? `Masih ada ${unanswered} dari ${total} soal yang belum dijawab. Soal kosong dihitung salah.`
        : `Semua ${total} soal sudah dijawab.`) + '\n\nSetelah dikirim, jawaban tidak bisa diubah.',
      confirmText: 'Kirim sekarang',
      cancelText: 'Periksa lagi'
    });
    // Saat dialog terbuka, waktu bisa habis dan pengiriman otomatis sudah berjalan
    if (!ok || isSubmitting || quizFinished) return;
  }

  isSubmitting = true;
  window.UI.closeAllDialogs();
  window.Timer.stop();
  flushProgress();
  lockQuizUI(true);
  showSubmitOverlay('loading', 'Mengirim jawaban...');

  try {
    const result = await submitWithRetry();
    await onSubmitSuccess(result);
  } catch (err) {
    console.error('Gagal mengirim jawaban:', err);
    if (err.status === 403 || err.status === 404) {
      showSubmitOverlay('error', 'Sesi peserta tidak valid', err.message);
      $('btn-submit-retry').classList.add('hidden');
      $('btn-submit-home').classList.remove('hidden');
    } else {
      const offline = err.network || !navigator.onLine;
      showSubmitOverlay('error',
        offline ? 'Jawaban belum terkirim' : 'Gagal mengirim jawaban',
        offline
          ? 'Tidak ada koneksi ke server. Jawabanmu AMAN tersimpan di HP ini. Pastikan WiFi menyala lalu tekan "Kirim Ulang". Akan dicoba otomatis begitu internet kembali.'
          : `${err.message} Jawabanmu aman tersimpan di HP ini. Tekan "Kirim Ulang".`);
      $('btn-submit-retry').classList.remove('hidden');
    }
  } finally {
    isSubmitting = false;
  }
}

async function onSubmitSuccess(result) {
  quizFinished = true;
  window.Timer.stop();
  clearTimeout(pollTimer);
  releaseWakeLock();
  Session.save({ submitted: true, answers: {}, questions: null, localDeadline: null });
  hideSubmitOverlay();
  window.RealtimeManager.disconnect();

  await ensureQuestionsLoaded();
  showResultPanel(result);
  startRankUpdates();
}

// Review soal membutuhkan teks soal & pilihan; setelah refresh daftar soal harus dimuat ulang
async function ensureQuestionsLoaded() {
  const ids = myQuestionIds();
  if (clientQuestions.length > 0 || !clientRoom || ids.length === 0) return;
  try {
    clientQuestions = await window.API.getQuestions(ids);
  } catch (err) {
    console.error('Gagal memuat soal untuk review:', err);
  }
}

async function showResultFromServer() {
  const result = await window.API.getParticipantResult(clientParticipant.id, clientParticipant.token);
  quizFinished = true;
  await ensureQuestionsLoaded();
  showResultPanel(result);
  startRankUpdates();
}

window.submitQuizAnswers = submitQuizAnswers;
