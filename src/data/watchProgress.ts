import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

/**
 * Журнал просмотра: где человек остановился. Портировано из data/watch/WatchProgressStore.kt.
 *
 * Хранится одним объектом в AsyncStorage и держится в памяти: позиция сохраняется раз в несколько
 * секунд прямо во время воспроизведения, и ходить на диск за каждым чтением незачем.
 */

export type WatchEntry = {
  key: string;
  positionMs: number;
  durationMs: number;
  updatedAt: number;
  title: string;
  /** «Сезон 1 · Серия 5» — для сериалов. */
  episodeLabel?: string;
  posterUrl?: string | null;
  /** Кадр тайтла — для карточек «Продолжить просмотр». */
  backdropUrl?: string | null;
  mediaId?: number;
  mediaType?: 'movie' | 'tv';
  /** Номер сезона и серии, чтобы «продолжить» открывало ровно её. Озвучка здесь больше не нужна:
   * она живёт дорожкой внутри файла, и плеер подхватывает ту же сам. */
  season?: string;
  episode?: string;
};

const KEY = 'lumiere_watch_v1';

/**
 * Доля, начиная с которой тайтл считается досмотренным.
 *
 * Досмотренное значит «начать заново», а не «начать с титров»: возобновление на 98% открывало бы
 * фильм на финальных титрах. Та же граница у Влада.
 */
const DONE_FRACTION = 0.92;
/** Ближе этого к началу возобновлять нечего — проще начать сначала. */
const MIN_RESUME_MS = 30_000;

let cache: Record<string, WatchEntry> = {};
let loaded = false;
/** Убранные из «Продолжить просмотр» тайтлы: когда убрали. Новый просмотр возвращает тайтл. */
let hidden: Record<string, number> = {};
const HIDDEN_KEY = 'lumiere_watch_hidden_v1';

/*
  ПОДПИСКА НА ЖУРНАЛ — чтобы «Продолжить просмотр» на главной и в списках обновлялись сами, когда
  выходишь из плеера. Сообщается не на каждое сохранение позиции (оно идёт раз в несколько секунд),
  а с той же задержкой, что и запись на диск.
*/
const listeners = new Set<() => void>();
let version = 0;
function emit() {
  version += 1;
  listeners.forEach((cb) => cb());
}
export function subscribeWatch(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
/** Номер версии журнала — меняется при каждом изменении (для useSyncExternalStore). */
export function useWatchVersion(): number {
  return useSyncExternalStore(subscribeWatch, () => version);
}

export function titleKey(type: 'movie' | 'tv', id: number): string {
  return `${type}:${id}`;
}

export function episodeKey(type: 'movie' | 'tv', id: number, season?: string, episode?: string): string {
  return `${type}:${id}:s${season ?? ''}e${episode ?? ''}`;
}

export async function loadWatchProgress(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) cache = JSON.parse(raw) as Record<string, WatchEntry>;
    const h = await AsyncStorage.getItem(HIDDEN_KEY);
    if (h) hidden = JSON.parse(h) as Record<string, number>;
  } catch {
    /* не прочиталось — журнал пуст, это допустимое состояние */
  }
  loaded = true;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Когда сработает отложенная запись — чтобы более срочная могла её подвинуть ближе. */
let flushAt = 0;
/** Будить ли экраны, когда отложенная запись сработает. */
let flushNotify = false;

function writeNow(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  AsyncStorage.setItem(KEY, JSON.stringify(cache)).catch(() => undefined);
}

function flushIn(ms: number, notify: boolean): void {
  flushNotify = flushNotify || notify;
  const at = Date.now() + ms;
  if (flushTimer && flushAt <= at) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushAt = at;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    AsyncStorage.setItem(KEY, JSON.stringify(cache)).catch(() => undefined);
    if (flushNotify) {
      flushNotify = false;
      emit();
    }
  }, ms);
}

function flushSoon() {
  // Запись на диск ОТЛОЖЕНА: позиция обновляется во время воспроизведения, и писать файл на каждое
  // обновление значит дёргать диск посреди фильма. Раз в пять секунд более чем достаточно.
  flushIn(5000, true);
}

/*
  ВО ВРЕМЯ КИНО — ДИСК РАЗ В ПОЛМИНУТЫ, ЭКРАНЫ — ТОЛЬКО КОГДА РЯД ПОМЕНЯЛСЯ.

  Плеер сохраняет позицию каждые пять секунд. Раньше каждое сохранение через пять секунд
  превращало в строку ВЕСЬ журнал (сотни записей) и будило главную и библиотеку под плеером — они
  пересобирали «Продолжить просмотр» ради процента, которого за плеером не видно. Теперь позиция
  обновляется в памяти сразу (её читают «продолжить» и соседние экраны), на диск уходит не чаще
  раза в полминуты, а также на паузе, при уходе приложения в фон и при закрытии плеера
  (flushWatchProgress). Экраны будятся сразу только если поменялся сам ряд — тайтл в нём появился,
  ушёл или сменил место; остальное они получат одним обновлением, когда плеер закроется.
*/
const PLAYING_FLUSH_MS = 30_000;

