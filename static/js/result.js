// js/result.js - layar hasil peserta: skor, peringkat realtime, review soal, dan PDF
//
// Bergantung pada room.js (state & helper: clientRoom, clientParticipant, clientQuestions, $, debounce).
// Skor dan kunci jawaban SELALU berasal dari server (hasil penilaian), bukan dihitung di HP.

let lastResult = null;
let rankPollTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  $('btn-download-pdf-client').addEventListener('click', downloadClientPDF);
  $('btn-finish-session').addEventListener('click', finishSession);
});

function finishSession() {
  window.RealtimeManager.disconnect();
  clearInterval(rankPollTimer);
  localStorage.removeItem('client_room_code');
  localStorage.removeItem('client_room_id');
  localStorage.removeItem('client_participant_name');
  localStorage.removeItem('client_department');
  localStorage.removeItem(SESSION_KEY);
  window.location.href = 'index.html';
}

function getOptionText(question, optionKey) {
  if (optionKey === 'A') return question.option_a;
  if (optionKey === 'B') return question.option_b;
  if (optionKey === 'C') return question.option_c;
  if (optionKey === 'D') return question.option_d;
  return '-';
}

// Teks jawaban peserta & kunci untuk satu soal (pilihan ganda: "B) teks pilihan"; essay: teks apa adanya)
function describeAnswers(question, answer) {
  const type = question.question_type || 'mcq';
  const given = (answer.answer_user || '').trim();
  const correctKey = answer.correct_answer;

  if (type === 'essay') {
    return {
      type,
      user: given ? window.escapeHTML(given) : '<em>(Tidak dijawab)</em>',
      correct: window.escapeHTML(correctKey)
    };
  }
  return {
    type,
    user: given ? `${window.escapeHTML(given)}) ${window.escapeHTML(getOptionText(question, given))}` : '<em>(Tidak dijawab)</em>',
    correct: `${window.escapeHTML(correctKey)}) ${window.escapeHTML(getOptionText(question, correctKey))}`
  };
}

// Rekap benar/total per level, mis. "Easy 3/3 · Normal 2/3 · Hard 1/2" (hanya level yang ada di soal peserta ini)
function renderLevelBreakdown(byLevel) {
  const box = $('result-level-breakdown');
  const rows = window.Levels.order.filter((level) => byLevel && byLevel[level] && byLevel[level].total > 0);
  box.innerHTML = rows.map((level) => (
    `<div class="level-stat">${window.Levels.badge(level)}<strong>${byLevel[level].correct}/${byLevel[level].total}</strong></div>`
  )).join('');
  box.classList.toggle('hidden', rows.length < 2); // satu level saja: rekapnya sama dengan Benar/Salah di atas
}

