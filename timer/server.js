const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 10e6 // 10MB for image uploads
});

// Trust proxy (for running behind nginx/reverse proxy)
app.set('trust proxy', true);

app.use(express.static(path.join(__dirname, 'public')));

// Health-check / status endpoint
app.get('/status', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    connections: {
      displays: displays.size,
      remotes: remotes.size,
      total: displays.size + remotes.size
    },
    timer: {
      running: state.timerRunning,
      paused: state.timerPaused,
      finished: state.timerFinished,
      endTime: state.timerEndTime
    }
  });
});

// Shared state
let state = {
  // Timer
  timerEndTime: null,       // ISO string or null
  timerRunning: false,
  timerPaused: false,
  timerPausedRemaining: 0,  // ms remaining when paused
  timerDuration: 0,         // total duration in ms

  // Display
  background: 'bg-dark-gradient',
  customBgColor1: '#0a0a2e',
  customBgColor2: '#1a1a4e',

  // Timer style
  timerColor: '#00ff88',
  timerWarningColor: '#ff6b35',
  timerDangerColor: '#ff0040',
  warningThreshold: 300,    // seconds - when to show warning (5 min)
  dangerThreshold: 60,      // seconds - when to show danger (1 min)

  // Announcements
  announcement: null,       // { text, textColor, bgColor, duration, fontSize }

  // Finish message
  finishMessage: '⏰ CZAS MINĄŁ!',
  finishImage: null,        // base64 image
  timerFinished: false,

  // Timer glow style: 'none', 'soft', 'neon', 'pulse', 'custom'
  timerGlowStyle: 'neon',
  glowColor1: '#00ff88',
  glowColor2: '#0088ff',

  // Timer display style: 'cyber', 'ring', 'classic', 'minimal', 'flip'
  timerDisplayStyle: 'cyber',

  // Timer label (shown under timer, empty = hidden)
  timerLabel: '',

  // Sounds
  soundEnabled: true,
  warningSound: true,
  finishSound: true,
  tickSound: false,

  // Custom image overlay
  overlayImage: null,
  overlayPosition: 'top-right', // top-left, top-right, bottom-left, bottom-right, center
  overlaySize: 150,
};

let displays = new Set();
let remotes = new Set();

function getNetworkIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

