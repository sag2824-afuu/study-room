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
// TURN 中繼伺服器（不同網路連不上時需要）
// 方法一：Cloudflare（每月 1,000 GB 免費，推薦）→ 設定 CF_TURN_KEY_ID 和 CF_TURN_API_TOKEN
// 方法二：Metered（每月 20 GB 免費）→ 設定 METERED_DOMAIN 和 METERED_API_KEY
// 方法三：自己的 TURN → 設定 TURN_URL、TURN_USERNAME、TURN_CREDENTIAL
let meteredCache = { at: 0, servers: null };
let cfCache = { at: 0, servers: null };
async function cloudflareTurn() {
  if (cfCache.servers && Date.now() - cfCache.at < 12 * 3600e3) return cfCache.servers; // 憑證有效 24 小時，每 12 小時換一次
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(process.env.CF_TURN_KEY_ID.trim())}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CF_TURN_API_TOKEN.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (r.ok) {
      const data = await r.json();
      let list = data.iceServers;
      if (list && !Array.isArray(list)) list = [list];
      if (Array.isArray(list) && list.length) {
        // 瀏覽器會擋 53 埠，先過濾掉（Cloudflare 文件的建議）
        list = list.map((sv) => ({ ...sv, urls: [].concat(sv.urls).filter((u) => !/:53(\?|$)/.test(u)) })).filter((sv) => sv.urls.length);
        cfCache = { at: Date.now(), servers: list };
        return list;
      }
    }
    console.warn('Cloudflare TURN 取得失敗：', r.status, (await r.text().catch(() => '')).slice(0, 200));
  } catch (e) { console.warn('Cloudflare TURN 取得失敗：', e.message); }
  return cfCache.servers || [];
}
async function turnServers() {
  if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN) {
    const list = await cloudflareTurn();
    if (list.length) return list;
  }
  if (process.env.METERED_DOMAIN && process.env.METERED_API_KEY) {
    if (meteredCache.servers && Date.now() - meteredCache.at < 3600e3) return meteredCache.servers;
    try {
      const domain = process.env.METERED_DOMAIN.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const r = await fetch(`https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(process.env.METERED_API_KEY)}`);
      if (r.ok) {
        const list = await r.json();
        if (Array.isArray(list) && list.length) { meteredCache = { at: Date.now(), servers: list }; return list; }
      }
      console.warn('Metered TURN 取得失敗：', r.status);
    } catch (e) { console.warn('Metered TURN 取得失敗：', e.message); }
    return meteredCache.servers || [];
  }
  if (process.env.TURN_URL) {
    return [{
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    }];
  }
  return [];
}
app.get('/config', async (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    ...(await turnServers()),
  ];
  res.json({ iceServers, needPassword: !!ROOM_PASSWORD, turn: iceServers.some((s) => String(s.urls).includes('turn')) });
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
// 區域的規則：
//  quiet  自習區：站在旁邊，鏡頭／麥克風／螢幕分開問，各自要雙方都按 ○ 才開
//  table  討論桌：同一桌的人互相連線，鏡頭／麥克風各自決定要不要開
//  lounge 休息區：靠近就自動開語音；視訊／螢幕要雙方都按 ○
//  group  小群組：自習區或休息區裡，兩個人只要有一項雙方都同意就組成小群組；
//         其他人可以申請加入（任何成員同意即可），成員各自決定要開什麼
const pairConsent = new Map(); // "a|b" -> { v: {...}, a: {...}, s: {...} }  v=視訊 a=語音 s=螢幕分享
const linkCtx = new Map();     // "a|b" -> 'quiet' | 'table' | 'lounge' | 'group'
const tableState = new Map();  // id -> { table, cam, mic, camAns, micAns }
const sentState = new Map();   // id -> 上次送出的狀態（避免重複送）
const groups = new Map();      // gid -> { id, zone, members:Set, media:Map(id -> {v,a,s}), requests:Set, rejected:Set }
const userGroup = new Map();   // id -> gid
let gidSeq = 0;
const GROUP_FAR = 4.5;         // 離最近的成員超過這個距離（格）就自動離開小群組

function ctxOf(a, b, prev) {
  const ra = MAP.region(a.x, a.y), rb = MAP.region(b.x, b.y);
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  if (ra === 'quiet' && rb === 'quiet') return d <= (prev === 'quiet' ? QUIET_FAR : QUIET_NEAR) ? 'quiet' : null;
  const ta = MAP.tableAt(a.x, a.y);
  if (ta && ta === MAP.tableAt(b.x, b.y)) return 'table';
  if (ra === 'lounge' && rb === 'lounge') return d <= (prev === 'lounge' ? FAR : NEAR) ? 'lounge' : null;
  return null;
}
const groupOf = (id) => groups.get(userGroup.get(id)) || null;
function leaveGroup(id) {
  const g = groupOf(id);
  if (!g) return;
  g.members.delete(id); g.media.delete(id); userGroup.delete(id);
  if (g.members.size < 2) { for (const m of g.members) userGroup.delete(m); groups.delete(g.id); }
}
function makeGroup(a, b, zone, media) {
  const g = { id: ++gidSeq, zone, members: new Set([a, b]), media: new Map(), requests: new Set(), rejected: new Set() };
  for (const id of [a, b]) { g.media.set(id, { ...media }); userGroup.set(id, g.id); }
  groups.set(g.id, g);
}
// 成員走出區域、或離其他成員太遠，就自動離開
function maintainGroups() {
  for (const g of [...groups.values()]) {
    for (const id of [...g.members]) {
      const u = users.get(id);
      if (!u || MAP.region(u.x, u.y) !== g.zone) { leaveGroup(id); continue; }
      let nearest = Infinity;
      for (const o of g.members) if (o !== id) { const v = users.get(o); if (v) nearest = Math.min(nearest, Math.hypot(u.x - v.x, u.y - v.y)); }
      if (nearest > GROUP_FAR) leaveGroup(id);
    }
  }
}

function recompute(depth = 0) {
  const ids = [...users.keys()];
  for (const id of ids) {
    const u = users.get(id);
    const ts = tableState.get(id);
    const t = MAP.tableAt(u.x, u.y);
    if (ts.table !== t) Object.assign(ts, { table: t, cam: false, mic: false, scr: false, camAns: false, micAns: false, scrAns: false });
  }
  maintainGroups();
  let formed = false;
  const out = new Map(ids.map((i) => [i, []]));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const key = pairKey(a, b);
      const prev = linkCtx.get(key);
      const ga = userGroup.get(a), gb = userGroup.get(b);
      const ctx = ga && ga === gb ? 'group' : ctxOf(users.get(a), users.get(b), prev);
      if (ctx !== prev) pairConsent.delete(key); // 換了情境就重新詢問
      if (ctx) { linkCtx.set(key, ctx); links.add(key); } else { linkCtx.delete(key); links.delete(key); continue; }
      const pc = pairConsent.get(key) || { v: {}, a: {}, s: {} };
      const get = (k, id) => (pc[k] && pc[k][id] !== undefined ? pc[k][id] : null);
      const ca = { v: get('v', a), a: get('a', a), s: get('s', a) };
      const cb = { v: get('v', b), a: get('a', b), s: get('s', b) };
      const both = (k) => ca[k] === true && cb[k] === true;
      let sab, sba; // a 送給 b、b 送給 a 的內容 {v: 視訊, a: 語音, s: 螢幕分享}
      let kinds = [], joinA = null, joinB = null; // kinds：可以一對一詢問的項目；join：可以申請加入對方的小群組
      if (ctx === 'group') {
        const g = groups.get(ga), A = g.media.get(a), B = g.media.get(b);
        const lounge = g.zone === 'lounge';
        sab = { v: A.v, a: lounge || A.a, s: A.s }; sba = { v: B.v, a: lounge || B.a, s: B.s };
      } else if (ctx === 'table') {
        const A = tableState.get(a), B = tableState.get(b);
        const scr = A.scr && B.scr; // 討論桌：雙方都開放螢幕分享才互通
        sab = { v: A.cam, a: A.mic, s: scr }; sba = { v: B.cam, a: B.mic, s: scr };
      } else if (ga || gb) {
        // 有一方已經在小群組裡：不再一對一詢問，改成「申請加入」
        sab = { v: false, a: ctx === 'lounge', s: false }; sba = sab;
        const st = (me, other) => {
          if (userGroup.get(me)) return null;
          const g = groupOf(other);
          return g.requests.has(me) ? 'pending' : g.rejected.has(me) ? null : 'can';
        };
        if (gb && !ga) joinA = st(a, b);
        if (ga && !gb) joinB = st(b, a);
      } else {
        kinds = ctx === 'quiet' ? ['v', 'a', 's'] : ['v', 's'];
        if (ctx === 'quiet') { sab = { v: both('v'), a: both('a'), s: both('s') }; sba = sab; }
        else { sab = { v: both('v'), a: true, s: both('s') }; sba = sab; }
        // 有任何一項雙方都同意 → 組成小群組
        if (both('v') || both('s') || (ctx === 'quiet' && both('a'))) {
          makeGroup(a, b, ctx, { v: both('v'), a: ctx === 'quiet' ? both('a') : false, s: both('s') });
          pairConsent.delete(key);
          formed = true;
        }
      }
      out.get(a).push({ id: b, ctx, send: sab, recv: sba, mine: ca, theirs: cb, kinds, join: joinA });
      out.get(b).push({ id: a, ctx, send: sba, recv: sab, mine: cb, theirs: ca, kinds, join: joinB });
    }
  }
  if (formed && depth < 3) return recompute(depth + 1);
  // 清掉已經離開範圍的申請
  for (const g of groups.values()) {
    const near = (r) => [...g.members].some((m) => ['quiet', 'lounge'].includes(linkCtx.get(pairKey(r, m))));
    for (const r of [...g.requests]) if (!users.has(r) || userGroup.has(r) || !near(r)) g.requests.delete(r);
    for (const r of [...g.rejected]) if (!users.has(r) || !near(r)) g.rejected.delete(r);
  }
  for (const id of ids) {
    const ts = tableState.get(id);
    const table = ts.table ? {
      id: ts.table, cam: ts.cam, mic: ts.mic, scr: ts.scr, camAns: ts.camAns, micAns: ts.micAns, scrAns: ts.scrAns,
      members: ids.filter((o) => o !== id && tableState.get(o).table === ts.table).map((o) => users.get(o).name),
    } : null;
    const g = groupOf(id);
    const group = g ? {
      id: g.id, zone: g.zone, media: g.media.get(id),
      members: [...g.members].filter((o) => o !== id).map((o) => users.get(o).name),
      requests: [...g.requests].map((r) => ({ id: r, name: users.get(r).name })),
    } : null;
    const payload = { peers: out.get(id), table, group };
    const str = JSON.stringify(payload);
    if (sentState.get(id) !== str) { sentState.set(id, str); io.to(id).emit('links', payload); }
  }
}
function forget(id) {
  leaveGroup(id);
  for (const g of groups.values()) { g.requests.delete(id); g.rejected.delete(id); }
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
      x, y, dir: 'down', cam: false, mic: false, scr: false,
    };
    users.set(socket.id, u);
    // 主機休眠／重新部署會清掉紀錄：用瀏覽器備份的今日時間補回來
    if (p.today && p.today.date === today() && Number.isFinite(p.today.sec)) {
      if (stats.date !== today()) stats = { date: today(), seconds: {} };
      stats.seconds[name] = Math.max(stats.seconds[name] || 0, Math.min(86400, Math.floor(p.today.sec)));
    }
    tableState.set(socket.id, { table: 0, cam: false, mic: false, scr: false, camAns: false, micAns: false, scrAns: false });
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
    u.cam = !!m.cam; u.mic = !!m.mic; u.scr = !!m.scr;
    socket.broadcast.emit('user-media', { id: u.id, cam: u.cam, mic: u.mic, scr: u.scr });
  });

  // 自習區／休息區：對某個人的鏡頭（kind='v'）或麥克風（kind='a'）按 ○（true）或 ✕（false）
  socket.on('pair', (m) => {
    if (!m || typeof m.peer !== 'string' || !users.has(socket.id)) return;
    const key = pairKey(socket.id, m.peer);
    const ctx = linkCtx.get(key);
    if (!ctx || ctx === 'table' || ctx === 'group' || userGroup.has(socket.id) || userGroup.has(m.peer)) return;
    const kind = ['v', 'a', 's'].includes(m.kind) ? m.kind : 'v';
    if (ctx === 'lounge' && kind === 'a') return; // 休息區語音本來就是開的
    const pc = pairConsent.get(key) || { v: {}, a: {}, s: {} };
    if (!pc[kind]) pc[kind] = {};
    pc[kind][socket.id] = m.value === true;
    pairConsent.set(key, pc);
    recompute();
  });
  // 小群組：申請加入、取消申請、成員同意／拒絕、調整自己的鏡頭麥克風螢幕、離開
  socket.on('group-join', (m) => {
    const g = m && groupOf(m.peer);
    if (!g || !users.has(socket.id) || userGroup.has(socket.id) || g.rejected.has(socket.id)) return;
    if (!['quiet', 'lounge'].includes(linkCtx.get(pairKey(socket.id, m.peer)))) return;
    g.requests.add(socket.id);
    recompute();
  });
  socket.on('group-cancel', (m) => {
    const g = m && groupOf(m.peer);
    if (g) { g.requests.delete(socket.id); recompute(); }
  });
  socket.on('group-answer', (m) => {
    const g = groupOf(socket.id);
    if (!g || !m || !g.requests.has(m.id)) return;
    g.requests.delete(m.id);
    if (m.ok && users.has(m.id) && !userGroup.has(m.id)) {
      g.members.add(m.id); g.media.set(m.id, { v: false, a: false, s: false }); userGroup.set(m.id, g.id);
    } else if (!m.ok) g.rejected.add(m.id);
    recompute();
  });
  socket.on('group-media', (m) => {
    const g = groupOf(socket.id);
    if (!g || !m) return;
    const media = g.media.get(socket.id);
    for (const k of ['v', 'a', 's']) if (k in m) media[k] = !!m[k];
    recompute();
  });
  socket.on('group-leave', () => { leaveGroup(socket.id); recompute(); });

  // 討論桌：鏡頭／麥克風分開選
  socket.on('table-media', (m) => {
    const ts = tableState.get(socket.id);
    if (!ts || !ts.table || !m) return;
    if ('cam' in m) { ts.cam = !!m.cam; ts.camAns = true; }
    if ('mic' in m) { ts.mic = !!m.mic; ts.micAns = true; }
    if ('scr' in m) { ts.scr = !!m.scr; ts.scrAns = true; }
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
    if (t) pushChat({ id: u.id, name: u.name, color: u.color, text: t, ts: now });
  });

  // 正在打字：讓其他人在角色頭上看到「…」
  socket.on('typing', (v) => {
    if (!me()) return;
    socket.broadcast.emit('user-typing', { id: socket.id, typing: !!v });
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

// Render 重新部署／休眠前會送 SIGTERM：先存檔再結束
process.on('SIGTERM', () => {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(stats)); } catch (_) { /* ignore */ }
  process.exit(0);
});

server.listen(PORT, () => console.log(`像素自習室已啟動：http://localhost:${PORT}`));
