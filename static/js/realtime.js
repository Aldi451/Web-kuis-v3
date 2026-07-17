// static/js/realtime.js

const RealtimeManager = {
  socket: null,
  callbacks: {},

  connect(roomId, handlers = {}) {
    this.disconnect();
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:8000';
    const wsUrl = `${protocol}//${host}/ws/${roomId}`;
    
    console.log("Realtime: Connecting to", wsUrl);
    this.socket = new WebSocket(wsUrl);
    this.callbacks = handlers;

    this.socket.onopen = () => {
      console.log("Realtime: Connected for room", roomId);
    };

    this.socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log("Realtime: Received message", message);
        
        switch (message.type) {
          case 'PARTICIPANT_JOINED':
            if (this.callbacks.onParticipantJoined) {
              this.callbacks.onParticipantJoined(message.participant);
            }
            break;
          case 'ROOM_STATUS_CHANGED':
            if (this.callbacks.onRoomStatusChanged) {
              this.callbacks.onRoomStatusChanged(message.status);
            }
            break;
          case 'ANSWER_SUBMITTED':
            if (this.callbacks.onAnswerSubmitted) {
              this.callbacks.onAnswerSubmitted(message);
            }
            break;
          default:
            console.warn("Realtime: Unknown message type", message.type);
        }
      } catch (err) {
        console.error("Realtime: Error parsing message", err);
      }
    };

    this.socket.onclose = () => {
      console.log("Realtime: Disconnected");
    };

    this.socket.onerror = (err) => {
      console.error("Realtime: WebSocket error", err);
    };
  },

  disconnect() {
    if (this.socket) {
      console.log("Realtime: Disconnecting");
      this.socket.close();
      this.socket = null;
      this.callbacks = {};
    }
  },

  // Legacy wrappers if other files still call them
  subscribeToWaitingRoom(roomId, onParticipantJoin) {
    if (!this.socket) {
      this.connect(roomId, { onParticipantJoined: onParticipantJoin });
    } else {
      this.callbacks.onParticipantJoined = onParticipantJoin;
    }
  },

  subscribeToActiveRoom(roomId, onAnswersUpdate, onParticipantsUpdate) {
    if (!this.socket) {
      this.connect(roomId, { 
        onAnswerSubmitted: () => {
          if (onAnswersUpdate) onAnswersUpdate();
          if (onParticipantsUpdate) onParticipantsUpdate();
        } 
      });
    } else {
      this.callbacks.onAnswerSubmitted = () => {
        if (onAnswersUpdate) onAnswersUpdate();
        if (onParticipantsUpdate) onParticipantsUpdate();
      };
    }
  },

  subscribeToRoomState(roomCode, onStateChange) {
    // If not connected, we need the roomId to connect, but this legacy method
    // only has roomCode. Let's assume roomCode = roomId for this app logic.
    if (!this.socket) {
      this.connect(roomCode, { 
        onRoomStatusChanged: (status) => onStateChange({ status }) 
      });
    } else {
      this.callbacks.onRoomStatusChanged = (status) => onStateChange({ status });
    }
  },

  subscribeToClientRank(roomId, onParticipantsUpdate) {
    if (!this.socket) {
      this.connect(roomId, { onAnswerSubmitted: onParticipantsUpdate });
    } else {
      this.callbacks.onAnswerSubmitted = onParticipantsUpdate;
    }
  },

  unsubscribeAll() {
    this.disconnect();
  }
};

window.RealtimeManager = RealtimeManager;
