// js/timer.js - hitung mundur berbasis BATAS WAKTU (deadline), bukan "kurangi 1 tiap detik"
//
// Kenapa: saat layar HP terkunci atau browser dipindah ke aplikasi lain, setInterval dibekukan/dilambatkan.
// Timer lama yang mengurangi 1 per tik jadi ketinggalan (peserta mendapat waktu ekstra). Dengan deadline,
// sisa waktu selalu dihitung dari jam sekarang sehingga otomatis benar begitu layar menyala lagi.

const Timer = {
  intervalId: null,
  deadline: 0,          // epoch ms (jam perangkat) saat waktu habis
  timeRemaining: 0,     // detik, diperbarui tiap tik
  _onTick: null,
  _onExpired: null,
  _lastShown: -1,
  _expired: false,

  // Versi lama: hitung mundur dari sekian detik sejak sekarang
  start(durationSeconds, onTick, onExpired) {
    this.startUntil(Date.now() + durationSeconds * 1000, onTick, onExpired);
  },

  // Versi baru: hitung mundur menuju batas waktu tertentu (epoch ms)
  startUntil(deadlineMs, onTick, onExpired) {
    this.stop();
    this.deadline = deadlineMs;
    this._onTick = onTick;
    this._onExpired = onExpired;
    this._lastShown = -1;
    this._expired = false;

    this._tick();
    // 250ms: ketepatan tampilan tetap bagus, dan DOM hanya diubah saat detik berganti
    this.intervalId = setInterval(() => this._tick(), 250);

    if (!this._visibilityBound) {
      this._visibilityBound = true;
      const refresh = () => { if (this.intervalId) this._tick(); };
      document.addEventListener('visibilitychange', refresh);
      window.addEventListener('focus', refresh);
      window.addEventListener('pageshow', refresh);
    }
  },

  // Geser batas waktu (mis. host/server memberi nilai ends_at yang lebih akurat)
  setDeadline(deadlineMs) {
    this.deadline = deadlineMs;
    if (this.intervalId) this._tick();
  },

  _tick() {
    const remaining = Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
    this.timeRemaining = remaining;

    if (remaining !== this._lastShown) {
      this._lastShown = remaining;
      if (this._onTick) this._onTick(window.UI ? window.UI.formatDuration(remaining) : this._format(remaining), remaining < 60);
    }

    if (remaining <= 0 && !this._expired) {
      this._expired = true;
      const done = this._onExpired;
      this.stop();
      if (done) done();
    }
  },

  _format(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  },

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
};

window.Timer = Timer;