io.on('connection', (socket) => {
  const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

  socket.on('register', (role) => {
    if (role === 'display') {
      displays.add(socket.id);
      socket.role = 'display';
    } else {
      remotes.add(socket.id);
      socket.role = 'remote';
    }
    console.log(`[+] ${role} connected from ${clientIP} (displays: ${displays.size}, remotes: ${remotes.size})`);
    // Send current state
    socket.emit('state-sync', state);
    // Broadcast connection count to all remotes
    io.emit('connection-count', { displays: displays.size, remotes: remotes.size });
  });

  // Timer controls
  socket.on('start-timer', (data) => {
    const { hours, minutes, seconds } = data;
    const totalMs = ((hours || 0) * 3600 + (minutes || 0) * 60 + (seconds || 0)) * 1000;
    state.timerDuration = totalMs;
    state.timerEndTime = new Date(Date.now() + totalMs).toISOString();
    state.timerRunning = true;
    state.timerPaused = false;
    state.timerFinished = false;
    io.emit('state-sync', state);
  });

  socket.on('start-timer-until', (data) => {
    const { targetHour, targetMinute } = data;
    const now = new Date();
    const target = new Date();
    target.setHours(targetHour, targetMinute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    const totalMs = target - now;
    state.timerDuration = totalMs;
    state.timerEndTime = target.toISOString();
    state.timerRunning = true;
    state.timerPaused = false;
    state.timerFinished = false;
    io.emit('state-sync', state);
  });

  socket.on('pause-timer', () => {
    if (state.timerRunning && !state.timerPaused) {
      const remaining = new Date(state.timerEndTime) - Date.now();
      state.timerPausedRemaining = Math.max(0, remaining);
      state.timerPaused = true;
      io.emit('state-sync', state);
    }
  });

  socket.on('resume-timer', () => {
    if (state.timerRunning && state.timerPaused) {
      state.timerEndTime = new Date(Date.now() + state.timerPausedRemaining).toISOString();
      state.timerPaused = false;
      io.emit('state-sync', state);
    }
  });

  socket.on('stop-timer', () => {
    state.timerRunning = false;
    state.timerPaused = false;
    state.timerEndTime = null;
    state.timerFinished = false;
    io.emit('state-sync', state);
  });

  socket.on('add-time', (seconds) => {
    if (state.timerRunning) {
      if (state.timerPaused) {
        state.timerPausedRemaining += seconds * 1000;
      } else {
        const newEnd = new Date(new Date(state.timerEndTime).getTime() + seconds * 1000);
        state.timerEndTime = newEnd.toISOString();
      }
      state.timerFinished = false;
      io.emit('state-sync', state);
    }
  });

  socket.on('timer-finished', () => {
    state.timerFinished = true;
    state.timerRunning = false;
    io.emit('state-sync', state);
  });

  // Display settings
  socket.on('set-background', (bg) => {
    state.background = bg;
    io.emit('state-sync', state);
  });

  socket.on('set-custom-bg', (data) => {
    state.customBgColor1 = data.color1;
    state.customBgColor2 = data.color2;
    state.background = 'bg-custom';
    io.emit('state-sync', state);
  });

  socket.on('set-timer-colors', (data) => {
    if (data.timerColor) state.timerColor = data.timerColor;
    if (data.warningColor) state.timerWarningColor = data.warningColor;
    if (data.dangerColor) state.timerDangerColor = data.dangerColor;
    if (data.warningThreshold !== undefined) state.warningThreshold = data.warningThreshold;
    if (data.dangerThreshold !== undefined) state.dangerThreshold = data.dangerThreshold;
    io.emit('state-sync', state);
  });

  // Timer glow style
  socket.on('set-timer-glow', (data) => {
    if (typeof data === 'string') {
      state.timerGlowStyle = data;
    } else {
      state.timerGlowStyle = data.style;
      if (data.color1) state.glowColor1 = data.color1;
      if (data.color2) state.glowColor2 = data.color2;
    }
    io.emit('state-sync', state);
  });

  // Timer display style
  socket.on('set-timer-display-style', (style) => {
    state.timerDisplayStyle = style;
    io.emit('state-sync', state);
  });

  // Timer label
  socket.on('set-timer-label', (label) => {
    state.timerLabel = label || '';
    io.emit('state-sync', state);
  });

  // Announcements
  socket.on('send-announcement', (data) => {
    state.announcement = {
      text: data.text,
      textColor: data.textColor || '#ffffff',
      bgColor: data.bgColor || 'rgba(0,0,0,0.85)',
      duration: data.duration || 10,
      fontSize: data.fontSize || 48,
      position: data.position || 'bottom',
      id: Date.now()
    };
    io.emit('state-sync', state);

    // Auto-clear after duration
    if (data.duration && data.duration > 0) {
      setTimeout(() => {
        if (state.announcement && state.announcement.id === data.id) {
          state.announcement = null;
          io.emit('state-sync', state);
        }
      }, (data.duration || 10) * 1000);
    }
  });

  socket.on('clear-announcement', () => {
    state.announcement = null;
    io.emit('state-sync', state);
  });

  // Finish settings
  socket.on('set-finish-message', (msg) => {
    state.finishMessage = msg;
    io.emit('state-sync', state);
  });

  socket.on('set-finish-image', (imgData) => {
    state.finishImage = imgData;
    io.emit('state-sync', state);
  });

  // Overlay image
  socket.on('set-overlay-image', (data) => {
    state.overlayImage = data.image;
    if (data.position) state.overlayPosition = data.position;
    if (data.size) state.overlaySize = data.size;
    io.emit('state-sync', state);
  });

  socket.on('remove-overlay-image', () => {
    state.overlayImage = null;
    io.emit('state-sync', state);
  });

  // Sounds
  socket.on('set-sounds', (data) => {
    if (data.soundEnabled !== undefined) state.soundEnabled = data.soundEnabled;
    if (data.warningSound !== undefined) state.warningSound = data.warningSound;
    if (data.finishSound !== undefined) state.finishSound = data.finishSound;
    if (data.tickSound !== undefined) state.tickSound = data.tickSound;
    io.emit('state-sync', state);
  });

  // Reset finished state
  socket.on('reset-finish', () => {
    state.timerFinished = false;
    io.emit('state-sync', state);
  });

  socket.on('disconnect', () => {
    const role = socket.role || 'unknown';
    displays.delete(socket.id);
    remotes.delete(socket.id);
    console.log(`[-] ${role} disconnected from ${clientIP} (displays: ${displays.size}, remotes: ${remotes.size})`);
    io.emit('connection-count', { displays: displays.size, remotes: remotes.size });
  });
});

const PORT = process.env.PORT || 3000;
const IP = getNetworkIP();

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🎯 Hackathon Timer Server');
  console.log('========================');
  console.log(`📺 Ekran projektora: http://${IP}:${PORT}/display.html`);
  console.log(`🎮 Pilot (remote):   http://${IP}:${PORT}/remote.html`);
  console.log(`📡 Lokalnie:         http://localhost:${PORT}`);
  console.log('========================');
  console.log('');
});
