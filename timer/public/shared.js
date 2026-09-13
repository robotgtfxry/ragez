/* Wspólna logika czasu: ekran projektora, pilot i strona startowa */
(function (global) {
  'use strict';

  const DEFAULT_COLORS = { normal: '#00ff88', warning: '#ff6b35', danger: '#ff0040' };

  function pad(n) { return String(n).padStart(2, '0'); }

  function numOr(v, fallback) { return typeof v === 'number' && Number.isFinite(v) ? v : fallback; }

  function splitTime(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return { total, h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
  }

  function formatTime(ms) {
    const { h, m, s } = splitTime(ms);
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // phase: idle | running | paused | finished, level: normal | warning | danger
  function computeTimer(st, now) {
    const finished = !!st.timerFinished;
    const running = !!st.timerRunning && !finished;
    const paused = running && !!st.timerPaused;

    let remaining = 0;
    if (running) {
      remaining = paused ? numOr(st.timerPausedRemaining, 0) : new Date(st.timerEndTime).getTime() - now;
    }
    remaining = Math.max(0, remaining || 0);

    const duration = numOr(st.timerDuration, 0);
    let progress = 1;
    if (finished) progress = 0;
    else if (running && duration > 0) progress = Math.min(1, remaining / duration);

    const parts = splitTime(remaining);
    let level = 'normal';
    if (finished) level = 'danger';
    else if (running) {
      if (parts.total <= numOr(st.dangerThreshold, 60)) level = 'danger';
      else if (parts.total <= numOr(st.warningThreshold, 300)) level = 'warning';
    }

    const color = level === 'danger' ? (st.timerDangerColor || DEFAULT_COLORS.danger)
      : level === 'warning' ? (st.timerWarningColor || DEFAULT_COLORS.warning)
      : (st.timerColor || DEFAULT_COLORS.normal);

    return {
      phase: finished ? 'finished' : paused ? 'paused' : running ? 'running' : 'idle',
      level, remaining, duration, progress, color, ...parts,
    };
  }

  // Synchronizacja z zegarem serwera (jak NTP): kilka próbek, wybieramy tę z najmniejszym opóźnieniem
  function createClock(socket) {
    const clock = {
      offset: 0,
      synced: false,
      now: () => Date.now() + clock.offset,
      hint(serverNow) {
        if (!clock.synced && typeof serverNow === 'number') clock.offset = serverNow - Date.now();
      },
    };

    function burst() {
      let best = null;
      let count = 0;
      const sample = () => {
        const t0 = Date.now();
        socket.emit('clock', (serverTime) => {
          const t1 = Date.now();
          const rtt = t1 - t0;
          if (typeof serverTime === 'number' && (!best || rtt < best.rtt)) {
            best = { rtt, offset: serverTime + rtt / 2 - t1 };
          }
          if (++count < 5) setTimeout(sample, 120);
          else if (best) { clock.offset = best.offset; clock.synced = true; }
        });
      };
      sample();
    }

    socket.on('connect', burst);
    if (socket.connected) burst();
    setInterval(() => { if (socket.connected) burst(); }, 60000);
    return clock;
  }

  global.TimerCore = { DEFAULT_COLORS, pad, splitTime, formatTime, computeTimer, createClock };
})(window);
