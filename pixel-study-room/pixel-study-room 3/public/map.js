// 地圖定義（伺服器與瀏覽器共用）
// #=牆 B=書架 D=書桌 T=討論桌 P=盆栽 q=安靜區地板 .=地板 r=地毯
(function (root) {
  const ROWS = [
    '##############################',
    '#BBBBBBBBBBBB#PP..........PP.#',
    '#qqqqqqqqqqqq#...............#',
    '#qDDqqDDqqDDq#...TT.....TT...#',
    '#qqqqqqqqqqqq#...TT.....TT...#',
    '#qqqqqqqqqqqq#...............#',
    '#qDDqqDDqqDDq#...............#',
    '#qqqqqqqqqqqq#...TT.....TT...#',
    '#qqqqqqqqqqqq#...TT.....TT...#',
    '#qDDqqDDqqDDq................#',
    '#qqqqqqqqqqqq................#',
    '#qqqqqqqqqqqq#...............#',
    '#qDDqqDDqqDDq#######..########',
    '#qqqqqqqqqqqq#P.....rrrrrr..P#',
    '#qqqqqqqqqqqq#......rrrrrr...#',
    '#qDDqqDDqqDDq#......rrrrrr...#',
    '#qqqqqqqqqqqq#......rrrrrr...#',
    '#qqqqqqqqqqqq#P............P.#',
    '#BBBBBBBBBBBB#...............#',
    '##############################',
  ];
  const W = ROWS[0].length;
  const H = ROWS.length;
  const BLOCK = new Set(['#', 'B', 'D', 'T', 'P']);

  function tile(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return '#';
    return ROWS[y][x];
  }
  function walkable(x, y) { return !BLOCK.has(tile(x, y)); }
  function isQuiet(x, y) { return tile(x, y) === 'q'; }
  // 區域：同區域（或站在門口）才會接通
  function region(x, y) {
    if (isQuiet(x, y)) return 'quiet';
    if (y === 12) return 'door';
    return y < 12 ? 'discuss' : 'lounge';
  }

  // 討論桌：把相連的 T 視為同一張桌子，站在桌子周圍一格就算「在這張桌子」
  const tableId = [];
  for (let y = 0; y < H; y++) tableId.push(new Array(W).fill(0));
  let tableCount = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (tile(x, y) !== 'T' || tableId[y][x]) continue;
    tableCount++;
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (tile(cx, cy) !== 'T' || tableId[cy][cx]) continue;
      tableId[cy][cx] = tableCount;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }
  function tableAt(x, y) {
    if (!walkable(x, y)) return 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const tx = x + dx, ty = y + dy;
      if (tile(tx, ty) === 'T') return tableId[ty][tx];
    }
    return 0;
  }

  const SPAWNS = [];
  for (let y = 13; y <= 16; y++) for (let x = 20; x <= 25; x++) SPAWNS.push([x, y]);

  const LABELS = [
    { x: 7, y: 2.5, text: '📚 自習區（互相邀請才開視訊）' },
    { x: 21.5, y: 2.5, text: '💬 討論區（到桌邊加入）' },
    { x: 21.5, y: 18.5, text: '☕ 休息區（靠近就能聊天）' },
  ];

  const api = { ROWS, W, H, tile, walkable, isQuiet, region, tableAt, tableCount, SPAWNS, LABELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MAP = api;
})(this);
