// Hand-drawn 12 x 12 pixel icons for the HUD's own chrome (money, labor, menu buttons, quest
// marks), drawn from ASCII art into inline SVG. Item and skill icons come from icons.gen.ts.

type Icon = { rows: string[]; pal?: Record<string, string> };

const MONO: Record<string, string> = { '#': '#2b1209', c: '#fbe6bd', s: '#d6ae78' };
const GOLD: Record<string, string> = { '#': '#3a1a06', y: '#ffd84a', Y: '#d99a1a' };
const Q_ROWS = ['...######...', '..#yyyyyy#..', '.#yyY##yyY#.', '.#yY#..#yY#.', '..##..#yyY#.', '.....#yyY#..', '....#yyY#...', '....#yY#....', '.....##.....', '....####....', '....#yY#....', '....####....'];

// A round coin: lit rim, an inner bevel lit the other way, and a shine on the face.
function coinRows(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 12; y++) {
    let row = '';
    for (let x = 0; x < 12; x++) {
      const dx = x - 5.5;
      const dy = y - 5.5;
      const d = Math.hypot(dx, dy);
      const light = (-dx * 0.6 - dy * 0.8) / Math.max(d, 0.001);
      let ch = '.';
      if (d <= 6.1) ch = '#';
      if (d <= 5.1) ch = light > 0.4 ? 'y' : light < -0.4 ? 'G' : 'g';
      if (d <= 3.6) ch = light > 0.4 ? 'G' : light < -0.4 ? 'y' : 'g';
      if (d <= 2.6) ch = dx < 0 && dy < 0 && d > 1 ? 'y' : 'g';
      row += ch;
    }
    rows.push(row);
  }
  return rows;
}

// A cart wheel: rim, four spokes and a hub.
function wheelRows(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 12; y++) {
    let row = '';
    for (let x = 0; x < 12; x++) {
      const dx = x - 5.5;
      const dy = y - 5.5;
      const d = Math.hypot(dx, dy);
      let ch = '.';
      if (d <= 6.1) ch = '#';
      if (d <= 5.0) ch = 'c';
      if (d <= 4.0) ch = '#';
      if (d <= 3.2) ch = '.';
      if (d <= 4.0 && (Math.abs(dx) < 1 || Math.abs(dy) < 1)) ch = 'c';
      if (d <= 1.6) ch = 'c';
      if (d <= 0.8) ch = '#';
      row += ch;
    }
    rows.push(row);
  }
  return rows;
}

