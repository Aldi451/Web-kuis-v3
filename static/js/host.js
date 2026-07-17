// js/host.js

let activeRoom = null;
let selectedRoomHistory = null;

document.addEventListener('DOMContentLoaded', () => {
  // Guard page for Host role only
  const currentUser = window.Auth.requireRole(['Host', 'Admin']);
  document.getElementById('host-welcome').textContent = `${currentUser.username} (${currentUser.role})`;

  // Initialize Question Bank
  loadQuestionBank();
  loadHistoryList();

  // Create Quiz Event
  document.getElementById('btn-generate-quiz').addEventListener('click', createQuizRoom);
  
  // Start Quiz Event
  document.getElementById('btn-start-quiz').addEventListener('click', startQuiz);

  // Finish Quiz Event
  document.getElementById('btn-finish-quiz').addEventListener('click', finishQuiz);

  // PDF Download Event
  document.getElementById('btn-download-hrd-pdf').addEventListener('click', downloadHRDPDF);
});

// Switch Dashboard Tab Views
function switchTab(tabId) {
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(section => section.classList.add('hidden'));

  const activeBtn = document.getElementById(`tab-${tabId}`);
  if (activeBtn) activeBtn.classList.add('active');

  const activeSection = document.getElementById(`section-${tabId}`);
  if (activeSection) activeSection.classList.remove('hidden');

  // Reload history when entering history tab
  if (tabId === 'quiz-history') {
    loadHistoryList();
  }
}

// Generate Room Code
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Create Quiz Room Action
async function createQuizRoom() {
  const name = document.getElementById('quiz-name').value.trim();
  const duration = parseInt(document.getElementById('quiz-duration').value);
  const passingGrade = parseInt(document.getElementById('quiz-passing-grade').value);
  
  // Get checked questions
  const selectedCheckboxes = document.querySelectorAll('input[name="quiz_questions"]:checked');
  const questionIds = Array.from(selectedCheckboxes).map(chk => parseInt(chk.value));

  if (!name || isNaN(duration) || isNaN(passingGrade)) {
    alert("Mohon lengkapi semua parameter kuis!");
    return;
  }

  if (questionIds.length === 0) {
    alert("Pilih minimal 1 soal dari daftar bank soal untuk kuis!");
    return;
  }

  const roomCode = generateRoomCode();

  // Save room details to API
  try {
    const room = await window.API.createRoom({
      title: name,
      duration: duration,
      passing_grade: passingGrade,
      question_ids: questionIds,
      created_by: window.Auth.getCurrentUser().username
    });
    activeRoom = room;

  // Render Waiting Room Details
  document.getElementById('wait-quiz-title').textContent = room.quiz_name;
  document.getElementById('wait-room-code').textContent = room.room_code;
  document.getElementById('btn-start-quiz').disabled = false;

  // Generate QR Code
  const qrContainer = document.getElementById('wait-qrcode');
  qrContainer.innerHTML = '';
  const clientUrl = `${window.location.origin}${window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/'))}/index.html?room=${room.room_code}`;
  
  new QRCode(qrContainer, {
    text: clientUrl,
    width: 128,
    height: 128,
    colorDark: "#0b0f19",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.H
  });

  // Subscribe to waiting room participants join
  window.RealtimeManager.subscribeToWaitingRoom(room.id, updateWaitingRoomParticipants);

  // Switch to Waiting Room tab
  switchTab('waiting-room');
  updateWaitingRoomParticipants();
} catch (error) {
    alert("Gagal membuat room kuis: " + error.message);
  }
}

// Fetch and Render Waiting Room Participants list
async function updateWaitingRoomParticipants() {
  if (!activeRoom) return;

  try {
    const participants = await window.API.getRoomParticipants(activeRoom.id);

  const countSpan = document.getElementById('wait-participants-count');
  countSpan.textContent = `${participants.length} Peserta`;

  const list = document.getElementById('wait-participants-list');
  if (participants.length === 0) {
    list.innerHTML = '<li class="text-gray-500 text-sm text-center py-4">Menunggu peserta masuk...</li>';
    return;
  }

  list.innerHTML = '';
  participants.forEach(p => {
    const li = document.createElement('li');
    li.className = 'glass-panel p-3 flex justify-between items-center bg-opacity-30 border-gray-800';
    li.innerHTML = `
      <span class="font-semibold text-gray-200">✓ ${escapeHTML(p.participant_name)}</span>
      <span class="text-xs text-green-400">Ready</span>
    `;
    list.appendChild(li);
  });
  } catch (error) {
    console.error("Gagal mengambil data peserta:", error);
  }
}

