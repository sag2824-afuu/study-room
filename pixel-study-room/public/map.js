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

  const SPAWNS = [];
  for (let y = 13; y <= 16; y++) for (let x = 20; x <= 25; x++) SPAWNS.push([x, y]);

  const LABELS = [
    { x: 7, y: 2.5, text: '📚 安靜自習區（自動靜音）' },
    { x: 21.5, y: 2.5, text: '💬 討論區' },
    { x: 21.5, y: 18.5, text: '☕ 休息區' },
  ];

  const api = { ROWS, W, H, tile, walkable, isQuiet, region, SPAWNS, LABELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MAP = api;
})(this);
