// js/question-bank.js - bank soal: daftar, filter kategori, tambah/ubah/hapus, dan pemilihan soal untuk kuis

let allQuestions = [];
let categories = new Set();
// Soal yang dipilih untuk kuis. Disimpan sebagai Set (bukan hanya checkbox di layar) supaya pilihan
// TIDAK hilang saat filter kategori diganti - jadi satu kuis bisa berisi soal dari beberapa kategori.
const selectedQuestionIds = new Set();

async function loadQuestionBank() {
  try {
    const questions = await window.API.getQuestions();
    allQuestions = questions;
    categories.clear();
    const existing = new Set(questions.map((q) => q.id));
    Array.from(selectedQuestionIds).forEach((id) => { if (!existing.has(id)) selectedQuestionIds.delete(id); });
    questions.forEach((q) => {
      if (q.category) categories.add(q.category);
    });

    updateCategoryDropdowns();
    renderQuestionBank();
    renderQuestionListForQuiz();
  } catch (error) {
    console.error('Gagal memuat soal:', error);
    const tbody = document.getElementById('question-bank-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-red-500 py-4">Gagal memuat soal: ${escapeHTML(error.message)}</td></tr>`;
    }
  }
}

function updateCategoryDropdowns() {
  const filterSelect = document.getElementById('question-category-filter');
  const quizSelect = document.getElementById('quiz-category-select');

  const optionsHtml = '<option value="All">Semua Kategori</option>' +
    Array.from(categories).map((cat) => `<option value="${escapeHTML(cat)}">${escapeHTML(cat)}</option>`).join('');

  [filterSelect, quizSelect].forEach((select) => {
    if (!select) return;
    const current = select.value;
    select.innerHTML = optionsHtml;
    select.value = categories.has(current) ? current : 'All';
  });
}

