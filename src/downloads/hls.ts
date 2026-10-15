/**
 * РАЗБОР HLS ДЛЯ ЗАГРУЗКИ — без сети и без файлов, чтобы проверялось в Node (tools/download-check.js).
 *
 * Как у планшетного Люмьера (lumiere.tab.Dl.hls): из главного плейлиста берётся качество не выше
 * 1080p с наибольшей полосой, из него — список кусков. Разница одна, и она из-за iPhone: планшет
 * склеивает куски в один .ts, а системный плеер iPhone .ts-файл не играет. Поэтому здесь куски
 * сохраняются по отдельности (с плейлистом на диске — по нему видно, что уже скачано), а в конце
 * перекладываются в один MP4 (remux.ts). Рассчитывать на плейлист с диска нельзя: HLS из файлов
 * системный плеер iPhone не открывает — так скачанное и «не прогружалось».
 *
 * Поддержано то, что встречается у раздач: отдельная звуковая дорожка (EXT-X-MEDIA с URI),
 * fMP4 с инициализирующим куском (EXT-X-MAP), куски по диапазонам байт (EXT-X-BYTERANGE).
 * Зашифрованные потоки (EXT-X-KEY) не качаются — как и у планшета.
 */

export type Range = { offset: number; length: number };

export type Piece = {
  /** Полный адрес куска. */
  url: string;
  range?: Range;
  /** Имя файла на диске, относительно папки дорожки. */
  name: string;
};

export type Track = {
  /** Плейлист дорожки, переписанный на локальные имена — пишется на диск как index.m3u8. */
  playlist: string;
  /** Что скачать: инициализирующий кусок (если есть) и все куски по порядку. */
  pieces: Piece[];
  /** Сумма длительностей, секунды. */
  seconds: number;
};

export type Variant = { url: string; bandwidth: number; height: number; audioGroup: string | null; line: string };
export type AudioRendition = { url: string; name: string; line: string };

