// js/timer.js

const Timer = {
  intervalId: null,
  timeRemaining: 0,

  start(durationSeconds, onTick, onExpired) {
    this.stop();
    this.timeRemaining = durationSeconds;

    const tick = () => {
      if (this.timeRemaining <= 0) {
        this.stop();
        if (onExpired) onExpired();
        return;
      }

      this.timeRemaining--;

      const minutes = Math.floor(this.timeRemaining / 60);
      const seconds = this.timeRemaining % 60;
      const formattedTime = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      
      const isLow = this.timeRemaining < 60; // Less than 1 minute remaining
      if (onTick) onTick(formattedTime, isLow);
    };

    // Run first tick immediately
    const initialMinutes = Math.floor(durationSeconds / 60);
    const initialSeconds = durationSeconds % 60;
    onTick(`${String(initialMinutes).padStart(2, '0')}:${String(initialSeconds).padStart(2, '0')}`, durationSeconds < 60);

    this.intervalId = setInterval(tick, 1000);
  },

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
};

window.Timer = Timer;