/** Состав и порядок рядов, которые рисуют экраны: если он не изменился — будить их незачем. */
function rowsSignature(): string {
  const recent = titlesByRecent()
    .map((t) => `${t.type}:${t.id}|${t.last.key}|${t.finished ? 1 : 0}`)
    .join(',');
  const cont = continueTitles()
    .map((t) => titleKey(t.type, t.id))
    .join(',');
  return `${recent}#${cont}`;
}

export function saveProgress(entry: Omit<WatchEntry, 'updatedAt'>): void {
  if (entry.durationMs <= 0 || entry.positionMs <= 0) return;
  const before = rowsSignature();
  cache[entry.key] = { ...entry, updatedAt: Date.now() };
  if (rowsSignature() !== before) flushIn(5000, true);
  else flushIn(PLAYING_FLUSH_MS, false);
}

/**
 * ЗАПИСАТЬ СЕЙЧАС. Пауза и уход в фон — только диск; закрытие плеера (`notify`) — ещё и экраны:
 * «Продолжить просмотр» должен показать новое место сразу, как только плеер ушёл.
 */
export function flushWatchProgress(notify = false): void {
  const pendingNotify = flushNotify;
  flushNotify = false;
  // Отложенной записи нет — значит, и писать нечего: всё уже на диске.
  if (flushTimer) writeNow();
  if (notify || pendingNotify) emit();
}

// Приложение ушло в фон — пишем сразу: система может выгрузить его, не дождавшись полуминуты.
AppState.addEventListener('change', (st) => {
  if (st === 'background' && flushTimer) flushWatchProgress();
});

/** Позиция, с которой продолжать. Ноль — начать сначала. */
export function resumePositionFor(key: string): number {
  const e = cache[key];
  if (!e || e.durationMs <= 0) return 0;
  if (e.positionMs / e.durationMs >= DONE_FRACTION) return 0;
  return e.positionMs >= MIN_RESUME_MS ? e.positionMs : 0;
}

export function watchEntry(key: string): WatchEntry | null {
  return cache[key] ?? null;
}

