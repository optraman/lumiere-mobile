/**
 * СКЛЕЙКА СКАЧАННОГО В ОДИН MP4 — без сети, без файловой системы, без сторонних библиотек.
 *
 * ЗАЧЕМ. Куски потока (HLS) скачиваются по отдельности, и раньше рядом писался свой плейлист со
 * ссылками на них — расчёт был, что системный плеер откроет его, как обычный HLS, только с диска.
 * На iPhone так не работает: системный плеер играет HLS только из сети (или из особого пакета
 * Apple, который умеет собирать лишь его собственная качалка). Скачанное не открывалось вовсе.
 *
 * Обычный MP4-файл системный плеер играет с диска всегда. Поэтому после загрузки куски
 * перекладываются в один MP4: видео и звук — как есть, без перекодирования, меняется только
 * «упаковка». Это быстро (просто переписывание байтов) и не теряет качества.
 *
 * Что понимается на входе — то, что встречается у раздач:
 *   — куски MPEG-TS (.ts) с H.264 и AAC — самый частый случай;
 *   — куски fMP4 (init + .m4s) — видео и звук вместе или отдельными дорожками;
 *   — отдельная звуковая дорожка — из TS, из fMP4 или голым AAC (.aac).
 * Чего нет (HEVC внутри TS, AC-3, шифрование) — честная ошибка: тогда загрузка остаётся HLS.
 *
 * Выход — «плоский» MP4: заголовок, все данные одним блоком, оглавление (moov) в конце. С диска
 * плеер читает оглавление откуда угодно, а писать его в конце позволяет идти по кускам один раз и
 * не держать в памяти ничего, кроме таблиц размеров.
 *
 * Проверка без телефона: tools/remux-check.js (ffmpeg режет пробу на куски, склейка, ffprobe).
 */

// ─────────────────────────────────────────────────────────────── ввод-вывод

/** Куда писать: только дописывать в конец и один раз подправить уже записанное (размер данных). */
export interface Sink {
  write(bytes: Uint8Array): void | Promise<void>;
  patch(offset: number, bytes: Uint8Array): void | Promise<void>;
}

/** Одна дорожка на входе: что в ней лежит и как прочитать кусок по порядку. */
export type Input = {
  /** Инициализирующий кусок fMP4, если есть. */
  init?: () => Promise<Uint8Array>;
  pieces: number;
  read: (index: number) => Promise<Uint8Array>;
};

export class RemuxError extends Error {}

/*
  ПЕРЕДЫШКИ. Склейка идёт в том же потоке, что и весь интерфейс приложения, а разбор кадров —
  это проход по каждому байту. Без передышек экран замирал бы на полсекунды на каждом куске;
  с ними — раз в кадр отдаём поток интерфейсу, и прокрутка, нажатия, анимации живут.
*/
let lastBreath = 0;
async function breathe(): Promise<void> {
  const now = Date.now();
  if (now - lastBreath < 12) return;
  await new Promise((r) => setTimeout(r, 0));
  lastBreath = Date.now();
}

// ─────────────────────────────────────────────────────────────── дорожки

type Kind = 'video' | 'audio';

/** Растущий массив чисел без копий на каждый элемент. */
class Nums {
  a: Float64Array;
  n = 0;
  constructor(cap = 1024) {
    this.a = new Float64Array(cap);
  }
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  get(i: number) {
    return this.a[i];
  }
}

class Track {
  id = 0;
  timescale = 90000;
  entry: Uint8Array | null = null; // готовая запись stsd (avc1 / mp4a / …)
  width = 0;
  height = 0;
  /** Время декодирования каждого сэмпла (в timescale дорожки). */
  dts = new Nums();
  cto = new Nums();
  size = new Nums();
  sync = new Nums();
  /** Отрезки подряд лежащих сэмплов: [смещение в файле, сколько сэмплов]. */
  chunkOff = new Nums(256);
  chunkCount = new Nums(256);
  /** Длительность последнего сэмпла (у него нет следующего, по которому её посчитать). */
  lastDur = 0;
  /** Метки в 90 кГц (из TS или голого AAC) — звук потом переводится в свою частоту. */
  in90k = false;
  /** Голый AAC без метки времени: его начало приравнивается к началу картинки. */
  floating = false;
  kind: Kind;
  constructor(kind: Kind) {
    this.kind = kind;
  }
}

/** Сэмплы одного куска одной дорожки, готовые к записи одним блоком. */
type Batch = { track: Track; parts: Uint8Array[]; bytes: number; dts: number[]; cto: number[]; sync: boolean[] };

const newBatch = (track: Track): Batch => ({ track, parts: [], bytes: 0, dts: [], cto: [], sync: [] });

function addSample(b: Batch, data: Uint8Array, dts: number, cto: number, sync: boolean) {
  b.parts.push(data);
  b.bytes += data.length;
  b.dts.push(dts);
  b.cto.push(cto);
  b.sync.push(sync);
}

// ─────────────────────────────────────────────────────────────── чтение битов

