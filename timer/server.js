const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    pingInterval: 10000,
    pingTimeout: 5000,
});

app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public')));

// ===== CLIENT TRACKING =====
const clients = { display: new Set(), remote: new Set() };

function getClientCounts() {
    return {
        displays: clients.display.size,
        remotes: clients.remote.size,
        total: clients.display.size + clients.remote.size,
    };
}

function broadcastClients() {
    io.emit('clients', getClientCounts());
}

// ===== SHARED TIMER STATE =====
let state = {
    mode: 'countdown',
    status: 'stopped',
    totalSeconds: 300,
    remainingSeconds: 300,
    targetTime: null,
    theme: 'cosmic',
    eventName: '',
    countdownInput: { h: 0, m: 5, s: 0 },
    targetInput: { h: 17, m: 0 },
};

let tickInterval = null;

function broadcastState() {
    io.emit('state', state);
}

function startTicking() {
    stopTicking();
    tickInterval = setInterval(() => {
        if (state.status !== 'running') return;

        if (state.mode === 'target' && state.targetTime) {
            const diff = Math.floor((new Date(state.targetTime) - Date.now()) / 1000);
            state.remainingSeconds = Math.max(0, diff);
        } else {
            state.remainingSeconds = Math.max(0, state.remainingSeconds - 1);
        }

        if (state.remainingSeconds <= 0) {
            state.status = 'finished';
            state.remainingSeconds = 0;
            stopTicking();
        }

        broadcastState();
    }, 1000);
}

function stopTicking() {
    if (tickInterval) {
        clearInterval(tickInterval);
        tickInterval = null;
    }
}

// ===== HEALTH CHECK =====
app.get('/status', (req, res) => {
    const c = getClientCounts();
    res.json({
        ok: true,
        timer: {
            status: state.status,
            mode: state.mode,
            remainingSeconds: state.remainingSeconds,
            eventName: state.eventName,
        },
        clients: c,
        uptime: Math.floor(process.uptime()),
    });
});

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
    const role = socket.handshake.query.role || 'unknown';
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    console.log(`[+] ${role} connected: ${socket.id} (${ip})`);

    // track client
    if (role === 'display') clients.display.add(socket.id);
    else if (role === 'remote') clients.remote.add(socket.id);

    // send current state + client counts
    socket.emit('state', state);
    broadcastClients();

    // ---- COMMANDS FROM REMOTE ----
    socket.on('cmd:start', () => {
        if (state.status === 'running') return;

        if (state.status === 'stopped' || state.status === 'finished') {
            if (state.mode === 'countdown') {
                const { h, m, s } = state.countdownInput;
                state.totalSeconds = h * 3600 + m * 60 + s;
                state.remainingSeconds = state.totalSeconds;
            } else {
                const { h, m } = state.targetInput;
                const now = new Date();
                const target = new Date(now);
                target.setHours(h, m, 0, 0);
                if (target <= now) target.setDate(target.getDate() + 1);
                state.targetTime = target.toISOString();
                state.totalSeconds = Math.floor((target - now) / 1000);
                state.remainingSeconds = state.totalSeconds;
            }
            if (state.totalSeconds <= 0) return;
        }

        state.status = 'running';
        startTicking();
        broadcastState();
    });

    socket.on('cmd:pause', () => {
        if (state.status !== 'running') return;
        state.status = 'paused';
        stopTicking();
        broadcastState();
    });

    socket.on('cmd:reset', () => {
        state.status = 'stopped';
        stopTicking();

        if (state.mode === 'countdown') {
            const { h, m, s } = state.countdownInput;
            state.totalSeconds = h * 3600 + m * 60 + s;
            state.remainingSeconds = state.totalSeconds;
        } else {
            state.remainingSeconds = 0;
            state.totalSeconds = 0;
        }
        state.targetTime = null;
        broadcastState();
    });

    socket.on('cmd:setMode', (mode) => {
        if (mode !== 'countdown' && mode !== 'target') return;
        state.mode = mode;
        state.status = 'stopped';
        stopTicking();
        broadcastState();
    });

    socket.on('cmd:setCountdown', ({ h, m, s }) => {
        state.countdownInput = {
            h: Math.max(0, Math.min(99, parseInt(h) || 0)),
            m: Math.max(0, Math.min(59, parseInt(m) || 0)),
            s: Math.max(0, Math.min(59, parseInt(s) || 0)),
        };
        if (state.status === 'stopped') {
            state.totalSeconds = state.countdownInput.h * 3600 + state.countdownInput.m * 60 + state.countdownInput.s;
            state.remainingSeconds = state.totalSeconds;
        }
        broadcastState();
    });

    socket.on('cmd:setTarget', ({ h, m }) => {
        state.targetInput = {
            h: Math.max(0, Math.min(23, parseInt(h) || 0)),
            m: Math.max(0, Math.min(59, parseInt(m) || 0)),
        };
        broadcastState();
    });

    socket.on('cmd:setTheme', (theme) => {
        state.theme = theme;
        broadcastState();
    });

    socket.on('cmd:setEvent', (name) => {
        state.eventName = String(name).slice(0, 100);
        broadcastState();
    });

    socket.on('cmd:addTime', (seconds) => {
        const delta = parseInt(seconds) || 0;
        if (state.status === 'running' || state.status === 'paused') {
            state.remainingSeconds = Math.max(0, state.remainingSeconds + delta);
            state.totalSeconds = Math.max(state.totalSeconds, state.remainingSeconds);
            if (state.mode === 'target' && state.targetTime) {
                state.targetTime = new Date(Date.now() + state.remainingSeconds * 1000).toISOString();
            }
        }
        broadcastState();
    });

    socket.on('disconnect', () => {
        console.log(`[-] ${role} disconnected: ${socket.id} (${ip})`);
        clients.display.delete(socket.id);
        clients.remote.delete(socket.id);
        broadcastClients();
    });
});

// ===== START =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('='.repeat(50));
    console.log('  HACKATHON TIMER');
    console.log('='.repeat(50));
    console.log('');
    console.log(`  Projektor (display):  http://localhost:${PORT}/`);
    console.log(`  Pilot (remote):       http://localhost:${PORT}/remote.html`);
    console.log(`  Status (health):      http://localhost:${PORT}/status`);
    console.log('');

    const nets = os.networkInterfaces();
    const lanIps = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                lanIps.push(net.address);
            }
        }
    }
    if (lanIps.length > 0) {
        console.log('  Adresy sieciowe:');
        lanIps.forEach(ip => {
            console.log(`    http://${ip}:${PORT}/remote.html`);
        });
    }
    console.log('');
    console.log('='.repeat(50));
});