/** Всё начатое и не досмотренное, свежее сверху — будущий ряд «Продолжить просмотр». */
export function continueWatching(): WatchEntry[] {
  return Object.values(cache)
    .filter((e) => e.durationMs > 0 && e.positionMs / e.durationMs < DONE_FRACTION)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * САМАЯ ДАЛЬНЯЯ СЕРИЯ ЭТОГО СЕРИАЛА — та, с которой открывается список.
 *
 * Правило Влада (глава 10 схемы): список серий открывается НЕ на первой, а на самой большой по
 * номеру (S×E) записи просмотра. Именно по номеру, а не по времени: пересмотр ранней серии не
 * должен утаскивать страницу назад к ней.
 *
 * Номера берём из полей записи, а если их нет (старые записи журнала) — из самого ключа, он
 * собран как `tv:1399:s2e5`.
 */
export function furthestEpisode(
  type: 'movie' | 'tv',
  id: number,
): { season: number; episode: number } | null {
  const prefix = `${type}:${id}:s`;
  let best: { season: number; episode: number } | null = null;
  for (const [key, e] of Object.entries(cache)) {
    if (!key.startsWith(prefix)) continue;
    const parsed = /:s(\d+)e(\d+)$/.exec(key);
    const season = Number(e.season ?? parsed?.[1]);
    const episode = Number(e.episode ?? parsed?.[2]);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
    if (!best || season * 1000 + episode > best.season * 1000 + best.episode) {
      best = { season, episode };
    }
  }
  return best;
}

/** Последняя запись по тайтлу — «где он остановился» во всём сериале или фильме. */
export type TitleProgress = {
  type: 'movie' | 'tv';
  id: number;
  last: WatchEntry;
  /** Досмотрел ли последнюю открытую серию (или фильм) до конца. */
  finished: boolean;
};

function titleOf(e: WatchEntry): { type: 'movie' | 'tv'; id: number } | null {
  if (e.mediaType && e.mediaId) return { type: e.mediaType, id: e.mediaId };
  const m = /^(movie|tv):(\d+)/.exec(e.key);
  return m ? { type: m[1] as 'movie' | 'tv', id: Number(m[2]) } : null;
}

/** Все тайтлы журнала, свежие сверху, — по одной записи (последней) на тайтл. */
export function titlesByRecent(): TitleProgress[] {
  const best = new Map<string, TitleProgress>();
  for (const e of Object.values(cache)) {
    const t = titleOf(e);
    if (!t) continue;
    const k = titleKey(t.type, t.id);
    const prev = best.get(k);
    if (!prev || e.updatedAt >= prev.last.updatedAt) {
      best.set(k, { ...t, last: e, finished: e.durationMs > 0 && e.positionMs / e.durationMs >= DONE_FRACTION });
    }
  }
  return [...best.values()].sort((a, b) => b.last.updatedAt - a.last.updatedAt);
}

/*
  «ПРОДОЛЖИТЬ ПРОСМОТР» — как у планшетного Люмьера и у Влада:
    — фильм — пока не досмотрен (до 92%) и смотрели хотя бы полминуты;
    — сериал — всегда, пока его не убрали: досмотренная серия значит «дальше — следующая»
      (какая именно — решается при нажатии, по списку серий источника);
    — убранный вручную возвращается, только если его снова начали смотреть.
*/
export function continueTitles(): TitleProgress[] {
  const list = titlesByRecent().filter((t) => {
    const k = titleKey(t.type, t.id);
    if (hidden[k] && t.last.updatedAt <= hidden[k]) return false;
    if (t.type === 'movie') return !t.finished && t.last.positionMs >= MIN_RESUME_MS;
    return t.finished || t.last.positionMs >= MIN_RESUME_MS;
  });
  /*
    СВОЙ ПОРЯДОК (как у Влада, cw_order): если ряд переставляли руками, он стоит в этом порядке;
    то, что смотрели ПОСЛЕ перестановки, встаёт первым — свежее важнее старого порядка.
  */
  if (!order.keys.length) return list;
  const pos = new Map(order.keys.map((k, i) => [k, i]));
  const fresh = list.filter((t) => t.last.updatedAt > order.at || !pos.has(titleKey(t.type, t.id)));
  const kept = list
    .filter((t) => !fresh.includes(t))
    .sort((a, b) => (pos.get(titleKey(a.type, a.id)) ?? 0) - (pos.get(titleKey(b.type, b.id)) ?? 0));
  return [...fresh, ...kept];
}

const ORDER_KEY = 'lumiere_cw_order_v1';
let order: { keys: string[]; at: number } = { keys: [], at: 0 };
AsyncStorage.getItem(ORDER_KEY)
  .then((raw) => {
    if (raw) {
      order = JSON.parse(raw);
      emit();
    }
  })
  .catch(() => undefined);

/** Порядок «Продолжить просмотр», выставленный руками (перетаскиванием). */
export function setContinueOrder(keys: string[]): void {
  order = { keys, at: Date.now() };
  AsyncStorage.setItem(ORDER_KEY, JSON.stringify(order)).catch(() => undefined);
  emit();
}

/** «Убрать из Продолжить просмотр» — места остановки в сериях при этом не забываются. */
export function hideFromContinue(type: 'movie' | 'tv', id: number): void {
  hidden[titleKey(type, id)] = Date.now();
  AsyncStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden)).catch(() => undefined);
  emit();
}

/**
 * УБРАТЬ ТАЙТЛ ИЗ ИСТОРИИ — все его записи разом (у сериала это каждая серия), а с ними и отметку
 * «убран из Продолжить просмотр»: тайтла в журнале больше нет, помнить её незачем.
 *
 * Пишем на диск и будим экраны сразу, а не через отложенную запись: строка уже уехала из списка
 * анимацией, и через пять секунд она не должна появиться обратно на главной.
 */
export function forgetTitleProgress(type: 'movie' | 'tv', id: number): void {
  for (const [key, e] of Object.entries(cache)) {
    const t = titleOf(e);
    if (t && t.type === type && t.id === id) delete cache[key];
  }
  const k = titleKey(type, id);
  if (hidden[k]) {
    delete hidden[k];
    AsyncStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden)).catch(() => undefined);
  }
  writeNow();
  emit();
}

export function forgetProgress(key: string): void {
  delete cache[key];
  flushSoon();
}

/**
 * СТЕРЕТЬ ВЕСЬ ЖУРНАЛ ПРОСМОТРА.
 *
 * И память, и диск — сразу, без отложенной записи: отложенная запись могла бы через пять секунд
 * вернуть на диск то, что только что стёрли, если в этот момент что-то ещё играло.
 */
export async function clearWatchProgress(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushNotify = false;
  cache = {};
  hidden = {};
  await AsyncStorage.removeItem(KEY).catch(() => undefined);
  await AsyncStorage.removeItem(HIDDEN_KEY).catch(() => undefined);
  emit();
}
