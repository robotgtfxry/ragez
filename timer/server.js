const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'pciowyadmin';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TIMER_MS = 100 * 3600 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 12e6 // obrazki przychodzą jako data URL (base64 = ~+33%)
});

// Trust proxy (for running behind nginx/reverse proxy)
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ============================================================
//  Allowed values
// ============================================================
const BACKGROUNDS = ['bg-dark-gradient', 'bg-cyber-purple', 'bg-ocean-deep', 'bg-fire', 'bg-matrix', 'bg-sunset',
  'bg-arctic', 'bg-neon-city', 'bg-midnight', 'bg-volcano', 'bg-aurora', 'bg-galaxy', 'bg-custom', 'bg-image'];
const GLOW_STYLES = ['none', 'soft', 'neon', 'pulse', 'custom', 'intense', 'subtle', 'fire', 'ice', 'rainbow',
  'matrix', 'electric', 'retro', 'warm', 'cold', 'breathe', 'shadow'];
const DISPLAY_STYLES = ['cyber', 'ring', 'classic', 'minimal', 'flip'];
const RING_VARIANTS = ['classic', 'no-ticks', 'major-only', 'dots', 'thin', 'thick', 'double', 'minimal-arc', 'glow-ring'];
const OVERLAY_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
const ANNOUNCEMENT_POSITIONS = ['top', 'center', 'bottom'];
const FX_TYPES = ['celebrate', 'test-sound'];
const MEDIA_SLOTS = { bg: 'customBgImage', finish: 'finishImage', overlay: 'overlayImage' };

// ============================================================
//  Shared state
// ============================================================
const DEFAULT_STATE = {
  // Timer
  timerEndTime: null,       // ISO string or null
  timerRunning: false,
  timerPaused: false,
  timerPausedRemaining: 0,  // ms remaining when paused
  timerDuration: 0,         // total duration in ms
  timerFinishedAt: null,    // server timestamp of the moment time ran out

  // Display
  background: 'bg-dark-gradient',
  customBgColor1: '#0a0a2e',
  customBgColor2: '#1a1a4e',
  customBgImage: null,      // /media/bg URL

  // Timer style
  timerColor: '#00ff88',
  timerWarningColor: '#ff6b35',
  timerDangerColor: '#ff0040',
  warningThreshold: 300,    // seconds - when to show warning (5 min)
  dangerThreshold: 60,      // seconds - when to show danger (1 min)
  warningMessage: 'CZAS SIĘ KOŃCZY',
  dangerMessage: 'OSTATNIE SEKUNDY!',
  pauseMessage: 'PAUZA',

  // Announcements
  announcement: null,       // { text, textColor, bgColor, duration, fontSize, position, id }

  // Finish message
  finishMessage: 'CZAS MINĄŁ!',
  finishImage: null,        // /media/finish URL
  timerFinished: false,

  // Timer glow style
  timerGlowStyle: 'neon',
  glowColor1: '#00ff88',
  glowColor2: '#0088ff',

  // Timer display style: 'cyber', 'ring', 'classic', 'minimal', 'flip'
  timerDisplayStyle: 'cyber',
  ringVariant: 'classic',

  // Timer label (shown under timer, empty = hidden)
  timerLabel: '',
  labelFont: 'Rajdhani',
  labelSize: 100,           // %
  labelUppercase: true,
  labelColor: '#ffffff',

  // Screen extras
  showTimerBar: true,
  finalCountdown: true,     // giant numbers during the last 10 seconds
  celebration: true,        // fireworks when time runs out
  showClock: false,         // wall clock in the corner

  // Sounds
  soundEnabled: true,
  warningSound: true,
  finishSound: true,
  tickSound: false,

  // Custom image overlay
  overlayImage: null,       // /media/overlay URL
  overlayPosition: 'top-right',
  overlaySize: 150,
};

const state = structuredClone(DEFAULT_STATE);
const media = new Map();   // slot -> { mime, buf, v }
const clients = new Map(); // socketId -> { role, ip, userAgent, connectedAt }

// ============================================================
//  Sanitizers
// ============================================================
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;
const obj = (v) => (v && typeof v === 'object' ? v : {});
const asColor = (v, cur) => (typeof v === 'string' && COLOR_RE.test(v) ? v : cur);
const asBool = (v, cur) => (typeof v === 'boolean' ? v : cur);
const asText = (max) => (v, cur) => (typeof v === 'string' ? v.slice(0, max) : cur);
const asOneOf = (list) => (v, cur) => (list.includes(v) ? v : cur);
const asFont = (v, cur) => (typeof v === 'string' && /^[\w \-]{1,40}$/.test(v) ? v : cur);
const asNum = (min, max) => (v, cur) => {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : cur;
};