class Bits {
  i = 0;
  d: Uint8Array;
  constructor(d: Uint8Array) {
    this.d = d;
  }
  bit(): number {
    const v = (this.d[this.i >> 3] >> (7 - (this.i & 7))) & 1;
    this.i++;
    return v;
  }
  bits(n: number): number {
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 2 + this.bit();
    return v;
  }
  ue(): number {
    let z = 0;
    while (this.bit() === 0 && z < 32) z++;
    return z === 0 ? 0 : 2 ** z - 1 + this.bits(z);
  }
  se(): number {
    const v = this.ue();
    return v & 1 ? (v + 1) / 2 : -(v / 2);
  }
}

/** Убрать «защитные» байты 00 00 03 из NAL — разбирать SPS можно только без них. */
function unescape(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]);
  }
  return Uint8Array.from(out);
}

/** Размер кадра из SPS H.264 — для оглавления (tkhd, avc1). */
function spsSize(sps: Uint8Array): { width: number; height: number } {
  const b = new Bits(unescape(sps));
  b.bits(8); // заголовок NAL
  const profile = b.bits(8);
  b.bits(16);
  b.ue();
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = b.ue();
    if (chroma === 3) b.bit();
    b.ue();
    b.ue();
    b.bit();
    if (b.bit()) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (b.bit()) {
          const n = i < 6 ? 16 : 64;
          let last = 8;
          let next = 8;
          for (let j = 0; j < n; j++) {
            if (next !== 0) next = (last + b.se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
  }
  b.ue();
  const pocType = b.ue();
  if (pocType === 0) b.ue();
  else if (pocType === 1) {
    b.bit();
    b.se();
    b.se();
    const n = b.ue();
    for (let i = 0; i < n; i++) b.se();
  }
  b.ue();
  b.bit();
  const wMbs = b.ue() + 1;
  const hMapUnits = b.ue() + 1;
  const frameMbsOnly = b.bit();
  if (!frameMbsOnly) b.bit();
  b.bit();
  let cl = 0;
  let cr = 0;
  let ct = 0;
  let cb = 0;
  if (b.bit()) {
    cl = b.ue();
    cr = b.ue();
    ct = b.ue();
    cb = b.ue();
  }
  const subW = chroma === 1 || chroma === 2 ? 2 : 1;
  const subH = chroma === 1 ? 2 : 1;
  const cropX = chroma === 0 ? 1 : subW;
  const cropY = (chroma === 0 ? 1 : subH) * (2 - frameMbsOnly);
  return {
    width: wMbs * 16 - (cl + cr) * cropX,
    height: (2 - frameMbsOnly) * hMapUnits * 16 - (ct + cb) * cropY,
  };
}

// ─────────────────────────────────────────────────────────────── запись коробок MP4

class W {
  parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 255);
    return this;
  }
  u16(v: number) {
    return this.u8(v >> 8).u8(v);
  }
  u24(v: number) {
    return this.u8(v >> 16).u8(v >> 8).u8(v);
  }
  u32(v: number) {
    return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v);
  }
  u64(v: number) {
    return this.u32(Math.floor(v / 2 ** 32)).u32(v >>> 0);
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }
  bytes(b: Uint8Array | number[]) {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]);
    return this;
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.parts.push(0);
    return this;
  }
  out(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

function box(type: string, ...kids: (Uint8Array | W)[]): Uint8Array {
  const body = kids.map((k) => (k instanceof W ? k.out() : k));
  const len = 8 + body.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const b of body) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

const full = (version: number, flags: number) => new W().u8(version).u24(flags);

function avcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  return box(
    'avcC',
    new W()
      .u8(1)
      .u8(sps[1])
      .u8(sps[2])
      .u8(sps[3])
      .u8(0xff) // длина NAL — 4 байта
      .u8(0xe1)
      .u16(sps.length)
      .bytes(sps)
      .u8(1)
      .u16(pps.length)
      .bytes(pps),
  );
}

function avc1(width: number, height: number, sps: Uint8Array, pps: Uint8Array): Uint8Array {
  return box(
    'avc1',
    new W()
      .zeros(6)
      .u16(1)
      .zeros(16)
      .u16(width)
      .u16(height)
      .u32(0x00480000)
      .u32(0x00480000)
      .u32(0)
      .u16(1)
      .zeros(32)
      .u16(0x18)
      .u16(0xffff),
    avcC(sps, pps),
  );
}

/** Длина дескриптора в esds — четыре байта с битом продолжения: так понимают все. */
const descLen = (n: number) => [0x80 | ((n >> 21) & 127), 0x80 | ((n >> 14) & 127), 0x80 | ((n >> 7) & 127), n & 127];

function mp4a(sampleRate: number, channels: number, asc: Uint8Array): Uint8Array {
  const dsi = [5, ...descLen(asc.length), ...asc];
  const dcd = [4, ...descLen(13 + dsi.length), 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...dsi];
  const sl = [6, ...descLen(1), 2];
  const es = [3, ...descLen(3 + dcd.length + sl.length), 0, 1, 0, ...dcd, ...sl];
  return box(
    'mp4a',
    new W()
      .zeros(6)
      .u16(1)
      .zeros(8)
      .u16(channels)
      .u16(16)
      .u16(0)
      .u16(0)
      .u32(Math.min(sampleRate, 65535) * 65536),
    box('esds', full(0, 0).bytes(es)),
  );
}

// ─────────────────────────────────────────────────────────────── MPEG-TS

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

type Pes = { pts: number; dts: number; data: Uint8Array };

