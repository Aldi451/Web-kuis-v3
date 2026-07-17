// js/result.js

async function submitQuizAnswers(isAutoSubmit = false) {
  // Stop the timer
  window.Timer.stop();

  if (!isAutoSubmit) {
    if (!confirm("Apakah Anda yakin ingin menyelesaikan kuis sekarang?")) {
      // Restart timer if user declines (would require keeping track of exact time, but simple prompt is ok)
      window.Timer.start(window.Timer.timeRemaining, handleTimerTick, handleTimerExpired);
      return;
    }
  }

  // Disable UI
  document.getElementById('btn-next-question').disabled = true;
  document.getElementById('btn-prev-question').disabled = true;
  document.querySelectorAll('.option-btn').forEach(btn => btn.disabled = true);

  // 1. Calculate Score & Correct/Incorrect Answers
  let correctCount = 0;
  let incorrectCount = 0;
  const answersPayload = [];

  clientQuestions.forEach(q => {
    const userAnswer = userAnswers[q.id] || '-';
    const isCorrect = userAnswer === q.correct_option;

    if (isCorrect) {
      correctCount++;
    } else {
      incorrectCount++;
    }

    answersPayload.push({
      room_id: clientRoom.id,
      participant_name: clientParticipant.participant_name,
      question_id: q.id,
      answer_user: userAnswer,
      correct_answer: q.correct_option,
      is_correct: isCorrect
    });
  });

  const rawScore = (correctCount / clientQuestions.length) * 100;
  const finalScore = Math.round(rawScore);
  const status = finalScore >= clientRoom.passing_grade ? 'PASS' : 'FAIL';

  let evaluatedAnswers = answersPayload;
  let finalScoreCalculated = finalScore;
  let finalStatusCalculated = status;
  let correctCountCalculated = correctCount;
  let incorrectCountCalculated = incorrectCount;

  try {
    if (answersPayload.length > 0) {
      const response = await window.API.submitAnswersBatch(answersPayload);
      if (response && response.answers) {
        evaluatedAnswers = response.answers;
        finalScoreCalculated = response.score;
        finalStatusCalculated = response.status;
        
        // Recalculate stats based on backend
        correctCountCalculated = evaluatedAnswers.filter(a => a.is_correct).length;
        incorrectCountCalculated = evaluatedAnswers.length - correctCountCalculated;
      }
    } else {
      // Just finalize if no answers
      await window.API.request(`/api/participants/${clientParticipant.id}/finalize`, 'POST', {
        score: finalScore,
        status: status
      });
    }
  } catch (err) {
    console.error("Gagal menyimpan hasil kuis:", err);
  }

  // Unsubscribe realtime events
  window.RealtimeManager.unsubscribeAll();

  // 4. Render Results Screen
  showResultPanel(finalScoreCalculated, finalStatusCalculated, correctCountCalculated, incorrectCountCalculated, evaluatedAnswers);

  // 5. Start real-time rank subscription
  window.RealtimeManager.subscribeToClientRank(clientRoom.id, () => {
    updateClientRank();
  });
  updateClientRank(); // Initial fetch
}

