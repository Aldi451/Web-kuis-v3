// js/room.js

let clientRoom = null;
let clientParticipant = null;
let clientQuestions = [];
let userAnswers = {}; // { questionId: selectedOption }
let currentQuestionIndex = 0;

document.addEventListener('DOMContentLoaded', () => {
  const roomCode = localStorage.getItem('client_room_code');
  const participantName = localStorage.getItem('client_participant_name');
  const department = localStorage.getItem('client_department') || '-';

  if (!roomCode || !participantName) {
    alert("Informasi room atau nama tidak ditemukan! Kembali ke Portal.");
    window.location.href = 'index.html';
    return;
  }

  // Check URL query parameters to prefill or override if needed
  const params = new URLSearchParams(window.location.search);
  const paramRoom = params.get('room');
  if (paramRoom && paramRoom !== roomCode) {
    // Override if url has a different room parameter
    localStorage.setItem('client_room_code', paramRoom.toUpperCase());
    window.location.reload();
    return;
  }

  initializeClientSession(roomCode, participantName, department);
});

async function initializeClientSession(roomCode, name, department) {
  try {
    // 1. Fetch Room details
    const room = await window.API.getRoom(roomCode);
    clientRoom = room;
    
    document.getElementById('client-wait-quiz-title').textContent = room.quiz_name;
    document.getElementById('client-wait-room-code').textContent = room.room_code;

    // Check if room is already On Progress or Finished
    if (room.status === 'Finished') {
      alert("Kuis sudah selesai!");
      window.location.href = 'index.html';
      return;
    }

    // 2. Join Room (Participant)
    const participant = await window.API.joinRoom(room.id, name, department);
    clientParticipant = participant;
    console.log('Registered participant:', clientParticipant);

    // 3. Render participants in waiting room
    updateWaitingParticipants();

    // 4. Connect to WebSocket
    if (window.RealtimeManager) {
      window.RealtimeManager.connect(room.id, {
        onParticipantJoined: (p) => {
          updateWaitingParticipants();
        },
        onRoomStatusChanged: (status) => {
          if (status === 'On Progress' || status === 'ON_PROGRESS') {
            startActiveQuiz();
          } else if (status === 'Finished' || status === 'FINISHED') {
            submitQuizAnswers(true);
          }
        }
      });
    }

    // If host already started the quiz prior to loading
    if (room.status === 'On Progress' || room.status === 'ON_PROGRESS') {
      startActiveQuiz();
    }
  } catch (err) {
    alert("Error joining room: " + err.message);
    window.location.href = 'index.html';
  }
}

async function updateWaitingParticipants() {
  if (!clientRoom) return;

  try {
    const participants = await window.API.getRoomParticipants(clientRoom.id);
    const list = document.getElementById('client-waiting-participants-list');
    list.innerHTML = '';
    participants.forEach(p => {
      const li = document.createElement('li');
      li.className = 'glass-panel p-2 flex items-center bg-opacity-20 border-gray-800 text-xs';
      li.innerHTML = `<span class="font-semibold text-gray-300">✓ ${escapeHTML(p.participant_name)}</span>`;
      list.appendChild(li);
    });
  } catch (err) {
    console.error("Failed to load participants:", err);
  }
}

// Start Active Quiz view
async function startActiveQuiz() {
  if (!clientRoom) return;

  // 1. Fetch questions using room.question_ids array
  const qIds = clientRoom.question_ids;
  if (!qIds || qIds.length === 0) {
    alert("Room kuis ini tidak memiliki soal!");
    return;
  }

  try {
    const questions = await window.API.getQuestions(qIds);
    clientQuestions = questions;
  } catch (error) {
    alert("Gagal memuat soal kuis: " + error.message);
    return;
  }

  // 2. Transition View
  document.getElementById('client-waiting-section').classList.add('hidden');
  document.getElementById('client-quiz-section').classList.remove('hidden');

  // 3. Initialize Timer
  window.Timer.start(clientRoom.duration_minutes * 60, handleTimerTick, handleTimerExpired);

  // 4. Render first question
  currentQuestionIndex = 0;
  renderQuestion(currentQuestionIndex);
}

function renderQuestion(index) {
  if (index < 0 || index >= clientQuestions.length) return;

  const q = clientQuestions[index];
  document.getElementById('quiz-progress-text').textContent = `Soal ${index + 1} dari ${clientQuestions.length}`;
  document.getElementById('quiz-active-title').textContent = clientRoom.quiz_name;
  document.getElementById('quiz-question-text').textContent = q.question_text;

  const qType = q.question_type || 'mcq';
  const mcqContainer = document.getElementById('client-mcq-container');
  const essayContainer = document.getElementById('client-essay-container');

  if (qType === 'essay') {
    mcqContainer.classList.add('hidden');
    essayContainer.classList.remove('hidden');

    const typedAnswer = userAnswers[q.id] || '';
    document.getElementById('client-essay-answer').value = typedAnswer;
  } else {
    mcqContainer.classList.remove('hidden');
    essayContainer.classList.add('hidden');

    document.getElementById('text-opt-A').textContent = q.option_a;
    document.getElementById('text-opt-B').textContent = q.option_b;
    document.getElementById('text-opt-C').textContent = q.option_c;
    document.getElementById('text-opt-D').textContent = q.option_d;

    // Reset selected styles
    document.querySelectorAll('.option-btn').forEach(btn => btn.classList.remove('selected'));

    // Highlight previously selected answer if exists
    const selected = userAnswers[q.id];
    if (selected) {
      document.getElementById(`btn-opt-${selected}`).classList.add('selected');
    }
  }

  // Handle navigation buttons
  document.getElementById('btn-prev-question').style.visibility = index === 0 ? 'hidden' : 'visible';
  
  const nextBtn = document.getElementById('btn-next-question');
  if (index === clientQuestions.length - 1) {
    nextBtn.textContent = 'Submit';
    nextBtn.className = 'btn btn-success text-sm';
  } else {
    nextBtn.textContent = 'Selanjutnya';
    nextBtn.className = 'btn btn-primary text-sm';
  }
}

function selectOption(option) {
  const q = clientQuestions[currentQuestionIndex];
  userAnswers[q.id] = option;

  document.querySelectorAll('.option-btn').forEach(btn => btn.classList.remove('selected'));
  document.getElementById(`btn-opt-${option}`).classList.add('selected');
}

function saveEssayAnswer() {
  const q = clientQuestions[currentQuestionIndex];
  userAnswers[q.id] = document.getElementById('client-essay-answer').value;
}
window.saveEssayAnswer = saveEssayAnswer;

function prevQuestion() {
  if (currentQuestionIndex > 0) {
    currentQuestionIndex--;
    renderQuestion(currentQuestionIndex);
  }
}

function nextQuestion() {
  if (currentQuestionIndex < clientQuestions.length - 1) {
    currentQuestionIndex++;
    renderQuestion(currentQuestionIndex);
  } else {
    // Submit Quiz
    submitQuizAnswers(false);
  }
}

function handleTimerTick(timeStr, isLow) {
  const timerSpan = document.getElementById('quiz-timer');
  timerSpan.textContent = timeStr;
  if (isLow) {
    timerSpan.classList.add('animate-pulse');
    timerSpan.style.color = 'var(--accent-danger)';
  }
}

function handleTimerExpired() {
  alert("Waktu habis! Jawaban Anda akan dikirim secara otomatis.");
  submitQuizAnswers(true);
}

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}