/** Разбор одного куска TS: PES-пакеты по дорожкам. */
function demuxTs(seg: Uint8Array, state: TsState): { video: Pes[]; audio: Pes[] } {
  const video: Pes[] = [];
  const audio: Pes[] = [];
  const pending = new Map<number, { parts: Uint8Array[]; size: number }>();
  const flush = (pid: number) => {
    const p = pending.get(pid);
    if (!p || !p.size) return;
    pending.delete(pid);
    const buf = new Uint8Array(p.size);
    let o = 0;
    for (const x of p.parts) {
      buf.set(x, o);
      o += x.length;
    }
    if (buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1) return;
    const flags = buf[7];
    const hlen = buf[8];
    let pts = -1;
    let dts = -1;
    const ts = (k: number) =>
      (buf[k] & 0x0e) * 536870912 + buf[k + 1] * 4194304 + (buf[k + 2] & 0xfe) * 16384 + buf[k + 3] * 128 + (buf[k + 4] >> 1);
    if (flags & 0x80) pts = ts(9);
    if ((flags & 0xc0) === 0xc0) dts = ts(14);
    else dts = pts;
    const out = { pts, dts, data: buf.subarray(9 + hlen) };
    if (pid === state.videoPid) video.push(out);
    else if (pid === state.audioPid) audio.push(out);
  };
  for (let off = 0; off + 188 <= seg.length; off += 188) {
    if (seg[off] !== 0x47) {
      // Сбилась синхронизация — ищем следующий пакет.
      let k = off + 1;
      while (k < seg.length && seg[k] !== 0x47) k++;
      off = k - 188;
      continue;
    }
    const pusi = (seg[off + 1] & 0x40) !== 0;
    const pid = ((seg[off + 1] & 0x1f) << 8) | seg[off + 2];
    const afc = (seg[off + 3] >> 4) & 3;
    let p = off + 4;
    if (afc === 2 || afc === 0) continue;
    if (afc === 3) p += 1 + seg[p];
    if (p >= off + 188) continue;
    const payload = seg.subarray(p, off + 188);
    if (pid === 0) {
      const q = payload.subarray(pusi ? 1 + payload[0] : 0);
      // PAT: первая программа → её PMT.
      const len = ((q[1] & 0x0f) << 8) | q[2];
      for (let i = 8; i + 4 <= 3 + len - 4; i += 4) {
        const prog = (q[i] << 8) | q[i + 1];
        if (prog !== 0) {
          state.pmtPid = ((q[i + 2] & 0x1f) << 8) | q[i + 3];
          break;
        }
      }
      continue;
    }
    if (pid === state.pmtPid) {
      const q = payload.subarray(pusi ? 1 + payload[0] : 0);
      const len = ((q[1] & 0x0f) << 8) | q[2];
      const infoLen = ((q[10] & 0x0f) << 8) | q[11];
      for (let i = 12 + infoLen; i + 5 <= 3 + len - 4; ) {
        const type = q[i];
        const epid = ((q[i + 1] & 0x1f) << 8) | q[i + 2];
        const esLen = ((q[i + 3] & 0x0f) << 8) | q[i + 4];
        if (type === 0x1b && state.videoPid < 0) state.videoPid = epid;
        else if (type === 0x0f && state.audioPid < 0) state.audioPid = epid;
        else if (type === 0x24 && state.videoPid < 0) state.unsupported = 'видео HEVC внутри TS';
        else if ((type === 0x81 || type === 0x87) && state.audioPid < 0) state.otherAudio = 'звук AC-3';
        i += 5 + esLen;
      }
      continue;
    }
    if (pid !== state.videoPid && pid !== state.audioPid) continue;
    if (pusi) flush(pid);
    const cur = pending.get(pid) ?? { parts: [], size: 0 };
    cur.parts.push(payload);
    cur.size += payload.length;
    pending.set(pid, cur);
  }
  for (const pid of [...pending.keys()]) flush(pid);
  return { video, audio };
}

type TsState = { pmtPid: number; videoPid: number; audioPid: number; unsupported?: string; otherAudio?: string };

/** NAL-единицы из потока Annex B (разделители 00 00 01). */
function nals(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  const n = data.length;
  while (i + 2 < n) {
    if (data[i + 2] > 1) {
      i += 3;
      continue;
    }
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && data[end - 1] === 0) end--;
        out.push(data.subarray(start, end));
      }
      start = i + 3;
      i += 3;
      continue;
    }
    i++;
  }
  if (start >= 0 && start < n) out.push(data.subarray(start));
  return out;
}

/** 33-битные метки TS переворачиваются раз в 26 часов эфира — разворачиваем по прошлой. */
function unwrap(ts: number, ref: number): number {
  if (ref < 0) return ts;
  const period = 2 ** 33;
  let v = ts + Math.round((ref - ts) / period) * period;
  if (!Number.isFinite(v)) v = ts;
  return v;
}

// ─────────────────────────────────────────────────────────────── fMP4

type BoxRef = { type: string; start: number; body: number; end: number };

function boxesIn(d: Uint8Array, from: number, to: number): BoxRef[] {
  const out: BoxRef[] = [];
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let o = from;
  while (o + 8 <= to) {
    let size = dv.getUint32(o);
    const type = String.fromCharCode(d[o + 4], d[o + 5], d[o + 6], d[o + 7]);
    let body = o + 8;
    if (size === 1) {
      size = dv.getUint32(o + 8) * 2 ** 32 + dv.getUint32(o + 12);
      body = o + 16;
    } else if (size === 0) size = to - o;
    if (size < 8 || o + size > to) break;
    out.push({ type, start: o, body, end: o + size });
    o += size;
  }
  return out;
}