const ICONS: Record<string, Icon> = {
  coin: { pal: { '#': '#4a2508', y: '#ffe58c', g: '#f2b431', G: '#b8741a' }, rows: coinRows() },
  heart: { pal: { '#': '#3a0c0c', r: '#e0403c', R: '#9c1f22', w: '#ffc2b5' }, rows: ['............', '.###....###.', '#rrr#..#rrr#', '#rwrr##rrrR#', '#rwrrrrrrrR#', '#rrrrrrrrrR#', '.#rrrrrrrR#.', '..#rrrrrR#..', '...#rrrR#...', '....#rR#....', '.....##.....', '............'] },
  bolt: { pal: { '#': '#4a2508', Y: '#ffe14d', O: '#e89a1a' }, rows: ['......####..', '.....#YYY#..', '....#YYY#...', '...#YYY####.', '..#YYYYYYY#.', '.####YYYYO#.', '....#YYYO#..', '...#YYO#....', '..#YYO#.....', '..#YO#......', '.#Y##.......', '.##.........'] },
  seal: { pal: { '#': '#3a0c0c', r: '#d23c3c', R: '#8e1f24', y: '#ffd76a', b: '#4a7be0' }, rows: ['....####....', '..##rrrr##..', '.#rrRRRRrr#.', '.#rRrrrrRr#.', '#rrRryyrRrr#', '#rrRyyyyRrr#', '.#rRryyrRr#.', '.#rrRRRRrr#.', '..##rrrr##..', '...#b##b#...', '..#bb#.#bb#.', '..###...###.'] },
  bag: { rows: ['..##....##..', '...#c##c#...', '....####....', '....#cc#....', '...#cccc#...', '..#cccccc#..', '.#cccccccc#.', '#cccccccccs#', '#ccccccccss#', '#cccccccsss#', '.#ssssssss#.', '..########..'] },
  map: { rows: ['............', '############', '#cccssss#c##', '#cccssssc#c#', '#cccssss#c##', '#cccssssccc#', '#cccss#sccc#', '#ccc#sssccc#', '#cccssssccc#', '#c#cssssccc#', '#cccssssccc#', '############'] },
  scroll: { rows: ['.##########.', '#ssssssssss#', '.#cccccccc#.', '.#c######c#.', '.#cccccccc#.', '.#c#####cc#.', '.#cccccccc#.', '.#c####ccc#.', '.#cccccccc#.', '#ssssssssss#', '.##########.', '............'] },
  star: { rows: ['.....#......', '....#c#.....', '....#c#.....', '#####c#####.', '#ccccccccc#.', '.#ccccccc#..', '..#ccccc#...', '..#cc#cc#...', '.#cc#.#cc#..', '.#c#...#c#..', '.##.....##..', '............'] },
  person: { rows: ['....####....', '...#cccc#...', '...#cccc#...', '...#cccc#...', '....####....', '..########..', '.#cccccccc#.', '#cc#cccc#cc#', '#cc#cccc#cc#', '...#cc#c#...', '...#cc#c#...', '...##.###...'] },
  gear: { rows: ['.....##.....', '..#.#cc#.#..', '.#c#cccc#c#.', '..#cc##cc#..', '.#cc#..#cc#.', '#cc#....#cc#', '#cc#....#cc#', '.#cc#..#cc#.', '..#cc##cc#..', '.#c#cccc#c#.', '..#.#cc#.#..', '.....##.....'] },
  wheel: { rows: wheelRows() },
  excl: { pal: GOLD, rows: ['....####....', '...#yyyy#...', '...#yyyY#...', '...#yyyY#...', '...#yyyY#...', '....#yY#....', '....#yY#....', '.....##.....', '....####....', '...#yyyY#...', '...#yYYY#...', '....####....'] },
  qmark: { pal: GOLD, rows: Q_ROWS },
  qgray: { pal: { '#': '#3a2a1a', y: '#d8cbb4', Y: '#9a8a74' }, rows: Q_ROWS },
  bubble: { rows: ['............', '..########..', '.#cccccccc#.', '#cccccccccc#', '#c##c##c##c#', '#cccccccccc#', '.#ssssssss#.', '..###c####..', '....#c#.....', '....##......', '............', '............'] },
  lock: { pal: { '#': '#2b1a0e', g: '#c9a24e', G: '#8a6420', s: '#5a3720' }, rows: ['............', '....####....', '...#....#...', '..#.#..#.#..', '..#.#..#.#..', '.##########.', '.#gggggggg#.', '.#gggssggg#.', '.#ggGssGgg#.', '.#gggssggg#.', '.#GGGGGGGG#.', '.##########.'] },
  // MP: a drop of blue.
  mana: { pal: { '#': '#0e1f44', b: '#4f8ff0', B: '#2b55b5', w: '#d6e8ff' }, rows: ['.....##.....', '....#bb#....', '...#bbbb#...', '...#bbbb#...', '..#bwbbbb#..', '.#bwbbbbbB#.', '.#bwbbbbbB#.', '.#bwbbbbbB#.', '.#bbbbbbbB#.', '..#bbbbbB#..', '...#BBBB#...', '....####....'] },
  // Stamina: a winged boot.
  stamina: { pal: { '#': '#3a2406', y: '#f5cf3f', Y: '#c48f16', w: '#fff6c8' }, rows: ['...######...', '#..#yyyy#...', '##.#ywyy#...', '#w##ywyy#...', '.#w#yyyy#...', '..##yyyy#...', '...#yyyyY##.', '...#yyyyyyY#', '..#ywyyyyyY#', '..#YYYYYYYY#', '..##########', '............'] },
};

/** Palettes for coins of each metal. */
export const COIN = {
  gold: undefined,
  silver: { '#': '#2b2f36', y: '#ffffff', g: '#c9d1d9', G: '#7d8590' },
  copper: { '#': '#3a1d0a', y: '#ffcfa0', g: '#d7874a', G: '#8a4f22' },
} as const;
export const GOLD_STAR = { '#': '#3a1a06', c: '#ffd84a', s: '#d99a1a' };

export type PixelIconName = keyof typeof ICONS;

const cache = new Map<string, string>();

/** An inline SVG of a pixel icon, `px` wide. */
export function pixelIcon(name: PixelIconName, px = 24, pal?: Record<string, string>): string {
  const key = `${name}|${px}|${pal ? JSON.stringify(pal) : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const icon = ICONS[name];
  const colours = { ...(icon.pal ?? MONO), ...(pal ?? {}) };
  const w = icon.rows[0].length;
  const h = icon.rows.length;
  let rects = '';
  icon.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let n = 1;
      while (x + n < row.length && row[x + n] === ch) n++;
      if (ch !== '.' && colours[ch]) rects += `<rect x="${x}" y="${y}" width="${n}" height="1" fill="${colours[ch]}"/>`;
      x += n;
    }
  });
  const svg = `<svg class="pxi" xmlns="http://www.w3.org/2000/svg" width="${px}" height="${(px * h) / w}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${rects}</svg>`;
  cache.set(key, svg);
  return svg;
}
