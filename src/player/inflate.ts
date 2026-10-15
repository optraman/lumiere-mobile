/**
 * РАСПАКОВКА GZIP — СВОИМИ РУКАМИ.
 *
 * Субтитры OpenSubtitles приходят файлами .gz, а у телефона под рукой нет ни zlib, ни
 * DecompressionStream. Тянуть ради одной функции библиотеку незачем: распаковщик DEFLATE — это
 * несколько таблиц и декодер кодов Хаффмана, всё по RFC 1951 (по образцу puff.c Марка Адлера).
 * Проверяется против настоящего zlib: tools/inflate-check.js.
 */

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

type Huff = { count: Uint16Array; symbol: Uint16Array };

class Bits {
  pos: number;
  private buf = 0;
  private cnt = 0;
  constructor(private data: Uint8Array, start: number) {
    this.pos = start;
  }
  need(n: number): number {
    let v = this.buf;
    while (this.cnt < n) {
      if (this.pos >= this.data.length) throw new Error('конец данных');
      v |= this.data[this.pos++] << this.cnt;
      this.cnt += 8;
    }
    this.buf = v >>> n;
    this.cnt -= n;
    return v & ((1 << n) - 1);
  }
  /** Выровняться на байт — перед несжатым блоком. */
  align(): void {
    this.buf = 0;
    this.cnt = 0;
  }
}

function build(lengths: number[], n: number): Huff {
  const count = new Uint16Array(16);
  const symbol = new Uint16Array(n);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  // Смещения считаются с длины 1: символы нулевой длины в коде не участвуют. Первая версия
  // начинала с нуля и сдвигала всю таблицу на их число — проверка против zlib это и поймала.
  const offs = new Uint16Array(16);
  offs[1] = 0;
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
  for (let i = 0; i < n; i++) if (lengths[i] !== 0) symbol[offs[lengths[i]]++] = i;
  count[0] = 0;
  return { count, symbol };
}

function decode(b: Bits, h: Huff): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len < 16; len++) {
    code |= b.need(1);
    const c = h.count[len];
    if (code - c < first) return h.symbol[index + (code - first)];
    index += c;
    first += c;
    first <<= 1;
    code <<= 1;
  }
  throw new Error('битый код Хаффмана');
}

let fixed: { lit: Huff; dist: Huff } | null = null;
function fixedTables() {
  if (fixed) return fixed;
  const l: number[] = [];
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  const d: number[] = [];
  for (let i = 0; i < 30; i++) d[i] = 5;
  fixed = { lit: build(l, 288), dist: build(d, 30) };
  return fixed;
}

function dynamicTables(b: Bits) {
  const nlen = b.need(5) + 257;
  const ndist = b.need(5) + 1;
  const ncode = b.need(4) + 4;
  const lengths: number[] = new Array(320).fill(0);
  for (let i = 0; i < ncode; i++) lengths[ORDER[i]] = b.need(3);
  const lencode = build(lengths, 19);
  let i = 0;
  const all: number[] = new Array(nlen + ndist).fill(0);
  while (i < nlen + ndist) {
    let sym = decode(b, lencode);
    if (sym < 16) {
      all[i++] = sym;
    } else {
      let len = 0;
      let rep: number;
      if (sym === 16) {
        if (i === 0) throw new Error('повтор без предыдущего');
        len = all[i - 1];
        rep = 3 + b.need(2);
      } else if (sym === 17) rep = 3 + b.need(3);
      else rep = 11 + b.need(7);
      while (rep--) all[i++] = len;
      sym = 0;
    }
  }
  return { lit: build(all.slice(0, nlen), nlen), dist: build(all.slice(nlen), ndist) };
}