const child = (d: Uint8Array, b: BoxRef, type: string) => boxesIn(d, b.body, b.end).find((x) => x.type === type);
const children = (d: Uint8Array, b: BoxRef, type: string) => boxesIn(d, b.body, b.end).filter((x) => x.type === type);

type FTrack = { id: number; kind: Kind; timescale: number; entry: Uint8Array; width: number; height: number; defDur: number; defSize: number; defFlags: number };

/** Из init-куска: дорожки, их масштаб времени и готовые записи stsd. */
function parseInit(d: Uint8Array): FTrack[] {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const moov = boxesIn(d, 0, d.length).find((b) => b.type === 'moov');
  if (!moov) throw new RemuxError('в начальном куске нет оглавления');
  const out: FTrack[] = [];
  for (const trak of children(d, moov, 'trak')) {
    const tkhd = child(d, trak, 'tkhd');
    const mdia = child(d, trak, 'mdia');
    if (!tkhd || !mdia) continue;
    const v = d[tkhd.body];
    const id = dv.getUint32(tkhd.body + (v === 1 ? 20 : 12));
    const mdhd = child(d, mdia, 'mdhd');
    const hdlr = child(d, mdia, 'hdlr');
    if (!mdhd || !hdlr) continue;
    const timescale = dv.getUint32(mdhd.body + (d[mdhd.body] === 1 ? 20 : 12));
    const handler = String.fromCharCode(d[hdlr.body + 8], d[hdlr.body + 9], d[hdlr.body + 10], d[hdlr.body + 11]);
    if (handler !== 'vide' && handler !== 'soun') continue;
    const minf = child(d, mdia, 'minf');
    const stbl = minf && child(d, minf, 'stbl');
    const stsd = stbl && child(d, stbl, 'stsd');
    if (!stsd) continue;
    const first = boxesIn(d, stsd.body + 8, stsd.end)[0];
    if (!first) continue;
    if (first.type === 'encv' || first.type === 'enca') throw new RemuxError('поток зашифрован');
    const entry = d.slice(first.start, first.end);
    const width = handler === 'vide' ? dv.getUint16(first.start + 32) : 0;
    const height = handler === 'vide' ? dv.getUint16(first.start + 34) : 0;
    out.push({ id, kind: handler === 'vide' ? 'video' : 'audio', timescale, entry, width, height, defDur: 0, defSize: 0, defFlags: 0 });
  }
  const mvex = child(d, moov, 'mvex');
  if (mvex)
    for (const trex of children(d, mvex, 'trex')) {
      const id = dv.getUint32(trex.body + 4);
      const t = out.find((x) => x.id === id);
      if (!t) continue;
      t.defDur = dv.getUint32(trex.body + 12);
      t.defSize = dv.getUint32(trex.body + 16);
      t.defFlags = dv.getUint32(trex.body + 20);
    }
  if (!out.length) throw new RemuxError('в начальном куске нет ни видео, ни звука');
  return out;
}

/** Сэмплы фрагментов одного куска fMP4 — в пачки по дорожкам. */
function readFragments(d: Uint8Array, tracks: FTrack[], into: Map<number, { track: Track; batch: Batch; next: number }>) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  for (const moof of boxesIn(d, 0, d.length).filter((b) => b.type === 'moof')) {
    for (const traf of children(d, moof, 'traf')) {
      const tfhd = child(d, traf, 'tfhd');
      if (!tfhd) continue;
      const tf = dv.getUint32(tfhd.body) & 0xffffff;
      const id = dv.getUint32(tfhd.body + 4);
      const ft = tracks.find((x) => x.id === id);
      const dest = into.get(id);
      if (!ft || !dest) continue;
      let p = tfhd.body + 8;
      let base = moof.start;
      if (tf & 0x1) {
        base = dv.getUint32(p) * 2 ** 32 + dv.getUint32(p + 4);
        p += 8;
      }
      if (tf & 0x2) p += 4;
      let defDur = ft.defDur;
      let defSize = ft.defSize;
      let defFlags = ft.defFlags;
      if (tf & 0x8) {
        defDur = dv.getUint32(p);
        p += 4;
      }
      if (tf & 0x10) {
        defSize = dv.getUint32(p);
        p += 4;
      }
      if (tf & 0x20) defFlags = dv.getUint32(p);
      const tfdt = child(d, traf, 'tfdt');
      let t = dest.next;
      if (tfdt) t = d[tfdt.body] === 1 ? dv.getUint32(tfdt.body + 4) * 2 ** 32 + dv.getUint32(tfdt.body + 8) : dv.getUint32(tfdt.body + 4);
      for (const trun of children(d, traf, 'trun')) {
        const ver = d[trun.body];
        const rf = dv.getUint32(trun.body) & 0xffffff;
        const count = dv.getUint32(trun.body + 4);
        let q = trun.body + 8;
        let dataAt = base;
        if (rf & 0x1) {
          dataAt = base + dv.getInt32(q);
          q += 4;
        }
        let firstFlags = -1;
        if (rf & 0x4) {
          firstFlags = dv.getUint32(q);
          q += 4;
        }
        for (let i = 0; i < count; i++) {
          let dur = defDur;
          let size = defSize;
          let flags = i === 0 && firstFlags >= 0 ? firstFlags : defFlags;
          let cto = 0;
          if (rf & 0x100) {
            dur = dv.getUint32(q);
            q += 4;
          }
          if (rf & 0x200) {
            size = dv.getUint32(q);
            q += 4;
          }
          if (rf & 0x400) {
            const f = dv.getUint32(q);
            q += 4;
            if (!(i === 0 && firstFlags >= 0)) flags = f;
          }
          if (rf & 0x800) {
            cto = ver === 1 ? dv.getInt32(q) : dv.getUint32(q);
            q += 4;
          }
          if (dataAt + size > d.length) throw new RemuxError('кусок обрезан');
          const sync = ft.kind === 'audio' || (flags & 0x00010000) === 0;
          addSample(dest.batch, d.subarray(dataAt, dataAt + size), t, cto, sync);
          dest.track.lastDur = dur;
          dataAt += size;
          t += dur;
        }
      }
      dest.next = t;
    }
  }
}

