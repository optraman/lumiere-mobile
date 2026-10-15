/**
 * СВЯЗЬ С COLLAPS.
 *
 * Весь транспорт — тридцать строк, и это не экономия, а точный размер задачи. У резки здесь жили
 * зеркала, Anubis, сессия, куки и повторные входы; у Collaps нет ничего из этого: один адрес, два
 * заголовка, один GET. Если когда-нибудь появится что-то ещё — оно появится ЗДЕСЬ, а не расползётся
 * по экранам.
 *
 * Адреса и Origin взяты из ModInit.updateConf() у Lampac. Они у них меняются время от времени,
 * поэтому вынесены константами в одно место: поменять — поменять тут.
 */

/*
  АДРЕСА ВЗЯТЫ ИЗ ONLINE_MOD (nb557, сборка 20.09.2026), А НЕ ИЗ LAMPAC.

  У Lampac стояли api.luxembd.ws и Origin kinokrad.my — и Collaps перестал отвечать. В свежем
  online_mod адрес другой, у него есть запасной, а Origin и Referer указывают на сам плеер. Это и
  было причиной «Collaps не работает»: старый адрес, чужой Origin.
*/

import { failOf, hintOf, note, where } from '../sources/http';

/** Страница плеера и запасная — на случай, если первая не ответит (не путать с «нет такого фильма»). */
export const EMBEDS = ['https://api.ortified.ws', 'https://api.kinogram.best'];
const EMBED = EMBEDS[0];

/** Collaps проверяет, откуда пришёл запрос: и странице, и файлу нужен его собственный адрес. */
const ORIGIN = EMBED;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const TIMEOUT_MS = 15_000;

/** Заголовки переписки — ModInit.headers у Lampac. */
export function headers(): Record<string, string> {
  return { 'User-Agent': UA, Origin: ORIGIN, Referer: `${ORIGIN}/` };
}

/**
 * ЗАГОЛОВКИ САМОГО ФАЙЛА — ModInit.headers_stream.
 *
 * Их на три больше, и это не украшение: раздача отвечает на запрос как на межсайтовый, и без
 * sec-fetch-* отдаёт отказ. Ровно эти заголовки уедут в плеер вместе со ссылкой.
 */
export function streamHeaders(): Record<string, string> {
  // У online_mod файлу уходят ровно те же три заголовка, что и странице.
  return { 'User-Agent': UA, Origin: ORIGIN, Referer: `${ORIGIN}/` };
}

/**
 * МЕТКА «&vp» НА ССЫЛКЕ ВИДЕО.
 *
 * online_mod дописывает её к каждой ссылке на поток (не к субтитрам). Без неё раздача отдаёт
 * поток хуже или не отдаёт вовсе — зачем она, в коде не сказано, но делается всегда, и мы делаем.
 */
export function withVp(url: string): string {
  return url.includes('?') ? `${url}&vp` : `${url}?vp`;
}

/** Адрес страницы плеера по внешнему идентификатору. */
export function embedUrl(ref: { imdb: string } | { kp: number } | { orid: number }, host = EMBED): string {
  if ('imdb' in ref) return `${host}/embed/imdb/${ref.imdb}`;
  if ('kp' in ref) return `${host}/embed/kp/${ref.kp}`;
  return `${host}/embed/movie/${ref.orid}`;
}

/**
 * Один GET со сроком.
 *   строка    — страница;
 *   'missing' — сервер ответил, что такого видео нет (404 с пустым телом или «видео недоступно»):
 *               к запасному адресу идти незачем, там его тоже нет;
 *   null      — не ответил: стоит спросить запасной адрес.
 */
export async function askEmbed(url: string, signal?: AbortSignal): Promise<string | 'missing' | null> {
  const ctrl = new AbortController();
  const started = Date.now();
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    ctrl.abort();
  }, TIMEOUT_MS);
  const onOuter = () => ctrl.abort();
  signal?.addEventListener('abort', onOuter);
  try {
    const res = await fetch(url, { headers: headers(), signal: ctrl.signal });
    const text = await res.text();
    // Журнал каскада (src/api/sources/http.ts): куда ходили и что ответили.
    note(signal, { at: where(url), status: res.status, ms: Date.now() - started, hint: hintOf(text) ?? '(пустой ответ)' });
    if (res.status === 404 && (!text || /видео недоступно/i.test(text))) return 'missing';
    if (!res.ok) return null;
    return text.length > 0 ? text : null;
  } catch (e) {
    note(signal, {
      at: where(url),
      status: signal?.aborted ? 'отменён' : late ? 'срок' : 'нет связи',
      ms: Date.now() - started,
      hint: late || signal?.aborted ? undefined : failOf(e),
    });
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuter);
  }
}

/** Один GET со сроком. Текст страницы или null, если не ответили. */
export async function ask(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: headers(), signal: ctrl.signal });
    if (!res.ok) return null;
    const text = await res.text();
    // Пустой ответ — это не страница; пусть вызывающий считает это отказом, а не «фильма нет».
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