// Copies whitelisted fields from payload into state. Returns false when nothing matched.
function patch(data, spec) {
  data = obj(data);
  let touched = false;
  for (const [field, [key, clean]] of Object.entries(spec)) {
    if (data[field] === undefined) continue;
    state[key] = clean(data[field], state[key]);
    touched = true;
  }
  return touched ? undefined : false;
}

// ============================================================
//  Auth
// ============================================================
const PANEL_TOKEN = crypto.createHmac('sha256', PANEL_PASSWORD).update('hackathon-timer:panel').digest('hex');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
const isValidToken = (token) => typeof token === 'string' && safeEqual(token, PANEL_TOKEN);

const authAttempts = new Map(); // ip -> { count, resetAt }
function tooManyAttempts(ip) {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    authAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count++;
  return entry.count > 10;
}
setInterval(() => {
  const now = Date.now();
  authAttempts.forEach((entry, ip) => { if (entry.resetAt < now) authAttempts.delete(ip); });
}, 5 * 60_000).unref();

app.post('/api/auth', (req, res) => {
  if (tooManyAttempts(req.ip)) {
    return res.status(429).json({ ok: false, error: 'Za dużo prób — odczekaj minutę' });
  }
  const password = req.body && req.body.password;
  if (typeof password === 'string' && safeEqual(password, PANEL_PASSWORD)) {
    authAttempts.delete(req.ip);
    return res.json({ ok: true, token: PANEL_TOKEN });
  }
  res.status(401).json({ ok: false });
});

app.get('/api/session', (req, res) => {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const ok = isValidToken(token);
  res.status(ok ? 200 : 401).json({ ok });
});

// ============================================================
//  Media (images are kept out of the socket state and served over HTTP)
// ============================================================
const mediaFile = (slot) => path.join(DATA_DIR, `media-${slot}`);
const mediaUrl = (slot, v) => `/media/${slot}?v=${v}`;

app.get('/media/:slot', (req, res) => {
  const item = media.get(req.params.slot);
  if (!item) return res.sendStatus(404);
  res.set({
    'Content-Type': item.mime,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(item.buf);
});

function setMedia(slot, dataUrl) {
  const key = MEDIA_SLOTS[slot];
  if (!dataUrl) {
    media.delete(slot);
    fs.rm(mediaFile(slot), { force: true }, () => {});
    state[key] = null;
    return;
  }
  if (typeof dataUrl !== 'string') throw new Error('Nieprawidłowy obrazek');
  const comma = dataUrl.indexOf(',');
  const header = /^data:(image\/(?:png|jpeg|gif|webp|avif));base64$/.exec(dataUrl.slice(0, comma));
  if (comma < 0 || !header) throw new Error('Nieobsługiwany format obrazka (PNG, JPG, GIF, WebP)');
  const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  if (!buf.length) throw new Error('Pusty obrazek');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('Obrazek jest za duży (max 8 MB)');

  const v = Date.now().toString(36);
  media.set(slot, { mime: header[1], buf, v });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(mediaFile(slot), buf);
  } catch (err) {
    console.warn(`[!] Nie udało się zapisać obrazka ${slot}:`, err.message);
  }
  state[key] = mediaUrl(slot, v);
}

// ============================================================
//  Persistence (survives pm2 restarts mid-hackathon)
// ============================================================
function loadState() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[!] Nie udało się wczytać zapisanego stanu:', err.message);
    return;
  }
  const s = obj(saved.state);
  const mediaKeys = Object.values(MEDIA_SLOTS);
  for (const key of Object.keys(DEFAULT_STATE)) {
    if (mediaKeys.includes(key) || !(key in s)) continue;
    if (DEFAULT_STATE[key] === null || typeof s[key] === typeof DEFAULT_STATE[key]) state[key] = s[key];
  }
  for (const [slot, meta] of Object.entries(obj(saved.media))) {
    if (!Object.hasOwn(MEDIA_SLOTS, slot)) continue;
    try {
      media.set(slot, { mime: meta.mime, v: meta.v, buf: fs.readFileSync(mediaFile(slot)) });
      state[MEDIA_SLOTS[slot]] = mediaUrl(slot, meta.v);
    } catch { /* file is gone, skip */ }
  }
  if (state.background === 'bg-image' && !state.customBgImage) state.background = DEFAULT_STATE.background;
  console.log(`[i] Wczytano zapisany stan z ${STATE_FILE}`);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const mediaMeta = {};
  media.forEach(({ mime, v }, slot) => { mediaMeta[slot] = { mime, v }; });
  const snapshot = { ...state };
  Object.values(MEDIA_SLOTS).forEach((key) => { snapshot[key] = null; });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, savedAt: new Date().toISOString(), state: snapshot, media: mediaMeta }, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.warn('[!] Nie udało się zapisać stanu:', err.message);
  }
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

