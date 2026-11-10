'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const MAP = require('./public/map.js');

const PORT = process.env.PORT || 3000;
const ROOM_PASSWORD = process.env.ROOM_PASSWORD || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const TZ = 'Asia/Taipei';
const NEAR = 2.5; // 走到這個距離（格）以內就接通
const FAR = 3.5;  // 超過這個距離才斷線（避免在邊界一直斷斷續續）

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/config', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  res.json({ iceServers, needPassword: !!ROOM_PASSWORD });
});

// ---------- 狀態 ----------
const users = new Map(); // socketId -> {id,name,color,hair,x,y,dir}
const links = new Set(); // "idA|idB"
const chatHistory = [];
const pomo = { phase: 'idle', endsAt: 0, focus: 25, brk: 5, round: 0 };
let pomoTimer = null;

function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
}
let stats = { date: today(), seconds: {} };
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (saved && saved.date === today() && saved.seconds) stats = saved;
} catch (_) { /* 沒有舊資料 */ }
function saveStats() { fs.writeFile(DATA_FILE, JSON.stringify(stats), () => {}); }
function board() {
  return Object.entries(stats.seconds)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, sec]) => ({ name, sec }));
}

// ---------- 接近偵測 ----------
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
function canLink(a, b) {
  const ra = MAP.region(a.x, a.y);
  const rb = MAP.region(b.x, b.y);
  if (ra === 'quiet' || rb === 'quiet') return false;
  return ra === rb || ra === 'door' || rb === 'door';
}
// 接通意願：auto=自動接通；accept=手動按了「接通」的人；declined=按了「掛斷」的人
const consent = new Map(); // id -> {auto, accept:Set, declined:Set}
const nearPairs = new Set(); // 目前在範圍內的配對
const nearSent = new Map();  // id -> 上次送出的附近名單
function wants(a, b) {
  const c = consent.get(a);
  if (!c || c.declined.has(b)) return false;
  return c.auto || c.accept.has(b);
}
function clearConsent(a, b) {
  const ca = consent.get(a), cb = consent.get(b);
  if (ca) { ca.accept.delete(b); ca.declined.delete(b); }
  if (cb) { cb.accept.delete(a); cb.declined.delete(a); }
}
// 重新計算所有人之間的距離、接通狀態與附近名單
function recompute() {
  const ids = [...users.keys()];
  const nearby = new Map(ids.map((i) => [i, []]));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const ua = users.get(a), ub = users.get(b);
      const key = pairKey(a, b);
      const d = Math.hypot(ua.x - ub.x, ua.y - ub.y);
      const inRange = canLink(ua, ub) && d <= (nearPairs.has(key) ? FAR : NEAR);
      if (inRange) nearPairs.add(key);
      else if (nearPairs.has(key)) { nearPairs.delete(key); clearConsent(a, b); }
      const wa = wants(a, b), wb = wants(b, a);
      const should = inRange && wa && wb;
      const linked = links.has(key);
      if (should && !linked) {
        links.add(key);
        io.to(a).emit('peer-link', { peer: b, initiator: a < b });
        io.to(b).emit('peer-link', { peer: a, initiator: b < a });
      } else if (!should && linked) {
        links.delete(key);
        io.to(a).emit('peer-unlink', { peer: b });
        io.to(b).emit('peer-unlink', { peer: a });
      }
      if (inRange) {
        nearby.get(a).push({ id: b, name: ub.name, linked: should, iWant: wa, theyWant: wb });
        nearby.get(b).push({ id: a, name: ua.name, linked: should, iWant: wb, theyWant: wa });
      }
    }
  }
  for (const [id, list] of nearby) {
    const s = JSON.stringify(list);
    if (nearSent.get(id) !== s) { nearSent.set(id, s); io.to(id).emit('nearby', list); }
  }
}
function dropLinks(id) {
  for (const key of [...links]) {
    const [a, b] = key.split('|');
    if (a === id || b === id) {
      links.delete(key);
      const other = a === id ? b : a;
      io.to(other).emit('peer-unlink', { peer: id });
      io.to(id).emit('peer-unlink', { peer: other });
    }
  }
  for (const key of [...nearPairs]) {
    const [a, b] = key.split('|');
    if (a === id || b === id) { nearPairs.delete(key); clearConsent(a, b); }
  }
  nearSent.delete(id);
}

// ---------- 聊天 ----------
function pushChat(msg) {
  chatHistory.push(msg);
  if (chatHistory.length > 50) chatHistory.shift();
  io.emit('chat', msg);
}
const systemMsg = (text) => pushChat({ system: true, text, ts: Date.now() });