/** Сырой DEFLATE → байты. */
export function inflateRaw(data: Uint8Array, start = 0): Uint8Array {
  const b = new Bits(data, start);
  /*
    ВЫХОД — ГОТОВЫМ БУФЕРОМ БАЙТОВ, А НЕ МАССИВОМ ЧИСЕЛ. Распакованные субтитры — сотни килобайт, и
    обычный массив с push на каждый байт рос кусками, держал каждое число как полноценное значение
    и в конце ещё раз копировался целиком. Буфер растёт удвоением; результат — тот же.
  */
  let out = new Uint8Array(Math.max(1024, (data.length - start) * 4));
  let n = 0;
  const room = (k: number) => {
    if (n + k <= out.length) return;
    let size = out.length * 2;
    while (size < n + k) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(out.subarray(0, n));
    out = grown;
  };
  let last = 0;
  while (!last) {
    last = b.need(1);
    const type = b.need(2);
    if (type === 0) {
      b.align();
      const p = b.pos;
      const len = data[p] | (data[p + 1] << 8);
      b.pos = p + 4;
      room(len);
      // Что за концом данных — остаётся нулями, как и прежде (там читался undefined → 0).
      const have = Math.max(0, Math.min(len, data.length - b.pos));
      out.set(data.subarray(b.pos, b.pos + have), n);
      n += len;
      b.pos += len;
    } else if (type === 1 || type === 2) {
      const { lit, dist } = type === 1 ? fixedTables() : dynamicTables(b);
      for (;;) {
        const sym = decode(b, lit);
        if (sym < 256) {
          room(1);
          out[n++] = sym;
        } else if (sym === 256) break;
        else {
          const s = sym - 257;
          const len = LBASE[s] + b.need(LEXT[s]);
          const ds = decode(b, dist);
          const back = DBASE[ds] + b.need(DEXT[ds]);
          const from = n - back;
          if (from < 0) throw new Error('ссылка назад за начало');
          room(len);
          // Побайтно: ссылка может перекрывать то, что пишется сейчас (повтор короче длины).
          for (let i = 0; i < len; i++) out[n++] = out[from + i];
        }
      }
    } else throw new Error('неизвестный тип блока');
  }
  return out.slice(0, n);
}

/** gzip → байты. Заголовок разбирается по RFC 1952; контрольная сумма не сверяется. */
export function gunzip(data: Uint8Array): Uint8Array {
  if (data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 8) throw new Error('это не gzip');
  const flg = data[3];
  let p = 10;
  if (flg & 4) p += 2 + (data[p] | (data[p + 1] << 8));
  if (flg & 8) while (data[p++] !== 0);
  if (flg & 16) while (data[p++] !== 0);
  if (flg & 2) p += 2;
  return inflateRaw(data, p);
}

// ───────────── кодировки ─────────────

/** Строгий UTF-8: null, если байты им не являются. */
export function strictUtf8(bytes: Uint8Array): string | null {
  let s = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let cp: number;
    let n: number;
    if (b < 0x80) {
      cp = b;
      n = 0;
    } else if ((b & 0xe0) === 0xc0) {
      cp = b & 0x1f;
      n = 1;
    } else if ((b & 0xf0) === 0xe0) {
      cp = b & 0x0f;
      n = 2;
    } else if ((b & 0xf8) === 0xf0) {
      cp = b & 0x07;
      n = 3;
    } else return null;
    for (let k = 1; k <= n; k++) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (n > 0 && ((n === 1 && cp < 0x80) || (n === 2 && cp < 0x800) || (n === 3 && cp < 0x10000))) return null;
    i += n + 1;
    if (cp > 0xffff) {
      const c = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    } else s += String.fromCharCode(cp);
  }
  return s;
}

/** Верхняя половина windows-1251 (0x80…0xBF); 0xC0…0xFF — подряд «А»…«я». */
const CP1251_HIGH = [
  0x0402, 0x0403, 0x201a, 0x0453, 0x201e, 0x2026, 0x2020, 0x2021, 0x20ac, 0x2030, 0x0409, 0x2039, 0x040a, 0x040c, 0x040b, 0x040f,
  0x0452, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0xfffd, 0x2122, 0x0459, 0x203a, 0x045a, 0x045c, 0x045b, 0x045f,
  0x00a0, 0x040e, 0x045e, 0x0408, 0x00a4, 0x0490, 0x00a6, 0x00a7, 0x0401, 0x00a9, 0x0404, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x0407,
  0x00b0, 0x00b1, 0x0406, 0x0456, 0x0491, 0x00b5, 0x00b6, 0x00b7, 0x0451, 0x2116, 0x0454, 0x00bb, 0x0458, 0x0405, 0x0455, 0x0457,
];

export function cp1251(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xc0) s += String.fromCharCode(CP1251_HIGH[b - 0x80]);
    else s += String.fromCharCode(0x0410 + (b - 0xc0));
  }
  return s;
}

/** Как у Влада (decodeSmart): сперва строгий UTF-8, не вышло — windows-1251. */
export function decodeSmart(bytes: Uint8Array): string {
  return strictUtf8(bytes) ?? cp1251(bytes);
}