// ─────────────────────────────────────────────────────────────── сборка

export type Progress = (done: number, total: number) => void;

/**
 * Склеить дорожки в MP4. inputs[0] — основная (видео, обычно со звуком внутри), inputs[1] —
 * отдельный звук, если он есть.
 */
export async function remux(inputs: Input[], sink: Sink, onProgress?: Progress): Promise<{ bytes: number; seconds: number }> {
  let pos = 0;
  const put = async (b: Uint8Array) => {
    await sink.write(b);
    pos += b.length;
  };

  // ftyp + заголовок mdat с 64-битным размером (подправим в конце).
  await put(box('ftyp', new W().str('isom').u32(512).str('isomiso2avc1mp41')));
  const mdatAt = pos;
  await put(new W().u32(1).str('mdat').u64(0).out());

  const tracks: Track[] = [];
  const total = inputs.reduce((n, x) => n + x.pieces, 0);
  let done = 0;

  // Каждая дорожка входа — свой разборщик; идём по кускам поочерёдно, чтобы звук и видео лежали
  // в файле рядом по времени (так плееру меньше прыгать по диску).
  type Reader = { input: Input; next: number; step: () => Promise<Batch[]> };
  const readers: Reader[] = [];

  for (const input of inputs) {
    const initBytes = input.init ? await input.init() : null;
    const firstPiece = input.pieces > 0 ? await input.read(0) : new Uint8Array(0);
    const isTs = !initBytes && firstPiece[0] === 0x47;
    const isAdts = !initBytes && firstPiece[0] === 0xff && (firstPiece[1] & 0xf0) === 0xf0;
    const isId3Adts = !initBytes && firstPiece[0] === 0x49 && firstPiece[1] === 0x44 && firstPiece[2] === 0x33;
    let cached: Uint8Array | null = firstPiece;
    const readPiece = async (i: number) => {
      if (i === 0 && cached) {
        const c = cached;
        cached = null;
        return c;
      }
      return input.read(i);
    };

    if (initBytes || (!isTs && !isAdts && !isId3Adts)) {
      // fMP4: init отдельно или в начале первого куска.
      const initData = initBytes ?? firstPiece;
      const ft = parseInit(initData);
      const map = new Map<number, { track: Track; batch: Batch; next: number }>();
      for (const f of ft) {
        const t = new Track(f.kind);
        t.timescale = f.timescale;
        t.entry = f.entry;
        t.width = f.width;
        t.height = f.height;
        tracks.push(t);
        map.set(f.id, { track: t, batch: newBatch(t), next: 0 });
      }
      const r: Reader = {
        input,
        next: 0,
        step: async () => {
          const d = await readPiece(r.next++);
          for (const v of map.values()) v.batch = newBatch(v.track);
          readFragments(d, ft, map);
          return [...map.values()].map((v) => v.batch);
        },
      };
      readers.push(r);
      continue;
    }

    if (isTs) {
      const st: TsState = { pmtPid: -1, videoPid: -1, audioPid: -1 };
      let video: Track | null = null;
      let audio: Track | null = null;
      let sps: Uint8Array | null = null;
      let pps: Uint8Array | null = null;
      let lastV = -1;
      let lastA = -1;
      /** Метка следующего кадра звука: ADTS-кадров в одном PES бывает несколько. */
      let aacClock = -1;
      let aac: { rate: number; channels: number; asc: Uint8Array } | null = null;
      let adtsRest: Uint8Array = new Uint8Array(0);
      const r: Reader = {
        input,
        next: 0,
        step: async () => {
          const d = await readPiece(r.next++);
          const { video: vp, audio: ap } = demuxTs(d, st);
          if (st.videoPid < 0 && st.unsupported) throw new RemuxError(st.unsupported);
          const out: Batch[] = [];
          if (vp.length) {
            if (!video) {
              video = new Track('video');
              tracks.push(video);
            }
            const b = newBatch(video);
            // Кусок PES без картинки (только SPS/PPS) приклеивается к следующему.
            let carry: Uint8Array[] = [];
            for (const p of vp) {
              await breathe();
              const units = nals(p.data);
              const keep: Uint8Array[] = [...carry];
              let pic = false;
              let idr = false;
              for (const u of units) {
                const type = u[0] & 0x1f;
                if (type === 7) {
                  if (!sps) sps = u.slice();
                  continue;
                }
                if (type === 8) {
                  if (!pps) pps = u.slice();
                  continue;
                }
                if (type === 9) continue; // разделитель кадров — в MP4 не нужен
                if (type >= 1 && type <= 5) pic = true;
                if (type === 5) idr = true;
                keep.push(u);
              }
              if (!pic) {
                carry = keep;
                continue;
              }
              carry = [];
              const size = keep.reduce((n, u) => n + 4 + u.length, 0);
              const sample = new Uint8Array(size);
              const dv = new DataView(sample.buffer);
              let o = 0;
              for (const u of keep) {
                dv.setUint32(o, u.length);
                sample.set(u, o + 4);
                o += 4 + u.length;
              }
              // Без метки (редко) — следом за прошлым кадром, на длительность кадра 29.97.
              const dts = p.dts >= 0 ? unwrap(p.dts, lastV) : lastV + 3003;
              const pts = p.pts >= 0 ? unwrap(p.pts, dts) : dts;
              lastV = dts;
              addSample(b, sample, dts, pts - dts, idr);
            }
            out.push(b);
          }
          if (ap.length) {
            if (!audio) {
              audio = new Track('audio');
              audio.in90k = true;
              tracks.push(audio);
            }
            const b = newBatch(audio);
            for (const p of ap) {
              if (p.pts >= 0) {
                const pts = unwrap(p.pts, lastA);
                lastA = pts;
                // Метка PES — у первого целого кадра; кадры за ним идут через 1024 отсчёта.
                if (aacClock < 0 || Math.abs(pts - aacClock) > 9000) aacClock = pts;
              }
              // Кадр, разрезанный границей PES, доклеивается из прошлого.
              const data = adtsRest.length ? concat(adtsRest, p.data) : p.data;
              const { frames, rest } = adtsSplit(data);
              adtsRest = rest;
              for (const f of frames) {
                if (!aac) aac = f.config;
                addSample(b, f.data, aacClock, 0, true);
                aacClock += (1024 * 90000) / f.config.rate;
              }
            }
            out.push(b);
            if (aac && !audio.entry) {
              audio.entry = mp4a(aac.rate, aac.channels, aac.asc);
            }
          }
          if (video && !video.entry && sps && pps) {
            const sz = spsSize(sps);
            video.width = sz.width;
            video.height = sz.height;
            video.entry = avc1(sz.width, sz.height, sps, pps);
          }
          return out;
        },
      };
      readers.push(r);
      continue;
    }

    // Голый AAC (ADTS), бывает с меткой ID3 в начале куска.
    {
      const t = new Track('audio');
      t.in90k = true;
      tracks.push(t);
      let clock = 0;
      const r: Reader = {
        input,
        next: 0,
        step: async () => {
          let d = await readPiece(r.next++);
          let ptsFromId3 = -1;
          if (d[0] === 0x49 && d[1] === 0x44 && d[2] === 0x33) {
            const len = ((d[6] & 0x7f) << 21) | ((d[7] & 0x7f) << 14) | ((d[8] & 0x7f) << 7) | (d[9] & 0x7f);
            ptsFromId3 = id3Timestamp(d.subarray(10, 10 + len));
            d = d.subarray(10 + len);
          }
          if (r.next === 1) {
            if (ptsFromId3 >= 0) clock = ptsFromId3;
            else t.floating = true;
          }
          const b = newBatch(t);
          for (const f of adtsSplit(d).frames) {
            if (!t.entry) t.entry = mp4a(f.config.rate, f.config.channels, f.config.asc);
            addSample(b, f.data, clock, 0, true);
            clock += (1024 * 90000) / f.config.rate;
          }
          return [b];
        },
      };
      readers.push(r);
    }
  }

  // Поочерёдно по кускам: кусок видео, кусок звука, следующий кусок видео…
  for (;;) {
    let any = false;
    for (const r of readers) {
      if (r.next >= r.input.pieces) continue;
      any = true;
      const batches = await r.step();
      for (const b of batches) {
        if (!b.parts.length) continue;
        const t = b.track;
        t.chunkOff.push(pos);
        t.chunkCount.push(b.parts.length);
        for (let i = 0; i < b.parts.length; i++) {
          t.dts.push(b.dts[i]);
          t.cto.push(b.cto[i]);
          t.size.push(b.parts[i].length);
          t.sync.push(b.sync[i] ? 1 : 0);
        }
        const blob = new Uint8Array(b.bytes);
        let o = 0;
        for (const part of b.parts) {
          blob.set(part, o);
          o += part.length;
        }
        await put(blob);
      }
      done++;
      onProgress?.(done, total);
    }
    if (!any) break;
  }

  const usable = tracks.filter((t) => t.entry && t.size.n > 0);
  // Звук без своих меток встаёт туда, где начинается картинка.
  const pic = usable.find((t) => t.kind === 'video');
  for (const t of usable) {
    if (!t.floating || !pic) continue;
    const at = ((pic.dts.get(0) + Math.max(0, pic.cto.get(0))) / pic.timescale) * 90000;
    for (let i = 0; i < t.dts.n; i++) t.dts.a[i] += at;
  }
  if (!usable.some((t) => t.kind === 'video')) throw new RemuxError('в кусках не нашлось видео');

  // Размер mdat.
  await sink.patch(mdatAt + 8, new W().u64(pos - mdatAt).out());

  // У TS метки в 90 кГц, у ADTS-звука — тоже (так считали выше); переводим звук в его частоту.
  for (const t of usable) {
    if (t.kind === 'audio' && t.in90k && t.entry) {
      const rate = new DataView(t.entry.buffer, t.entry.byteOffset).getUint32(32) >>> 16;
      if (rate > 0) {
        for (let i = 0; i < t.dts.n; i++) t.dts.a[i] = Math.round((t.dts.a[i] * rate) / 90000);
        t.timescale = rate;
        t.lastDur = 1024;
      }
    }
  }

  const MOVIE_TS = 1000;
  /*
    ГРАНИЦЫ ПОКАЗА ДОРОЖКИ — по самому раннему и самому позднему кадру на экране, а не по первому
    и последнему в файле: с B-кадрами порядок в файле и порядок показа разные, и счёт «по первому
    кадру» срезал два последних кадра фильма.
  */
  const span = (t: Track) => {
    const n = t.size.n;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const c = t.dts.get(i) - t.dts.get(0) + t.cto.get(i);
      const dur = i + 1 < n ? t.dts.get(i + 1) - t.dts.get(i) : t.lastDur || (n > 1 ? t.dts.get(i) - t.dts.get(i - 1) : 1);
      if (c < lo) lo = c;
      if (c + dur > hi) hi = c + dur;
    }
    return { lo: Math.max(0, lo), hi };
  };
  const startOf = (t: Track) => (t.dts.get(0) + span(t).lo) / t.timescale;
  const t0 = Math.min(...usable.map(startOf));
  let movieDur = 0;
  const traks: Uint8Array[] = [];
  usable.forEach((t, idx) => {
    t.id = idx + 1;
    const n = t.size.n;
    // Длительности — по разнице меток; последняя — как у предыдущего.
    const durs: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const d = i + 1 < n ? t.dts.get(i + 1) - t.dts.get(i) : t.lastDur || (n > 1 ? durs[i - 1] : 1);
      durs[i] = Math.max(0, Math.round(d));
    }
    const mediaDur = durs.reduce((a, b) => a + b, 0);
    const trackSec = mediaDur / t.timescale;
    const delay = startOf(t) - t0;
    const sp = span(t);
    void trackSec;
    const shown = Math.round(((sp.hi - sp.lo) / t.timescale) * MOVIE_TS);
    movieDur = Math.max(movieDur, Math.round(delay * MOVIE_TS) + shown);

    const stts = new W();
    const runs: [number, number][] = [];
    for (const d of durs) {
      const last = runs[runs.length - 1];
      if (last && last[1] === d) last[0]++;
      else runs.push([1, d]);
    }
    stts.u32(runs.length);
    for (const [c, d] of runs) stts.u32(c).u32(d);

    let anyCto = false;
    let negCto = false;
    for (let i = 0; i < n; i++) {
      if (t.cto.get(i) !== 0) anyCto = true;
      if (t.cto.get(i) < 0) negCto = true;
    }
    const ctts = new W();
    if (anyCto) {
      const cr: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const v = Math.round(t.cto.get(i));
        const last = cr[cr.length - 1];
        if (last && last[1] === v) last[0]++;
        else cr.push([1, v]);
      }
      ctts.u32(cr.length);
      for (const [c, v] of cr) ctts.u32(c).u32(v >>> 0);
    }

    const syncIdx: number[] = [];
    for (let i = 0; i < n; i++) if (t.sync.get(i)) syncIdx.push(i + 1);
    const stss = new W().u32(syncIdx.length);
    for (const k of syncIdx) stss.u32(k);

    const stsc = new W();
    const sc: [number, number][] = [];
    for (let i = 0; i < t.chunkCount.n; i++) {
      const c = t.chunkCount.get(i);
      const last = sc[sc.length - 1];
      if (!last || last[1] !== c) sc.push([i + 1, c]);
    }
    stsc.u32(sc.length);
    for (const [first, c] of sc) stsc.u32(first).u32(c).u32(1);

    const stsz = new W().u32(0).u32(n);
    for (let i = 0; i < n; i++) stsz.u32(t.size.get(i));
    const co64 = new W().u32(t.chunkOff.n);
    for (let i = 0; i < t.chunkOff.n; i++) co64.u64(t.chunkOff.get(i));

    const stbl = box(
      'stbl',
      box('stsd', full(0, 0).u32(1), t.entry as Uint8Array),
      box('stts', full(0, 0), stts),
      ...(anyCto ? [box('ctts', full(negCto ? 1 : 0, 0), ctts)] : []),
      ...(t.kind === 'video' && syncIdx.length < n ? [box('stss', full(0, 0), stss)] : []),
      box('stsc', full(0, 0), stsc),
      box('stsz', full(0, 0), stsz),
      box('co64', full(0, 0), co64),
    );
    const minf = box(
      'minf',
      t.kind === 'video' ? box('vmhd', full(0, 1).zeros(8)) : box('smhd', full(0, 0).zeros(4)),
      box('dinf', box('dref', full(0, 0).u32(1), box('url ', full(0, 1)))),
      stbl,
    );
    const mdia = box(
      'mdia',
      box('mdhd', full(1, 0).u64(0).u64(0).u32(t.timescale).u64(mediaDur).u16(0x55c4).u16(0)),
      box('hdlr', full(0, 0).u32(0).str(t.kind === 'video' ? 'vide' : 'soun').zeros(12).str(t.kind === 'video' ? 'Video' : 'Sound').u8(0)),
      minf,
    );
    // Правка времени: задержка старта дорожки (пустой отрезок) и сдвиг на смещение показа
    // первого кадра — иначе звук и картинка разъедутся на эти доли секунды.
    const elst = new W();
    const edits: [number, number][] = [];
    if (delay > 0.001) edits.push([Math.round(delay * MOVIE_TS), -1]);
    edits.push([shown, Math.round(sp.lo)]);
    elst.u32(edits.length);
    for (const [dur, mt] of edits) {
      elst.u64(dur);
      if (mt < 0) elst.u32(0xffffffff).u32(0xffffffff);
      else elst.u64(mt);
      elst.u16(1).u16(0);
    }
    const tkhd = full(1, 3)
      .u64(0)
      .u64(0)
      .u32(t.id)
      .u32(0)
      .u64(Math.round(delay * MOVIE_TS) + shown)
      .zeros(8)
      .u16(0)
      .u16(t.kind === 'audio' ? 1 : 0)
      .u16(t.kind === 'audio' ? 0x0100 : 0)
      .u16(0)
      .u32(0x00010000)
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(0x00010000)
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(0x40000000)
      .u32(t.kind === 'video' ? t.width * 65536 : 0)
      .u32(t.kind === 'video' ? t.height * 65536 : 0);
    traks.push(box('trak', box('tkhd', tkhd), box('edts', box('elst', full(1, 0), elst)), mdia));
  });

  const mvhd = full(1, 0)
    .u64(0)
    .u64(0)
    .u32(MOVIE_TS)
    .u64(movieDur)
    .u32(0x00010000)
    .u16(0x0100)
    .zeros(10)
    .u32(0x00010000)
    .u32(0)
    .u32(0)
    .u32(0)
    .u32(0x00010000)
    .u32(0)
    .u32(0)
    .u32(0)
    .u32(0x40000000)
    .zeros(24)
    .u32(usable.length + 1);
  await put(box('moov', box('mvhd', mvhd), ...traks));
  return { bytes: pos, seconds: movieDur / MOVIE_TS };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Кадры ADTS: данные без заголовка и настройка декодера; недорезанный хвост — отдельно. */
