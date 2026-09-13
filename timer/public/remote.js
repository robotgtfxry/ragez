(() => {
  'use strict';

  const { computeTimer, formatTime, pad } = TimerCore;
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ============================================================
  //  Session
  // ============================================================
  function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  const token = (() => { try { return localStorage.getItem('panelToken'); } catch (e) { return null; } })();
  function logout() {
    try { localStorage.removeItem('panelToken'); } catch (e) {}
    location.replace('/?login=1');
  }
  if (!token) { logout(); return; }

  fetch('/api/session', { headers: { Authorization: 'Bearer ' + token } })
    .then((res) => { if (res.status === 401) logout(); else document.body.classList.remove('booting'); })
    .catch(() => document.body.classList.remove('booting'));

  const socket = io({ auth: { token } });
  const clock = TimerCore.createClock(socket);
  let st = null;

  // ============================================================
  //  Helpers
  // ============================================================
  function toast(message, type) {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    el.textContent = message;
    box.appendChild(el);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, 2400);
  }

  function emit(event, payload, okMessage, failMessage) {
    return new Promise((resolve) => {
      if (!socket.connected) {
        toast('Brak połączenia z serwerem', 'error');
        resolve(false);
        return;
      }
      socket.timeout(15000).emit(event, payload, (err, res) => {
        if (err) { toast('Serwer nie odpowiada', 'error'); resolve(false); return; }
        if (res && res.ok) {
          if (okMessage) toast(okMessage);
          resolve(true);
        } else {
          const message = (res && res.error) || failMessage;
          if (message) toast(message, 'error');
          resolve(false);
        }
      });
    });
  }

  function throttle(fn, ms) {
    let last = 0;
    let timer = null;
    let args = [];
    return (...next) => {
      args = next;
      const run = () => { last = Date.now(); timer = null; fn(...args); };
      const wait = ms - (Date.now() - last);
      if (wait <= 0) run();
      else if (!timer) timer = setTimeout(run, wait);
    };
  }

  function clampInt(value, min, max) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
  }

  function plural(n, one, few, many) {
    if (n === 1) return one;
    const d = n % 10, dd = n % 100;
    return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
  }

  function humanDuration(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const parts = [];
    if (h) parts.push(`${h} godz`);
    if (m) parts.push(`${m} min`);
    if (s || !parts.length) parts.push(`${s} s`);
    return parts.join(' ');
  }

  const clockText = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  function setVal(id, value) {
    const el = $(id);
    if (!el || document.activeElement === el || el.value === String(value)) return;
    el.value = value;
    if (el.type === 'range') paintRange(el);
  }
  function setChecked(id, value) { $(id).checked = !!value; }

  function paintRange(el) {
    const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--fill', pct + '%');
  }
  $$('input[type="range"]').forEach((r) => {
    paintRange(r);
    r.addEventListener('input', () => paintRange(r));
  });

  // Double-tap confirmation for destructive actions
  function armOrRun(btn, armedLabel, action) {
    const label = btn.querySelector('.lbl');
    if (btn.dataset.armed) {
      disarm(btn);
      action();
      return;
    }
    btn.dataset.armed = '1';
    if (label) { btn._label = label.textContent; label.textContent = armedLabel; }
    btn._armTimer = setTimeout(() => disarm(btn), 3000);
    if (navigator.vibrate) navigator.vibrate([12, 40, 12]);
  }
  function disarm(btn) {
    if (!btn.dataset.armed) return;
    clearTimeout(btn._armTimer);
    delete btn.dataset.armed;
    const label = btn.querySelector('.lbl');
    if (label && btn._label) label.textContent = btn._label;
  }

  document.addEventListener('pointerdown', (e) => {
    if (navigator.vibrate && e.target.closest('.btn, .chip-btn, .style-tile, .seg-btn, .tf-step, .bg-option, .pos-btn')) navigator.vibrate(8);
  });

  // ============================================================
  //  Connection
  // ============================================================
  function setConnection(online) {
    $('conn').className = 'conn ' + (online ? 'online' : 'offline');
    $('connText').textContent = online ? 'Połączony' : 'Rozłączony';
  }
  socket.on('connect', () => { socket.emit('register', 'remote'); setConnection(true); });
  socket.on('disconnect', () => setConnection(false));
  socket.on('connect_error', () => setConnection(false));
  socket.on('auth-required', logout);
  $('btnLogout').addEventListener('click', logout);

  // ============================================================
  //  Live timer
  // ============================================================
  const view = { color: null };

  function renderTimer() {
    if (!st) return;
    const t = computeTimer(st, clock.now());
    const text = formatTime(t.remaining);

    if (t.color !== view.color) {
      view.color = t.color;
      document.documentElement.style.setProperty('--accent', t.color);
    }

    const heroTime = $('heroTime');
    if (heroTime.textContent !== text) heroTime.textContent = text;
    heroTime.classList.toggle('long', text.length > 5);
    heroTime.classList.toggle('paused', t.phase === 'paused');
    if ($('dockTime').textContent !== text) $('dockTime').textContent = text;
    $('heroBar').style.width = (t.progress * 100) + '%';

    const phaseLabel = t.phase === 'running'
      ? (t.level === 'danger' ? 'Ostatnie sekundy' : t.level === 'warning' ? 'Kończy się' : 'Odliczanie')
      : { idle: 'Gotowy', paused: 'Pauza', finished: 'Czas minął' }[t.phase];
    const chip = $('heroPhase');
    if (chip.textContent !== phaseLabel) chip.textContent = phaseLabel;
    chip.className = 'phase-chip ' + t.phase;

    let endHtml = '';
    if (t.phase === 'running') {
      endHtml = `Koniec o <b>${clockText(new Date(new Date(st.timerEndTime).getTime() - clock.offset))}</b>`;
    } else if (t.phase === 'paused') {
      endHtml = 'Odliczanie <b>wstrzymane</b>';
    } else if (t.phase === 'finished' && st.timerFinishedAt) {
      endHtml = `Minął o <b>${clockText(new Date(st.timerFinishedAt - clock.offset))}</b>`;
    }
    if ($('heroEnd').innerHTML !== endHtml) $('heroEnd').innerHTML = endHtml;

    const paused = t.phase === 'paused';
    const canPause = t.phase === 'running' || paused;
    const pauseBtn = $('btnPause');
    pauseBtn.disabled = !canPause;
    pauseBtn.classList.toggle('btn-primary', paused);
    pauseBtn.classList.toggle('btn-warn', !paused);
    $('btnPauseLbl').textContent = paused ? 'Wznów' : 'Pauza';
    $('btnPauseIcon').setAttribute('href', paused ? '#i-play' : '#i-pause');
    $('dockPause').disabled = !canPause;
    $('dockPause').classList.toggle('btn-primary', paused);
    $('dockPause').classList.toggle('btn-warn', !paused);
    $('dockPauseIcon').setAttribute('href', paused ? '#i-play' : '#i-pause');
    $('btnStop').disabled = t.phase === 'idle';
    $('dockStop').disabled = t.phase === 'idle';

    const title = canPause ? `${text} · Pilot` : 'Hackathon Timer - Pilot';
    if (document.title !== title) document.title = title;
  }
  setInterval(renderTimer, 200);

  function togglePause() {
    if (!st || !st.timerRunning) return;
    if (st.timerPaused) emit('resume-timer', null, 'Wznowiono odliczanie');
    else emit('pause-timer', null, 'Pauza');
  }
  function stopTimer(btn) {
    armOrRun(btn, 'Na pewno?', () => emit('stop-timer', null, 'Timer zatrzymany'));
  }
  function addTime(seconds) {
    emit('add-time', seconds, null, 'Najpierw uruchom timer');
  }

  $('btnPause').addEventListener('click', togglePause);
  $('dockPause').addEventListener('click', togglePause);
  $('btnStop').addEventListener('click', () => stopTimer($('btnStop')));
  $('dockStop').addEventListener('click', () => stopTimer($('dockStop')));
  $$('[data-add]').forEach((btn) => btn.addEventListener('click', () => addTime(Number(btn.dataset.add))));

  new IntersectionObserver(([entry]) => {
    $('dock').classList.toggle('show', !entry.isIntersecting);
  }, { rootMargin: '-60px 0px 0px 0px' }).observe($('hero'));

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select, button, summary')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePause(); }
    else if (e.key === '+' || e.key === '=') addTime(60);
    else if (e.key === '-') addTime(-60);
  });

  // ============================================================
  //  New countdown
  // ============================================================
  $$('#timerTabs .seg-btn').forEach((btn) => btn.addEventListener('click', () => {
    $$('#timerTabs .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    $('tabDuration').hidden = btn.dataset.tab !== 'duration';
    $('tabUntil').hidden = btn.dataset.tab !== 'until';
    renderStartHints();
  }));

  function readDuration() {
    return {
      hours: clampInt($('setHours').value, 0, 99),
      minutes: clampInt($('setMinutes').value, 0, 59),
      seconds: clampInt($('setSeconds').value, 0, 59),
    };
  }

  function readUntilTarget() {
    const [h, m] = ($('targetTime').value || '17:00').split(':').map(Number);
    const target = new Date();
    target.setHours(h || 0, m || 0, 0, 0);
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
    return target;
  }

  function renderStartHints() {
    const d = readDuration();
    const sec = d.hours * 3600 + d.minutes * 60 + d.seconds;
    $('durationHint').innerHTML = sec > 0
      ? `${humanDuration(sec)} · koniec o <b>${clockText(new Date(Date.now() + sec * 1000))}</b>`
      : 'Ustaw czas większy od zera';
    const target = readUntilTarget();
    const left = Math.round((target.getTime() - Date.now()) / 60000) * 60;
    const tomorrow = target.getDate() !== new Date().getDate();
    $('untilHint').innerHTML = `Za <b>${humanDuration(left)}</b>${tomorrow ? ' (jutro)' : ''}`;
  }
  setInterval(renderStartHints, 5000);

  $$('.tf-step').forEach((btn) => btn.addEventListener('click', () => {
    const input = $(btn.dataset.target);
    const max = Number(input.max);
    let v = clampInt(input.value, 0, max) + Number(btn.dataset.step);
    if (v > max) v = 0;
    if (v < 0) v = max;
    input.value = v;
    renderStartHints();
  }));
  ['setHours', 'setMinutes', 'setSeconds', 'targetTime'].forEach((id) => $(id).addEventListener('input', renderStartHints));
  ['setHours', 'setMinutes', 'setSeconds'].forEach((id) => $(id).addEventListener('focus', (e) => e.target.select()));
  $$('[data-preset]').forEach((btn) => btn.addEventListener('click', () => {
    const [h, m, s] = btn.dataset.preset.split(',');
    $('setHours').value = h;
    $('setMinutes').value = m;
    $('setSeconds').value = s;
    renderStartHints();
  }));

  function startGuarded(btn, action) {
    if (st && st.timerRunning) armOrRun(btn, 'Nadpisać bieżący?', action);
    else action();
  }

  $('btnStart').addEventListener('click', () => {
    const d = readDuration();
    const ms = (d.hours * 3600 + d.minutes * 60 + d.seconds) * 1000;
    if (ms <= 0) { toast('Ustaw czas większy od zera', 'error'); return; }
    startGuarded($('btnStart'), () => emit('start-timer', d, `Start! ${formatTime(ms)}`));
  });

  $('btnStartUntil').addEventListener('click', () => {
    const target = readUntilTarget();
    startGuarded($('btnStartUntil'), () => emit('start-timer-until', {
      targetTime: target.getTime(),
      targetHour: target.getHours(),
      targetMinute: target.getMinutes(),
    }, `Odliczanie do ${clockText(target)}`));
  });

  // ============================================================
  //  Preview & devices
  // ============================================================
  let previewLoaded = false;
  function setPreview(open) {
    $('previewToggle').setAttribute('aria-expanded', String(open));
    $('previewBody').hidden = !open;
    const frame = $('previewFrame');
    if (open && !previewLoaded) { frame.src = '/display.html?preview=1'; previewLoaded = true; }
    if (!open && previewLoaded) { frame.src = 'about:blank'; previewLoaded = false; }
    store('previewOpen', open);
  }
  $('previewToggle').addEventListener('click', () => setPreview($('previewBody').hidden));
  setPreview(load('previewOpen', true));
  new ResizeObserver(([entry]) => {
    $('previewFrame').style.transform = `scale(${entry.contentRect.width / 1920})`;
  }).observe($('previewStage'));

  function getDeviceName(ua) {
    if (!ua) return 'Nieznane';
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android.*Mobile/i.test(ua)) return 'Android';
    if (/Android/i.test(ua)) return 'Tablet Android';
    if (/Windows/i.test(ua)) return 'Windows PC';
    if (/Macintosh/i.test(ua)) return 'Mac';
    if (/Linux/i.test(ua)) return 'Linux';
    return 'Urządzenie';
  }

  socket.on('connection-count', (data) => {
    const list = $('devicesList');
    list.textContent = '';
    (data.devices || []).forEach((d) => {
      const chip = document.createElement('span');
      chip.className = 'device-chip' + (d.role === 'display' ? '' : ' remote');
      const dot = document.createElement('span');
      dot.className = 'dot';
      const role = document.createElement('em');
      role.textContent = (d.role === 'display' ? 'Ekran' : 'Pilot') + (d.id === socket.id ? ' · ty' : '');
      chip.append(dot, getDeviceName(d.userAgent), role);
      list.appendChild(chip);
    });
    $('devicesCount').textContent = `${data.displays} ${plural(data.displays, 'ekran', 'ekrany', 'ekranów')} · ${data.remotes} ${plural(data.remotes, 'pilot', 'piloty', 'pilotów')}`;
    $('heroScreens').classList.toggle('none', data.displays === 0);
    $('heroScreensText').textContent = data.displays === 0
      ? 'Brak podłączonego ekranu!'
      : `${data.displays} ${plural(data.displays, 'ekran', 'ekrany', 'ekranów')} online`;
  });

  // ============================================================
  //  Look: styles, glow, ring variants, colors, effects
  // ============================================================
  const GLOW_OPTIONS = {
    cyber: [['none', 'Brak'], ['soft', 'Miękki'], ['neon', 'Neon'], ['intense', 'Intensywny'], ['pulse', 'Pulsujący'],
      ['electric', 'Elektryczny'], ['matrix', 'Matrix'], ['rainbow', 'Tęcza'], ['custom', 'Własny kolor']],
    ring: [['none', 'Brak'], ['soft', 'Miękki'], ['neon', 'Neon'], ['pulse', 'Pulsujący'], ['breathe', 'Oddech'],
      ['fire', 'Ogień'], ['ice', 'Lód'], ['rainbow', 'Tęcza'], ['custom', 'Własny kolor']],
    classic: [['none', 'Brak'], ['subtle', 'Delikatny'], ['soft', 'Miękki'], ['neon', 'Neon'], ['warm', 'Ciepły'],
      ['cold', 'Zimny'], ['shadow', 'Cień'], ['custom', 'Własny kolor']],
    minimal: [['none', 'Brak'], ['subtle', 'Delikatny'], ['soft', 'Miękki'], ['shadow', 'Cień'], ['breathe', 'Oddech']],
    flip: [['none', 'Brak'], ['soft', 'Miękki'], ['neon', 'Neon'], ['retro', 'Retro'], ['warm', 'Ciepły'],
      ['electric', 'Elektryczny'], ['fire', 'Ogień'], ['custom', 'Własny kolor']],
  };
  const RING_VARIANTS = [['classic', 'Klasyczny'], ['no-ticks', 'Bez kresek'], ['major-only', 'Główne kreski'],
    ['dots', 'Kropki'], ['thin', 'Cienki'], ['thick', 'Gruby'], ['double', 'Podwójny'],
    ['minimal-arc', 'Minimalny łuk'], ['glow-ring', 'Świecący']];

  function makeChips(container, options, onPick) {
    container.textContent = '';
    options.forEach(([id, name]) => {
      const btn = document.createElement('button');
      btn.className = 'chip-btn';
      btn.dataset.id = id;
      btn.textContent = name;
      btn.addEventListener('click', () => onPick(id));
      container.appendChild(btn);
    });
  }
  const markActive = (container, id) => $$('[data-id]', container).forEach((b) => b.classList.toggle('active', b.dataset.id === id));

  function glowPayload(id) {
    return id === 'custom' ? { style: 'custom', color1: $('glowColor1').value, color2: $('glowColor2').value } : id;
  }

  function pickGlow(id) {
    st.timerGlowStyle = id;
    emit('set-timer-glow', glowPayload(id));
    renderLook();
  }

  makeChips($('ringChips'), RING_VARIANTS, (id) => {
    st.ringVariant = id;
    emit('set-ring-variant', id);
    renderLook();
  });

  $$('.style-tile').forEach((tile) => tile.addEventListener('click', () => {
    if (!st) return;
    const style = tile.dataset.style;
    st.timerDisplayStyle = style;
    emit('set-timer-display-style', style);
    const available = GLOW_OPTIONS[style];
    if (!available.some(([id]) => id === st.timerGlowStyle)) {
      pickGlow((available.find(([id]) => id === 'neon') || available[1])[0]);
    }
    renderLook();
  }));

  let glowChipsFor = null;
  function renderLook() {
    const style = GLOW_OPTIONS[st.timerDisplayStyle] ? st.timerDisplayStyle : 'cyber';
    $$('.style-tile').forEach((t) => t.classList.toggle('active', t.dataset.style === style));
    if (glowChipsFor !== style) {
      makeChips($('glowChips'), GLOW_OPTIONS[style], pickGlow);
      glowChipsFor = style;
    }
    markActive($('glowChips'), st.timerGlowStyle);
    $('glowCustom').hidden = st.timerGlowStyle !== 'custom';
    $('ringVariantBlock').hidden = style !== 'ring';
    markActive($('ringChips'), st.ringVariant || 'classic');
  }

  const sendGlowColors = throttle(() => emit('set-timer-glow', glowPayload('custom')), 120);
  ['glowColor1', 'glowColor2'].forEach((id) => $(id).addEventListener('input', sendGlowColors));

  const sendTimerColors = throttle(() => emit('set-timer-colors', {
    timerColor: $('timerColor').value,
    warningColor: $('warningColor').value,
    dangerColor: $('dangerColor').value,
  }), 120);
  ['timerColor', 'warningColor', 'dangerColor'].forEach((id) => $(id).addEventListener('input', sendTimerColors));

  $('showTimerBar').addEventListener('change', (e) => emit('set-timer-bar-visible', e.target.checked));
  ['finalCountdown', 'showClock', 'celebration'].forEach((id) => $(id).addEventListener('change', (e) => {
    emit('set-effects', { [id]: e.target.checked });
  }));

  // ============================================================
  //  Label
  // ============================================================
  function setTimerLabel() {
    const label = $('timerLabelInput').value.trim();
    emit('set-timer-label', label, label ? 'Napis ustawiony' : 'Napis usunięty');
  }
  $('btnSetLabel').addEventListener('click', setTimerLabel);
  $('timerLabelInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') setTimerLabel(); });

  const sendLabelStyle = throttle(() => emit('set-label-style', {
    font: $('labelFont').value,
    size: clampInt($('labelSize').value, 50, 250),
    uppercase: $('labelUppercase').checked,
    color: $('labelColor').value,
  }), 120);
  $('labelFont').addEventListener('change', sendLabelStyle);
  $('labelUppercase').addEventListener('change', sendLabelStyle);
  $('labelColor').addEventListener('input', sendLabelStyle);
  $('labelSize').addEventListener('input', () => {
    $('labelSizeVal').textContent = $('labelSize').value + '%';
    sendLabelStyle();
  });

  // ============================================================
  //  Warnings
  // ============================================================
  function renderThresholdHints() {
    $('warningThresholdHint').textContent = '= ' + humanDuration(clampInt($('warningThreshold').value, 0, 360000));
    $('dangerThresholdHint').textContent = '= ' + humanDuration(clampInt($('dangerThreshold').value, 0, 360000));
  }
  ['warningThreshold', 'dangerThreshold'].forEach((id) => {
    $(id).addEventListener('input', renderThresholdHints);
    $(id).addEventListener('change', () => emit('set-timer-colors', {
      warningThreshold: clampInt($('warningThreshold').value, 0, 360000),
      dangerThreshold: clampInt($('dangerThreshold').value, 0, 360000),
    }, 'Zapisano progi'));
  });
  ['warningMessage', 'dangerMessage', 'pauseMessage'].forEach((id) => $(id).addEventListener('change', (e) => {
    emit('set-timer-colors', { [id]: e.target.value }, 'Zapisano komunikat');
  }));

  // ============================================================
  //  Images
  // ============================================================
  function readDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Nie udało się odczytać pliku'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Nie udało się wczytać obrazka')); };
      img.src = url;
    });
  }

  // Scales the image down and re-encodes it (WebP keeps transparency); GIFs are sent as-is to keep animation
  async function prepareImage(file, maxW, maxH) {
    if (!file.type.startsWith('image/')) throw new Error('Wybierz plik graficzny');
    if (file.type === 'image/gif') {
      if (file.size > 7.5 * 1024 * 1024) throw new Error('GIF jest za duży (max 7,5 MB)');
      return readDataUrl(file);
    }
    const img = await loadImage(file);
    const ratio = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    let url = canvas.toDataURL('image/webp', 0.88);
    if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/png');
    return url;
  }

  function setupDropzone(zoneId, inputId, maxW, maxH, send) {
    const zone = $(zoneId);
    const input = $(inputId);
    async function handle(file) {
      if (!file) return;
      zone.classList.add('busy');
      try {
        await send(await prepareImage(file, maxW, maxH));
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        zone.classList.remove('busy');
      }
    }
    zone.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
    input.addEventListener('change', () => { handle(input.files[0]); input.value = ''; });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      handle(e.dataTransfer.files[0]);
    });
  }

  function renderMediaPreview(previewId, imgId, url) {
    $(previewId).hidden = !url;
    if (url && $(imgId).getAttribute('src') !== url) $(imgId).src = url;
  }

  // ============================================================
  //  Finish
  // ============================================================
  $('finishMessage').addEventListener('change', (e) => emit('set-finish-message', e.target.value, 'Zapisano komunikat końcowy'));
  setupDropzone('finishDrop', 'finishImageUpload', 1920, 1080, (data) => emit('set-finish-image', data, 'Obrazek końcowy wysłany'));
  $('btnRemoveFinish').addEventListener('click', () => emit('set-finish-image', null, 'Usunięto obrazek końcowy'));
  $('btnResetFinish').addEventListener('click', () => emit('reset-finish', null, 'Ekran końcowy schowany', 'Ekran końcowy nie jest wyświetlany'));

  // ============================================================
  //  Announcements
  // ============================================================
  let annPosition = 'bottom';

  function sendAnnouncement(text) {
    text = (text || '').trim();
    if (!text) { toast('Wpisz treść komunikatu', 'error'); return; }
    emit('send-announcement', {
      text,
      textColor: $('annTextColor').value,
      bgColor: $('annBgColor').value + 'dd',
      fontSize: clampInt($('annFontSize').value, 16, 140),
      duration: clampInt($('annDuration').value, 0, 3600),
      position: annPosition,
    }, 'Komunikat na ekranie');
  }

  const clearAnnouncement = () => emit('clear-announcement', null, 'Komunikat usunięty', 'Brak aktywnego komunikatu');

  $('btnSendAnn').addEventListener('click', () => sendAnnouncement($('announcementText').value));
  $('btnClearAnn').addEventListener('click', clearAnnouncement);
  $('btnClearAnnLive').addEventListener('click', clearAnnouncement);
  $('announcementText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendAnnouncement($('announcementText').value);
  });
  $('annFontSize').addEventListener('input', () => { $('annFontSizeVal').textContent = $('annFontSize').value + ' px'; });
  $$('#annDurationChips .chip-btn').forEach((chip) => chip.addEventListener('click', () => {
    $('annDuration').value = chip.dataset.duration;
    $$('#annDurationChips .chip-btn').forEach((c) => c.classList.toggle('active', c === chip));
  }));
  $$('#annPosition .seg-btn').forEach((btn) => btn.addEventListener('click', () => {
    annPosition = btn.dataset.pos;
    $$('#annPosition .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
  }));
  $$('[data-text]').forEach((btn) => btn.addEventListener('click', () => {
    $('announcementText').value = btn.dataset.text;
    sendAnnouncement(btn.dataset.text);
  }));

  function renderAnnouncementLive() {
    const a = st.announcement;
    $('annLive').hidden = !a;
    if (a) $('annLiveText').textContent = 'Na ekranie: ' + a.text;
  }

  // ============================================================
  //  Backgrounds
  // ============================================================
  const BACKGROUNDS = [
    { id: 'bg-dark-gradient', name: 'Ciemny', colors: ['#0a0a2e', '#1a0a3e', '#0a1a3e'] },
    { id: 'bg-cyber-purple', name: 'Cyber', colors: ['#1a002e', '#3d0066', '#0d0022'] },
    { id: 'bg-ocean-deep', name: 'Ocean', colors: ['#001122', '#003355', '#000d1a'] },
    { id: 'bg-fire', name: 'Ogień', colors: ['#1a0000', '#4d0000', '#1a0500'] },
    { id: 'bg-matrix', name: 'Matrix', colors: ['#000a00', '#001a00', '#000800'] },
    { id: 'bg-sunset', name: 'Zachód', colors: ['#1a0022', '#661a00', '#332200'] },
    { id: 'bg-arctic', name: 'Arktyka', colors: ['#0a1628', '#162d50', '#051020'] },
    { id: 'bg-neon-city', name: 'Neon', colors: ['#0d001a', '#1a0033', '#001a0d'] },
    { id: 'bg-midnight', name: 'Północ', colors: ['#000000', '#1a1a2e', '#000000'] },
    { id: 'bg-volcano', name: 'Wulkan', colors: ['#1a0500', '#4d1a00', '#0d0500'] },
    { id: 'bg-aurora', name: 'Aurora', colors: ['#001a0d', '#001a33', '#1a0033'] },
    { id: 'bg-galaxy', name: 'Galaktyka', colors: ['#0a001a', '#000d1a', '#1a000d'] },
  ];

  BACKGROUNDS.forEach((bg) => {
    const btn = document.createElement('button');
    btn.className = 'bg-option';
    btn.dataset.id = bg.id;
    btn.style.background = `linear-gradient(135deg, ${bg.colors.join(',')})`;
    const name = document.createElement('span');
    name.textContent = bg.name;
    btn.appendChild(name);
    btn.addEventListener('click', () => emit('set-background', bg.id));
    $('bgGrid').appendChild(btn);
  });

  $('btnCustomBg').addEventListener('click', () => emit('set-custom-bg', {
    color1: $('customBg1').value,
    color2: $('customBg2').value,
  }, 'Własne tło ustawione'));
  setupDropzone('bgDrop', 'bgImageInput', 1920, 1080, (image) => emit('set-custom-bg-image', { image }, 'Zdjęcie tła ustawione'));
  $('btnRemoveBg').addEventListener('click', () => emit('set-custom-bg-image', { image: null }, 'Usunięto zdjęcie tła'));

  // ============================================================
  //  Overlay
  // ============================================================
  setupDropzone('overlayDrop', 'overlayUpload', 1000, 1000, (image) => emit('set-overlay-image', {
    image,
    position: st.overlayPosition,
    size: clampInt($('overlaySize').value, 50, 600),
  }, 'Logo na ekranie'));
  $('btnRemoveOverlay').addEventListener('click', () => emit('remove-overlay-image', null, 'Usunięto logo'));
  $$('#overlayPos .pos-btn').forEach((btn) => btn.addEventListener('click', () => {
    st.overlayPosition = btn.dataset.pos;
    markPositions();
    emit('set-overlay-image', { position: btn.dataset.pos });
  }));
  const sendOverlaySize = throttle(() => emit('set-overlay-image', { size: clampInt($('overlaySize').value, 50, 600) }), 150);
  $('overlaySize').addEventListener('input', () => {
    $('overlaySizeVal').textContent = $('overlaySize').value + ' px';
    sendOverlaySize();
  });
  function markPositions() {
    $$('#overlayPos .pos-btn').forEach((b) => b.classList.toggle('active', b.dataset.pos === (st.overlayPosition || 'top-right')));
  }

  // ============================================================
  //  Sounds & effects
  // ============================================================
  ['soundEnabled', 'warningSound', 'finishSound', 'tickSound'].forEach((id) => $(id).addEventListener('change', () => {
    emit('set-sounds', {
      soundEnabled: $('soundEnabled').checked,
      warningSound: $('warningSound').checked,
      finishSound: $('finishSound').checked,
      tickSound: $('tickSound').checked,
    });
  }));
  $('btnTestSound').addEventListener('click', () => emit('trigger-fx', 'test-sound', 'Wysłano sygnał testowy na ekrany'));
  $('btnFireworks').addEventListener('click', () => emit('trigger-fx', 'celebrate', 'Fajerwerki! 🎆'));

  // ============================================================
  //  Panels open state
  // ============================================================
  const openPanels = load('openPanels', ['look']);
  $$('details.panel').forEach((panel) => {
    panel.open = openPanels.includes(panel.dataset.key);
    panel.addEventListener('toggle', () => {
      store('openPanels', $$('details.panel').filter((p) => p.open).map((p) => p.dataset.key));
    });
  });

  // ============================================================
  //  State sync
  // ============================================================
  function syncForm() {
    setVal('timerColor', st.timerColor || '#00ff88');
    setVal('warningColor', st.timerWarningColor || '#ff6b35');
    setVal('dangerColor', st.timerDangerColor || '#ff0040');
    setVal('glowColor1', st.glowColor1 || '#00ff88');
    setVal('glowColor2', st.glowColor2 || '#0088ff');
    setVal('warningThreshold', st.warningThreshold ?? 300);
    setVal('dangerThreshold', st.dangerThreshold ?? 60);
    setVal('warningMessage', st.warningMessage ?? '');
    setVal('dangerMessage', st.dangerMessage ?? '');
    setVal('pauseMessage', st.pauseMessage ?? '');
    setVal('finishMessage', st.finishMessage ?? '');
    setVal('timerLabelInput', st.timerLabel || '');
    setVal('labelFont', st.labelFont || 'Rajdhani');
    setVal('labelSize', st.labelSize || 100);
    $('labelSizeVal').textContent = (st.labelSize || 100) + '%';
    setVal('labelColor', st.labelColor || '#ffffff');
    setVal('customBg1', st.customBgColor1 || '#0a0a2e');
    setVal('customBg2', st.customBgColor2 || '#1a1a4e');
    setVal('overlaySize', st.overlaySize || 150);
    $('overlaySizeVal').textContent = (st.overlaySize || 150) + ' px';
    setChecked('labelUppercase', st.labelUppercase !== false);
    setChecked('showTimerBar', st.showTimerBar !== false);
    setChecked('finalCountdown', st.finalCountdown !== false);
    setChecked('showClock', st.showClock === true);
    setChecked('celebration', st.celebration !== false);
    setChecked('soundEnabled', st.soundEnabled !== false);
    setChecked('warningSound', st.warningSound !== false);
    setChecked('finishSound', st.finishSound !== false);
    setChecked('tickSound', st.tickSound === true);
    renderThresholdHints();
  }

  socket.on('state-sync', (state) => {
    clock.hint(state.serverNow);
    st = state;
    syncForm();
    renderLook();
    $$('.bg-option').forEach((b) => b.classList.toggle('active', b.dataset.id === st.background));
    renderMediaPreview('bgImagePreview', 'bgImagePrev', st.customBgImage);
    renderMediaPreview('finishPreview', 'finishImgPrev', st.finishImage);
    renderMediaPreview('overlayPreview', 'overlayPrev', st.overlayImage);
    markPositions();
    renderAnnouncementLive();
    renderTimer();
  });

  renderStartHints();
})();