// Start Quiz Action
async function startQuiz() {
  if (!activeRoom) return;

  try {
    // Change room status to On Progress
    const room = await window.API.updateRoomStatus(activeRoom.id, 'On Progress');
    activeRoom = room;

  // Setup active monitoring view
  document.getElementById('monitor-room-info').textContent = `Kuis: ${room.quiz_name} | Kode: ${room.room_code}`;
  
  // Switch to monitoring tab
  switchTab('active-monitoring');

  // Subscribe to realtime updates for active scoreboard
  window.RealtimeManager.subscribeToActiveRoom(room.id, handleNewAnswer, updateActiveMonitoring);
  updateActiveMonitoring();
  } catch (error) {
    alert("Gagal memulai kuis: " + error.message);
  }
}

function handleNewAnswer(answer) {
  console.log("Realtime answer received:", answer);
  // Optional animation or small sound helper
}

// Fetch and updates active monitoring scoreboard
async function updateActiveMonitoring() {
  if (!activeRoom) return;

  try {
    const participants = await window.API.getRoomParticipants(activeRoom.id);

  // Calculate stats
  let total = participants.length;
  let submitted = participants.filter(p => p.submit_time !== null).length;
  let passed = participants.filter(p => p.status === 'PASS').length;
  let failed = participants.filter(p => p.status === 'FAIL').length;

  document.getElementById('monitor-stat-total').textContent = total;
  document.getElementById('monitor-stat-submitted').textContent = submitted;
  document.getElementById('monitor-stat-pass').textContent = passed;
  document.getElementById('monitor-stat-fail').textContent = failed;

  // Render Table
  const tbody = document.getElementById('monitor-table-tbody');
  if (participants.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-500 py-4">Belum ada peserta terdaftar.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  participants.forEach(p => {
    const row = document.createElement('tr');
    const statusBadge = p.submit_time ? 
      (p.status === 'PASS' ? '<span class="badge badge-pass">PASS</span>' : '<span class="badge badge-fail">FAIL</span>') : 
      '<span class="badge badge-waiting">ON PROGRESS</span>';

    row.innerHTML = `
      <td class="font-medium">${escapeHTML(p.participant_name)}</td>
      <td class="font-bold text-gray-200">${p.score !== null ? p.score : '-'}</td>
      <td>${statusBadge}</td>
      <td class="text-xs text-gray-400">${new Date(p.join_time).toLocaleTimeString()}</td>
      <td class="text-xs text-gray-400">${p.submit_time ? new Date(p.submit_time).toLocaleTimeString() : '-'}</td>
    `;
    tbody.appendChild(row);
  });
  } catch (error) {
    console.error("Gagal mengambil data monitoring:", error);
  }
}

// Finish Quiz Action
async function finishQuiz() {
  if (!activeRoom) return;

  if (!confirm("Apakah Anda yakin ingin mengakhiri kuis ini sekarang? Semua peserta yang masih berjalan akan di-auto-submit.")) {
    return;
  }

  try {
    // Update room status to Finished
    await window.API.updateRoomStatus(activeRoom.id, 'Finished');

    alert("Kuis berhasil diakhiri! Hasil akhir dapat dilihat di tab Riwayat Kuis & Laporan.");
    
    // Unsubscribe realtime listeners
    window.RealtimeManager.unsubscribeAll();
    activeRoom = null;

    switchTab('quiz-history');
  } catch (error) {
    alert("Gagal mengakhiri kuis: " + error.message);
  }
}

// Load history list in the history tab
async function loadHistoryList() {
  const container = document.getElementById('history-rooms-list');
  if (!container) return;

  try {
    const rooms = await window.API.getFinishedRooms();

  if (rooms.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm text-center py-4">Belum ada riwayat kuis.</p>';
    return;
  }

  container.innerHTML = '';
  rooms.forEach(room => {
    const btn = document.createElement('button');
    btn.className = 'w-full text-left p-3 glass-panel bg-opacity-20 border-gray-800 hover:border-indigo-500 hover:bg-gray-900 transition mb-2 rounded-lg flex flex-col gap-1';
    btn.innerHTML = `
      <div class="font-bold text-gray-200 text-sm truncate">${escapeHTML(room.quiz_name)}</div>
      <div class="flex justify-between items-center w-full mt-1">
        <span class="text-xs text-indigo-400 font-semibold">${room.room_code}</span>
        <span class="text-xs text-gray-400">${new Date(room.created_at).toLocaleDateString()}</span>
      </div>
    `;
    btn.addEventListener('click', () => selectHistoryRoom(room));
    container.appendChild(btn);
  });
  } catch (error) {
    container.innerHTML = '<p class="text-red-500 text-sm">Gagal memuat riwayat.</p>';
  }
}