function adtsSplit(d: Uint8Array): {
  frames: { data: Uint8Array; config: { rate: number; channels: number; asc: Uint8Array } }[];
  rest: Uint8Array;
} {
  const out: { data: Uint8Array; config: { rate: number; channels: number; asc: Uint8Array } }[] = [];
  let o = 0;
  let rest: Uint8Array = new Uint8Array(0);
  while (o + 7 <= d.length) {
    if (d[o] !== 0xff || (d[o + 1] & 0xf6) !== 0xf0) {
      o++;
      continue;
    }
    const noCrc = d[o + 1] & 1;
    const profile = (d[o + 2] >> 6) & 3;
    const sfi = (d[o + 2] >> 2) & 15;
    const ch = ((d[o + 2] & 1) << 2) | (d[o + 3] >> 6);
    const len = ((d[o + 3] & 3) << 11) | (d[o + 4] << 3) | (d[o + 5] >> 5);
    const head = noCrc ? 7 : 9;
    if (len < head) {
      o++;
      continue;
    }
    if (o + len > d.length) {
      rest = d.slice(o);
      break;
    }
    const objType = profile + 1;
    const asc = Uint8Array.from([(objType << 3) | (sfi >> 1), ((sfi & 1) << 7) | (ch << 3)]);
    out.push({ data: d.subarray(o + head, o + len), config: { rate: AAC_RATES[sfi] ?? 44100, channels: ch || 2, asc } });
    o += len;
  }
  return { frames: out, rest };
}

/** Метка времени из ID3 в начале AAC-куска (com.apple.streaming.transportStreamTimestamp). */
function id3Timestamp(tag: Uint8Array): number {
  for (let i = 0; i + 10 < tag.length; ) {
    const id = String.fromCharCode(tag[i], tag[i + 1], tag[i + 2], tag[i + 3]);
    const size = (tag[i + 4] << 24) | (tag[i + 5] << 16) | (tag[i + 6] << 8) | tag[i + 7];
    if (id === 'PRIV') {
      const body = tag.subarray(i + 10, i + 10 + size);
      const owner = 'com.apple.streaming.transportStreamTimestamp';
      let match = true;
      for (let k = 0; k < owner.length; k++) if (body[k] !== owner.charCodeAt(k)) match = false;
      if (match) {
        const p = owner.length + 1;
        return (body[p + 3] & 1) * 2 ** 32 + ((body[p + 4] << 24) >>> 0) + (body[p + 5] << 16) + (body[p + 6] << 8) + body[p + 7];
      }
    }
    if (size <= 0) break;
    i += 10 + size;
  }
  return -1;
}
