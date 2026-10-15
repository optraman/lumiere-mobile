import { json, UA } from './http';
import { KEYS } from './keys';
import { norm } from './util';

/**
 * НОМЕР КИНОПОИСКА.
 *
 * Половина источников ищет тайтл только по нему, а ТМДБ, откуда приходит весь каталог, такого номера
 * не знает. Его приходится добывать, и добывается он по лесенке — от самого надёжного к запасному:
 *
 *  1. ВИКИДАННЫЕ по номеру IMDB. Открытая база, у которой есть оба номера (свойства P345 и P2603),
 *     без ключей и без ограничений для такого объёма. Ошибиться здесь нечем: номер к номеру.
 *  2. ПОИСК HDVB по названию — если Викиданные молчат (свежий релиз, редкий сериал). Тут уже
 *     сверяется название и год, потому что поиск по строке умеет промахиваться.
 *
 * Ответ запоминается на весь сеанс — номер у тайтла не меняется.
 */

const cache = new Map<string, number | null>();

async function fromWikidata(imdb: string, signal?: AbortSignal): Promise<number | null> {
  const q = `SELECT ?kp WHERE { ?f wdt:P345 "${imdb}" ; wdt:P2603 ?kp . } LIMIT 1`;
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`;
  // Викиданные просят представляться: без своего агента запрос могут отклонить.
  const r = await json<{ results?: { bindings?: { kp?: { value?: string } }[] } }>(url, {
    headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'Lumiere/1.0 (personal media app)' },
    signal,
    timeoutMs: 8_000,
  });
  const v = r?.results?.bindings?.[0]?.kp?.value;
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fromHdvbSearch(
  title: string,
  year: number | null,
  signal?: AbortSignal,
): Promise<number | null> {
  const url = `https://apivb.com/api/videos.json?token=${KEYS.hdvbToken}&title=${encodeURIComponent(title)}`;
  const list = await json<{ kinopoisk_id?: number | string; title_ru?: string; title_en?: string; year?: number | string }[]>(
    url,
    { headers: { 'User-Agent': UA }, signal, timeoutMs: 8_000 },
  );
  if (!Array.isArray(list)) return null;
  const want = norm(title);
  for (const it of list) {
    const same = norm(it.title_ru) === want || norm(it.title_en) === want;
    const y = Number(it.year);
    const yearOk = !year || !Number.isFinite(y) || Math.abs(y - year) <= 1;
    const kp = Number(it.kinopoisk_id);
    if (same && yearOk && kp > 0) return kp;
  }
  return null;
}

/**
 * ПОСТОЯННАЯ ПАМЯТЬ НОМЕРОВ.
 *
 * Номер Кинопоиска у тайтла не меняется никогда, а добывается он дольше всего остального при
 * открытии (Викиданные отвечают за секунду-две). Поэтому найденный номер кладётся на диск и при
 * следующем открытии берётся мгновенно. Хранилище подключает приложение (playback.ts) — здесь его
 * нет, чтобы модуль оставался запускаемым в Node для зонда и проверок.
 */
export type KpStore = { get(key: string): Promise<number | null>; set(key: string, kp: number): Promise<void> };
let store: KpStore | null = null;
export function setKpStore(s: KpStore): void {
  store = s;
}

/** Первый непустой ответ из нескольких — не дожидаясь медленных. */
function firstFound(list: Promise<number | null>[]): Promise<number | null> {
  return new Promise((resolve) => {
    let left = list.length;
    if (left === 0) resolve(null);
    for (const p of list) {
      p.then(
        (v) => {
          if (v) resolve(v);
          else if (--left === 0) resolve(null);
        },
        () => {
          if (--left === 0) resolve(null);
        },
      );
    }
  });
}

export async function kinopoiskId(
  ids: { imdb: string | null; title: string; originalTitle: string | null; year: number | null },
  signal?: AbortSignal,
): Promise<number | null> {
  const key = ids.imdb ?? `${norm(ids.title)}:${ids.year ?? ''}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const saved = store ? await store.get(key).catch(() => null) : null;
  if (saved) {
    cache.set(key, saved);
    return saved;
  }

  /*
    ВСЕ СПОСОБЫ — РАЗОМ, А НЕ ПО ОЧЕРЕДИ.

    Раньше поиск по названию начинался, только когда Викиданные ответили «не знаю», — и при их
    медленном ответе это складывалось в лишние секунды. Теперь все пути спрашиваются одновременно,
    и берётся первый найденный номер.
  */
  const tries: Promise<number | null>[] = [];
  if (ids.imdb) tries.push(fromWikidata(ids.imdb, signal));
  tries.push(fromHdvbSearch(ids.title, ids.year, signal));
  if (ids.originalTitle && ids.originalTitle !== ids.title) tries.push(fromHdvbSearch(ids.originalTitle, ids.year, signal));
  const kp = await firstFound(tries);

  // Неудачу не запоминаем: это мог быть обрыв связи, а не отсутствие номера.
  if (kp) {
    cache.set(key, kp);
    void store?.set(key, kp).catch(() => undefined);
  }
  return kp;
}
