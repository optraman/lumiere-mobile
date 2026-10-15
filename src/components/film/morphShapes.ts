/*
  ФИГУРЫ ДЛЯ МОРФИНГА СЦЕН «НАСТРОЕНИЯ».

  У каждой сцены одни и те же четыре «актёра» — задник, главная фигура, вторая фигура и
  акцент. Каждая фигура — контур ровно из K точек, обход по часовой стрелке, начиная с точки
  «слева сверху» от центра. Раз точки совпадают по числу и порядку, любую фигуру можно плавно
  перелить в любую другую простой интерполяцией точек: полоса боевика вздувается в розовый
  круг, круг стягивается в арку, арка раздувается в планету.

  Если фигуры у сцены нет — она стянута в точку цвета фона: появляется «из ничего» и уходит
  в ничто.

  Порядок актёров важен — это порядок рисования: back, main, second, accent.
*/
export const K = 56;

type Pt = [number, number];

function resample(poly: Pt[], k: number = K): Pt[] {
  const segs: number[] = [];
  let total = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push(l);
    total += l;
  }
  const out: Pt[] = [];
  let si = 0;
  let acc = 0;
  for (let j = 0; j < k; j++) {
    const target = (j / k) * total;
    while (si < segs.length - 1 && acc + segs[si] < target) {
      acc += segs[si];
      si++;
    }
    const a = poly[si];
    const b = poly[(si + 1) % poly.length];
    const t = segs[si] ? (target - acc) / segs[si] : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** По часовой (в экранных координатах), старт — ближайшая к направлению «влево-вверх» точка. */
function align(pts: Pt[]): Pt[] {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  let p = area < 0 ? pts.slice().reverse() : pts.slice();
  const cx = p.reduce((s, q) => s + q[0], 0) / p.length;
  const cy = p.reduce((s, q) => s + q[1], 0) / p.length;
  let best = 0;
  let bestV = -Infinity;
  for (let i = 0; i < p.length; i++) {
    const dx = p[i][0] - cx;
    const dy = p[i][1] - cy;
    const l = Math.hypot(dx, dy) || 1;
    const v = (-dx - dy) / l; // косинус к направлению (-1,-1)
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  }
  p = p.slice(best).concat(p.slice(0, best));
  return p;
}

const shape = (poly: Pt[]) => align(resample(poly));

function circle(cx: number, cy: number, r: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return shape(out);
}
function arch(x0: number, x1: number, top: number, bottom: number): Pt[] {
  const r = (x1 - x0) / 2;
  const cx = x0 + r;
  const cy = top + r;
  const out: Pt[] = [[x0, bottom], [x0, cy]];
  for (let i = 1; i < 40; i++) {
    const a = Math.PI + (i / 40) * Math.PI;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  out.push([x1, cy], [x1, bottom]);
  return shape(out);
}
function star(cx: number, cy: number, outer: number, inner: number, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i / (n * 2)) * Math.PI * 2;
    const r = i % 2 ? inner : outer;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return shape(out);
}
function bar(x1: number, y1: number, x2: number, y2: number, wdt: number): Pt[] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l = Math.hypot(dx, dy);
  const nx = (-dy / l) * (wdt / 2);
  const ny = (dx / l) * (wdt / 2);
  return shape([[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]]);
}
const dot = (x: number, y: number): Pt[] => Array.from({ length: K }, () => [x, y] as Pt);

export type Actor = { pts: number[]; color: string };
export type MorphScene = { bg: string; actors: Actor[] };

const flat = (p: Pt[]) => p.flatMap((q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]);
const A = (pts: Pt[], color: string): Actor => ({ pts: flat(pts), color });

/*
  Цвета — средние тона рисунков сцен (градиенты в морфинге не переливаются, поэтому берётся их
  середина): на краях перехода фигура совпадает с настоящей сценой, и подмена не видна.
*/
export const MORPH: Record<string, MorphScene> = {
  action: {
    bg: '#070404',
    actors: [
      A(shape([[40, 300], [140, 300], [330, 0], [230, 0]]), '#170808'),
      A(shape([[60, 330], [360, -20], [470, -20], [170, 330]]), '#B00A06'),
      A(shape([[190, 140], [300, -20], [400, -20], [238, 210]]), '#EC1409'),
      A(star(356, 62, 6, 1.2, 4), '#E0201A'),
    ],
  },
  romance: {
    bg: '#D21C4A',
    actors: [
      A(dot(185, 150), '#D21C4A'),
      A(circle(270, 200, 165), '#EA4573'),
      A(circle(318, 258, 108), '#D11B48'),
      A(star(362, 38, 11, 2.2, 4), '#FFFFFF'),
    ],
  },
  comedy: {
    bg: '#F27300',
    actors: [
      A(dot(185, 150), '#F27300'),
      A(circle(245, 160, 150), '#E46406'),
      A(shape([[268, 300], [400, 168], [400, 300]]), '#E86200'),
      A(star(40, 263, 15, 6, 8), '#C63E00'),
    ],
  },
  horror: {
    bg: '#0E0914',
    actors: [
      A(dot(185, 150), '#0E0914'),
      A(circle(200, 140, 128), '#2C1756'),
      A(arch(142, 258, 42, 232), '#0F0817'),
      A(shape([[110, 254], [290, 254], [290, 262], [110, 262]]), '#7440CC'),
    ],
  },
  scifi: {
    bg: '#061035',
    actors: [
      A(dot(185, 150), '#061035'),
      A(circle(350, 380, 235), '#2448D0'),
      A(circle(300, 70, 26), '#4566E0'),
      A(bar(40, 150, 150, 60, 1.6), '#C8D6FF'),
    ],
  },
};
