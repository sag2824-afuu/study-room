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
  let linkState = { peers: [], table: null }; // 伺服器算好的連線狀態
  const linkInfo = new Map(); // id -> {ctx, send, recv, mine, theirs}
  window.__room = { users, peers, linkInfo };

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
    socket.emit('join', { ...profile, today: loadToday() }, (res) => {
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
      applyLinks({ peers: [], table: null });
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
    applyLinks({ peers: [], table: null });
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
  socket.on('chat', (m) => {
    addMsg(m);
    if (!sideOpen && !m.system) { unread++; renderSideTab(); }
    const u = m.id && users.get(m.id);
    if (u) { u.say = { text: m.text, until: performance.now() + 6000 }; u.typingUntil = 0; } // 頭上顯示訊息 6 秒
  });
  socket.on('user-typing', ({ id, typing }) => {
    const u = users.get(id);
    if (u) u.typingUntil = typing ? performance.now() + 6000 : 0;
  });
  socket.on('pomo', (p) => setPomo(p, false));
  socket.on('board', setBoard);
  // ---------- 連線狀態（自習區／討論桌／休息區） ----------
  const kindsOf = (n) => n.kinds || [];
  let prevReqIds = new Set();
  const isInvite = (n) => kindsOf(n).some((k) => n.theirs[k] === true && n.mine[k] === null);
  function applyLinks(st) {
    const prevInvites = new Set([...linkInfo.values()].filter(isInvite).map((n) => n.id));
    if (st.group && st.group.requests.some((r) => !prevReqIds.has(r.id))) beep('ring'); // 有人申請加入小群組
    prevReqIds = new Set(st.group ? st.group.requests.map((r) => r.id) : []);
    linkState = st;
    linkInfo.clear();
    for (const n of st.peers) linkInfo.set(n.id, n);
    for (const n of st.peers) {
      if (!peers.has(n.id)) { const init = selfId < n.id; getPeer(n.id, init); if (init) makeOffer(n.id); }
    }
    for (const id of [...peers.keys()]) if (!linkInfo.has(id)) closePeer(id);
    if (st.peers.some((n) => isInvite(n) && !prevInvites.has(n.id))) beep('ring');
    for (const id of peers.keys()) refreshTile(id);
    renderBubbles();
    renderTable();
    updateZone();
    syncMedia();
  }
  socket.on('links', applyLinks);

  function mkBtn(label, fn, cls) {
    const b = document.createElement('button');
    b.textContent = label; b.className = cls || ''; b.onclick = fn;
    return b;
  }
  const pair = (id, kind, value) => socket.emit('pair', { peer: id, kind, value });

  // 頭上的 ○✕ 泡泡（自習區：鏡頭、麥克風分開問／休息區：只問鏡頭）
  const bubbles = new Map();
  function renderBubbles() {
    const want = new Set();
    for (const n of linkState.peers) {
      const segs = [];
      if (n.join) { // 對方在小群組裡：可以申請加入
        const seg = document.createElement('span');
        seg.className = 'seg' + (n.join === 'pending' ? '' : ' invite');
        const t = document.createElement('span');
        if (n.join === 'pending') { t.textContent = '👥 等待同意…'; seg.append(t, mkBtn('取消', () => socket.emit('group-cancel', { peer: n.id }), 'x')); }
        else { t.textContent = '👥 小群組'; seg.append(t, mkBtn('申請加入', () => socket.emit('group-join', { peer: n.id }), 'o')); }
        segs.push(seg);
      }
      for (const k of kindsOf(n)) {
        if (n.mine[k] === false) continue; // 按過 ✕ 就不再顯示，走開再回來會重新詢問
        const icon = k === 'v' ? '📷' : k === 'a' ? '🎤' : '🖥️';
        const seg = document.createElement('span');
        seg.className = 'seg';
        const t = document.createElement('span');
        const yes = mkBtn('○', () => pair(n.id, k, true), 'o');
        const no = mkBtn('✕', () => pair(n.id, k, false), 'x');
        if (n.mine[k] === true && n.theirs[k] === true) {
          seg.classList.add('on'); t.textContent = `${icon} 開`;
          seg.append(t, mkBtn('關', () => pair(n.id, k, false), 'x'));
        } else if (n.mine[k] === true) {
          t.textContent = `${icon} 等待…`; seg.append(t, no);
        } else if (n.theirs[k] === true) {
          seg.classList.add('invite'); t.textContent = `${icon} 邀請你`; seg.append(t, yes, no);
        } else {
          t.textContent = `${icon}？`; seg.append(t, yes, no);
        }
        segs.push(seg);
      }
      if (!segs.length) continue;
      want.add(n.id);
      let el = bubbles.get(n.id);
      if (!el) { el = document.createElement('div'); $('bubbles').append(el); bubbles.set(n.id, el); }
      el.innerHTML = '';
      el.className = 'bubble' + (isInvite(n) ? ' invite' : '') + (n.join === 'can' ? ' joinable' : '');
      el.append(...segs);
    }
    for (const [id, el] of bubbles) if (!want.has(id)) { el.remove(); bubbles.delete(id); }
    placeBubbles();
  }
  function placeBubbles() {
    if (!bubbles.size) return;
    const cr = canvas.getBoundingClientRect(), sr = $('stage').getBoundingClientRect();
    const sc = Math.min(cr.width / canvas.width, cr.height / canvas.height);
    const ox = cr.left - sr.left + (cr.width - canvas.width * sc) / 2;
    const oy = cr.top - sr.top + (cr.height - canvas.height * sc) / 2;
    for (const [id, el] of bubbles) {
      const u = users.get(id);
      if (!u) continue;
      const half = el.offsetWidth / 2 + 4; // 泡泡不要超出畫面左右邊緣
      el.style.left = Math.min(sr.width - half, Math.max(half, ox + (u.rx * T + T / 2) * sc)) + 'px';
      el.style.top = (oy + (u.ry * T + T + 2) * sc) + 'px'; // 放在腳下，頭上留給對話框
    }
  }

  // 討論桌卡片：鏡頭／麥克風分開問
  function renderGroup(box) {
    const g = linkState.group;
    const card = document.createElement('div');
    card.className = 'tablecard groupcard';
    const h = document.createElement('div');
    h.className = 'th';
    h.textContent = `👥 小群組・${g.members.join('、')}`;
    card.append(h);
    const rows = g.zone === 'lounge' ? [['v', '📷', '鏡頭'], ['s', '🖥️', '螢幕分享']] : [['v', '📷', '鏡頭'], ['a', '🎤', '麥克風'], ['s', '🖥️', '螢幕分享']];
    for (const [k, icon, name] of rows) {
      const row = document.createElement('div');
      row.className = 'trow';
      const label = document.createElement('span');
      const on = g.media[k];
      label.textContent = `${icon} ${name}：${on ? '開' : '關'}`;
      row.append(label, mkBtn(on ? '關閉' : '開啟', () => socket.emit('group-media', { [k]: !on }), on ? 'x' : 'o'));
      card.append(row);
    }
    if (g.zone === 'lounge') { const p = document.createElement('div'); p.className = 'hint'; p.textContent = '🎤 休息區的語音是公開的，靠近就聽得到'; card.append(p); }
    for (const r of g.requests) {
      const row = document.createElement('div');
      row.className = 'trow req';
      const label = document.createElement('span');
      label.textContent = `🙋 ${r.name} 想加入`;
      row.append(label, mkBtn('○', () => socket.emit('group-answer', { id: r.id, ok: true }), 'o'), mkBtn('✕', () => socket.emit('group-answer', { id: r.id, ok: false }), 'x'));
      card.append(row);
    }
    card.append(mkBtn('🚪 離開小群組', () => socket.emit('group-leave'), 'leave'));
    box.append(card);
  }
  function renderTable() {
    const box = $('prompt');
    box.innerHTML = '';
    if (linkState.group) { renderGroup(box); return; }
    const t = linkState.table;
    if (!t) return;
    const card = document.createElement('div');
    card.className = 'tablecard';
    const h = document.createElement('div');
    h.className = 'th';
    h.textContent = `🪑 討論桌 ${t.id}・` + (t.members.length ? t.members.join('、') : '目前只有你');
    card.append(h);
    for (const [k, icon, name] of [['cam', '📷', '鏡頭'], ['mic', '🎤', '麥克風'], ['scr', '🖥️', '螢幕分享']]) {
      const row = document.createElement('div');
      row.className = 'trow';
      const label = document.createElement('span');
      if (!t[k + 'Ans']) {
        label.textContent = `${icon} 要開${name}嗎？`;
        row.append(label, mkBtn('○', () => socket.emit('table-media', { [k]: true }), 'o'), mkBtn('✕', () => socket.emit('table-media', { [k]: false }), 'x'));
      } else {
        label.textContent = `${icon} ${name}：${t[k] ? '開' : '關'}`;
        row.append(label, mkBtn(t[k] ? '關閉' : '開啟', () => socket.emit('table-media', { [k]: !t[k] }), t[k] ? 'x' : 'o'));
      }
      card.append(row);
    }
    box.append(card);
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
      pc.addTransceiver('video', { direction: 'sendrecv' }); // 鏡頭
      pc.addTransceiver('video', { direction: 'sendrecv' }); // 螢幕分享
      attachTracks(id);
    }
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => {
      ensureTile(id);
      // 聲音和畫面分開播放：聲音用獨立的 <audio>，畫面用靜音的 <video>（Safari／手機比較不會擋）
      const idx = p.pc.getTransceivers().indexOf(e.transceiver);
      const el = e.track.kind === 'audio' ? p.audio : idx === 2 ? p.svideo : p.video;
      el.srcObject = new MediaStream([e.track]);
      e.track.onunmute = () => el.play().catch(showUnlock); // 對方開始送聲音／畫面時再播一次
      el.play().catch(showUnlock);
    };
    const onState = () => {
      const st = pc.connectionState || pc.iceConnectionState;
      p.state = st;
      if (p.tile) p.tile.style.opacity = st === 'connected' || st === 'completed' ? '1' : '.6';
      refreshTile(id);
      if (st === 'failed' && !p.warned) {
        p.warned = true;
        const u = users.get(id);
        localNotice(`⚠️ 跟 ${u ? u.name : '對方'} 的連線失敗了：可能是網路之間打不通，需要設定 TURN 中繼伺服器（請看 README）`);
      }
    };
    pc.onconnectionstatechange = onState;
    pc.oniceconnectionstatechange = onState;
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
  socket.on('signal', async ({ from, data }) => {
    if (!data) return;
    let p = peers.get(from);
    try {
      if (data.sdp) {
        if (!p) { if (data.sdp.type !== 'offer') return; p = getPeer(from, false); }
        await p.pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          p.pc.getTransceivers().forEach((t) => { t.direction = 'sendrecv'; });
          attachTracks(from);
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
    if (p.stile) p.stile.remove();
    if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
    peers.delete(id);
  }
  function ensureTile(id) {
    const p = peers.get(id);
    if (!p || p.tile) return;
    const tile = document.createElement('div');
    tile.className = 'vtile';
    tile.style.opacity = '.6';
    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true; v.muted = true;
    const a = document.createElement('audio');
    a.autoplay = true; a.setAttribute('playsinline', '');
    applySink(a);
    $('audios').append(a);
    p.audio = a;
    const off = document.createElement('div');
    off.className = 'camoff';
    const label = document.createElement('span');
    tile.append(v, off, label);
    $('videos').append(tile);
    p.tile = tile; p.video = v; p.label = label; p.off = off;
    // 螢幕分享的格子
    const stile = document.createElement('div');
    stile.className = 'vtile screen';
    stile.hidden = true;
    const sv = document.createElement('video');
    sv.autoplay = true; sv.playsInline = true; sv.muted = true;
    const slabel = document.createElement('span');
    stile.append(sv, slabel);
    $('videos').prepend(stile);
    p.stile = stile; p.svideo = sv; p.slabel = slabel;
    refreshTile(id);
  }
  function refreshTile(id) {
    const p = peers.get(id), u = users.get(id);
    if (!p || !p.tile || !u) return;
    const n = linkInfo.get(id);
    const flowing = n && (n.recv.v || n.recv.a || n.send.v || n.send.a || n.recv.s || n.send.s);
    p.tile.hidden = !flowing;
    const scrOn = !!(n && n.recv.s && u.scr);
    p.stile.hidden = !scrOn;
    p.slabel.textContent = `🖥️ ${u.name} 的螢幕`;
    if (scrOn) p.svideo.play().catch(() => {});
    p.tile.classList.toggle('cam-off', !(n && n.recv.v && u.cam));
    p.off.textContent = u.name.slice(0, 1);
    const conn = p.state === 'failed' ? '❌ 連線失敗 ' : p.state && !['connected', 'completed'].includes(p.state) ? '⏳ ' : '';
    p.label.textContent = conn + (n && n.recv.a && u.mic ? '' : '🔇 ') + u.name;
    updateLayout();
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
    const st = document.createElement('div');
    st.className = 'vtile screen self-screen';
    st.hidden = true;
    const sv = document.createElement('video');
    sv.autoplay = true; sv.playsInline = true; sv.muted = true;
    const sl = document.createElement('span');
    sl.textContent = '🖥️ 你正在分享螢幕';
    st.append(sv, sl);
    $('videos').prepend(st);
    selfScreen = sv;
  }
  let selfScreen = null;

  // ---------- 裝置設定與測試 ----------
  const devPref = { mic: store.get('dev-mic') || '', spk: store.get('dev-spk') || '', cam: store.get('dev-cam') || '' };
  const canSink = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  async function getMedia(kind, deviceId) {
    const base = kind === 'video'
      ? { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } }
      : { echoCancellation: true, noiseSuppression: true };
    const mk = (id) => ({ [kind]: id ? { ...base, deviceId: { exact: id } } : base });
    try { return await navigator.mediaDevices.getUserMedia(mk(deviceId)); }
    catch (e) { if (deviceId) return navigator.mediaDevices.getUserMedia(mk('')); throw e; } // 裝置被拔掉時改用預設
  }
  function applySink(el) {
    if (canSink && el && el.setSinkId) el.setSinkId(devPref.spk || '').catch(() => {});
  }
  // Safari／手機常會擋自動播放聲音：被擋時顯示按鈕讓使用者點一下
  function showUnlock(e) {
    if (e && e.name && e.name !== 'NotAllowedError') return; // 只有瀏覽器真的擋住聲音時才顯示（換來源造成的中斷不算）
    $('unlock').hidden = false;
  }
  $('unlock').onclick = () => {
    $('unlock').hidden = true;
    for (const p of peers.values()) { if (p.audio) p.audio.play().catch(() => {}); if (p.video) p.video.play().catch(() => {}); }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  };

  let testMic = null, testCam = null, meterRaf = 0, meterCtx = null;
  async function fillDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, pref, word) => {
      const devs = list.filter((d) => d.kind === kind);
      sel.innerHTML = '';
      const def = document.createElement('option');
      def.value = ''; def.textContent = '系統預設';
      sel.append(def);
      devs.forEach((d, i) => {
        if (!d.deviceId || d.deviceId === 'default') return;
        const o = document.createElement('option');
        o.value = d.deviceId; o.textContent = d.label || `${word} ${i + 1}（按測試後會顯示名稱）`;
        sel.append(o);
      });
      sel.value = [...sel.options].some((o) => o.value === pref) ? pref : '';
    };
    fill($('selMic'), 'audioinput', devPref.mic, '麥克風');
    fill($('selCam'), 'videoinput', devPref.cam, '鏡頭');
    fill($('selSpk'), 'audiooutput', devPref.spk, '喇叭');
    $('spkRow').hidden = !canSink;
    $('spkNote').hidden = canSink;
  }
  function stopTests() {
    cancelAnimationFrame(meterRaf);
    if (testMic) { testMic.getTracks().forEach((t) => t.stop()); testMic = null; }
    if (testCam) { testCam.getTracks().forEach((t) => t.stop()); testCam = null; }
    if (meterCtx) { meterCtx.close().catch(() => {}); meterCtx = null; }
    $('micLevel').style.width = '0%';
    $('micTestBtn').textContent = '🎤 開始測試麥克風';
    $('camPreview').srcObject = null; $('camPreview').hidden = true;
    $('camTestBtn').textContent = '📷 預覽鏡頭';
  }
  async function startMicTest() {
    stopTests();
    try { testMic = await getMedia('audio', $('selMic').value); }
    catch (_) { $('micHint').textContent = '⚠️ 無法使用麥克風：請允許瀏覽器使用麥克風'; return; }
    await fillDevices(); // 取得權限後才看得到裝置名稱
    meterCtx = new (window.AudioContext || window.webkitAudioContext)();
    const an = meterCtx.createAnalyser();
    an.fftSize = 512;
    meterCtx.createMediaStreamSource(testMic).connect(an);
    const buf = new Uint8Array(an.fftSize);
    let peak = 0;
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const x of buf) { const v = (x - 128) / 128; sum += v * v; }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      $('micLevel').style.width = (level * 100).toFixed(0) + '%';
      peak = Math.max(peak * 0.995, level);
      $('micHint').textContent = peak > 0.08 ? '✅ 有收到聲音' : '對著麥克風說話，綠色長條會跳動';
      meterRaf = requestAnimationFrame(tick);
    };
    tick();
    $('micTestBtn').textContent = '⏹ 停止測試';
  }
  async function playTestTone() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = ctx.createMediaStreamDestination();
      const el = new Audio();
      el.srcObject = dest.stream;
      if (canSink && $('selSpk').value) await el.setSinkId($('selSpk').value).catch(() => {});
      await el.play();
      [523, 659, 784, 1047].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f;
        const t0 = ctx.currentTime + i * 0.22;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
        o.connect(g).connect(dest); o.start(t0); o.stop(t0 + 0.4);
      });
      $('spkHint').textContent = '有聽到「叮叮叮叮」就代表喇叭正常';
      setTimeout(() => { el.pause(); ctx.close().catch(() => {}); }, 1400);
    } catch (_) { $('spkHint').textContent = '⚠️ 無法播放，請檢查音量或改選其他裝置'; }
  }
  async function startCamTest() {
    stopTests();
    try { testCam = await getMedia('video', $('selCam').value); }
    catch (_) { $('camHint').textContent = '⚠️ 無法開啟鏡頭：請允許瀏覽器使用鏡頭，並關掉其他正在用鏡頭的分頁或 App'; return; }
    await fillDevices();
    $('camPreview').srcObject = testCam; $('camPreview').hidden = false; $('camPreview').play().catch(() => {});
    $('camTestBtn').textContent = '⏹ 關閉預覽';
    $('camHint').textContent = '';
  }
  // 換裝置時，若正在使用就立刻切換過去
  async function switchDevice(kind) {
    const isCam = kind === 'video';
    if (isCam ? !camTrack : !micTrack) return;
    try {
      const s = await getMedia(kind, isCam ? devPref.cam : devPref.mic);
      const t = isCam ? s.getVideoTracks()[0] : s.getAudioTracks()[0];
      const old = isCam ? camTrack : micTrack;
      t.onended = old.onended;
      if (isCam) camTrack = t; else micTrack = t;
      stopTrack(old);
      attachAll(); updateMediaButtons();
    } catch (_) { /* 失敗就維持原本的裝置 */ }
  }
  // ---------- 連線診斷 ----------
  const lastBytes = new Map();
  async function runDiag() {
    const box = $('diag');
    const rows = [];
    const yn = (ok, yes, no) => (ok ? `✅ ${yes}` : `❌ ${no}`);
    rows.push(`<div class="drow"><b>我的麥克風</b>：${!micAllowed ? '❌ 已停用（按右上角麥克風按鈕打開）' : micTrack ? (micTrack.muted ? '⚠️ 被系統靜音了' : '✅ 使用中') : '待命（目前沒有需要開麥克風的人）'}</div>`);
    if (!peers.size) rows.push('<div class="drow hint">目前沒有和任何人連線。走到別人旁邊後再打開這裡看看。</div>');
    for (const [id, p] of peers) {
      const u = users.get(id), n = linkInfo.get(id);
      let outB = 0, inB = 0, level = 0;
      try {
        const st = await p.pc.getStats();
        st.forEach((r) => {
          if (r.kind !== 'audio' && r.mediaType !== 'audio') return;
          if (r.type === 'outbound-rtp') outB += r.bytesSent || 0;
          if (r.type === 'inbound-rtp') inB += r.bytesReceived || 0;
          if (r.type === 'inbound-rtp' && typeof r.audioLevel === 'number') level = Math.max(level, r.audioLevel);
        });
      } catch (_) { /* ignore */ }
      const prev = lastBytes.get(id) || { outB, inB };
      lastBytes.set(id, { outB, inB });
      const sending = outB > prev.outB, receiving = inB > prev.inB;
      let route = '';
      try {
        const st2 = await p.pc.getStats();
        let pairId = null;
        st2.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
        st2.forEach((r) => { if (!pairId && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pairId = r.id; });
        const pairR = pairId && st2.get(pairId);
        const loc = pairR && st2.get(pairR.localCandidateId);
        if (loc) route = loc.candidateType === 'relay' ? '（經由中繼伺服器）' : loc.candidateType === 'host' ? '（同一個網路直連）' : '（跨網路直連）';
      } catch (_) { /* ignore */ }
      const sender = p.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      const state = p.pc.connectionState || p.pc.iceConnectionState;
      rows.push(`<div class="dpeer"><div><b>${u ? u.name.replace(/[<>&]/g, '') : '…'}</b>　連線：${state === 'connected' ? '✅ 已連上' + route : state === 'failed' ? '❌ 連線失敗（' + (config.turn ? '中繼伺服器也連不上' : '尚未設定 TURN 中繼伺服器') + '）' : '⏳ ' + state}</div>
        <div>我送出聲音：${!(n && n.send.a) ? '－ 這裡的規則目前不用送聲音' : yn(sender && sending, '有在送', '沒有送出（確認麥克風是「使用中」）')}</div>
        <div>收到對方聲音：${!(n && n.recv.a) ? '－ 對方目前沒有開聲音' : yn(receiving, '有收到' + (level > 0.01 ? '（有音量）' : '（目前很安靜）'), '沒收到（請對方確認他的麥克風）')}</div>
        <div>播放聲音：${!(n && n.recv.a) ? '－' : p.audio && !p.audio.paused ? '✅ 播放中' : '❌ 被瀏覽器擋住 → 點畫面上的「點這裡開啟聲音」'}</div></div>`);
      if (p.audio && p.audio.paused && n && n.recv.a) showUnlock();
    }
    box.innerHTML = rows.join('');
  }
  let diagTimer = 0;
  $('settingsBtn').onclick = async () => {
    $('settings').hidden = false; await fillDevices();
    runDiag(); diagTimer = setInterval(runDiag, 1500);
  };
  $('settingsClose').onclick = () => { stopTests(); clearInterval(diagTimer); $('settings').hidden = true; };
  // 每 3 秒檢查一次：有聲音進來卻沒在播放，就重新播放
  setInterval(() => {
    for (const [id, p] of peers) {
      const n = linkInfo.get(id);
      if (p.audio && p.audio.paused && n && n.recv.a) p.audio.play().catch(showUnlock);
      if (p.video && p.video.paused && n && n.recv.v) p.video.play().catch(() => {});
    }
  }, 3000);
  $('micTestBtn').onclick = () => (testMic ? stopTests() : startMicTest());
  $('camTestBtn').onclick = () => (testCam ? stopTests() : startCamTest());
  $('spkTestBtn').onclick = playTestTone;
  $('selMic').onchange = () => {
    devPref.mic = $('selMic').value; store.set('dev-mic', devPref.mic);
    if (testMic) startMicTest();
    switchDevice('audio');
  };
  $('selCam').onchange = () => {
    devPref.cam = $('selCam').value; store.set('dev-cam', devPref.cam);
    if (testCam) startCamTest();
    switchDevice('video');
  };
  $('selSpk').onchange = () => {
    devPref.spk = $('selSpk').value; store.set('dev-spk', devPref.spk);
    for (const p of peers.values()) applySink(p.audio);
  };

  // ---------- 相機 / 麥克風 ----------
  // 需要時才開（例如雙方都按了 ○、或在討論桌選了開）；右上角按鈕是總開關
  let camAllowed = true, micAllowed = true;
  function attachTracks(id) {
    const p = peers.get(id);
    if (!p) return;
    const n = linkInfo.get(id);
    const send = n ? n.send : { v: false, a: false, s: false };
    p.pc.getTransceivers().forEach((t, i) => {
      // 0=麥克風 1=鏡頭 2=螢幕分享
      const track = i === 0 ? (send.a ? micTrack : null) : i === 1 ? (send.v ? camTrack : null) : i === 2 ? (send.s ? screenTrack : null) : null;
      if (t.sender && t.sender.track !== track) t.sender.replaceTrack(track).catch(() => {});
    });
  }
  function attachAll() { for (const id of peers.keys()) attachTracks(id); }
  function localNotice(text) { addMsg({ system: true, text, ts: Date.now() }); }
  async function acquire(kind) {
    const isCam = kind === 'video';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      localNotice('⚠️ 這個瀏覽器不支援相機／麥克風（請確認網址是 https 開頭）');
      if (isCam) camAllowed = false; else micAllowed = false;
      return null;
    }
    try {
      const stream = await getMedia(kind, isCam ? devPref.cam : devPref.mic);
      const track = isCam ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
      track.onended = () => { // 被系統或其他分頁中斷
        if (isCam && camTrack === track) { camTrack = null; camAllowed = false; }
        if (!isCam && micTrack === track) { micTrack = null; micAllowed = false; }
        attachAll(); updateMediaButtons();
        localNotice(isCam ? '⚠️ 相機被中斷了，按右上角「鏡頭」按鈕可以重新開啟' : '⚠️ 麥克風被中斷了，按右上角「麥克風」按鈕可以重新開啟');
      };
      return track;
    } catch (_) {
      if (isCam) camAllowed = false; else micAllowed = false;
      localNotice(isCam
        ? '⚠️ 無法開啟相機：請允許瀏覽器使用相機，並關掉其他正在用相機的分頁或 App，再按右上角「鏡頭」按鈕'
        : '⚠️ 無法開啟麥克風：請允許瀏覽器使用麥克風，再按右上角「麥克風」按鈕');
      return null;
    }
  }
  function stopTrack(t) { t.onended = null; t.stop(); }
  let syncing = false, resync = false;
  async function syncMedia() {
    if (syncing) { resync = true; return; }
    syncing = true;
    try {
      const needV = camAllowed && linkState.peers.some((n) => n.send.v);
      const needA = micAllowed && linkState.peers.some((n) => n.send.a);
      if (needV && !camTrack) camTrack = await acquire('video');
      if (!needV && camTrack) { stopTrack(camTrack); camTrack = null; }
      if (needA && !micTrack) micTrack = await acquire('audio');
      if (!needA && micTrack) { stopTrack(micTrack); micTrack = null; }
    } finally { syncing = false; }
    attachAll();
    updateMediaButtons();
    if (resync) { resync = false; syncMedia(); }
  }
  function updateMediaButtons() {
    const st2 = (allowed, track) => (!allowed ? '已停用' : track ? '使用中' : '待命');
    $('camBtn').innerHTML = `📷 <span class="lbl">鏡頭：</span>${st2(camAllowed, camTrack)}`;
    $('micBtn').innerHTML = `🎤 <span class="lbl">麥克風：</span>${st2(micAllowed, micTrack)}`;
    $('camBtn').className = !camAllowed ? 'off' : camTrack ? 'live' : '';
    $('micBtn').className = !micAllowed ? 'off' : micTrack ? 'live' : '';
    if (selfVideo) {
      selfVideo.parentElement.hidden = !camTrack;
      if (camTrack && (!selfVideo.srcObject || selfVideo.srcObject.getVideoTracks()[0] !== camTrack)) {
        selfVideo.srcObject = new MediaStream([camTrack]); selfVideo.play().catch(() => {});
      }
      if (!camTrack) selfVideo.srcObject = null;
    }
    $('shareBtn').innerHTML = screenTrack ? '⏹ <span class="lbl">停止分享</span>' : '🖥️ <span class="lbl">分享螢幕</span>';
    $('shareBtn').className = screenTrack ? 'live' : '';
    $('switchBtn').hidden = !screenTrack;
    if (selfScreen) {
      selfScreen.parentElement.hidden = !screenTrack;
      if (screenTrack && (!selfScreen.srcObject || selfScreen.srcObject.getVideoTracks()[0] !== screenTrack)) {
        selfScreen.srcObject = new MediaStream([screenTrack]); selfScreen.play().catch(() => {});
      }
      if (!screenTrack) selfScreen.srcObject = null;
    }
    syncToolbar();
    updateLayout();
    if (joined) socket.emit('media-state', { cam: !!camTrack, mic: !!micTrack, scr: !!screenTrack });
  }

  // ---------- 可收合的側邊欄 ----------
  let sideOpen = true, lastMeeting = false, unread = 0;
  function setSidebar(open) {
    sideOpen = open;
    document.querySelector('main').classList.toggle('side-closed', !open);
    if (open) unread = 0;
    renderSideTab();
  }
  function renderSideTab() {
    const b = $('sideToggle');
    if (!b) return;
    if (sideOpen) { b.innerHTML = '<span class="arrow">▶</span>'; b.title = '收起側邊欄'; b.classList.remove('has-unread'); return; }
    let html = '<span class="arrow">◀</span>';
    if (pomo.phase !== 'idle') {
      const left = Math.max(0, Math.round((pomo.endsAt - (Date.now() + clockOffset)) / 1000));
      html += `<span class="mini">${pomo.phase === 'focus' ? '🔥' : '☕'}<br>${pad(Math.floor(left / 60))}:${pad(left % 60)}</span>`;
    } else html += '<span class="mini">🍅</span>';
    html += `<span class="mini">💬${unread ? `<b>${unread > 99 ? '99+' : unread}</b>` : ''}</span>`;
    b.innerHTML = html;
    b.title = '打開側邊欄（番茄鐘、自習時間、聊天室）';
    b.classList.toggle('has-unread', unread > 0);
  }
  $('sideToggle').onclick = () => setSidebar(!sideOpen);

  // ---------- 會議版面（類似騰訊會議） ----------
  let layoutOverride = null; // 'map' = 使用者手動切回大地圖
  let wasMeeting = false;
  function updateLayout() {
    const stage = $('stage');
    if (!stage) return;
    let anyVideo = !!camTrack || !!screenTrack;
    for (const [id, p] of peers) {
      if (p.stile && !p.stile.hidden) anyVideo = true;
      if (p.tile && !p.tile.hidden && !p.tile.classList.contains('cam-off')) anyVideo = true;
    }
    if (anyVideo && !wasMeeting) layoutOverride = null; // 有新的視訊出現時自動切到會議畫面
    wasMeeting = anyVideo;
    const meeting = anyVideo && layoutOverride !== 'map';
    stage.classList.toggle('meeting', meeting);
    if (meeting !== lastMeeting) { lastMeeting = meeting; setSidebar(!meeting); } // 會議畫面預設收起，其他時候預設打開
    $('backMeeting').hidden = !(anyVideo && !meeting);
    // 主畫面：使用者點選固定的格子 > 第一個螢幕分享 > 沒有（平均排列）
    const box = $('videos');
    const vis = [...box.children].filter((t) => !t.hidden);
    if (pinned && (!pinned.isConnected || pinned.hidden)) pinned = null;
    const main = meeting ? (pinned || vis.find((t) => t.classList.contains('screen')) || null) : null;
    for (const t of box.children) { t.classList.toggle('main', t === main); t.classList.toggle('pinned', t === pinned && meeting); }
    box.classList.toggle('has-main', !!main);
    if (meeting) {
      const others = vis.filter((t) => t !== main);
      box.style.setProperty('--cols', String(Math.max(1, Math.ceil(Math.sqrt(others.length)))));
      box.style.setProperty('--rows', String(Math.max(1, others.length)));
    }
  }
  // 會議畫面：點一下某個格子就放大成主畫面，再點一次取消
  let pinned = null;
  $('videos').addEventListener('click', (e) => {
    if (!$('stage').classList.contains('meeting')) return;
    const t = e.target.closest('.vtile');
    if (!t) return;
    pinned = pinned === t ? null : t;
    updateLayout();
  });
  function syncToolbar() {
    const set = (id, src) => { const a = $(id), b = $(src); a.innerHTML = b.innerHTML; a.className = b.className; a.hidden = b.hidden; };
    set('tMic', 'micBtn'); set('tCam', 'camBtn'); set('tShare', 'shareBtn'); set('tSwitch', 'switchBtn');
  }
  $('tMic').onclick = () => $('micBtn').click();
  $('tCam').onclick = () => $('camBtn').click();
  $('tShare').onclick = toggleShare;
  $('tSettings').onclick = () => $('settingsBtn').click();
  $('tMap').onclick = () => { layoutOverride = 'map'; updateLayout(); };
  $('backMeeting').onclick = () => { layoutOverride = null; updateLayout(); };
  // ---------- 螢幕分享 ----------
  let screenTrack = null;
  const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  // 讓瀏覽器跳出選擇視窗：整個螢幕／某個視窗／某個分頁
  async function pickScreen() {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 10, max: 15 }, displaySurface: 'monitor' },
      audio: false,
      selfBrowserSurface: 'exclude',   // 不要把自習室這個分頁列進去（避免畫面無限套娃）
      surfaceSwitching: 'include',     // Chrome：分享中可以直接切換分頁
      monitorTypeSurfaces: 'include',  // 一定要提供「整個螢幕」選項
    });
    const t = s.getVideoTracks()[0];
    if ('contentHint' in t) t.contentHint = 'detail';
    t.onended = () => { if (screenTrack === t) { screenTrack = null; attachAll(); updateMediaButtons(); } }; // 從瀏覽器的「停止分享」按掉
    return t;
  }
  async function startShare(switching) {
    $('sharePick').hidden = true;
    try {
      const t = await pickScreen();
      const old = screenTrack;
      screenTrack = t;
      if (old) stopTrack(old);
      attachAll(); updateMediaButtons();
      if (!switching && !linkState.peers.some((n) => n.send.s)) localNotice('🖥️ 已開始分享螢幕。目前還沒有人同意接收，對方按 🖥️ 的 ○（討論桌要雙方都開放螢幕分享）後就會看到。');
    } catch (_) { /* 使用者取消選擇 */ }
  }
  function toggleShare() {
    if (screenTrack) { stopTrack(screenTrack); screenTrack = null; attachAll(); updateMediaButtons(); return; }
    if (!canShare) { localNotice('⚠️ 這個裝置的瀏覽器不支援分享螢幕（手機和平板通常不行，請用電腦）'); return; }
    $('sharePick').hidden = false; // 先說明，再讓使用者按下按鈕跳出瀏覽器的選擇視窗
  }
  $('shareBtn').onclick = toggleShare;
  $('shareBtn').hidden = !canShare;
  $('sharePickGo').onclick = () => startShare(false);
  $('sharePickCancel').onclick = () => { $('sharePick').hidden = true; };
  $('switchBtn').onclick = () => startShare(true);
  $('tSwitch').onclick = () => startShare(true);

  $('camBtn').onclick = () => { camAllowed = !camAllowed; syncMedia(); };
  $('micBtn').onclick = () => { micAllowed = !micAllowed; syncMedia(); };
  socket.on('user-media', ({ id, cam, mic, scr }) => {
    const u = users.get(id);
    if (!u) return;
    u.cam = cam; u.mic = mic; u.scr = !!scr;
    refreshTile(id);
  });

  // ---------- 移動 ----------
  const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const held = [];
  let lastMoveAt = 0;
  let frozenNoticeAt = 0;
  function tryMove(dir) {
    const me = users.get(selfId);
    if (!me) return;
    if ($('stage').classList.contains('meeting')) { // 會議畫面時不能移動
      if (performance.now() - frozenNoticeAt > 4000) { frozenNoticeAt = performance.now(); flashHint('會議中不能移動，按「🗺️ 大地圖」回到地圖再走'); }
      return;
    }
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
    if (e.key === 'Enter') { e.preventDefault(); if (!sideOpen) setSidebar(true); chatInput.focus(); return; }
    const d = KEYMAP[e.code];
    if (d) { e.preventDefault(); press(d); }
  });
  window.addEventListener('keyup', (e) => { const d = KEYMAP[e.code]; if (d) release(d); });
  window.addEventListener('blur', () => { held.length = 0; });
  // 手機方向鍵：長按時 iOS 可能吃掉「放開」的事件，所以多重保險，避免一直走停不下來
  const padHeld = new Set();
  const releasePad = () => { for (const d of padHeld) release(d); padHeld.clear(); };
  document.querySelectorAll('#dpad button').forEach((b) => {
    const d = b.dataset.dir;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      padHeld.add(d); press(d);
    });
    const up = () => { padHeld.delete(d); release(d); };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => b.addEventListener(ev, up));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  $('dpad').addEventListener('touchstart', (e) => e.preventDefault(), { passive: false }); // 不讓長按觸發選取／放大鏡
  ['pointercancel', 'touchend', 'touchcancel'].forEach((ev) => window.addEventListener(ev, (e) => {
    if (!e.touches || e.touches.length === 0) releasePad(); // 所有手指都離開螢幕 → 一定停下
  }));
  document.addEventListener('visibilitychange', () => { if (document.hidden) { releasePad(); held.length = 0; } });
  window.addEventListener('blur', releasePad);
  document.addEventListener('selectionchange', () => { if (padHeld.size) { const s = window.getSelection(); if (s) s.removeAllRanges(); } });

  function updateZone() {
    const me = users.get(selfId);
    if (!me) return;
    const z = $('zone');
    const r = MAP.region(me.x, me.y);
    z.classList.toggle('quiet', r === 'quiet');
    const t = linkState.table;
    const g = linkState.group;
    if (g) { z.textContent = `👥 小群組（${g.members.length + 1} 人）`; z.classList.remove('quiet'); return; }
    z.textContent = r === 'quiet' ? '🤫 自習區：走到別人旁邊可以邀請視訊'
      : t ? `🪑 討論桌 ${t.id}`
      : r === 'discuss' ? '💬 討論區：走到桌子旁邊加入討論'
      : r === 'lounge' ? '☕ 休息區：靠近就能聊天' : '🚪 走廊';
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

    if (me && MAP.region(me.x, me.y) === 'lounge') { // 只有休息區用距離判斷，才畫範圍圈
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
      const ln = linkInfo.get(u.id);
      const connected = !!ln && (ln.send.v || ln.send.a || ln.recv.v || ln.recv.a);
      const ringing = !!ln && isInvite(ln);
      const label = u.name;
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = u.id === selfId ? 'rgba(74,144,217,.9)' : connected ? 'rgba(46,158,91,.92)' : ringing ? 'rgba(232,140,40,.95)' : 'rgba(0,0,0,.55)';
      roundRect(ctx, px + T / 2 - w / 2, py - 14, w, 15, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(label, px + T / 2, py - 6);
      drawSpeech(u, px + T / 2, py - 17, ts);
    }

    // 距離越遠音量越小
    if (me) {
      for (const [id, p] of peers) {
        const u = users.get(id);
        if (!u || !p.audio) continue;
        const d = Math.hypot(u.x - me.x, u.y - me.y);
        p.audio.volume = Math.max(0.3, Math.min(1, 1 - (d - 1) / 4));
      }
    }
    placeBubbles();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function flashHint(text) {
    const h = $('flash');
    h.textContent = text; h.hidden = false;
    clearTimeout(flashHint.t); flashHint.t = setTimeout(() => { h.hidden = true; }, 2500);
  }

  // ---------- 頭上的對話框 ----------
  function wrapText(text, maxW, maxLines) {
    const lines = [];
    let cur = '';
    for (const ch of text) {
      if (ctx.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ''; if (lines.length === maxLines) break; }
      cur += ch;
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    const used = lines.join('').length;
    if (used < [...text].length && lines.length) {
      let last = lines[lines.length - 1];
      while (last && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
      lines[lines.length - 1] = last + '…';
    }
    return lines;
  }
  function drawSpeech(u, cx, bottom, now) {
    const saying = u.say && u.say.until > now;
    const typing = !saying && u.typingUntil > now;
    if (!saying && !typing) return;
    ctx.save();
    ctx.font = '12px system-ui, "PingFang TC", "Microsoft JhengHei", sans-serif';
    let lines, w, h;
    if (saying) {
      lines = wrapText(u.say.text, 150, 2);
      w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
      h = lines.length * 15 + 8;
    } else { w = 34; h = 18; }
    const fade = saying ? Math.min(1, (u.say.until - now) / 600) : 1; // 最後 0.6 秒淡出
    ctx.globalAlpha = fade;
    const x = Math.max(2, Math.min(canvas.width - w - 2, cx - w / 2)), y = bottom - h - 6;
    ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(59,47,39,.35)'; ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 8); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - 5, y + h - 0.5); ctx.lineTo(cx, y + h + 6); ctx.lineTo(cx + 5, y + h - 0.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#3b2f27'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (saying) lines.forEach((l, i) => ctx.fillText(l, x + w / 2, y + 4 + 7.5 + i * 15));
    else {
      for (let i = 0; i < 3; i++) { // 跳動的三個點
        const dy = Math.sin(now / 180 - i * 0.9) * 2;
        ctx.beginPath(); ctx.arc(x + 10 + i * 7, y + h / 2 + dy, 2.2, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

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
  // 打字中通知（最多每 2 秒送一次；清空、送出或離開輸入框就取消）
  let typingSent = 0;
  function setTyping(on) {
    const me = users.get(selfId);
    if (on) {
      if (me) me.typingUntil = performance.now() + 6000;
      if (performance.now() - typingSent > 2000) { typingSent = performance.now(); socket.emit('typing', true); }
    } else if (typingSent) {
      typingSent = 0; socket.emit('typing', false);
      if (me) me.typingUntil = 0;
    }
  }
  $('chatInput').addEventListener('input', () => setTyping($('chatInput').value.trim().length > 0));
  $('chatInput').addEventListener('blur', () => setTyping(false));
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const t = $('chatInput').value.trim();
    if (t) socket.emit('chat', t);
    $('chatInput').value = '';
    typingSent = 0; // 送出後伺服器的訊息會自動清掉「…」
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
      if (!sideOpen) renderSideTab();
      return;
    }
    const left = Math.max(0, Math.round((pomo.endsAt - (Date.now() + clockOffset)) / 1000));
    const s = `${pad(Math.floor(left / 60))}:${pad(left % 60)}`;
    el.textContent = s;
    $('pomoPhase').textContent = pomo.phase === 'focus' ? `🔥 專注中（第 ${pomo.round} 輪）` : '☕ 休息中';
    document.title = `${pomo.phase === 'focus' ? '🔥' : '☕'} ${s}｜像素自習室`;
    if (!sideOpen) renderSideTab();
  }
  setInterval(renderPomo, 250);
  $('pomoStart').onclick = () => { ensureAudio(); socket.emit('pomo-start', { focus: $('pomoFocus').value, brk: $('pomoBreak').value }); };
  $('pomoSkip').onclick = () => socket.emit('pomo-skip');
  $('pomoStop').onclick = () => socket.emit('pomo-stop');

  // ---------- 排行 ----------
  // 自己的今日時間也存在瀏覽器裡，主機重啟後進來會補回去
  const taipeiDate = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  function loadToday() {
    try { const t = JSON.parse(store.get('today') || 'null'); return t && t.date === taipeiDate() ? t : null; } catch (_) { return null; }
  }
  function setBoard(list) {
    boardData = list || [];
    const mine = boardData.find((r) => r.name === profile.name);
    const saved = loadToday();
    if (mine && (!saved || mine.sec >= saved.sec)) store.set('today', JSON.stringify({ date: taipeiDate(), sec: mine.sec }));
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
