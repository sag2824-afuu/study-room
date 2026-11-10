(() => {
  'use strict';
  const T = 32;          // 每格像素
  const NEAR = 2.5;      // 與伺服器一致，用來畫範圍圈
  const COLORS = ['#e05a5a', '#f0a33a', '#e8c63a', '#5bbf6a', '#4a90d9', '#7b6ad9', '#d96ab0', '#555b66'];
  const HAIRS = ['#2b1d14', '#6b4226', '#c98a3c', '#e8d6a0', '#8a8f99', '#b83a2e'];
  const SKIN = '#f5cfa8';
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
  };

  let config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], needPassword: false };
  const profile = {
    name: store.get('name') || '',
    color: store.get('color') || COLORS[4],
    hair: store.get('hair') || HAIRS[0],
    auto: store.get('auto') !== '0',
    password: '',
  };
  let selfId = null;
  let joined = false;
  let camTrack = null; // 預設關閉，按按鈕才開
  let micTrack = null;
  let clockOffset = 0;
  let pomo = { phase: 'idle', endsAt: 0, round: 0 };
  let boardData = [];
  const users = new Map(); // id -> {..., rx, ry, anim}
  const peers = new Map(); // id -> {pc, pending, tile, video}
  let nearby = []; // 附近的人 [{id,name,linked,iWant,theyWant}]
  window.__room = { users, peers };

  // ---------- 小工具 ----------
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const c = (v) => Math.max(0, Math.min(255, v));
    const r = c((n >> 16) + amt), g = c(((n >> 8) & 255) + amt), b = c((n & 255) + amt);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }
  const pad = (n) => String(n).padStart(2, '0');
  function fmtDur(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h ? `${h} 小時 ${m} 分` : `${m} 分`;
  }

  // ---------- 像素小人 ----------
  function drawAvatar(ctx, x, y, p, u) {
    const r = (gx, gy, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x + gx * p, y + gy * p, w * p, h * p); };
    const step = u.moving ? Math.floor((u.anim || 0) * 8) % 2 : -1;
    const b = step === 1 ? -1 : 0;
    ctx.fillStyle = 'rgba(0,0,0,.2)';
    ctx.beginPath(); ctx.ellipse(x + 8 * p, y + 15 * p, 5 * p, 1.5 * p, 0, 0, Math.PI * 2); ctx.fill();
    r(5, 12 + (step === 0 ? -1 : 0), 2, 3, '#3a3f4b');
    r(9, 12 + (step === 1 ? -1 : 0), 2, 3, '#3a3f4b');
    r(4, 8 + b, 8, 5, u.color);
    r(3, 9 + b, 1, 3, shade(u.color, -30)); r(12, 9 + b, 1, 3, shade(u.color, -30));
    r(3, 12 + b, 1, 1, SKIN); r(12, 12 + b, 1, 1, SKIN);
    r(4, 2 + b, 8, 7, SKIN);
    r(4, 1 + b, 8, 2, u.hair);
    if (u.dir === 'up') {
      r(4, 1 + b, 8, 7, u.hair);
    } else {
      r(4, 3 + b, 1, 3, u.hair); r(11, 3 + b, 1, 3, u.hair);
      if (u.dir === 'left') { r(9, 3 + b, 3, 4, u.hair); r(5, 5 + b, 1, 2, '#222'); r(7, 5 + b, 1, 2, '#222'); }
      else if (u.dir === 'right') { r(4, 3 + b, 3, 4, u.hair); r(8, 5 + b, 1, 2, '#222'); r(10, 5 + b, 1, 2, '#222'); }
      else { r(6, 5 + b, 1, 2, '#222'); r(9, 5 + b, 1, 2, '#222'); r(7, 7 + b, 2, 1, '#e0907f'); }
    }
  }

  // ---------- 地圖繪製（只畫一次） ----------
  function renderMap() {
    const c = document.createElement('canvas');
    c.width = MAP.W * T; c.height = MAP.H * T;
    const g = c.getContext('2d');
    for (let y = 0; y < MAP.H; y++) for (let x = 0; x < MAP.W; x++) drawTile(g, x, y, MAP.tile(x, y));
    g.font = 'bold 14px system-ui, "PingFang TC", "Microsoft JhengHei", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const l of MAP.LABELS) {
      const w = g.measureText(l.text).width + 16;
      g.fillStyle = 'rgba(255,250,242,.85)';
      roundRect(g, l.x * T - w / 2, l.y * T - 11, w, 22, 11); g.fill();
      g.fillStyle = '#3b2f27'; g.fillText(l.text, l.x * T, l.y * T + 1);
    }
    return c;
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function edges(g, x, y, t, color, wdt) {
    const px = x * T, py = y * T;
    g.fillStyle = color;
    if (MAP.tile(x, y - 1) !== t) g.fillRect(px, py, T, wdt);
    if (MAP.tile(x, y + 1) !== t) g.fillRect(px, py + T - wdt, T, wdt);
    if (MAP.tile(x - 1, y) !== t) g.fillRect(px, py, wdt, T);
    if (MAP.tile(x + 1, y) !== t) g.fillRect(px + T - wdt, py, wdt, T);
  }
  function drawTile(g, x, y, t) {
    const px = x * T, py = y * T, alt = (x + y) % 2;
    const quietish = t === 'q' || t === 'D';
    g.fillStyle = quietish ? (alt ? '#cfe3d4' : '#c6dccb') : t === 'r' ? '#e7b9a5' : (alt ? '#eadfc8' : '#e4d7bd');
    g.fillRect(px, py, T, T);
    switch (t) {
      case '#':
        g.fillStyle = '#6b5547'; g.fillRect(px, py, T, T);
        g.fillStyle = '#856a59'; g.fillRect(px, py + T - 10, T, 10);
        g.fillStyle = '#5a463a'; g.fillRect(px, py + T - 11, T, 1);
        break;
      case 'B': {
        g.fillStyle = '#6e4a2c'; g.fillRect(px, py, T, T);
        g.fillStyle = '#4f341f'; g.fillRect(px + 2, py + 3, T - 4, 12); g.fillRect(px + 2, py + 17, T - 4, 12);
        const books = ['#c0504d', '#4f81bd', '#9bbb59', '#e8b04a', '#8064a2', '#4bacc6'];
        for (let row = 0; row < 2; row++) {
          let bx = px + 3;
          let i = (x * 7 + row * 3) % books.length;
          while (bx < px + T - 5) {
            const w = 3 + ((bx + row + x) % 2);
            const h = 9 + ((bx + x) % 3);
            g.fillStyle = books[i++ % books.length];
            g.fillRect(bx, py + 4 + row * 14 + (11 - h), w, h);
            bx += w + 1;
          }
        }
        break;
      }
      case 'D':
        g.fillStyle = '#8a5a2e'; g.fillRect(px + 1, py + 6, T - 2, T - 10);
        g.fillStyle = '#b07a44'; g.fillRect(px + 1, py + 6, T - 2, 14);
        if ((x + y) % 3 === 0) { g.fillStyle = '#f2efe6'; g.fillRect(px + 8, py + 9, 14, 9); g.fillStyle = '#c9c3b5'; g.fillRect(px + 15, py + 9, 1, 9); }
        else if ((x + y) % 3 === 1) { g.fillStyle = '#4f81bd'; g.fillRect(px + 6, py + 10, 10, 7); g.fillStyle = '#e8b04a'; g.fillRect(px + 18, py + 8, 6, 9); }
        else { g.fillStyle = '#ffe9a8'; g.beginPath(); g.arc(px + 16, py + 12, 5, 0, Math.PI * 2); g.fill(); }
        break;
      case 'T':
        g.fillStyle = '#8b5a2b'; g.fillRect(px, py, T, T);
        edges(g, x, y, 'T', '#6b4320', 3);
        break;
      case 'r':
        edges(g, x, y, 'r', '#c98f78', 3);
        break;
      case 'P':
        g.fillStyle = '#b5653b'; g.fillRect(px + 10, py + 20, 12, 10);
        g.fillStyle = '#3f8f4a';
        [[16, 12, 9], [10, 15, 6], [22, 15, 6], [16, 7, 6]].forEach(([cx, cy, rr]) => { g.beginPath(); g.arc(px + cx, py + cy, rr, 0, Math.PI * 2); g.fill(); });
        g.fillStyle = '#5fb36a'; g.beginPath(); g.arc(px + 13, py + 10, 3, 0, Math.PI * 2); g.fill();
        break;
      default: break;
    }
  }

  // ---------- 加入畫面 ----------
  const previewCtx = $('preview').getContext('2d');
  function drawPreview() {
    previewCtx.clearRect(0, 0, 64, 64);
    drawAvatar(previewCtx, 0, 0, 4, { color: profile.color, hair: profile.hair, dir: 'down', moving: false });
  }
  function buildSwatches(el, list, key) {
    el.innerHTML = '';
    for (const c of list) {
      const b = document.createElement('button');
      b.type = 'button'; b.style.background = c; b.title = c;
      if (c === profile[key]) b.classList.add('sel');
      b.onclick = () => { profile[key] = c; [...el.children].forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); drawPreview(); };
      el.append(b);
    }
  }
  $('name').value = profile.name;
  buildSwatches($('colors'), COLORS, 'color');
  buildSwatches($('hairs'), HAIRS, 'hair');
  drawPreview();
  fetch('/config').then((r) => r.json()).then((c) => { config = c; $('pwWrap').hidden = !c.needPassword; }).catch(() => {});

  $('joinBtn').onclick = async () => {
    const name = $('name').value.trim();
    if (!name) { $('joinErr').textContent = '請輸入名字'; return; }
    profile.name = name;
    profile.password = $('pw').value;
    store.set('name', name); store.set('color', profile.color); store.set('hair', profile.hair);
    $('joinBtn').disabled = true; $('joinErr').textContent = '';
    ensureAudio();
    sendJoin();
  };
  $('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });

  // ---------- Socket ----------
  const socket = io();

  function sendJoin() {
    socket.emit('join', profile, (res) => {
      $('joinBtn').disabled = false;
      if (!res || !res.ok) {
        $('joinErr').textContent = (res && res.error) || '無法加入';
        if (joined) { joined = false; $('app').hidden = true; $('join').hidden = false; }
        return;
      }
      const first = !joined;
      joined = true;
      selfId = res.self.id;
      clockOffset = res.now - Date.now();
      users.clear();
      nearby = []; renderNearby();
      res.users.forEach(addUser);
      $('messages').innerHTML = '';
      res.chat.forEach(addMsg);
      setPomo(res.pomo, true);
      setBoard(res.board);
      $('join').hidden = true; $('app').hidden = false;
      if (first) setupSelfTile();
      updateZone();
      updateMediaButtons();
    });
  }

  socket.on('connect', () => { $('offline').hidden = true; if (joined) sendJoin(); });
  socket.on('disconnect', () => {
    if (!joined) return;
    $('offline').hidden = false;
    for (const id of [...peers.keys()]) closePeer(id);
    nearby = []; renderNearby();
  });
  socket.on('user-joined', addUser);
  socket.on('user-moved', (m) => {
    const u = users.get(m.id);
    if (!u) return;
    if (Math.abs(u.x - m.x) + Math.abs(u.y - m.y) > 2) { u.rx = m.x; u.ry = m.y; }
    u.x = m.x; u.y = m.y; u.dir = m.dir;
  });
  socket.on('user-left', ({ id }) => { users.delete(id); closePeer(id); });
  socket.on('correct', ({ x, y }) => { const me = users.get(selfId); if (me) { me.x = x; me.y = y; updateZone(); } });
  socket.on('chat', addMsg);
  socket.on('pomo', (p) => setPomo(p, false));
  socket.on('board', setBoard);
  socket.on('nearby', (list) => {
    const before = new Set(nearby.filter((n) => n.theyWant && !n.iWant).map((n) => n.id));
    nearby = list || [];
    if (nearby.some((n) => n.theyWant && !n.iWant && !before.has(n.id))) beep('ring');
    renderNearby();
  });

  // ---------- 接通按鈕 ----------
  function updateAutoBtn() {
    $('autoBtn').textContent = profile.auto ? '🔔 自動接通：開' : '🔕 自動接通：關';
    $('autoBtn').classList.toggle('manual', !profile.auto);
  }
  $('autoBtn').onclick = () => {
    profile.auto = !profile.auto;
    store.set('auto', profile.auto ? '1' : '0');
    socket.emit('set-auto', profile.auto);
    updateAutoBtn();
  };
  updateAutoBtn();
  function renderNearby() {
    const box = $('nearby');
    box.innerHTML = '';
    for (const n of nearby) {
      const row = document.createElement('div');
      row.className = 'near';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = n.name;
      const st = document.createElement('span'); st.className = 'st';
      const btn = document.createElement('button');
      if (n.linked) {
        st.textContent = '通話中'; btn.textContent = '掛斷'; btn.className = 'hang';
        btn.onclick = () => socket.emit('hangup', n.id);
      } else if (n.iWant && !n.theyWant) {
        st.textContent = '等待對方接通…'; btn.textContent = '取消';
        btn.onclick = () => socket.emit('hangup', n.id);
      } else if (n.theyWant) {
        row.classList.add('ringing');
        st.textContent = '想跟你通話'; btn.textContent = '📞 接聽'; btn.className = 'call';
        btn.onclick = () => socket.emit('call', n.id);
      } else {
        st.textContent = '在附近'; btn.textContent = '📞 接通'; btn.className = 'call';
        btn.onclick = () => socket.emit('call', n.id);
      }
      row.append(nm, st, btn);
      box.append(row);
    }
  }

  function addUser(u) {
    const old = users.get(u.id);
    users.set(u.id, Object.assign(old || { rx: u.x, ry: u.y, anim: 0 }, u));
  }

  // ---------- WebRTC ----------
  function getPeer(id, initiator) {
    let p = peers.get(id);
    if (p) return p;
    const pc = new RTCPeerConnection({ iceServers: config.iceServers });
    p = { pc, pending: [], tile: null, video: null };
    peers.set(id, p);
    if (initiator) {
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      attachTracks(p);
    }
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => {
      ensureTile(id);
      const v = p.video;
      if (e.streams && e.streams[0]) { if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0]; }
      else { if (!v.srcObject) v.srcObject = new MediaStream(); v.srcObject.addTrack(e.track); }
      v.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (p.tile) p.tile.style.opacity = pc.connectionState === 'connected' ? '1' : '.6';
    };
    ensureTile(id);
    return p;
  }
  async function makeOffer(id) {
    const p = peers.get(id);
    if (!p) return;
    try {
      const offer = await p.pc.createOffer();
      await p.pc.setLocalDescription(offer);
      socket.emit('signal', { to: id, data: { sdp: p.pc.localDescription } });
    } catch (e) { console.warn('offer 失敗', e); }
  }
  socket.on('peer-link', ({ peer, initiator }) => {
    getPeer(peer, initiator);
    if (initiator) makeOffer(peer);
  });
  socket.on('peer-unlink', ({ peer }) => closePeer(peer));
  socket.on('signal', async ({ from, data }) => {
    if (!data) return;
    let p = peers.get(from);
    try {
      if (data.sdp) {
        if (!p) { if (data.sdp.type !== 'offer') return; p = getPeer(from, false); }
        await p.pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          p.pc.getTransceivers().forEach((t) => { t.direction = 'sendrecv'; });
          attachTracks(p);
        }
        for (const c of p.pending) await p.pc.addIceCandidate(c).catch(() => {});
        p.pending = [];
        if (data.sdp.type === 'offer') {
          const ans = await p.pc.createAnswer();
          await p.pc.setLocalDescription(ans);
          socket.emit('signal', { to: from, data: { sdp: p.pc.localDescription } });
        }
      } else if (data.candidate && p) {
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.candidate).catch(() => {});
        else p.pending.push(data.candidate);
      }
    } catch (e) { console.warn('signal 錯誤', e); }
  });
  function closePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch (_) { /* ignore */ }
    if (p.tile) p.tile.remove();
    peers.delete(id);
  }
  function ensureTile(id) {
    const p = peers.get(id);
    if (!p || p.tile) return;
    const tile = document.createElement('div');
    tile.className = 'vtile';
    tile.style.opacity = '.6';
    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true;
    const off = document.createElement('div');
    off.className = 'camoff';
    const label = document.createElement('span');
    tile.append(v, off, label);
    $('videos').append(tile);
    p.tile = tile; p.video = v; p.label = label; p.off = off;
    refreshTile(id);
  }
  function refreshTile(id) {
    const p = peers.get(id), u = users.get(id);
    if (!p || !p.tile || !u) return;
    p.tile.classList.toggle('cam-off', !u.cam);
    p.off.textContent = u.name.slice(0, 1);
    p.label.textContent = (u.mic ? '' : '🔇 ') + u.name;
  }
  let selfVideo = null;
  function setupSelfTile() {
    const tile = document.createElement('div');
    tile.className = 'vtile self';
    tile.hidden = true;
    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true; v.muted = true;
    const label = document.createElement('span');
    label.textContent = '我';
    tile.append(v, label);
    $('videos').prepend(tile);
    selfVideo = v;
  }

  // ---------- 相機 / 麥克風（預設關閉） ----------
  function attachTracks(p) {
    for (const t of p.pc.getTransceivers()) {
      const kind = t.receiver && t.receiver.track && t.receiver.track.kind;
      const track = kind === 'video' ? camTrack : kind === 'audio' ? micTrack : null;
      if (t.sender && t.sender.track !== track) t.sender.replaceTrack(track).catch(() => {});
    }
  }
  function attachAll() { for (const p of peers.values()) attachTracks(p); }
  function updateMediaButtons() {
    $('camBtn').textContent = camTrack ? '📷 相機：開' : '📷 相機：關';
    $('micBtn').textContent = micTrack ? '🎤 麥克風：開' : '🎤 麥克風：關';
    $('camBtn').classList.toggle('off', !camTrack);
    $('micBtn').classList.toggle('off', !micTrack);
    if (selfVideo) {
      selfVideo.parentElement.hidden = !camTrack;
      selfVideo.srcObject = camTrack ? new MediaStream([camTrack]) : null;
      if (camTrack) selfVideo.play().catch(() => {});
    }
    if (joined) socket.emit('media-state', { cam: !!camTrack, mic: !!micTrack });
  }
  function localNotice(text) { addMsg({ system: true, text, ts: Date.now() }); }
  async function toggleMedia(kind) {
    const isCam = kind === 'video';
    const cur = isCam ? camTrack : micTrack;
    if (cur) {
      cur.onended = null; cur.stop();
      if (isCam) camTrack = null; else micTrack = null;
    } else {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { localNotice('⚠️ 這個瀏覽器不支援相機／麥克風（請確認網址是 https 開頭）'); return; }
      try {
        const constraints = isCam
          ? { video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } } }
          : { audio: { echoCancellation: true, noiseSuppression: true } };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const track = isCam ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
        track.onended = () => { // 被系統或其他分頁中斷時，自動變回關閉
          if (isCam && camTrack === track) camTrack = null;
          if (!isCam && micTrack === track) micTrack = null;
          attachAll(); updateMediaButtons();
          localNotice(isCam ? '⚠️ 相機被中斷了，可以再按一次「相機」重新開啟' : '⚠️ 麥克風被中斷了，可以再按一次「麥克風」重新開啟');
        };
        if (isCam) camTrack = track; else micTrack = track;
      } catch (e) {
        localNotice(isCam
          ? '⚠️ 無法開啟相機：請允許瀏覽器使用相機，並關掉其他正在用相機的分頁或 App'
          : '⚠️ 無法開啟麥克風：請允許瀏覽器使用麥克風');
        return;
      }
    }
    attachAll();
    updateMediaButtons();
  }
  $('camBtn').onclick = () => toggleMedia('video');
  $('micBtn').onclick = () => toggleMedia('audio');
  socket.on('user-media', ({ id, cam, mic }) => {
    const u = users.get(id);
    if (!u) return;
    u.cam = cam; u.mic = mic;
    refreshTile(id);
  });

  // ---------- 移動 ----------
  const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const held = [];
  let lastMoveAt = 0;
  function tryMove(dir) {
    const me = users.get(selfId);
    if (!me) return;
    const now = performance.now();
    if (now - lastMoveAt < 120) return;
    lastMoveAt = now;
    const [dx, dy] = DIRS[dir];
    const nx = me.x + dx, ny = me.y + dy;
    me.dir = dir;
    if (MAP.walkable(nx, ny)) { me.x = nx; me.y = ny; }
    socket.emit('move', { x: me.x, y: me.y, dir });
    updateZone();
  }
  const press = (d) => { if (!held.includes(d)) held.push(d); tryMove(d); };
  const release = (d) => { const i = held.indexOf(d); if (i >= 0) held.splice(i, 1); };
  setInterval(() => { if (joined && held.length) tryMove(held[held.length - 1]); }, 40);

  window.addEventListener('keydown', (e) => {
    if (!joined) return;
    const chatInput = $('chatInput');
    if (document.activeElement === chatInput) { if (e.key === 'Escape') chatInput.blur(); return; }
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if (e.key === 'Enter') { e.preventDefault(); chatInput.focus(); return; }
    const d = KEYMAP[e.code];
    if (d) { e.preventDefault(); press(d); }
  });
  window.addEventListener('keyup', (e) => { const d = KEYMAP[e.code]; if (d) release(d); });
  window.addEventListener('blur', () => { held.length = 0; });
  document.querySelectorAll('#dpad button').forEach((b) => {
    const d = b.dataset.dir;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); press(d); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => release(d)));
  });

  function updateZone() {
    const me = users.get(selfId);
    if (!me) return;
    const z = $('zone');
    const r = MAP.region(me.x, me.y);
    z.classList.toggle('quiet', r === 'quiet');
    z.textContent = r === 'quiet' ? '🤫 安靜區：不會接通任何人' : r === 'discuss' ? '💬 討論區' : r === 'lounge' ? '☕ 休息區' : '🚪 走廊';
  }

  // ---------- 畫面 ----------
  const canvas = $('game');
  canvas.width = MAP.W * T; canvas.height = MAP.H * T;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const mapCanvas = renderMap();
  let last = performance.now();

  function frame(ts) {
    const dt = Math.min(0.1, (ts - last) / 1000);
    last = ts;
    ctx.drawImage(mapCanvas, 0, 0);
    const me = users.get(selfId);

    for (const u of users.values()) {
      const k = Math.min(1, dt * 14);
      u.rx += (u.x - u.rx) * k; u.ry += (u.y - u.ry) * k;
      u.moving = Math.abs(u.x - u.rx) + Math.abs(u.y - u.ry) > 0.03;
      if (u.moving) u.anim = (u.anim || 0) + dt; else u.anim = 0;
    }

    if (me && !MAP.isQuiet(me.x, me.y)) {
      ctx.save();
      ctx.strokeStyle = 'rgba(74,144,217,.5)'; ctx.fillStyle = 'rgba(74,144,217,.08)';
      ctx.setLineDash([6, 6]); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc((me.rx + 0.5) * T, (me.ry + 0.5) * T, NEAR * T + T / 2, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke(); ctx.restore();
    }

    const list = [...users.values()].sort((a, b) => a.ry - b.ry);
    ctx.font = 'bold 11px system-ui, "PingFang TC", "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const u of list) {
      const px = u.rx * T, py = u.ry * T - 4;
      drawAvatar(ctx, px, py, 2, u);
      const connected = peers.has(u.id);
      const ringing = !connected && nearby.some((n) => n.id === u.id && n.theyWant && !n.iWant);
      const label = (MAP.isQuiet(u.x, u.y) ? '🤫 ' : '') + u.name;
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = u.id === selfId ? 'rgba(74,144,217,.9)' : connected ? 'rgba(46,158,91,.92)' : ringing ? 'rgba(232,140,40,.95)' : 'rgba(0,0,0,.55)';
      roundRect(ctx, px + T / 2 - w / 2, py - 14, w, 15, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(label, px + T / 2, py - 6);
    }

    // 距離越遠音量越小
    if (me) {
      for (const [id, p] of peers) {
        const u = users.get(id);
        if (!u || !p.video) continue;
        const d = Math.hypot(u.x - me.x, u.y - me.y);
        p.video.volume = Math.max(0.3, Math.min(1, 1 - (d - 1) / 4));
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------- 聊天 ----------
  function addMsg(m) {
    const box = $('messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const div = document.createElement('div');
    div.className = 'msg' + (m.system ? ' system' : '');
    const d = new Date(m.ts);
    const time = document.createElement('span');
    time.className = 'time'; time.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    div.append(time);
    if (!m.system) {
      const who = document.createElement('span');
      who.className = 'who'; who.style.color = shade(m.color || '#555555', -40); who.textContent = m.name;
      div.append(who);
    }
    div.append(document.createTextNode(m.text));
    box.append(div);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const t = $('chatInput').value.trim();
    if (t) socket.emit('chat', t);
    $('chatInput').value = '';
  };

  // ---------- 番茄鐘 ----------
  let audioCtx = null;
  function ensureAudio() {
    try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { /* ignore */ }
  }
  function beep(phase) {
    if (!audioCtx) return;
    const notes = phase === 'ring' ? [880, 660, 880, 660] : phase === 'focus' ? [523, 659, 784] : [784, 659, 523];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = 'sine';
      const t0 = audioCtx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
      o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.32);
    });
  }
  function setPomo(p, silent) {
    const prev = pomo.phase;
    pomo = p;
    if (typeof p.now === 'number') clockOffset = p.now - Date.now();
    if (!silent && prev !== p.phase && p.phase !== 'idle') beep(p.phase);
    if (p.phase !== 'idle') { $('pomoFocus').value = p.focus; $('pomoBreak').value = p.brk; }
    renderPomo();
  }
  function renderPomo() {
    const el = $('pomoTime');
    el.className = pomo.phase;
    if (pomo.phase === 'idle') {
      $('pomoPhase').textContent = '尚未開始：大家按下「開始」就會一起計時';
      el.textContent = '--:--';
      document.title = '像素自習室';
      return;
    }
    const left = Math.max(0, Math.round((pomo.endsAt - (Date.now() + clockOffset)) / 1000));
    const s = `${pad(Math.floor(left / 60))}:${pad(left % 60)}`;
    el.textContent = s;
    $('pomoPhase').textContent = pomo.phase === 'focus' ? `🔥 專注中（第 ${pomo.round} 輪）` : '☕ 休息中';
    document.title = `${pomo.phase === 'focus' ? '🔥' : '☕'} ${s}｜像素自習室`;
  }
  setInterval(renderPomo, 250);
  $('pomoStart').onclick = () => { ensureAudio(); socket.emit('pomo-start', { focus: $('pomoFocus').value, brk: $('pomoBreak').value }); };
  $('pomoSkip').onclick = () => socket.emit('pomo-skip');
  $('pomoStop').onclick = () => socket.emit('pomo-stop');

  // ---------- 排行 ----------
  function setBoard(list) {
    boardData = list || [];
    const ol = $('board');
    ol.innerHTML = '';
    if (!boardData.length) { const li = document.createElement('li'); li.textContent = '還沒有紀錄'; ol.append(li); return; }
    for (const r of boardData) {
      const li = document.createElement('li');
      if (r.name === profile.name) li.className = 'me';
      const t = document.createElement('span');
      t.className = 't'; t.textContent = fmtDur(r.sec);
      li.append(document.createTextNode(r.name), t);
      ol.append(li);
    }
  }
})();
