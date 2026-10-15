/**
 * Разбор PNG прямо в приложении — ради ОДНОГО вопроса: как выглядит логотип.
 *
 * React Native не даёт доступа к пикселям картинки: ни Image, ни Animated.Image не умеют ничего
 * рассказать о том, что внутри. А знать надо две вещи, и обе видны только в пикселях: где на
 * холсте кончается прозрачное поле и начинается сама марка (у логотипов TMDB поля бывают в
 * половину файла — отсюда «крошечные» логотипы) и не нарисована ли марка чёрным (тогда на тёмной
 * афише её не видно вовсе).
 *
 * Поэтому файл читается вручную. Берётся САМАЯ МАЛЕНЬКАЯ разумная копия (w154): по ней и рамка, и
 * светлота считаются с избытком точности, а весит она несколько килобайт.
 *
 * Свой inflate — потому что чужого взять неоткуда: установка пакетов с этой машины не проходит, а
 * тянуть в проект чужой сжатый бандл ради двухсот строк хуже, чем написать эти двести строк.
 * Разборщик проверен на файлах со всеми пятью фильтрами строк, обоими видами блоков deflate,
 * палитрой с tRNS, RGB и RGBA — рамка и светлота совпали с образцом до пикселя.
 */

/** Результат разбора. */
export type LogoProbe = {
  /** Размер холста. */
  w: number;
  h: number;
  /** Рамка непрозрачного — в пикселях холста. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Средняя светлота марки, 0..255. */
  lum: number;
  /** Светлота САМЫХ СВЕТЛЫХ пикселей марки (97-й процентиль), 0..255. */
  lumHi: number;
  /** Доля пикселей, у которых есть выраженный цвет (а не оттенок серого). */
  colorFrac: number;
};

// ---------------------------------------------------------------- inflate

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

type Huff = { count: Int32Array; symbols: Int32Array };

function buildHuff(lengths: Uint8Array | Int32Array, n: number): Huff {
  const count = new Int32Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  const offs = new Int32Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
  const symbols = new Int32Array(n);
  for (let s = 0; s < n; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  return { count, symbols };
}

/**
 * Распаковка потока deflate. Алгоритм — «puff» из справочной реализации zlib: разбор кода по одному
 * биту без таблиц. Он в разы медленнее табличного, и это здесь совершенно неважно: файл весит
 * несколько килобайт и читается один раз на фильм.
 */
function inflate(src: Uint8Array, start: number): Uint8Array | null {
  let pos = start;
  let bitBuf = 0;
  let bitCnt = 0;

  const bits = (n: number): number => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new Error('eof');
      bitBuf = (bitBuf | (src[pos++] << bitCnt)) >>> 0;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };

  const decode = (h: Huff): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const cnt = h.count[len];
      if (code - first < cnt) return h.symbols[index + (code - first)];
      index += cnt;
      first = (first + cnt) << 1;
      code <<= 1;
    }
    throw new Error('bad code');
  };

  let out = new Uint8Array(1 << 16);
  let len = 0;
  const push = (b: number) => {
    if (len === out.length) {
      const bigger = new Uint8Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    out[len++] = b;
  };

  let fixedLit: Huff | null = null;
  let fixedDist: Huff | null = null;

  try {
    for (;;) {
      const last = bits(1);
      const type = bits(2);

      if (type === 0) {
        // Несжатый блок: остаток текущего байта отбрасывается.
        bitBuf = 0;
        bitCnt = 0;
        const l = src[pos] | (src[pos + 1] << 8);
        pos += 4;
        for (let i = 0; i < l; i++) push(src[pos++]);
      } else {
        let lit: Huff;
        let dist: Huff;
        if (type === 1) {
          if (!fixedLit) {
            const ll = new Uint8Array(288);
            for (let i = 0; i < 144; i++) ll[i] = 8;
            for (let i = 144; i < 256; i++) ll[i] = 9;
            for (let i = 256; i < 280; i++) ll[i] = 7;
            for (let i = 280; i < 288; i++) ll[i] = 8;
            fixedLit = buildHuff(ll, 288);
            const dl = new Uint8Array(30).fill(5);
            fixedDist = buildHuff(dl, 30);
          }
          lit = fixedLit;
          dist = fixedDist as Huff;
        } else if (type === 2) {
          const hlit = bits(5) + 257;
          const hdist = bits(5) + 1;
          const hclen = bits(4) + 4;
          const clen = new Uint8Array(19);
          for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = bits(3);
          const clenH = buildHuff(clen, 19);
          const lengths = new Uint8Array(hlit + hdist);
          let i = 0;
          while (i < hlit + hdist) {
            const sym = decode(clenH);
            if (sym < 16) lengths[i++] = sym;
            else if (sym === 16) {
              const prev = lengths[i - 1];
              let r = 3 + bits(2);
              while (r--) lengths[i++] = prev;
            } else if (sym === 17) {
              let r = 3 + bits(3);
              while (r--) lengths[i++] = 0;
            } else {
              let r = 11 + bits(7);
              while (r--) lengths[i++] = 0;
            }
          }
          lit = buildHuff(lengths.subarray(0, hlit), hlit);
          dist = buildHuff(lengths.subarray(hlit), hdist);
        } else {
          return null;
        }

        for (;;) {
          const sym = decode(lit);
          if (sym < 256) push(sym);
          else if (sym === 256) break;
          else {
            const li = sym - 257;
            const l = LEN_BASE[li] + bits(LEN_EXTRA[li]);
            const ds = decode(dist);
            const d = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
            for (let i = 0; i < l; i++) push(out[len - d]);
          }
        }
      }
      if (last) break;
    }
  } catch {
    return null;
  }
  return out.subarray(0, len);
}

