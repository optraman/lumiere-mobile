import { File, FileMode } from 'expo-file-system';

/**
 * ЧТО ЛЕЖИТ В ФАЙЛЕ — для самой качалки (engine.ts), без всякого интерфейса: склеенный MP4
 * перечитывается с диска до того, как попасть к плееру, а при неудаче склейки в журнал пишется,
 * чем начинались куски.
 */

/** Что за содержимое — по первым байтам. */
export function kindOf(b: Uint8Array): string {
  if (b.length === 0) return 'пусто';
  if (b[0] === 0x47) return 'TS';
  const tag = String.fromCharCode(b[4] ?? 0, b[5] ?? 0, b[6] ?? 0, b[7] ?? 0);
  if (['ftyp', 'styp', 'moof', 'moov', 'sidx', 'free', 'mdat'].includes(tag)) return `MP4 (${tag})`;
  if (b[0] === 0xff && (b[1] & 0xf0) === 0xf0) return 'AAC';
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'ID3/AAC';
  const text = String.fromCharCode(...Array.from(b.subarray(0, 24))).trim();
  if (text.startsWith('#EXTM3U')) return 'плейлист вместо куска';
  if (text.startsWith('<') || text.startsWith('{')) return `страница вместо куска: «${text.slice(0, 20)}»`;
  return 'неизвестно';
}

/** Коробки верхнего уровня MP4 — читая только их заголовки, не весь файл. */
export function topBoxes(f: File): { list: string[]; ok: boolean; size: number } {
  const h = f.open(FileMode.ReadOnly);
  const size = f.size ?? 0;
  const list: string[] = [];
  let ok = true;
  try {
    let at = 0;
    for (let guard = 0; at + 8 <= size && guard < 50; guard++) {
      h.offset = at;
      const b = h.readBytes(16);
      if (b.length < 8) {
        ok = false;
        break;
      }
      let len = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
      const type = String.fromCharCode(b[4], b[5], b[6], b[7]);
      if (len === 1) len = (((b[8] << 24) >>> 0) + (b[9] << 16) + (b[10] << 8) + b[11]) * 2 ** 32 + (((b[12] << 24) >>> 0) + (b[13] << 16) + (b[14] << 8) + b[15]);
      else if (len === 0) len = size - at;
      list.push(`${type} ${len}`);
      if (len < 8) {
        ok = false;
        break;
      }
      at += len;
    }
    if (at !== size) ok = false;
  } finally {
    h.close();
  }
  return { list, ok, size };
}