// ---------- 番茄鐘 ----------
function setPhase(phase) {
  clearTimeout(pomoTimer);
  if (phase === 'idle') {
    pomo.phase = 'idle'; pomo.endsAt = 0; pomo.round = 0;
  } else {
    pomo.phase = phase;
    const min = phase === 'focus' ? pomo.focus : pomo.brk;
    pomo.endsAt = Date.now() + min * 60000;
    if (phase === 'focus') pomo.round++;
    pomoTimer = setTimeout(advancePhase, min * 60000);
  }
  io.emit('pomo', { ...pomo, now: Date.now() });
}
function advancePhase() {
  const next = pomo.phase === 'focus' ? 'break' : 'focus';
  setPhase(next);
  systemMsg(next === 'focus' ? `🍅 休息結束，第 ${pomo.round} 輪專注開始！` : `☕ 專注結束，休息 ${pomo.brk} 分鐘～`);
}
const clampInt = (v, lo, hi, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

function pickSpawn() {
  const free = MAP.SPAWNS.filter(([x, y]) => ![...users.values()].some((u) => u.x === x && u.y === y));
  const list = free.length ? free : MAP.SPAWNS;
  return list[Math.floor(Math.random() * list.length)];
}
const HEX = /^#[0-9a-f]{6}$/i;

// ---------- Socket ----------
io.on('connection', (socket) => {
  const me = () => users.get(socket.id);

  socket.on('join', (p, ack) => {
    if (typeof ack !== 'function') return;
    p = p || {};
    if (ROOM_PASSWORD && String(p.password || '') !== ROOM_PASSWORD) return ack({ ok: false, error: '密碼錯誤' });
    const name = String(p.name || '').trim().slice(0, 16);
    if (!name) return ack({ ok: false, error: '請輸入名字' });
    const rejoin = users.has(socket.id);
    if (rejoin) dropLinks(socket.id);
    const [x, y] = pickSpawn();
    const u = {
      id: socket.id, name,
      color: HEX.test(p.color) ? p.color : '#4a90d9',
      hair: HEX.test(p.hair) ? p.hair : '#2b1d14',
      x, y, dir: 'down',
    };
    users.set(socket.id, u);
    consent.set(socket.id, { auto: p.auto !== false, accept: new Set(), declined: new Set() });
    ack({ ok: true, self: u, users: [...users.values()], chat: chatHistory, pomo, board: board(), now: Date.now() });
    socket.broadcast.emit('user-joined', u);
    if (!rejoin) systemMsg(`👋 ${name} 進入了自習室`);
    recompute();
  });

  socket.on('move', (m) => {
    const u = me();
    if (!u || !m) return;
    const x = m.x | 0, y = m.y | 0;
    const dir = ['up', 'down', 'left', 'right'].includes(m.dir) ? m.dir : u.dir;
    if (Math.abs(x - u.x) + Math.abs(y - u.y) > 1 || !MAP.walkable(x, y)) {
      socket.emit('correct', { x: u.x, y: u.y });
      return;
    }
    u.x = x; u.y = y; u.dir = dir;
    socket.broadcast.emit('user-moved', { id: u.id, x, y, dir });
    recompute();
  });

  socket.on('set-auto', (v) => {
    const c = consent.get(socket.id);
    if (!c) return;
    c.auto = !!v;
    recompute();
  });
  socket.on('call', (pid) => {
    const c = consent.get(socket.id);
    if (!c || typeof pid !== 'string') return;
    c.accept.add(pid); c.declined.delete(pid);
    recompute();
  });
  socket.on('hangup', (pid) => {
    const c = consent.get(socket.id);
    if (!c || typeof pid !== 'string') return;
    c.accept.delete(pid); c.declined.add(pid);
    recompute();
  });

  socket.on('signal', (msg) => {
    if (!msg || typeof msg.to !== 'string') return;
    if (!links.has(pairKey(socket.id, msg.to))) return;
    io.to(msg.to).emit('signal', { from: socket.id, data: msg.data });
  });

  let lastChat = 0;
  socket.on('chat', (text) => {
    const u = me();
    if (!u) return;
    const now = Date.now();
    if (now - lastChat < 400) return;
    lastChat = now;
    const t = String(text || '').trim().slice(0, 300);
    if (t) pushChat({ name: u.name, color: u.color, text: t, ts: now });
  });

  socket.on('pomo-start', (opt) => {
    const u = me();
    if (!u) return;
    opt = opt || {};
    pomo.focus = clampInt(opt.focus, 1, 120, 25);
    pomo.brk = clampInt(opt.brk, 1, 60, 5);
    pomo.round = 0;
    setPhase('focus');
    systemMsg(`🍅 ${u.name} 開始了番茄鐘：專注 ${pomo.focus} 分鐘／休息 ${pomo.brk} 分鐘`);
  });
  socket.on('pomo-skip', () => {
    const u = me();
    if (!u || pomo.phase === 'idle') return;
    systemMsg(`⏭ ${u.name} 跳過了目前階段`);
    advancePhase();
  });
  socket.on('pomo-stop', () => {
    const u = me();
    if (!u || pomo.phase === 'idle') return;
    setPhase('idle');
    systemMsg(`⏹ ${u.name} 停止了番茄鐘`);
  });

  socket.on('disconnect', () => {
    const u = me();
    if (!u) return;
    users.delete(socket.id);
    dropLinks(socket.id);
    consent.delete(socket.id);
    recompute();
    io.emit('user-left', { id: socket.id });
    systemMsg(`🚪 ${u.name} 離開了自習室`);
  });
});

// 每 10 秒幫在線的人累積自習時間
setInterval(() => {
  const d = today();
  if (stats.date !== d) stats = { date: d, seconds: {} };
  const names = new Set([...users.values()].map((u) => u.name));
  for (const n of names) stats.seconds[n] = (stats.seconds[n] || 0) + 10;
  if (names.size) io.emit('board', board());
}, 10000);
setInterval(saveStats, 60000);

server.listen(PORT, () => console.log(`像素自習室已啟動：http://localhost:${PORT}`));