function showResultPanel(result) {
  lastResult = result;

  $('client-waiting-section').classList.add('hidden');
  $('client-quiz-section').classList.add('hidden');
  document.body.classList.remove('in-quiz');
  const resultSection = $('client-result-section');
  resultSection.classList.remove('hidden');
  window.scrollTo(0, 0);

  const status = result.status === 'PASS' ? 'PASS' : 'FAIL';
  const answers = Array.isArray(result.answers) ? result.answers : [];
  const correct = answers.filter((a) => a.is_correct).length;
  const incorrect = answers.length - correct;

  // Fill details
  $('result-score').textContent = result.score;
  $('result-rank').textContent = result.rank > 0 ? result.rank : '-';
  $('pdf-rank').textContent = result.rank > 0 ? result.rank : '-';

  const statusBadge = $('result-status-badge');
  statusBadge.textContent = status;
  statusBadge.className = `badge py-2 px-6 text-sm ${status === 'PASS' ? 'badge-pass' : 'badge-fail'}`;

  $('result-stat-correct').textContent = correct;
  $('result-stat-incorrect').textContent = incorrect;
  renderLevelBreakdown(result.by_level);

  // Render review lists (Visual review on page and Hidden printable PDF preview)
  const reviewList = $('result-review-list');
  reviewList.innerHTML = '';
  const pdfReviewList = $('pdf-questions-review-list');
  pdfReviewList.innerHTML = '';

  // Setup client printable card values
  $('pdf-date').textContent = `Tanggal: ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  $('pdf-participant-name').textContent = clientParticipant.participant_name;
  const pdfDept = $('pdf-department');
  if (pdfDept) pdfDept.textContent = clientParticipant.department || '-';
  $('pdf-quiz-name').textContent = clientRoom.quiz_name;
  $('pdf-score').textContent = result.score;
  $('pdf-status').textContent = status;

  if (clientQuestions.length === 0) {
    reviewList.innerHTML = '<p class="text-gray-500 text-sm">Review soal tidak dapat dimuat. Skor di atas tetap sah.</p>';
    return;
  }

  clientQuestions.forEach((q, idx) => {
    const ans = answers.find((a) => a.question_id === q.id);
    if (!ans) return;
    const text = describeAnswers(q, ans);
    const typeLabel = text.type === 'essay' ? 'ESSAY' : 'PILIHAN GANDA';

    // UI Question review element
    const reviewCard = document.createElement('div');
    reviewCard.className = `glass-panel p-4 border bg-opacity-10 ${ans.is_correct ? 'border-emerald-500' : 'border-red-500'}`;
    reviewCard.innerHTML = `
      <div class="flex justify-between items-center mb-2 gap-2">
        <span class="flex items-center gap-2 flex-wrap">
          <span class="text-xs text-gray-400 font-bold">SOAL ${idx + 1} (${typeLabel})</span>
          ${window.Levels.badge(q.level)}
        </span>
        <span class="badge ${ans.is_correct ? 'badge-pass' : 'badge-fail'}">${ans.is_correct ? 'BENAR' : 'SALAH'}</span>
      </div>
      <p class="font-medium text-gray-200 mb-4" style="overflow-wrap: anywhere; white-space: pre-line;">${window.escapeHTML(q.question_text)}</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
        <div style="min-width: 0; overflow-wrap: anywhere;">
          <span class="text-gray-400 block">Jawaban Anda:</span>
          <span class="font-bold ${ans.is_correct ? 'text-green-400' : 'text-red-400'}">${text.user}</span>
        </div>
        <div style="min-width: 0; overflow-wrap: anywhere;">
          <span class="text-gray-400 block">Jawaban Benar:</span>
          <span class="font-bold text-green-400">${text.correct}</span>
        </div>
      </div>
    `;
    reviewList.appendChild(reviewCard);

    // PDF Printable review element
    const pdfCard = document.createElement('div');
    pdfCard.className = 'border-b border-gray-100 py-3 pdf-avoid-break';
    pdfCard.setAttribute('style', 'border-bottom: 1px solid #e2e8f0; padding: 12px 0;');
    pdfCard.innerHTML = `
      <div style="font-weight: bold; color: #111827; margin-bottom: 4px;">${idx + 1}. ${window.escapeHTML(q.question_text)} <span style="font-size: 9px; color: #4b5563;">(${text.type.toUpperCase()} &middot; ${window.Levels.label(q.level).toUpperCase()})</span></div>
      <div style="margin-left: 10px; font-size: 11px; color: #374151;">
        <div style="margin-bottom: 2px;">Jawaban Anda: <strong style="color: ${ans.is_correct ? '#16a34a' : '#dc2626'}">${text.user}</strong></div>
        <div style="margin-bottom: 2px;">Jawaban Benar: <strong style="color: #16a34a;">${text.correct}</strong></div>
        <div>Status: <span style="color: ${ans.is_correct ? '#16a34a' : '#dc2626'}; font-weight: bold;">${ans.is_correct ? 'BENAR' : 'SALAH'}</span></div>
      </div>
    `;
    pdfReviewList.appendChild(pdfCard);
  });
}

async function downloadClientPDF() {
  const button = $('btn-download-pdf-client');
  window.UI.setBusy(button, true, 'Menyiapkan PDF...');
  try {
    await window.PDFExport.fromElement(
      $('client-pdf-print-container'),
      `${window.PDFExport.safeFilename(clientRoom.quiz_name)}.pdf`
    );
  } catch (err) {
    console.error('Gagal membuat PDF:', err);
    window.UI.toast('Gagal membuat PDF: ' + err.message, 'error', 7000);
  } finally {
    window.UI.setBusy(button, false);
  }
}

// ───────────────────────── Peringkat realtime ─────────────────────────

const refreshRankSoon = debounce(() => updateClientRank(), 500);

function startRankUpdates() {
  // Setiap peserta lain yang selesai mengubah peringkat -> dengarkan lewat WebSocket
  window.RealtimeManager.connect(clientRoom.id, {
    onAnswerSubmitted: refreshRankSoon,
    onReconnect: () => updateClientRank()
  });
  // Cadangan jika WebSocket diblokir jaringan
  clearInterval(rankPollTimer);
  rankPollTimer = setInterval(updateClientRank, 20000);
  updateClientRank(); // Initial fetch
}

async function updateClientRank() {
  try {
    let participants = await window.API.getRoomParticipants(clientRoom.id);
    participants = participants.filter((p) => p.submit_time !== null);

    // Sort participants by score DESC and submit_time ASC
    participants.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score; // Highest score first
      }
      // If scores are equal, sort by submit_time ASC (earliest time first)
      return new Date(a.submit_time).getTime() - new Date(b.submit_time).getTime();
    });

    // Find client rank
    const rankIndex = participants.findIndex((p) => p.id === clientParticipant.id);
    const rank = rankIndex !== -1 ? rankIndex + 1 : (lastResult && lastResult.rank > 0 ? lastResult.rank : '-');

    // Update UI
    const rankElement = $('result-rank');
    if (rankElement) rankElement.textContent = rank;
    const pdfRankElement = $('pdf-rank');
    if (pdfRankElement) pdfRankElement.textContent = rank;
  } catch (error) {
    console.error('Failed to fetch participants for ranking:', error);
  }
}
