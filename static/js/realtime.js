// js/realtime.js - koneksi WebSocket yang tahan banting untuk HP
//
// Masalah di HP: layar terkunci / pindah aplikasi / pindah WiFi-seluler memutus WebSocket TANPA pemberitahuan,
// lalu peserta tidak pernah menerima "kuis dimulai". Yang dilakukan di sini:
//   * sambung ulang otomatis dengan jeda bertahap (backoff)
//   * heartbeat ping/pong untuk mendeteksi koneksi "setengah mati"
//   * sambung ulang seketika saat layar menyala lagi / internet kembali
//   * memanggil onReconnect() agar halaman mengambil ulang status terbaru lewat REST

const RealtimeManager = {
  socket: null,
  roomId: null,
  callbacks: {},
  state: 'closed',            // 'connecting' | 'open' | 'reconnecting' | 'closed'
  _wanted: false,
  _attempt: 0,
  _retryTimer: null,
  _heartbeatTimer: null,
  _lastActivity: 0,
  _everConnected: false,
  _globalBound: false,

  connect(roomId, handlers = {}) {
    // Room yang sama dan koneksi masih hidup: cukup ganti handler, jangan putus-sambung lagi
    if (this.roomId === roomId && this.socket && this.socket.readyState <= 1 && this._wanted) {
      this.callbacks = handlers;
      return;
    }
    this.disconnect();
    this.roomId = roomId;
    this.callbacks = handlers;
    this._wanted = true;
    this._attempt = 0;
    this._everConnected = false;
    this._bindGlobalEvents();
    this._open();
  },

  _url() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:8000';
    return `${protocol}//${host}/ws/${encodeURIComponent(this.roomId)}`;
  },

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    if (this.callbacks.onConnectionChange) this.callbacks.onConnectionChange(state);
  },

  _open() {
    if (!this._wanted) return;
    clearTimeout(this._retryTimer);
    this._setState(this._everConnected ? 'reconnecting' : 'connecting');

    let ws;
    try {
      ws = new WebSocket(this._url());
    } catch (err) {
      console.error('Realtime: gagal membuat WebSocket', err);
      this._scheduleReconnect();
      return;
    }
    this.socket = ws;

    ws.onopen = () => {
      if (this.socket !== ws) return;
      const wasReconnect = this._everConnected;
      this._everConnected = true;
      this._attempt = 0;
      this._lastActivity = Date.now();
      this._setState('open');
      this._startHeartbeat();
      // Event yang terlewat saat terputus tidak akan dikirim ulang oleh server -> minta halaman sinkron ulang
      if (wasReconnect && this.callbacks.onReconnect) this.callbacks.onReconnect();
    };

    ws.onmessage = (event) => {
      if (this.socket !== ws) return;
      this._lastActivity = Date.now();
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        console.error('Realtime: pesan tidak valid', err);
        return;
      }
      this._dispatch(message);
    };

    ws.onclose = () => {
      if (this.socket !== ws) return;
      this._stopHeartbeat();
      this.socket = null;
      if (this._wanted) this._scheduleReconnect();
      else this._setState('closed');
    };

    ws.onerror = () => {
      // onclose akan menyusul dan menjadwalkan sambung ulang
    };
  },

  _dispatch(message) {
    const cb = this.callbacks;
    switch (message.type) {
      case 'PARTICIPANT_JOINED':
        if (cb.onParticipantJoined) cb.onParticipantJoined(message.participant, message);
        break;
      case 'PARTICIPANT_LEFT':
        if (cb.onParticipantLeft) cb.onParticipantLeft(message);
        else if (cb.onParticipantJoined) cb.onParticipantJoined(null, message);
        break;
      case 'ROOM_STATUS_CHANGED':
        if (cb.onRoomStatusChanged) cb.onRoomStatusChanged(message.status, message);
        break;
      case 'ANSWER_SUBMITTED':
        if (cb.onAnswerSubmitted) cb.onAnswerSubmitted(message);
        break;
      case 'PONG':
        break;
      default:
        console.warn('Realtime: tipe pesan tidak dikenal', message.type);
    }
  },

  _scheduleReconnect() {
    if (!this._wanted) return;
    this._setState('reconnecting');
    const delays = [500, 1000, 2000, 4000, 8000, 15000];
    const base = delays[Math.min(this._attempt, delays.length - 1)];
    this._attempt += 1;
    const delay = base + Math.random() * 400; // acak sedikit: puluhan HP tidak menyambung di detik yang sama
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._open(), delay);
  },

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      const ws = this.socket;
      if (!ws || ws.readyState !== 1) return;
      if (Date.now() - this._lastActivity > 50000) {
        // 50 detik tanpa kabar apa pun (padahal kita ping tiap 20 detik) = koneksi mati diam-diam
        try { ws.close(); } catch (e) { /* abaikan */ }
        return;
      }
      try { ws.send('ping'); } catch (e) { /* onclose akan menangani */ }
    }, 20000);
  },

  _stopHeartbeat() {
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  },

  // Dipanggil saat layar HP menyala lagi / internet kembali: jangan menunggu jadwal backoff
  _wake() {
    if (!this._wanted) return;
    const ws = this.socket;
    if (ws && ws.readyState === 1) {
      try { ws.send('ping'); } catch (e) { /* abaikan */ }
      return;
    }
    if (ws && ws.readyState === 0) return; // sedang menyambung
    this._attempt = 0;
    this._open();
  },

  _bindGlobalEvents() {
    if (this._globalBound) return;
    this._globalBound = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this._wake(); });
    window.addEventListener('online', () => this._wake());
    window.addEventListener('pageshow', () => this._wake());
    window.addEventListener('focus', () => this._wake());
  },

  disconnect() {
    this._wanted = false;
    clearTimeout(this._retryTimer);
    this._stopHeartbeat();
    if (this.socket) {
      const ws = this.socket;
      this.socket = null;
      ws.onclose = null;
      try { ws.close(); } catch (e) { /* abaikan */ }
    }
    this.callbacks = {};
    this.roomId = null;
    this.state = 'closed';
  },

  // ---- Pembungkus lama (kompatibel). Semuanya menggabungkan handler ke koneksi untuk room yang diminta ----
  _ensure(roomId) {
    if (this.roomId !== roomId || !this._wanted) {
      this.connect(roomId, {});
    }
  },

  subscribeToWaitingRoom(roomId, onParticipantsChange) {
    this._ensure(roomId);
    this.callbacks.onParticipantJoined = onParticipantsChange;
    this.callbacks.onParticipantLeft = onParticipantsChange;
  },

  subscribeToActiveRoom(roomId, onAnswersUpdate, onParticipantsUpdate) {
    this._ensure(roomId);
    this.callbacks.onAnswerSubmitted = () => {
      if (onAnswersUpdate) onAnswersUpdate();
      if (onParticipantsUpdate) onParticipantsUpdate();
    };
  },

  subscribeToRoomState(roomCode, onStateChange) {
    this._ensure(roomCode);
    this.callbacks.onRoomStatusChanged = (status, message) => onStateChange({ status, message });
  },

  subscribeToClientRank(roomId, onParticipantsUpdate) {
    this._ensure(roomId);
    this.callbacks.onAnswerSubmitted = onParticipantsUpdate;
  },

  // Handler tambahan (mis. banner koneksi, sinkron ulang saat tersambung kembali)
  on(handlers) {
    Object.assign(this.callbacks, handlers);
  },

  unsubscribeAll() {
    this.disconnect();
  }
};

window.RealtimeManager = RealtimeManager;