function showResultPanel(score, status, correct, incorrect, answers) {
  document.getElementById('client-quiz-section').classList.add('hidden');
  const resultSection = document.getElementById('client-result-section');
  resultSection.classList.remove('hidden');

  // Fill details
  document.getElementById('result-score').textContent = score;
  
  const statusBadge = document.getElementById('result-status-badge');
  statusBadge.textContent = status;
  if (status === 'PASS') {
    statusBadge.className = 'badge py-2 px-6 text-sm badge-pass';
  } else {
    statusBadge.className = 'badge py-2 px-6 text-sm badge-fail';
  }

  document.getElementById('result-stat-correct').textContent = correct;
  document.getElementById('result-stat-incorrect').textContent = incorrect;

  // Render review lists (Visual review on page and Hidden printable PDF preview)
  const reviewList = document.getElementById('result-review-list');
  reviewList.innerHTML = '';

  const pdfReviewList = document.getElementById('pdf-questions-review-list');
  pdfReviewList.innerHTML = '';

  // Setup client printable card values
  document.getElementById('pdf-date').textContent = `Tanggal: ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  document.getElementById('pdf-participant-name').textContent = clientParticipant.participant_name;
  
  const pdfDept = document.getElementById('pdf-department');
  if (pdfDept) pdfDept.textContent = clientParticipant.department || '-';
  
  document.getElementById('pdf-quiz-name').textContent = clientRoom.quiz_name;
  document.getElementById('pdf-score').textContent = score;
  document.getElementById('pdf-status').textContent = status;

  clientQuestions.forEach((q, idx) => {
    const ans = answers.find(a => a.question_id === q.id);
    const userAnswerStr = ans ? ans.answer_user : '-';
    const qType = q.question_type || 'mcq';
    
    // UI Question review element
    const reviewCard = document.createElement('div');
    reviewCard.className = `glass-panel p-4 border bg-opacity-10 ${ans.is_correct ? 'border-emerald-500' : 'border-red-500'}`;
    
    let answerTextUser = "";
    let answerTextCorrect = "";

    if (qType === 'essay') {
      answerTextUser = escapeHTML(userAnswerStr);
      answerTextCorrect = escapeHTML(q.correct_option);
    } else {
      answerTextUser = `${userAnswerStr}) ${escapeHTML(getOptionText(q, userAnswerStr))}`;
      answerTextCorrect = `${q.correct_option}) ${escapeHTML(getOptionText(q, q.correct_option))}`;
    }

    reviewCard.innerHTML = `
      <div class="flex justify-between items-center mb-2">
        <span class="text-xs text-gray-400 font-bold">SOAL ${idx + 1} (${qType === 'essay' ? 'ESSAY' : 'PILIHAN GANDA'})</span>
        <span class="badge ${ans.is_correct ? 'badge-pass' : 'badge-fail'}">${ans.is_correct ? 'BENAR' : 'SALAH'}</span>
      </div>
      <p class="font-medium text-gray-200 mb-4">${escapeHTML(q.question_text)}</p>
      <div class="grid grid-cols-2 gap-4 text-xs">
        <div>
          <span class="text-gray-400 block">Jawaban Anda:</span>
          <span class="font-bold ${ans.is_correct ? 'text-green-400' : 'text-red-400'}">${answerTextUser}</span>
        </div>
        <div>
          <span class="text-gray-400 block">Jawaban Benar:</span>
          <span class="font-bold text-green-400">${answerTextCorrect}</span>
        </div>
      </div>
    `;
    reviewList.appendChild(reviewCard);

    // PDF Printable review element
    const pdfCard = document.createElement('div');
    pdfCard.className = 'border-b border-gray-100 py-3';
    pdfCard.setAttribute('style', 'border-bottom: 1px solid #e2e8f0; padding: 12px 0;');
    pdfCard.innerHTML = `
      <div style="font-weight: bold; color: #111827; margin-bottom: 4px;">${idx + 1}. ${escapeHTML(q.question_text)} <span style="font-size: 9px; color: #4b5563;">(${qType.toUpperCase()})</span></div>
      <div style="margin-left: 10px; font-size: 11px; color: #374151;">
        <div style="margin-bottom: 2px;">Jawaban Anda: <strong style="color: ${ans.is_correct ? '#16a34a' : '#dc2626'}">${answerTextUser}</strong></div>
        <div style="margin-bottom: 2px;">Jawaban Benar: <strong style="color: #16a34a;">${answerTextCorrect}</strong></div>
        <div>Status: <span style="color: ${ans.is_correct ? '#16a34a' : '#dc2626'}; font-weight: bold;">${ans.is_correct ? 'BENAR' : 'SALAH'}</span></div>
      </div>
    `;
    pdfReviewList.appendChild(pdfCard);
  });

  // Attach PDF download action
  document.getElementById('btn-download-pdf-client').addEventListener('click', downloadClientPDF);
}

function getOptionText(question, optionKey) {
  if (optionKey === 'A') return question.option_a;
  if (optionKey === 'B') return question.option_b;
  if (optionKey === 'C') return question.option_c;
  if (optionKey === 'D') return question.option_d;
  return '-';
}

function downloadClientPDF() {
  const element = document.getElementById('client-pdf-print-container');
  element.classList.remove('hidden');

  const opt = {
    margin:       10,
    filename:     `${clientRoom.quiz_name.replace(/\s+/g, '_')}.pdf`,
    image:        { type: 'jpeg', quality: 0.98 },
    html2canvas:  { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
    jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };

  html2pdf().set(opt).from(element).save().then(() => {
    element.classList.add('hidden');
  });
}

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

async function updateClientRank() {
  try {
    let participants = await window.API.getRoomParticipants(clientRoom.id);
    participants = participants.filter(p => p.submit_time !== null);

  // Sort participants by score DESC and submit_time ASC
  participants.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score; // Highest score first
    }
    // If scores are equal, sort by submit_time ASC (earliest time first)
    const timeA = new Date(a.submit_time).getTime();
    const timeB = new Date(b.submit_time).getTime();
    return timeA - timeB;
  });

  // Find client rank
  const rankIndex = participants.findIndex(p => p.id === clientParticipant.id);
  const rank = rankIndex !== -1 ? rankIndex + 1 : '-';

  // Update UI
  const rankElement = document.getElementById('result-rank');
  if (rankElement) {
    rankElement.textContent = rank;
  }
  const pdfRankElement = document.getElementById('pdf-rank');
  if (pdfRankElement) {
    pdfRankElement.textContent = rank;
  }
  } catch (error) {
    console.error('Failed to fetch participants for ranking:', error);
  }
}

window.submitQuizAnswers = submitQuizAnswers;