/** Ссылка относительно плейлиста → полная. Своё, без URL с базой (в React Native он ненадёжен). */
export function resolveUrl(ref: string, base: string): string {
  if (/^https?:\/\//i.test(ref)) return ref;
  const m = /^(https?:)\/\/([^/?#]+)([^?#]*)/i.exec(base);
  if (!m) return ref;
  const [, scheme, host, path] = m;
  if (ref.startsWith('//')) return `${scheme}${ref}`;
  if (ref.startsWith('/')) return `${scheme}//${host}${ref}`;
  return `${scheme}//${host}${path.slice(0, path.lastIndexOf('/') + 1)}${ref}`;
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function attr(line: string, name: string): string | null {
  const m = new RegExp(`(?:^|[:,])${name}=("([^"]*)"|[^,]*)`).exec(line);
  return m ? (m[2] ?? m[1]) : null;
}

export function isMaster(text: string): boolean {
  return /#EXT-X-STREAM-INF/i.test(text);
}

/** Варианты качества главного плейлиста. */
export function variantsOf(master: string, base: string): Variant[] {
  const ls = lines(master);
  const out: Variant[] = [];
  for (let i = 0; i < ls.length; i++) {
    if (!/^#EXT-X-STREAM-INF/i.test(ls[i])) continue;
    const uri = ls.slice(i + 1).find((l) => !l.startsWith('#'));
    if (!uri) continue;
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(ls[i]);
    out.push({
      url: resolveUrl(uri, base),
      bandwidth: Number(attr(ls[i], 'BANDWIDTH') ?? 0) || 0,
      height: res ? Math.min(Number(res[1]), Number(res[2])) : 0,
      audioGroup: attr(ls[i], 'AUDIO'),
      line: ls[i],
    });
  }
  return out;
}

/**
 * КАЧЕСТВО ДЛЯ ЗАГРУЗКИ: не выше 1080p, среди таких — с наибольшей полосой (как у планшета).
 * Если все выше 1080p — самый лёгкий из них; если разрешение не подписано — по полосе.
 */
export function pickVariant(list: Variant[], maxHeight = 1080): Variant | null {
  if (list.length === 0) return null;
  const fit = list.filter((v) => !v.height || v.height <= maxHeight);
  const pool = fit.length ? fit : [...list].sort((a, b) => a.bandwidth - b.bandwidth).slice(0, 1);
  return [...pool].sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth)[0];
}

/**
 * Отдельная звуковая дорожка варианта: нужная по номеру (голос выбран — Collaps), иначе помеченная
 * DEFAULT, иначе первая.
 */
export function audioFor(master: string, base: string, group: string | null, index?: number): AudioRendition | null {
  if (!group) return null;
  const found = lines(master)
    .filter((l) => /^#EXT-X-MEDIA/i.test(l) && /TYPE=AUDIO/i.test(l) && attr(l, 'GROUP-ID') === group && attr(l, 'URI'))
    .map((l) => ({ url: resolveUrl(attr(l, 'URI') as string, base), name: attr(l, 'NAME') ?? 'audio', line: l }));
  if (index != null && index >= 0 && found[index]) return found[index];
  return found.find((a) => /DEFAULT=YES/i.test(a.line)) ?? found[0] ?? null;
}

export class EncryptedError extends Error {
  constructor() {
    super('Этот поток зашифрован — скачать его нельзя');
  }
}

function extOf(url: string, fallback: string): string {
  const m = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(url.replace(/[?#].*$/, ''));
  return m ? `.${m[1].toLowerCase()}` : fallback;
}

/**
 * Плейлист дорожки → что качать и каким он станет на диске.
 *
 * Каждый кусок получает своё имя (00001.ts …), диапазоны байт превращаются в отдельные файлы, а
 * строки BYTERANGE из плейлиста убираются — на диске каждый кусок уже целый файл.
 */
export function trackOf(media: string, base: string): Track {
  const ls = lines(media);
  if (ls.some((l) => /^#EXT-X-KEY/i.test(l) && !/METHOD=NONE/i.test(l))) throw new EncryptedError();
  const pieces: Piece[] = [];
  const out: string[] = [];
  let pendingRange: Range | undefined;
  let nextOffset = 0;
  let seconds = 0;
  let n = 0;
  for (const l of ls) {
    if (/^#EXT-X-MAP/i.test(l)) {
      const uri = attr(l, 'URI');
      if (!uri) continue;
      const br = attr(l, 'BYTERANGE');
      let range: Range | undefined;
      if (br) {
        const [len, off] = br.split('@');
        range = { length: Number(len), offset: off ? Number(off) : 0 };
      }
      const url = resolveUrl(uri, base);
      const name = `init${extOf(url, '.mp4')}`;
      pieces.push({ url, range, name });
      out.push(`#EXT-X-MAP:URI="${name}"`);
      continue;
    }
    if (/^#EXT-X-BYTERANGE:/i.test(l)) {
      const [len, off] = l.slice(l.indexOf(':') + 1).trim().split('@');
      const offset = off !== undefined ? Number(off) : nextOffset;
      pendingRange = { length: Number(len), offset };
      nextOffset = offset + Number(len);
      continue;
    }
    if (/^#EXTINF:/i.test(l)) {
      seconds += parseFloat(l.slice(8)) || 0;
      out.push(l);
      continue;
    }
    if (/^#EXT-X-ENDLIST/i.test(l)) continue;
    if (l.startsWith('#')) {
      // Служебные строки переносим как есть, кроме тех, что описывают сеть (ключи «NONE» безвредны).
      if (/^#EXT-X-(PLAYLIST-TYPE|ENDLIST|I-FRAMES-ONLY)/i.test(l)) continue;
      out.push(l);
      continue;
    }
    n += 1;
    const url = resolveUrl(l, base);
    const name = `${String(n).padStart(5, '0')}${extOf(url, '.ts')}`;
    pieces.push({ url, range: pendingRange, name });
    pendingRange = undefined;
    out.push(name);
  }
  if (!pieces.some((p) => !p.name.startsWith('init'))) throw new Error('Пустой плейлист');
  // Плейлист на диске — законченный фильм: тип VOD и конец списка, иначе плеер ждёт продолжения.
  const head = out[0] === '#EXTM3U' ? out.slice(1) : out;
  const playlist = ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD', ...head, '#EXT-X-ENDLIST', ''].join('\n');
  return { playlist, pieces, seconds };
}

/** Главный плейлист на диске — когда звук лежит отдельной дорожкой. */
export function localMaster(variant: Variant, audio: AudioRendition): string {
  const media = audio.line.replace(/URI="[^"]*"/i, 'URI="a/index.m3u8"');
  return ['#EXTM3U', media, variant.line, 'v/index.m3u8', ''].join('\n');
}