// Fetch details of selected history room and render HRD report
async function selectHistoryRoom(room) {
  selectedRoomHistory = room;

  // Hide placeholder, show print container
  document.getElementById('history-placeholder-msg').classList.add('hidden');
  const printContainer = document.getElementById('hrd-report-print-container');
  printContainer.classList.remove('hidden');
  document.getElementById('btn-download-hrd-pdf').disabled = false;

  try {
    const participants = await window.API.getRoomParticipants(room.id);
    const summary = await window.API.getRoomSummary(room.id).catch(() => null);

  // Populate data
  document.getElementById('report-date-created').textContent = `Tanggal: ${new Date(room.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  document.getElementById('report-quiz-name').textContent = room.quiz_name;
  document.getElementById('report-room-code').textContent = room.room_code;
  document.getElementById('report-passing-grade').textContent = `${room.passing_grade}%`;
  document.getElementById('report-total-participants').textContent = participants.length;
  document.getElementById('report-time-duration').textContent = `${room.duration_minutes} Menit`;
  document.getElementById('report-initiator').textContent = room.created_by || 'Host';

  const tbody = document.getElementById('report-participants-tbody');
  tbody.innerHTML = '';
  
  if (participants.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-500 py-4">Tidak ada peserta berpartisipasi.</td></tr>';
  } else {
    participants.forEach((p, idx) => {
      const row = document.createElement('tr');
      row.setAttribute('style', 'border-bottom: 1px solid #e2e8f0;');
      row.innerHTML = `
        <td style="padding: 8px 0; color: #4b5563;">${idx + 1}</td>
        <td style="padding: 8px 0; font-weight: 600; color: #111827;">${escapeHTML(p.participant_name)}</td>
        <td style="padding: 8px 0; color: #111827; font-weight: bold;">${p.score !== null ? p.score : 0}</td>
        <td style="padding: 8px 0; text-align: right;">
          <span style="font-weight: bold; padding: 2px 8px; border-radius: 4px; font-size: 11px;
            color: ${p.status === 'PASS' ? '#16a34a' : '#dc2626'};
            background: ${p.status === 'PASS' ? '#f0fdf4' : '#fef2f2'};
            border: 1px solid ${p.status === 'PASS' ? '#bbf7d0' : '#fecaca'};">
            ${p.status}
          </span>
        </td>
      `;
      tbody.appendChild(row);
    });
  }

  if (summary) {
    document.getElementById('report-average-score').textContent = summary.average_score;
    document.getElementById('report-pass-count').textContent = summary.pass_count;
    document.getElementById('report-fail-count').textContent = summary.fail_count;
  } else {
    // Recalculate dynamically if summary record was missing
    let totalScoreSum = 0;
    let passCount = 0;
    let failCount = 0;

    participants.forEach(p => {
      totalScoreSum += (p.score || 0);
      if (p.status === 'PASS') passCount++;
      if (p.status === 'FAIL') failCount++;
    });

    const averageScore = participants.length > 0 ? (totalScoreSum / participants.length).toFixed(2) : 0;
    document.getElementById('report-average-score').textContent = averageScore;
    document.getElementById('report-pass-count').textContent = passCount;
      document.getElementById('report-fail-count').textContent = failCount;
    }
  } catch (error) {
    console.error("Gagal memuat detail riwayat kuis:", error);
  }
}

// Download Assessment Report PDF using html2pdf.js
function downloadHRDPDF() {
  if (!selectedRoomHistory) return;

  const element = document.getElementById('hrd-report-print-container');
  
  const opt = {
    margin:       10,
    filename:     `HRD_Assessment_Report_${selectedRoomHistory.quiz_name.replace(/\s+/g, '_')}.pdf`,
    image:        { type: 'jpeg', quality: 0.98 },
    html2canvas:  { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
    jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };

  html2pdf().set(opt).from(element).save();
}

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}