function renderQuestionBank() {
  const tbody = document.getElementById('question-bank-tbody');
  if (!tbody) return;

  const filterVal = document.getElementById('question-category-filter').value;
  const filtered = filterVal === 'All' ? allQuestions : allQuestions.filter((q) => q.category === filterVal);

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-500 py-4">Tidak ada soal ditemukan.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  filtered.forEach((q) => {
    const qType = q.question_type || 'mcq';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td data-label="Pertanyaan" class="font-medium"><div class="cell-clamp">${escapeHTML(q.question_text)}</div></td>
      <td data-label="Kategori">
        <span class="badge badge-waiting">${escapeHTML(q.category || 'Umum')}</span>
        <span class="badge ${qType === 'essay' ? 'badge-pass' : 'badge-waiting'}" style="text-transform: uppercase;">${escapeHTML(qType)}</span>
      </td>
      <td data-label="Kunci Jawaban" class="font-bold text-indigo-400"><div class="cell-clamp">${escapeHTML(q.correct_option)}</div></td>
      <td class="text-right cell-actions">
        <div class="row-actions">
          <button type="button" onclick="editQuestion(${Number(q.id)})" class="btn btn-secondary text-xs py-1 px-3" style="min-height: 38px;">Edit</button>
          <button type="button" onclick="deleteQuestion(${Number(q.id)})" class="btn btn-danger text-xs py-1 px-3" style="min-height: 38px;">Hapus</button>
        </div>
      </td>
    `;
    tbody.appendChild(row);
  });
}

function renderQuestionListForQuiz() {
  const container = document.getElementById('quiz-question-list-container');
  if (!container) return;

  const categoryFilterVal = document.getElementById('quiz-category-select').value;
  const filtered = categoryFilterVal === 'All' ? allQuestions : allQuestions.filter((q) => q.category === categoryFilterVal);

  if (filtered.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm">Tidak ada soal tersedia untuk kategori ini.</p>';
    updateSelectedCount();
    return;
  }

  container.innerHTML = '';
  filtered.forEach((q) => {
    const div = document.createElement('div');
    div.className = 'flex items-start gap-3 p-3 border-b border-gray-800 hover:bg-gray-900 rounded-lg mb-2';
    div.innerHTML = `
      <input type="checkbox" name="quiz_questions" value="${Number(q.id)}" id="chk-q-${Number(q.id)}" class="mt-1"
             style="width: 22px; height: 22px; flex: 0 0 auto;" ${selectedQuestionIds.has(q.id) ? 'checked' : ''}>
      <label for="chk-q-${Number(q.id)}" class="text-sm cursor-pointer flex-1" style="min-width: 0; overflow-wrap: anywhere;">
        <div class="font-medium text-gray-200">${escapeHTML(q.question_text)}</div>
        <div class="text-xs text-gray-400 mt-1">
          Kategori: <span class="text-indigo-400">${escapeHTML(q.category || 'Umum')}</span>
          <span class="badge ${(q.question_type || 'mcq') === 'essay' ? 'badge-pass' : 'badge-waiting'}" style="text-transform: uppercase; margin-left: 4px;">${escapeHTML(q.question_type || 'mcq')}</span>
        </div>
      </label>
    `;
    div.querySelector('input').addEventListener('change', (event) => {
      if (event.target.checked) selectedQuestionIds.add(q.id);
      else selectedQuestionIds.delete(q.id);
      updateSelectedCount();
    });
    container.appendChild(div);
  });
  updateSelectedCount();
}

function updateSelectedCount() {
  const countSpan = document.getElementById('selected-questions-count');
  if (countSpan) {
    countSpan.textContent = `${selectedQuestionIds.size} Terpilih`;
  }
}

// ID soal terpilih, berurutan sesuai bank soal
function getSelectedQuestionIds() {
  return allQuestions.filter((q) => selectedQuestionIds.has(q.id)).map((q) => q.id);
}

// "Pilih semua" / "Kosongkan" berlaku untuk soal pada kategori yang sedang ditampilkan
function setAllQuestionsSelected(selected) {
  const categoryFilterVal = document.getElementById('quiz-category-select').value;
  const visible = categoryFilterVal === 'All' ? allQuestions : allQuestions.filter((q) => q.category === categoryFilterVal);
  visible.forEach((q) => {
    if (selected) selectedQuestionIds.add(q.id);
    else selectedQuestionIds.delete(q.id);
  });
  renderQuestionListForQuiz();
}

function toggleOptionFields() {
  const type = document.getElementById('question-type').value;
  const optionsContainer = document.getElementById('options-container');
  const mcqContainer = document.getElementById('correct-option-mcq-container');
  const essayContainer = document.getElementById('correct-option-essay-container');

  const optA = document.getElementById('option-a');
  const optB = document.getElementById('option-b');
  const optC = document.getElementById('option-c');
  const optD = document.getElementById('option-d');

  if (type === 'essay') {
    optionsContainer.classList.add('hidden');
    mcqContainer.classList.add('hidden');
    essayContainer.classList.remove('hidden');

    // Set required false for options when essay
    optA.required = false;
    optB.required = false;
    optC.required = false;
    optD.required = false;
  } else {
    optionsContainer.classList.remove('hidden');
    mcqContainer.classList.remove('hidden');
    essayContainer.classList.add('hidden');

    optA.required = true;
    optB.required = true;
    optC.required = true;
    optD.required = true;
  }
}

// Modal actions
function showQuestionModal(title) {
  document.getElementById('question-modal-title').textContent = title;
  document.getElementById('question-modal').classList.remove('hidden');
  document.body.classList.add('modal-open');
  // Di HP jangan langsung memunculkan keyboard; di desktop fokuskan kolom pertama
  if (!window.UI.isMobile()) document.getElementById('question-text').focus();
}

function openQuestionModal() {
  document.getElementById('form-question').reset();
  document.getElementById('edit-question-id').value = '';
  document.getElementById('question-type').value = 'mcq';
  toggleOptionFields();
  showQuestionModal('Tambah Soal Baru');
}

function closeQuestionModal() {
  document.getElementById('question-modal').classList.add('hidden');
  if (!document.querySelector('.ui-modal-backdrop')) document.body.classList.remove('modal-open');
}

async function editQuestion(id) {
  const q = allQuestions.find((item) => item.id === id);
  if (!q) return;

  document.getElementById('edit-question-id').value = q.id;
  document.getElementById('question-text').value = q.question_text;

  const qType = q.question_type || 'mcq';
  document.getElementById('question-type').value = qType;
  toggleOptionFields();

  if (qType === 'essay') {
    document.getElementById('correct-option-essay').value = q.correct_option;
  } else {
    document.getElementById('option-a').value = q.option_a;
    document.getElementById('option-b').value = q.option_b;
    document.getElementById('option-c').value = q.option_c;
    document.getElementById('option-d').value = q.option_d;
    document.getElementById('correct-option').value = q.correct_option;
  }

  document.getElementById('question-category').value = q.category;
  showQuestionModal('Edit Soal');
}

async function deleteQuestion(id) {
  const ok = await window.UI.confirm({
    title: 'Hapus soal ini?',
    message: 'Soal akan dihapus dari bank soal. Tindakan ini tidak bisa dibatalkan.',
    confirmText: 'Hapus',
    cancelText: 'Batal',
    danger: true
  });
  if (!ok) return;

  try {
    await window.API.deleteQuestion(id);
    selectedQuestionIds.delete(id);
    loadQuestionBank();
  } catch (error) {
    window.UI.alert('Gagal menghapus soal: ' + error.message);
  }
}

// Save question handler
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('form-question');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('edit-question-id').value;
      const question_text = document.getElementById('question-text').value.trim();
      const question_type = document.getElementById('question-type').value;
      const category = document.getElementById('question-category').value.trim();

      let option_a = '';
      let option_b = '';
      let option_c = '';
      let option_d = '';
      let correct_option = '';

      if (question_type === 'essay') {
        correct_option = document.getElementById('correct-option-essay').value.trim();
      } else {
        option_a = document.getElementById('option-a').value.trim();
        option_b = document.getElementById('option-b').value.trim();
        option_c = document.getElementById('option-c').value.trim();
        option_d = document.getElementById('option-d').value.trim();
        correct_option = document.getElementById('correct-option').value;
      }

      const payload = { question_text, option_a, option_b, option_c, option_d, correct_option, category, question_type };

      const submitButton = form.querySelector('button[type="submit"]');
      window.UI.setBusy(submitButton, true, 'Menyimpan...');
      try {
        if (id) {
          // Update
          await window.API.updateQuestion(id, payload);
        } else {
          // Insert
          await window.API.createQuestion(payload);
        }
        // Modal ditutup HANYA jika berhasil; jika gagal, isian pengguna tetap ada agar tidak perlu mengetik ulang
        closeQuestionModal();
        window.UI.toast('Soal berhasil disimpan.', 'success');
        loadQuestionBank();
      } catch (error) {
        window.UI.alert('Gagal menyimpan: ' + error.message);
      } finally {
        window.UI.setBusy(submitButton, false);
      }
    });
  }

  // Tombol Esc menutup modal soal (HP: tombol ✕)
  document.addEventListener('keydown', (event) => {
    const modal = document.getElementById('question-modal');
    if (event.key === 'Escape' && modal && !modal.classList.contains('hidden') && !document.querySelector('.ui-modal-backdrop')) {
      closeQuestionModal();
    }
  });

  const catFilter = document.getElementById('question-category-filter');
  if (catFilter) {
    catFilter.addEventListener('change', renderQuestionBank);
  }

  const quizCatSelect = document.getElementById('quiz-category-select');
  if (quizCatSelect) {
    quizCatSelect.addEventListener('change', renderQuestionListForQuiz);
  }
});
