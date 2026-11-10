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
const NEAR = 2.5;       // 休息區：這個距離（格）以內就接通語音
const FAR = 3.5;        // 超過這個距離才斷線（避免在邊界一直斷斷續續）
const QUIET_NEAR = 1.5; // 自習區：要站在旁邊（含斜角）才會詢問
const QUIET_FAR = 2.5;

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
const links = new Set(); // 目前有連線的配對 "idA|idB"
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
// 三種區域的規則：
//  quiet  自習區：站在旁邊，鏡頭和麥克風分開問，各自要雙方都按 ○ 才開
//  table  討論桌：同一桌的人互相連線，鏡頭／麥克風各自決定要不要開
//  lounge 休息區：靠近就自動開語音；視訊要雙方都按 ○
const pairConsent = new Map(); // "a|b" -> { v: {[id]: true/false}, a: {...} }  v=視訊 a=語音
const linkCtx = new Map();     // "a|b" -> 'quiet' | 'table' | 'lounge'
const tableState = new Map();  // id -> { table, cam, mic, camAns, micAns }
const sentState = new Map();   // id -> 上次送出的狀態（避免重複送）

function ctxOf(a, b, prev) {
  const ra = MAP.region(a.x, a.y), rb = MAP.region(b.x, b.y);
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  if (ra === 'quiet' && rb === 'quiet') return d <= (prev === 'quiet' ? QUIET_FAR : QUIET_NEAR) ? 'quiet' : null;
  const ta = MAP.tableAt(a.x, a.y);
  if (ta && ta === MAP.tableAt(b.x, b.y)) return 'table';
  if (ra === 'lounge' && rb === 'lounge') return d <= (prev === 'lounge' ? FAR : NEAR) ? 'lounge' : null;
  return null;
}

function recompute() {
  const ids = [...users.keys()];
  for (const id of ids) {
    const u = users.get(id);
    const ts = tableState.get(id);
    const t = MAP.tableAt(u.x, u.y);
    if (ts.table !== t) Object.assign(ts, { table: t, cam: false, mic: false, camAns: false, micAns: false });
  }
  const out = new Map(ids.map((i) => [i, []]));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const key = pairKey(a, b);
      const prev = linkCtx.get(key);
      const ctx = ctxOf(users.get(a), users.get(b), prev);
      if (ctx !== prev) pairConsent.delete(key); // 換了情境就重新詢問
      if (ctx) { linkCtx.set(key, ctx); links.add(key); } else { linkCtx.delete(key); links.delete(key); continue; }
      const pc = pairConsent.get(key) || { v: {}, a: {} };
      const get = (k, id) => (pc[k][id] === undefined ? null : pc[k][id]);
      const ca = { v: get('v', a), a: get('a', a) };
      const cb = { v: get('v', b), a: get('a', b) };
      const bothV = ca.v === true && cb.v === true;
      const bothA = ca.a === true && cb.a === true;
      let sab, sba; // a 送給 b、b 送給 a 的內容 {v: 視訊, a: 語音}
      if (ctx === 'quiet') { sab = { v: bothV, a: bothA }; sba = sab; }
      else if (ctx === 'lounge') { sab = { v: bothV, a: true }; sba = sab; }
      else {
        const A = tableState.get(a), B = tableState.get(b);
        sab = { v: A.cam, a: A.mic }; sba = { v: B.cam, a: B.mic };
      }
      out.get(a).push({ id: b, ctx, send: sab, recv: sba, mine: ca, theirs: cb });
      out.get(b).push({ id: a, ctx, send: sba, recv: sab, mine: cb, theirs: ca });
    }
  }
  for (const id of ids) {
    const ts = tableState.get(id);
    const table = ts.table ? {
      id: ts.table, cam: ts.cam, mic: ts.mic, camAns: ts.camAns, micAns: ts.micAns,
      members: ids.filter((o) => o !== id && tableState.get(o).table === ts.table).map((o) => users.get(o).name),
    } : null;
    const payload = { peers: out.get(id), table };
    const str = JSON.stringify(payload);
    if (sentState.get(id) !== str) { sentState.set(id, str); io.to(id).emit('links', payload); }
  }
}
function forget(id) {
  for (const key of [...linkCtx.keys()]) {
    const [a, b] = key.split('|');
    if (a === id || b === id) { linkCtx.delete(key); links.delete(key); pairConsent.delete(key); }
  }
  sentState.delete(id);
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
    if (rejoin) forget(socket.id);
    const [x, y] = pickSpawn();
    const u = {
      id: socket.id, name,
      color: HEX.test(p.color) ? p.color : '#4a90d9',
      hair: HEX.test(p.hair) ? p.hair : '#2b1d14',
      x, y, dir: 'down', cam: false, mic: false,
    };
    users.set(socket.id, u);
    tableState.set(socket.id, { table: 0, cam: false, mic: false, camAns: false, micAns: false });
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

  socket.on('media-state', (m) => {
    const u = me();
    if (!u || !m) return;
    u.cam = !!m.cam; u.mic = !!m.mic;
    socket.broadcast.emit('user-media', { id: u.id, cam: u.cam, mic: u.mic });
  });

  // 自習區／休息區：對某個人的鏡頭（kind='v'）或麥克風（kind='a'）按 ○（true）或 ✕（false）
  socket.on('pair', (m) => {
    if (!m || typeof m.peer !== 'string' || !users.has(socket.id)) return;
    const key = pairKey(socket.id, m.peer);
    const ctx = linkCtx.get(key);
    if (!ctx || ctx === 'table') return;
    const kind = m.kind === 'a' ? 'a' : 'v';
    if (ctx === 'lounge' && kind === 'a') return; // 休息區語音本來就是開的
    const pc = pairConsent.get(key) || { v: {}, a: {} };
    pc[kind][socket.id] = m.value === true;
    pairConsent.set(key, pc);
    recompute();
  });
  // 討論桌：鏡頭／麥克風分開選
  socket.on('table-media', (m) => {
    const ts = tableState.get(socket.id);
    if (!ts || !ts.table || !m) return;
    if ('cam' in m) { ts.cam = !!m.cam; ts.camAns = true; }
    if ('mic' in m) { ts.mic = !!m.mic; ts.micAns = true; }
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
    forget(socket.id);
    tableState.delete(socket.id);
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
