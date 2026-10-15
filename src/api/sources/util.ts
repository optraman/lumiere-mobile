/**
 * МЕЛКИЕ ОБЩИЕ ДЕЛА: сравнение названий и base64.
 */

/**
 * НАЗВАНИЕ ДЛЯ СРАВНЕНИЯ — замена SearchNameTo.Convert у Lampac.
 *
 * Его исходника в открытом коде нет, поэтому правило собрано по тому, как им пользуются: строчные
 * буквы, «ё» как «е», всё, кроме букв и цифр, выброшено. «Теория большого взрыва» и «теория
 * большого взрыва!» — одно и то же название, а не два разных.
 */
export function norm(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^0-9a-zа-я]/gi, '');
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 → байты. Пробелы, переносы и «=» в конце прощаются; незнакомые символы — нет. */
export function b64bytes(s: string): Uint8Array | null {
  const clean = s.replace(/[\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Байты → строка UTF-8. Своё, потому что TextDecoder есть не во всех движках. */
export function utf8(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xe0) s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b < 0xf0) {
      s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    } else {
      const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      const c = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    }
  }
  return s;
}

export function b64text(s: string): string | null {
  const b = b64bytes(s);
  return b ? utf8(b) : null;
}

/** Строка → base64 (только для ASCII — номеров и путей). */
export function b64ascii(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i);
    const b = s.charCodeAt(i + 1);
    const c = s.charCodeAt(i + 2);
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < s.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < s.length ? B64[n & 63] : '=';
  }
  return out;
}

/** Первое число в строке: «3 сезон» → 3, «Серия 12» → 12. */
export function num(s: string | null | undefined): number | null {
  const m = /(\d+)/.exec(s ?? '');
  return m ? Number(m[1]) : null;
}

/** Вырезать сбалансированный объект {…}, начиная с первой «{» после позиции. */
export function balanced(s: string, from = 0): string | null {
  const start = s.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}
