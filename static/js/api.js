// js/api.js

const API = {
  async request(endpoint, method = 'GET', body = null) {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    try {
      const res = await fetch(endpoint, options);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Error ${res.status}: ${res.statusText}`);
      }
      return await res.json();
    } catch (e) {
      console.error(`API Error [${method} ${endpoint}]:`, e);
      throw e;
    }
  },

  // Auth
  login(username, password) {
    return this.request('/api/auth/login', 'POST', { username, password });
  },
  register(username, password, role) {
    return this.request('/api/auth/register', 'POST', { username, password, role });
  },
  getUsers() {
    return this.request('/api/auth/users');
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
    return this.request(`/api/rooms/${code}`);
  },
  getFinishedRooms() {
    return this.request('/api/rooms/finished');
  },
  updateRoomStatus(code, status) {
    return this.request(`/api/rooms/${code}/status`, 'PUT', { status });
  },
  
  // Participants
  joinRoom(roomId, name, department) {
    return this.request('/api/rooms/join', 'POST', { room_id: roomId, name, department });
  },
  getRoomParticipants(roomId) {
    return this.request(`/api/rooms/${roomId}/participants`);
  },
  submitAnswersBatch(answers) {
    return this.request('/api/answers/batch', 'POST', answers);
  },
  submitAnswerSingle(answer) {
    return this.request('/api/answers', 'POST', answer);
  },
  getRoomSummary(roomId) {
    return this.request(`/api/rooms/${roomId}/summary`);
  }
};

window.API = API;