// ---------------------------------------------------------------- PNG

const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/**
 * Разбор PNG до пикселей и сразу — до ответа.
 *
 * Поддержаны только восьмибитные непрослоённые файлы: ими TMDB и отдаёт логотипы. Всё остальное
 * (глубина 1/2/4/16, Adam7) честно возвращает null — тогда логотип показывается как есть, без
 * поправок. Гадать по половине формата хуже, чем не гадать вовсе.
 */
export function probePng(bytes: Uint8Array): LogoProbe | null {
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;

  let p = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  while (p + 8 <= bytes.length) {
    const clen = be32(bytes, p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const data = bytes.subarray(p + 8, p + 8 + clen);
    if (type === 'IHDR') {
      w = be32(data, 0);
      h = be32(data, 4);
      depth = data[8];
      color = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + clen;
  }

  if (!w || !h || depth !== 8 || interlace !== 0 || idat.length === 0) return null;

  const chan = color === 0 ? 1 : color === 2 ? 3 : color === 3 ? 1 : color === 4 ? 2 : color === 6 ? 4 : 0;
  if (chan === 0) return null;
  if (color === 3 && !plte) return null;

  let z: Uint8Array;
  if (idat.length === 1) z = idat[0];
  else {
    let total = 0;
    for (const d of idat) total += d.length;
    z = new Uint8Array(total);
    let at = 0;
    for (const d of idat) {
      z.set(d, at);
      at += d.length;
    }
  }
  // Заголовок zlib: два байта, плюс четыре на словарь, если он объявлен.
  const zStart = (z[1] & 0x20) !== 0 ? 6 : 2;
  const raw = inflate(z, zStart);
  if (!raw) return null;

  const stride = w * chan;
  if (raw.length < (stride + 1) * h) return null;

  // Расфильтровка: каждая строка начинается с байта типа фильтра.
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const inRow = y * (stride + 1) + 1;
    const outRow = y * stride;
    const prev = outRow - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[inRow + x];
      const a = x >= chan ? px[outRow + x - chan] : 0;
      const b = y > 0 ? px[prev + x] : 0;
      const c = x >= chan && y > 0 ? px[prev + x - chan] : 0;
      let out: number;
      if (ft === 0) out = v;
      else if (ft === 1) out = v + a;
      else if (ft === 2) out = v + b;
      else if (ft === 3) out = v + ((a + b) >> 1);
      else if (ft === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else return null;
      px[outRow + x] = out & 255;
    }
  }

  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  let sum = 0;
  let n = 0;
  const hist = new Int32Array(256);
  let colored = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * stride + x * chan;
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      if (color === 6) {
        r = px[i];
        g = px[i + 1];
        b = px[i + 2];
        a = px[i + 3];
      } else if (color === 2) {
        r = px[i];
        g = px[i + 1];
        b = px[i + 2];
      } else if (color === 4) {
        r = g = b = px[i];
        a = px[i + 1];
      } else if (color === 3) {
        const idx = px[i];
        const q = plte as Uint8Array;
        r = q[idx * 3];
        g = q[idx * 3 + 1];
        b = q[idx * 3 + 2];
        a = trns && idx < trns.length ? trns[idx] : 255;
      } else {
        r = g = b = px[i];
      }
      // Рамка — по еле заметному следу: сглаженные края марки тоже её часть.
      if (a >= 24) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      // Светлота — только по плотным пикселям: полупрозрачная кайма темнее самой марки и
      // утянула бы среднее вниз у любого логотипа.
      if (a >= 128) {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sum += l;
        hist[Math.min(255, Math.round(l))]++;
        // Насыщенность по-простому: разброс между каналами. У серого он нулевой, у красной марки
        // «Человека-паука» — под две сотни.
        if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colored++;
        n++;
      }
    }
  }

  if (x1 < 0 || n === 0) return null;

  // 97-й процентиль, а не максимум: у любой марки найдётся десяток случайных светлых пикселей на
  // краю глифа, и максимум по ним говорил бы о картинке неправду.
  let acc = 0;
  let lumHi = 0;
  const cut = n * 0.97;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= cut) {
      lumHi = i;
      break;
    }
  }

  return { w, h, x0, y0, x1, y1, lum: sum / n, lumHi, colorFrac: colored / n };
}