// ============================================================
//  Timer engine (server is the single source of truth)
// ============================================================
let finishTimer = null;
let announcementTimer = null;

function publicState() {
  return { ...state, serverNow: Date.now() };
}

function broadcast() {
  io.emit('state-sync', publicState());
  saveSoon();
}

function finishNow() {
  Object.assign(state, {
    timerRunning: false,
    timerPaused: false,
    timerFinished: true,
    timerFinishedAt: Date.now(),
  });
  console.log('[⏰] Czas minął');
  broadcast();
}

function scheduleFinish() {
  clearTimeout(finishTimer);
  finishTimer = null;
  if (!state.timerRunning || state.timerPaused || !state.timerEndTime) return;
  const ms = new Date(state.timerEndTime).getTime() - Date.now();
  if (ms <= 0) {
    finishNow();
    return;
  }
  finishTimer = setTimeout(scheduleFinish, Math.min(ms, 2 ** 31 - 1));
}

function startCountdown(totalMs) {
  Object.assign(state, {
    timerDuration: totalMs,
    timerEndTime: new Date(Date.now() + totalMs).toISOString(),
    timerRunning: true,
    timerPaused: false,
    timerPausedRemaining: 0,
    timerFinished: false,
    timerFinishedAt: null,
  });
  scheduleFinish();
}

function scheduleAnnouncementClear() {
  clearTimeout(announcementTimer);
  const a = state.announcement;
  if (!a || !(a.duration > 0)) return;
  const left = a.id + a.duration * 1000 - Date.now();
  if (left <= 0) {
    state.announcement = null;
    return;
  }
  announcementTimer = setTimeout(() => {
    if (state.announcement && state.announcement.id === a.id) {
      state.announcement = null;
      broadcast();
    }
  }, left);
}

// ============================================================
//  HTTP status
// ============================================================
function connectionSummary() {
  const devices = [...clients].map(([id, info]) => ({ id, ...info }));
  return {
    displays: devices.filter((d) => d.role === 'display').length,
    remotes: devices.filter((d) => d.role === 'remote').length,
    devices,
  };
}

// Health-check / status endpoint
app.get('/status', (req, res) => {
  const { displays, remotes } = connectionSummary();
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    connections: { displays, remotes, total: displays + remotes },
    timer: {
      running: state.timerRunning,
      paused: state.timerPaused,
      finished: state.timerFinished,
      endTime: state.timerEndTime,
    },
  });
});

function getNetworkIP() {
  const interfaces = os.networkInterfaces();
  let fallback = null;
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      // 169.254.x.x = brak DHCP, inne urządzenia tego adresu nie widzą
      if (iface.address.startsWith('169.254.')) { fallback = fallback || iface.address; continue; }
      return iface.address;
    }
  }
  return fallback || 'localhost';
}

function broadcastConnections() {
  io.to('remotes').emit('connection-count', connectionSummary());
}

// ============================================================
//  Sockets
// ============================================================
io.use((socket, next) => {
  socket.data.authed = isValidToken(socket.handshake.auth && socket.handshake.auth.token);
  next();
});

