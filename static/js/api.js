// js/api.js - pembungkus fetch ke backend

const API = {
  /**
   * @param {string} endpoint
   * @param {string} method
   * @param {object|Array|null} body
   * @param {{headers?: object, timeout?: number, retries?: number}} options
   *   retries: berapa kali diulang saat jaringan putus / server 5xx (default 1 untuk GET, 0 untuk lainnya
   *   supaya POST tidak terkirim ganda).
   */
  async request(endpoint, method = 'GET', body = null, options = {}) {
    const { headers = {}, timeout = 20000 } = options;
    const retries = options.retries !== undefined ? options.retries : (method === 'GET' ? 1 : 0);

    let attempt = 0;
    for (;;) {
      try {
        return await this._once(endpoint, method, body, headers, timeout);
      } catch (e) {
        const retryable = (e.network || (e.status >= 500 && e.status < 600)) && attempt < retries;
        if (!retryable) {
          console.error(`API Error [${method} ${endpoint}]:`, e);
          throw e;
        }
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
      }
    }
  },

  async _once(endpoint, method, body, headers, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let res;
    try {
      res = await fetch(endpoint, {
        method,
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        cache: 'no-store'
      });
    } catch (err) {
      const e = new Error(err && err.name === 'AbortError'
        ? 'Server tidak merespons (waktu habis). Periksa koneksi lalu coba lagi.'
        : 'Tidak dapat terhubung ke server. Pastikan HP terhubung ke WiFi yang sama dengan komputer host, lalu coba lagi.');
      e.network = true;
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      let message = errData.detail;
      if (Array.isArray(message)) message = message.map((m) => m.msg || m).join('; ');
      const e = new Error(message || `Error ${res.status}: ${res.statusText}`);
      e.status = res.status;
      throw e;
    }
    if (res.status === 204) return null;
    return res.json();
  },

  // System
  getServerInfo() {
    return this.request('/api/server-info');
  },

  // Auth
  login(username, password) {
    return this.request('/api/auth/login', 'POST', { username, password });
  },
  register(username, password, role) {
    return this.request('/api/auth/register', 'POST', { username, password, role });
  },
  getUsers(role = null) {
    const query = role ? `?role=${encodeURIComponent(role)}` : '';
    return this.request(`/api/auth/users${query}`);
  },
  deleteUser(userId) {
    return this.request(`/api/auth/users/${userId}`, 'DELETE');
  },

  // Questions
  getQuestions(ids = null) {
    let url = '/api/questions';
    if (ids && ids.length > 0) {
      url += `?ids=${ids.join(',')}`;
    }
    return this.request(url);
  },
  createQuestion(data) {
    return this.request('/api/questions', 'POST', data);
  },
  updateQuestion(id, data) {
    return this.request(`/api/questions/${id}`, 'PUT', data);
  },
  deleteQuestion(id) {
    return this.request(`/api/questions/${id}`, 'DELETE');
  },

  // Rooms
  createRoom(data) {
    return this.request('/api/rooms', 'POST', data);
  },
  getRoom(code) {
    return this.request(`/api/rooms/${encodeURIComponent(code)}`);
  },
  getRoomMembers(code) {
    return this.request(`/api/rooms/${encodeURIComponent(code)}/members`);
  },
  setRoomMembers(code, members) {
    return this.request(`/api/rooms/${encodeURIComponent(code)}/members`, 'PUT', { members });
  },
  getFinishedRooms() {
    return this.request('/api/rooms/finished');
  },
  getActiveRooms(createdBy = null) {
    const query = createdBy ? `?created_by=${encodeURIComponent(createdBy)}` : '';
    return this.request(`/api/rooms/active${query}`);
  },
  updateRoomStatus(code, status) {
    return this.request(`/api/rooms/${encodeURIComponent(code)}/status`, 'PUT', { status });
  },

  // Participants
  // token = kunci sesi dari join sebelumnya; dengan token, refresh halaman di HP tidak membuat peserta "terkunci".
  // authToken = token sesi LOGIN (Member). Dipakai server untuk menghubungkan peserta ke akunnya
  // (roster kuis, level soal per member, anti soal berulang).
  joinRoom(roomId, name, department, token = null, authToken = null) {
    const body = { room_id: roomId, name, department };
    if (token) body.token = token;
    const headers = authToken ? { 'X-Auth-Token': authToken } : {};
    return this.request('/api/rooms/join', 'POST', body, { headers });
  },
  leaveRoom(participantId, token) {
    return this.request(`/api/participants/${participantId}/leave`, 'POST', null, {
      headers: { 'X-Participant-Token': token || '' }
    });
  },
  getRoomParticipants(roomId) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/participants`);
  },
  submitAnswersBatch(answers, token = null) {
    return this.request('/api/answers/batch', 'POST', answers, {
      headers: token ? { 'X-Participant-Token': token } : {},
      timeout: 60000 // penilaian essay oleh AI bisa memakan waktu
    });
  },
  submitAnswerSingle(answer, token = null) {
    return this.request('/api/answers', 'POST', answer, {
      headers: token ? { 'X-Participant-Token': token } : {}
    });
  },
  finalizeParticipant(participantId, token = null) {
    return this.request(`/api/participants/${participantId}/finalize`, 'POST', {}, {
      headers: token ? { 'X-Participant-Token': token } : {},
      timeout: 60000
    });
  },
  getParticipantResult(participantId, token = null) {
    return this.request(`/api/participants/${participantId}/result`, 'GET', null, {
      headers: token ? { 'X-Participant-Token': token } : {}
    });
  },
  getRoomSummary(roomId) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/summary`);
  },

  // Import soal dari Excel (.xlsx) - upload multipart (tidak bisa lewat request JSON biasa)
  async uploadQuestionsImport(file) {
    let res;
    try {
      const form = new FormData();
      form.append('file', file, file.name || 'import.xlsx');
      res = await fetch('/api/questions/import', { method: 'POST', body: form, cache: 'no-store' });
    } catch (err) {
      const e = new Error('Tidak dapat terhubung ke server. Pastikan HP terhubung ke WiFi yang sama dengan komputer host, lalu coba lagi.');
      e.network = true;
      throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.detail || `Error ${res.status}: ${res.statusText}`);
      e.status = res.status;
      throw e;
    }
    return data;
  },

  // Unduh template Excel untuk import soal
  downloadImportTemplate() {
    const link = document.createElement('a');
    link.href = '/api/questions/import/template';
    link.download = 'template_import_soal.xlsx';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
};

window.API = API;