io.on('connection', (socket) => {
  const clientIP = String(socket.handshake.headers['x-forwarded-for'] || socket.handshake.address).split(',')[0].trim();

  // Every panel action goes through here: auth check, validation, broadcast and ack.
  // Handler return value: false = rejected/no-op, null = ok without state change, anything else = state changed.
  function control(event, handler) {
    socket.on(event, (...args) => {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      if (!socket.data.authed) {
        if (ack) ack({ ok: false, error: 'Brak autoryzacji' });
        socket.emit('auth-required');
        return;
      }
      try {
        const result = handler(args[0]);
        if (result !== false && result !== null) broadcast();
        if (ack) ack({ ok: result !== false });
      } catch (err) {
        console.warn(`[!] ${event}: ${err.message}`);
        if (ack) ack({ ok: false, error: err.message });
      }
    });
  }

  socket.on('clock', (ack) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('register', (role) => {
    role = ['display', 'remote', 'preview', 'viewer'].includes(role) ? role : 'viewer';
    socket.data.role = role;

    if (role === 'remote') {
      if (!socket.data.authed) {
        socket.emit('auth-required');
        return;
      }
      socket.join('remotes');
    }
    if (role === 'display' || role === 'remote') {
      clients.set(socket.id, {
        role,
        ip: clientIP.replace('::ffff:', ''),
        userAgent: socket.handshake.headers['user-agent'] || '',
        connectedAt: Date.now(),
      });
      const { displays, remotes } = connectionSummary();
      console.log(`[+] ${role} connected from ${clientIP} (displays: ${displays}, remotes: ${remotes})`);
    }
    socket.emit('state-sync', publicState());
    broadcastConnections();
  });

  // ---------- Timer controls ----------
  control('start-timer', (data) => {
    data = obj(data);
    const totalMs = (asNum(0, 99)(data.hours, 0) * 3600 + asNum(0, 5999)(data.minutes, 0) * 60
      + asNum(0, 359999)(data.seconds, 0)) * 1000;
    if (totalMs <= 0) return false;
    startCountdown(Math.min(totalMs, MAX_TIMER_MS));
  });

  control('start-timer-until', (data) => {
    data = obj(data);
    const now = Date.now();
    // targetTime is computed on the panel, in the operator's timezone (the server may run in UTC)
    let target = Number(data.targetTime);
    if (!Number.isFinite(target)) {
      const d = new Date();
      d.setHours(asNum(0, 23)(data.targetHour, 0), asNum(0, 59)(data.targetMinute, 0), 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      target = d.getTime();
    }
    if (target <= now || target - now > 48 * 3600 * 1000) return false;
    startCountdown(target - now);
  });

  control('pause-timer', () => {
    if (!state.timerRunning || state.timerPaused) return false;
    state.timerPausedRemaining = Math.max(0, new Date(state.timerEndTime).getTime() - Date.now());
    state.timerPaused = true;
    scheduleFinish();
  });

  control('resume-timer', () => {
    if (!state.timerRunning || !state.timerPaused) return false;
    state.timerEndTime = new Date(Date.now() + state.timerPausedRemaining).toISOString();
    state.timerPaused = false;
    scheduleFinish();
  });

  control('stop-timer', () => {
    Object.assign(state, {
      timerRunning: false,
      timerPaused: false,
      timerEndTime: null,
      timerPausedRemaining: 0,
      timerFinished: false,
      timerFinishedAt: null,
    });
    scheduleFinish();
  });

  control('add-time', (seconds) => {
    const deltaMs = asNum(-360000, 360000)(seconds, 0) * 1000;
    if (!deltaMs) return false;
    if (state.timerFinished) {
      // "Dogrywka": adding time after the end starts a fresh countdown
      if (deltaMs < 0) return false;
      startCountdown(deltaMs);
      return;
    }
    if (!state.timerRunning) return false;

    let remaining;
    if (state.timerPaused) {
      state.timerPausedRemaining = Math.max(0, state.timerPausedRemaining + deltaMs);
      remaining = state.timerPausedRemaining;
    } else {
      const end = new Date(state.timerEndTime).getTime() + deltaMs;
      state.timerEndTime = new Date(end).toISOString();
      remaining = end - Date.now();
    }
    state.timerDuration = Math.min(MAX_TIMER_MS, Math.max(state.timerDuration, remaining));
    scheduleFinish();
  });

  control('reset-finish', () => {
    if (!state.timerFinished) return false;
    state.timerFinished = false;
  });

  // ---------- Display settings ----------
  control('set-background', (bg) => {
    if (!BACKGROUNDS.includes(bg) || (bg === 'bg-image' && !state.customBgImage)) return false;
    state.background = bg;
  });

  control('set-custom-bg', (data) => {
    const result = patch(data, { color1: ['customBgColor1', asColor], color2: ['customBgColor2', asColor] });
    if (result === false) return false;
    state.background = 'bg-custom';
  });

  control('set-custom-bg-image', (data) => {
    const image = obj(data).image;
    setMedia('bg', image);
    if (image) state.background = 'bg-image';
    else if (state.background === 'bg-image') state.background = DEFAULT_STATE.background;
  });

  control('set-timer-colors', (data) => patch(data, {
    timerColor: ['timerColor', asColor],
    warningColor: ['timerWarningColor', asColor],
    dangerColor: ['timerDangerColor', asColor],
    warningThreshold: ['warningThreshold', asNum(0, 360000)],
    dangerThreshold: ['dangerThreshold', asNum(0, 360000)],
    warningMessage: ['warningMessage', asText(80)],
    dangerMessage: ['dangerMessage', asText(80)],
    pauseMessage: ['pauseMessage', asText(80)],
  }));

  control('set-timer-glow', (data) => patch(typeof data === 'string' ? { style: data } : data, {
    style: ['timerGlowStyle', asOneOf(GLOW_STYLES)],
    color1: ['glowColor1', asColor],
    color2: ['glowColor2', asColor],
  }));

  control('set-timer-display-style', (style) => patch({ style }, { style: ['timerDisplayStyle', asOneOf(DISPLAY_STYLES)] }));

  control('set-ring-variant', (variant) => patch({ variant }, { variant: ['ringVariant', asOneOf(RING_VARIANTS)] }));

  control('set-timer-label', (label) => patch({ label: label || '' }, { label: ['timerLabel', asText(120)] }));

  control('set-label-style', (data) => patch(data, {
    font: ['labelFont', asFont],
    size: ['labelSize', asNum(30, 300)],
    uppercase: ['labelUppercase', asBool],
    color: ['labelColor', asColor],
  }));

  control('set-timer-bar-visible', (visible) => patch({ visible }, { visible: ['showTimerBar', asBool] }));

  control('set-effects', (data) => patch(data, {
    finalCountdown: ['finalCountdown', asBool],
    celebration: ['celebration', asBool],
    showClock: ['showClock', asBool],
  }));

  // ---------- Announcements ----------
  control('send-announcement', (data) => {
    data = obj(data);
    const text = asText(500)(data.text, '').trim();
    if (!text) return false;
    state.announcement = {
      text,
      textColor: asColor(data.textColor, '#ffffff'),
      bgColor: asColor(data.bgColor, 'rgba(0,0,0,0.85)'),
      duration: asNum(0, 3600)(data.duration, 10),
      fontSize: asNum(12, 200)(data.fontSize, 48),
      position: asOneOf(ANNOUNCEMENT_POSITIONS)(data.position, 'bottom'),
      id: Date.now(),
    };
    scheduleAnnouncementClear();
  });

  control('clear-announcement', () => {
    if (!state.announcement) return false;
    state.announcement = null;
    scheduleAnnouncementClear();
  });

  // ---------- Finish settings ----------
  control('set-finish-message', (msg) => patch({ msg }, { msg: ['finishMessage', asText(120)] }));

  control('set-finish-image', (imgData) => setMedia('finish', imgData));

  // ---------- Overlay image ----------
  control('set-overlay-image', (data) => {
    data = obj(data);
    if (typeof data.image === 'string' && data.image.startsWith('data:')) setMedia('overlay', data.image);
    else if (data.image === null) setMedia('overlay', null);
    patch(data, {
      position: ['overlayPosition', asOneOf(OVERLAY_POSITIONS)],
      size: ['overlaySize', asNum(30, 1200)],
    });
  });

  control('remove-overlay-image', () => setMedia('overlay', null));

  // ---------- Sounds & effects ----------
  control('set-sounds', (data) => patch(data, {
    soundEnabled: ['soundEnabled', asBool],
    warningSound: ['warningSound', asBool],
    finishSound: ['finishSound', asBool],
    tickSound: ['tickSound', asBool],
  }));

  control('trigger-fx', (type) => {
    if (!FX_TYPES.includes(type)) return false;
    io.emit('fx', { type, at: Date.now() });
    return null;
  });

  socket.on('disconnect', () => {
    const role = socket.data.role || 'unknown';
    const tracked = clients.delete(socket.id);
    if (tracked) {
      const { displays, remotes } = connectionSummary();
      console.log(`[-] ${role} disconnected from ${clientIP} (displays: ${displays}, remotes: ${remotes})`);
      broadcastConnections();
    }
  });
});

// ============================================================
//  Boot
// ============================================================
loadState();
scheduleFinish();
scheduleAnnouncementClear();

function shutdown() {
  saveNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const IP = getNetworkIP();

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('Hackathon Timer Server');
  console.log('========================');
  console.log(`Strona startowa:  http://${IP}:${PORT}/`);
  console.log(`Ekran projektora: http://${IP}:${PORT}/display.html`);
  console.log(`Pilot (remote):   http://${IP}:${PORT}/remote.html`);
  console.log(`Lokalnie:         http://localhost:${PORT}`);
  console.log('========================');
  if (!process.env.PANEL_PASSWORD) {
    console.log('[!] Używasz domyślnego hasła panelu — ustaw zmienną PANEL_PASSWORD');
  }
  console.log('');
});
