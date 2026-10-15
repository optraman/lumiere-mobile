import type { MediaItem } from '../../types/media';
import type { PlaybackRequest, SubtitleTrack } from '../../player/request';
import { episodeKey, resumePositionFor, titleKey } from '../../data/watchProgress';
import { imdbId } from '../tmdb';
import { say } from '../../data/journal';
import { checkTitle, type Target as CheckTarget } from './check';
import { setVoiceFor, voiceForAsync } from '../../data/voicePrefs';
import { localRequest } from '../../downloads/offline';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SOURCES, search, type Hit, type Search } from './index';
import { setKpStore } from './ids';
import type { Ids, Variant } from './types';

const SOURCES_ORDER = SOURCES.map((x) => x.id);

// Номера Кинопоиска — на диск: при повторном открытии тайтла они нужны мгновенно (ids.ts).
const KP_KEY = 'lumiere_kp_v1:';
setKpStore({
  get: async (key) => {
    const v = await AsyncStorage.getItem(KP_KEY + key);
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  },
  set: (key, kp) => AsyncStorage.setItem(KP_KEY + key, String(kp)),
});

/**
 * ОТ ТАЙТЛА К ЗАПРОСУ ПЛЕЕРА — ЧЕРЕЗ КАСКАД ИСТОЧНИКОВ.
 *
 * Здесь собрано всё, что делает «много запасных вариантов» не словами, а поведением:
 *
 *  — ПОИСК ОДИН НА ТАЙТЛ. Открыли сериал — каскад опрашивает все источники один раз, и дальше
 *    каждая серия, каждое переключение озвучки и каждый запасной вариант берутся из уже
 *    полученных ответов. Сеть трогается только там, где у источника ссылка выдаётся по запросу.
 *
 *  — ПЕРЕБОР ДО ПЕРВОЙ ЖИВОЙ ССЫЛКИ. Источник ответил, но ссылку не дал — следующая озвучка того
 *    же источника; кончились — следующий источник. Человек видит одно: фильм включился.
 *
 *  — ЗАПАС НА ВРЕМЯ ПРОСМОТРА. Перебор не выбрасывается после первой удачи. Если плеер не смог
 *    поднять поток, он просит «дальше» — и получает следующий вариант с того места, где перебор
 *    остановился, а не начинает поиск сначала.
 */

type Session = { ids: Ids; search: Search; ctrl: AbortController; at: number };

const SESSION_TTL_MS = 30 * 60_000;
const sessions = new Map<string, Session>();

async function idsOf(item: MediaItem): Promise<Ids> {
  const imdb = await imdbId(item.type, item.id).catch(() => null);
  const year = Number(item.year);
  return {
    title: item.title,
    originalTitle: item.originalTitle || null,
    year: Number.isFinite(year) && year > 0 ? year : null,
    imdb,
    kp: null,
    tmdb: item.id,
    kind: item.type === 'movie' ? 'movie' : 'serial',
  };
}

/*
  ПОИСК, КОТОРЫЙ ЕЩЁ СОБИРАЕТСЯ, — ТОЖЕ ОДИН НА ТАЙТЛ. Пока ждём номер IMDB (idsOf), сессии в
  `sessions` ещё нет, и два одновременных вызова (страница тайтла и плеер, серия и запасной
  вариант) запускали каждый свой полный каскад по всем источникам. Обещание кладётся сюда
  синхронно, и второй вызов ждёт тот же поиск.
*/
const starting = new Map<string, Promise<Session>>();

function sessionFor(item: MediaItem): Promise<Session> {
  const key = titleKey(item.type, item.id);
  const kept = sessions.get(key);
  if (kept && Date.now() - kept.at < SESSION_TTL_MS) return Promise.resolve(kept);
  const pending = starting.get(key);
  if (pending) return pending;

  // Объявлено заранее: сборка сверяется, что в `starting` всё ещё лежит именно она.
  let p: Promise<Session> | null = null;
  p = (async () => {
    const ids = await idsOf(item);
    const ctrl = new AbortController();
    const s: Session = { ids, search: search(ids, ctrl.signal), ctrl, at: Date.now() };
    // Тайтл забыли, пока искали номер (forgetTitle / forgetAllSources) — в память не кладём.
    if (starting.get(key) === p) sessions.set(key, s);
    return s;
  })();
  const run = p;
  starting.set(key, run);
  // Сборка закончилась (или упала) — следующий вызов снова смотрит в `sessions`.
  const clear = () => {
    if (starting.get(key) === p) starting.delete(key);
  };
  run.then(clear, clear);
  return run;
}

/** Забыть поиск: например, если человек явно попросил «поискать заново». */
export function forgetTitle(item: Pick<MediaItem, 'type' | 'id'>): void {
  const key = titleKey(item.type, item.id);
  sessions.get(key)?.ctrl.abort();
  sessions.delete(key);
  starting.delete(key);
}

/**
 * ЗАБЫТЬ ВСЕ ИСТОЧНИКИ — часть «Очистить историю просмотра».
 *
 * Иначе ещё полчаса после очистки тот же тайтл играл бы с того же балансера: поиск и выбор
 * держатся в памяти, чтобы не опрашивать всех заново на каждой серии. После очистки следующий
 * просмотр начинает поиск с нуля.
 */
export function forgetAllSources(): void {
  sessions.forEach((s) => s.ctrl.abort());
  sessions.clear();
  starting.clear();
  states.clear();
}

/**
 * Подписка плеера на пополнение меню озвучек: источники, ответившие уже после старта,
 * дописывают свои голоса. Возвращает отписку.
 */
export function watchChoices(mediaKey: string, cb: (choices: PlaybackRequest['choices']) => void): () => void {
  const set = choiceListeners.get(mediaKey) ?? new Set();
  set.add(cb);
  choiceListeners.set(mediaKey, set);
  return () => {
    set.delete(cb);
    if (set.size === 0) choiceListeners.delete(mediaKey);
  };
}

// ─────────────────────────────── выбор лучшего источника ───────────────────────────────

/*
  СНАЧАЛА ГОДНЫЙ — ПОТОМ ОСТАЛЬНЫЕ.

  Прошлая версия ждала после первого ответа ещё шесть секунд, чтобы сравнить всех. Справедливо,
  но долго: человек смотрит на крутилку, хотя годный источник уже ответил.

  Теперь кино включается, как только ответил источник, у которого для ЭТОЙ серии есть всё сразу:
  ОРИГИНАЛ, 1080p и НЕСКОЛЬКО ОЗВУЧЕК. Ждать дальше незачем — лучше по сути не будет.
  Остальные источники продолжают искать в фоне: их голоса дописываются в меню озвучек, а их
  ссылки — в запасные варианты. Играющий источник при этом НЕ МЕНЯЕТСЯ: подмена посреди кадра
  хуже, чем чуть лучший файл.

  Если годного нет ни у кого из ответивших — после первого ответа ещё короткое ожидание, и
  выбирается лучший из тех, кто успел: оригинал, потом качество, потом число озвучек.
*/

/**
 * КТО ИГРАЕТ ПЕРВЫМ (решение Марка): COLLAPS — ОСНОВНОЙ, CDNVIDEOHUB — ЕСЛИ COLLAPS НЕ ОТВЕТИЛ.
 *
 * Collaps отдаёт один файл с русскими озвучками и оригиналом дорожками внутри — это лучший старт,
 * поэтому, пока он опрашивается, старт его ЖДЁТ (не дольше PRIMARY_WAIT_MS), даже если кто-то
 * другой ответил раньше. Ответил и нашёл — играет он, без сравнений с остальными. Отказал, не
 * нашёл, не успел или не дал ни одной живой ссылки — играет CDNVideoHub (ранг выше остальных).
 * VixSrc с «Оригиналом» первым не играет: он только пополняет меню озвучек.
 */
const PRIMARY = 'collaps';
// 8 с: Collaps может искать в два шага (IMDb, потом Кинопоиск) — 5 с на это не хватало, и фильмы
// уходили в CDNVideoHub, хотя Collaps их находил чуть позже.
const PRIMARY_WAIT_MS = 8_000;
/** Раньше VixSrc стартовал сразу («пока просто английская озвучка»); теперь основной — Collaps. */
const ENGLISH_FIRST = new Set<string>();
const TIER: Record<string, number> = { collaps: 2, cdnvideohub: 1, vixsrc: 0 };
const tier = (h: Hit) => TIER[h.source.id] ?? 0;

/**
 * ОРИГИНАЛЬНАЯ ДОРОЖКА.
 *
 * Источники называют её по-разному: «Оригинал», «Eng.Original», «Original», «Английский»,
 * просто «ENG». Ищем по смыслу, а не по одному слову.
 */
const ORIGINAL = /ориг|origin|\beng\b|англ|english/i;

/** «Соответствует всем критериям»: оригинал, не ниже этого качества и не меньше стольких голосов. */
const GOOD_QUALITY = 1080;
const GOOD_VOICES = 3;

/** Если годного нет — сколько ещё ждать после первого ответа, прежде чем взять лучшего из ответивших. */
const GRACE_MS = 2_500;

/**
 * ОДНОГОЛОСЫЙ ИСТОЧНИК (RuDub: одна своя озвучка, без оригинала) — не повод начинать.
 *
 * Он отвечает быстро и раньше побеждал по одной скорости: сериал включался в единственном голосе,
 * а меню озвучек оставалось пустым. Теперь его ответ не запускает короткое ожидание — ждём того,
 * у кого есть выбор, но не дольше WEAK_WAIT_MS. И в ранге он ниже любого источника с выбором.
 */
const WEAK_WAIT_MS = 8_000;

export type Target = { season: number; episode: number } | null;

function variantsFor(hit: Hit, target: Target): Variant[] {
  if (!target) return hit.found.kind === 'movie' ? hit.found.variants : [];
  if (hit.found.kind !== 'serial') return [];
  return (
    hit.found.seasons.find((s) => s.season === target.season)?.episodes.find((e) => e.episode === target.episode)
      ?.variants ?? []
  );
}

function qualityOf(v: Variant, hit: Hit): number {
  const m = /(\d{3,4})/.exec(v.quality ?? '');
  return m ? Number(m[1]) : hit.source.typical;
}

/** Озвучки варианта: дорожки внутри файла считаются тоже — это такие же голоса на выбор. */
function voicesOf(list: Variant[]): Set<string> {
  const out = new Set<string>();
  for (const v of list) {
    if (v.tracks && v.tracks.length > 0) v.tracks.forEach((t) => out.add(t.toLowerCase().trim()));
    else out.add(v.voice.toLowerCase().trim());
  }
  return out;
}

function score(hit: Hit, target: Target): { original: number; voices: number; quality: number } {
  const list = variantsFor(hit, target);
  const voices = voicesOf(list);
  return {
    original: [...voices].some((v) => ORIGINAL.test(v)) ? 1 : 0,
    voices: voices.size,
    quality: list.reduce((q, v) => Math.max(q, qualityOf(v, hit)), 0),
  };
}

function isWeak(hit: Hit, target: Target): boolean {
  const sc = score(hit, target);
  return sc.original === 0 && sc.voices <= 1;
}

function isGood(hit: Hit, target: Target): boolean {
  if (tier(hit) < 0) return false;
  const sc = score(hit, target);
  if (ENGLISH_FIRST.has(hit.source.id)) return sc.original === 1;
  return sc.original === 1 && sc.quality >= GOOD_QUALITY && sc.voices >= GOOD_VOICES;
}

/*
  ПОРЯДОК ДОВОДОВ: есть ли оригинал, потом качество, потом число озвучек.

  Оригинал первым — потому что без него выбора «как задумал режиссёр» нет вовсе, и это
  невосполнимо: озвучек много у всех, а оригинал у немногих. Качество вторым: из двух
  источников с оригиналом лучше тот, где картинка чётче. Число озвучек — третьим: оно решает,
  когда первые два равны. Порядок в списке источников — только при полном равенстве.
*/
function rank(hits: Hit[], target: Target): Hit[] {
  const order = (h: Hit) => SOURCES_ORDER.indexOf(h.source.id);
  const main = (h: Hit) => Number(h.source.id === PRIMARY);
  return [...hits].sort((a, b) => {
    const sa = score(a, target);
    const sb = score(b, target);
    return (
      // Основной источник — первым, даже если у этой серии в нём одна дорожка.
      main(b) - main(a) ||
      Number(isWeak(a, target)) - Number(isWeak(b, target)) ||
      tier(b) - tier(a) ||
      sb.original - sa.original ||
      sb.quality - sa.quality ||
      sb.voices - sa.voices ||
      order(a) - order(b)
    );
  });
}

/** Ответившие источники, у которых есть эта серия (или фильм). */
function usable(s: Session, target: Target): Hit[] {
  return s.search.ready().filter((h) => variantsFor(h, target).length > 0);
}

/**
 * ДОЖДАТЬСЯ, С ЧЕГО НАЧАТЬ.
 *
 * Сначала — ОСНОВНОЙ (Collaps): ответил с этой серией — старт с него сразу; ещё думает — ждём его
 * до PRIMARY_WAIT_MS, что бы ни ответили остальные. Отказал или не успел — обычные правила:
 * конец ожидания — что наступит раньше: ответил годный источник; ответил тот, кого человек уже
 * слушал (следующая серия — тот же голос, без сравнений); прошло GRACE_MS после первого ответа
 * с этой серией; ответили все.
 */
function firstUsable(s: Session, target: Target, prefer?: Prefer): Promise<Hit[]> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let weakTimer: ReturnType<typeof setTimeout> | null = null;
    let mainTimer: ReturnType<typeof setTimeout> | null = null;
    let mainGaveUp = false;
    let over = false;
    let off: () => void = () => undefined;
    const finish = () => {
      if (over) return;
      over = true;
      off();
      if (timer) clearTimeout(timer);
      if (weakTimer) clearTimeout(weakTimer);
      if (mainTimer) clearTimeout(mainTimer);
      resolve(usable(s, target));
    };
    const check = () => {
      if (over) return;
      const u = usable(s, target);
      // Основной ответил с этой серией — начинаем с него, остальных не ждём.
      if (u.some((h) => h.source.id === PRIMARY)) return finish();
      // Основной ещё думает — ждём его, но не дольше PRIMARY_WAIT_MS; потом — обычный выбор.
      if (!mainGaveUp && s.search.pending(PRIMARY)) {
        if (!mainTimer)
          mainTimer = setTimeout(() => {
            mainGaveUp = true;
            check();
          }, PRIMARY_WAIT_MS);
        return;
      }
      // Основного прождали — остальные уже успели показать, что у них есть: берём лучшего сразу,
      // без ещё одного ожидания сверху (иначе старт растягивался до 7–8 с).
      if (mainGaveUp && u.length > 0) return finish();
      const strong = u.filter((h) => !isWeak(h, target));
      if (s.search.isSettled()) return finish();
      if (u.some((h) => isGood(h, target))) return finish();
      if (prefer?.source && strong.some((h) => h.source.id === prefer.source)) return finish();
      if (strong.length > 0 && !timer) timer = setTimeout(finish, GRACE_MS);
      if (u.length > 0 && !weakTimer) weakTimer = setTimeout(finish, WEAK_WAIT_MS);
    };
    off = s.search.onChange(check);
    check();
  });
}

function describe(hits: Hit[], target: Target): string {
  return (
    hits
      .map((h) => {
        const sc = score(h, target);
        return `${h.source.name}(${sc.original ? 'ориг., ' : ''}${sc.quality}p, ${sc.voices} озв.)`;
      })
      .join(' > ') || '—'
  );
}

/*
  ЖУРНАЛ ВЫБОРА — в консоль Metro. Когда играет «не тот» балансер, вопрос всегда один: кто
  ответил и почему победил этот. Ответ должен быть виден, а не угадываться.
*/
function logChoice(s: Session, target: Target, ranked: Hit[], what: string): void {
  const where = target ? `сезон ${target.season} серия ${target.episode}` : 'фильм';
  const waiting = s.search.isSettled() ? '' : ' · остальные ещё ищут';
  say(`ЛЮМЬЕР · ${s.ids.title} · ${where} · ${what}: ${describe(ranked, target)}${waiting}`);
}

// ─────────────────────────────── перебор попыток ───────────────────────────────

type Prefer = { source?: string; voice?: string };

/** Один пункт выбора: источник и вариант в нём. Из таких состоит и перебор, и меню озвучек. */
type Choice = { hit: Hit; variants: Variant[]; index: number };

/**
 * ВСЕ ВАРИАНТЫ ДЛЯ ЭТОЙ СЕРИИ ИЗ ДАННЫХ ИСТОЧНИКОВ — источник за источником.
 * Внутри источника лучшее качество первым, одинаковые голоса не повторяются.
 */
function picksOf(hits: Hit[], target: Target): Choice[] {
  const out: Choice[] = [];
  for (const hit of hits) {
    const variants = variantsFor(hit, target);
    const order = variants
      .map((v, i) => ({ v, i }))
      .sort((a, b) => qualityOf(b.v, hit) - qualityOf(a.v, hit));
    const seen = new Set<string>();
    for (const { v, i } of order) {
      const key = v.voice.toLowerCase().trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ hit, variants, index: i });
    }
  }
  return out;
}

/**
 * Ссылки, полученные заранее (prewarm), живут 10 минут: за это время они точно не протухнут,
 * а повторный запрос ссылки — это лишние полсекунды перед стартом.
 */
const realized = new WeakMap<Variant, { url: string; at: number }>();
const REALIZED_TTL_MS = 10 * 60_000;

async function realize(v: Variant, signal?: AbortSignal): Promise<string | null> {
  if (v.url) return v.url;
  const kept = realized.get(v);
  if (kept && Date.now() - kept.at < REALIZED_TTL_MS) return kept.url;
  try {
    const url = (await v.resolve?.(signal)) ?? null;
    if (url) realized.set(v, { url, at: Date.now() });
    return url;
  } catch {
    return null;
  }
}

// ─────────────────────────────── сборка запроса ───────────────────────────────

/**
 * Состояние просмотра по ключу.
 *
 * `picks` только ДОПИСЫВАЮТСЯ — номер варианта постоянен, на него ссылаются меню плеера и
 * множество испробованных. Порядок предпочтения живёт отдельно, в `order`: когда в фоне
 * ответил источник лучше уже известных, его варианты встают выше в `order`, а номера прежних
 * не сдвигаются.
 */
type State = {
  item: MediaItem;
  target: Target;
  prefer?: Prefer;
  picks: Choice[];
  order: number[];
  tried: Set<number>;
  at: number;
  /** Источники, чьи варианты уже в `picks`. */
  have: Set<string>;
  /** Играет скачанное: его пункт — первым в меню озвучек (номер −1, см. enrichOffline). */
  offline?: PlaybackRequest['choices'][number];
};
const states = new Map<string, State>();

/** Номер пункта «скачанная озвучка» в меню: не пересекается с номерами вариантов источников. */
export const OFFLINE_CHOICE = -1;

/*
  СКАЧАННОЕ + СЕТЬ (решение Марка). Играет файл с телефона; если интернет есть, к нему добавляется
  всё, чего не скачивали: другие озвучки (онлайн), остальные серии сериала, номер IMDb (по нему
  плеер найдёт субтитры онлайн). Сети нет — источники просто не ответят, и останется только
  скачанное. Плеер подписывается на эти добавки (watchOffline) и вливает их в свой запрос.
*/
export type OfflineExtras = { imdb: string | null; episodes: PlaybackRequest['episodes'] };
const offlineListeners = new Map<string, Set<(x: OfflineExtras) => void>>();
const offlineKept = new Map<string, OfflineExtras>();

export function watchOffline(mediaKey: string, cb: (x: OfflineExtras) => void): () => void {
  const set = offlineListeners.get(mediaKey) ?? new Set();
  set.add(cb);
  offlineListeners.set(mediaKey, set);
  const kept = offlineKept.get(mediaKey);
  if (kept) cb(kept);
  return () => {
    set.delete(cb);
    if (set.size === 0) offlineListeners.delete(mediaKey);
  };
}

function enrichOffline(item: MediaItem, target: Target, prefer: Prefer | undefined, off: PlaybackRequest): void {
  void (async () => {
    const s = await sessionFor(item).catch(() => null);
    if (!s) return;
    const ranked = rank(await firstUsable(s, target, prefer), target);
    // Никто не ответил: сети нет (или тайтла нигде нет) — остаётся только скачанное.
    if (ranked.length === 0) return;
    const st: State = {
      item,
      target,
      prefer,
      picks: picksOf(ranked, target),
      order: [],
      tried: new Set(),
      at: OFFLINE_CHOICE,
      have: new Set(ranked.map((h) => h.source.id)),
      offline: off.choices[0],
    };
    arrange(st, ranked);
    states.set(off.mediaKey, st);
    choiceListeners.get(off.mediaKey)?.forEach((cb) => cb(choicesOf(st)));
    keepGrowing(st, s);

    const top = ranked[0];
    const episodes =
      top.found.kind === 'serial'
        ? top.found.seasons.flatMap((x) =>
            x.episodes.map((e) => ({ season: String(x.season), episode: String(e.episode), label: `Сезон ${x.season} · Серия ${e.episode}` })),
          )
        : off.episodes;
    const extras: OfflineExtras = { imdb: s.ids.imdb, episodes };
    offlineKept.set(off.mediaKey, extras);
    offlineListeners.get(off.mediaKey)?.forEach((cb) => cb(extras));
  })();
}

/** Кому сообщать, что меню озвучек пополнилось. */
const choiceListeners = new Map<string, Set<(choices: PlaybackRequest['choices']) => void>>();

function subtitlesOf(v: Variant): SubtitleTrack[] {
  return (v.captions ?? []).map((c) => ({ label: c.name, lang: null, url: c.url }));
}

function isHls(url: string): boolean {
  return /\.m3u8(\?|$|#)/i.test(url) || !/\.(mp4|mkv|webm)(\?|$|#)/i.test(url);
}

function keyOf(item: MediaItem, target: Target): string {
  return target ? episodeKey(item.type, item.id, String(target.season), String(target.episode)) : titleKey(item.type, item.id);
}

/**
 * ПОРЯДОК ПОПЫТОК: сначала основной источник (Collaps), затем то, что человек уже слушал (тот же
 * источник и голос), потом всё остальное — по рангу источника, внутри источника — как разложил picksOf.
 */
function arrange(st: State, ranked: Hit[]): void {
  const pos = new Map(ranked.map((h, i) => [h.source.id, i]));
  const w = (p: Choice) => {
    const v = p.variants[p.index].voice;
    return (
      (st.prefer?.source && p.hit.source.id === st.prefer.source ? 2 : 0) + (st.prefer?.voice && v === st.prefer.voice ? 3 : 0)
    );
  };
  /*
    Collaps — первым ДАЖЕ если тайтл раньше смотрели в другом источнике (решение Марка): память
    о прошлом источнике и голосе решает только порядок внутри остальных. Голос, если он есть среди
    дорожек Collaps, включается в плеере сам (preferTrack).
  */
  const main = (p: Choice) => Number(p.hit.source.id === PRIMARY);
  st.order = st.picks
    .map((_, i) => i)
    .sort(
      (a, b) =>
        main(st.picks[b]) - main(st.picks[a]) ||
        w(st.picks[b]) - w(st.picks[a]) ||
        (pos.get(st.picks[a].hit.source.id) ?? 99) - (pos.get(st.picks[b].hit.source.id) ?? 99) ||
        a - b,
    );
}

/** Дописать варианты источников, ответивших после старта. True — что-то добавилось. */
function absorb(st: State, s: Session): boolean {
  const fresh = usable(s, st.target).filter((h) => !st.have.has(h.source.id));
  if (fresh.length === 0) return false;
  for (const h of fresh) st.have.add(h.source.id);
  st.picks.push(...picksOf(rank(fresh, st.target), st.target));
  const all = usable(s, st.target);
  arrange(st, rank(all, st.target));
  logChoice(s, st.target, rank(all, st.target), 'дописаны в запас');
  return true;
}

/*
  ОДИН ГОЛОС — ОДИН ПУНКТ (решение Марка). Один и тот же голос часто есть у нескольких балансеров
  («LostFilm» у Collaps дорожкой и у CDNVideoHub отдельной ссылкой). В меню остаётся первый — а
  порядок здесь такой, что первым идёт Collaps: у него голоса — дорожки одного файла, и переключение
  мгновенное, без новой загрузки. Каждая дорожка Collaps — свой пункт (track).
  Сравнение — по смыслу имени (voiceKey), а не по буквам: «MVO LostFilm» и «LostFilm» — один голос.
*/
function choicesOf(st: State): PlaybackRequest['choices'] {
  const out: PlaybackRequest['choices'] = st.offline ? [st.offline] : [];
  const seen = new Set<string>(st.offline ? [voiceKey(st.offline.voice)] : []);
  // Голос, который ИГРАЕТ сейчас, остаётся в меню своим пунктом — его не вытесняет такой же
  // у другого источника (иначе текущий выбор пропадал из меню).
  const cur = st.picks[st.at];
  const curKeys = new Set(cur ? (cur.variants[cur.index].tracks?.length ? cur.variants[cur.index].tracks! : [cur.variants[cur.index].voice]).map(voiceKey) : []);
  for (const i of st.order) {
    const x = st.picks[i];
    const v = x.variants[x.index];
    const quality = v.quality ?? (x.hit.source.typical ? `${x.hit.source.typical}p` : null);
    const names = v.tracks?.length ? v.tracks : [v.voice];
    for (const name of names) {
      const k = voiceKey(name);
      if (seen.has(k)) continue;
      if (i !== st.at && curKeys.has(k)) continue;
      seen.add(k);
      out.push({ voice: name, quality, source: x.hit.source.name, index: i, ...(v.tracks?.length ? { track: name } : {}) });
    }
  }
  return out;
}

/**
 * «Тот же голос?» — по смыслу: без регистра, знаков и пометок вида MVO/DVO/«многоголосый».
 * Любой оригинал («Eng.Original», «Оригинал», «Original») — один голос.
 */
export function voiceKey(name: string): string {
  const l = name.toLowerCase();
  if (/ориг|origin/.test(l)) return 'original';
  return l
    .replace(/\b(mvo|dvo|avo|svo|vo)\b/g, '')
    .replace(/многоголос\S*|двухголос\S*|одноголос\S*|закадров\S*|профессиональ\S*|любительск\S*|авторск\S*/g, '')
    .replace(/[^a-zа-яё0-9]+/g, '');
}

/**
 * ФОНОВЫЙ ДОПОИСК. Кино уже играет, а остальные источники ещё отвечают — каждый ответ
 * дописывается в запас и в меню озвучек, открытое меню обновляется само.
 */
function keepGrowing(st: State, s: Session): void {
  if (s.search.isSettled()) {
    absorb(st, s);
    return;
  }
  const key = keyOf(st.item, st.target);
  const off = s.search.onChange(() => {
    // Состояние заменили (другая серия, «Очистить историю») — этот допоиск больше никому не нужен.
    if (states.get(key) !== st) return off();
    if (absorb(st, s)) {
      const choices = choicesOf(st);
      choiceListeners.get(key)?.forEach((cb) => cb(choices));
    }
    if (s.search.isSettled()) off();
  });
}

/** Дорожка файла с тем же голосом (без учёта регистра и пробелов) — или null. */
function matchTrack(tracks: string[] | undefined, voice: string | undefined): string | null {
  if (!tracks?.length || !voice) return null;
  const want = voice.toLowerCase().trim();
  return tracks.find((t) => t.toLowerCase().trim() === want) ?? null;
}

/**
 * Человек выбрал дорожку внутри файла (Collaps) — запомнить голос для тайтла, как и при выборе
 * озвучки-ссылки: следующая серия и следующий запуск начнутся с него же.
 */
export function rememberTrack(req: Pick<PlaybackRequest, 'mediaType' | 'mediaId'>, voice: string): void {
  setVoiceFor(titleKey(req.mediaType, req.mediaId), voice);
}

function build(st: State, at: number, url: string, imdb: string | null): PlaybackRequest {
  const { item, target, picks } = st;
  const p = picks[at];
  const v = p.variants[p.index];
  const key = keyOf(item, target);

  const episodes =
    p.hit.found.kind === 'serial'
      ? p.hit.found.seasons.flatMap((s) =>
          s.episodes.map((e) => ({ season: String(s.season), episode: String(e.episode), label: `Сезон ${s.season} · Серия ${e.episode}` })),
        )
      : [];
  const currentEpisode = target
    ? episodes.findIndex((e) => e.season === String(target.season) && e.episode === String(target.episode))
    : -1;

  return {
    url,
    title: item.title,
    subtitle: target ? `Сезон ${target.season} · Серия ${target.episode}` : null,
    isHls: isHls(url),
    headers: v.headers,
    subtitleTracks: subtitlesOf(v),
    voices: v.tracks ?? [],
    // Голос, который человек слушал раньше, — если он есть среди дорожек этого файла.
    preferTrack: matchTrack(v.tracks, st.prefer?.voice),
    durationSec: null,
    mediaKey: key,
    mediaId: item.id,
    mediaType: item.type,
    posterUrl: item.posterUrl,
    backdropUrl: item.backdropUrl,
    startPositionMs: resumePositionFor(key),
    imdb,
    season: target ? String(target.season) : null,
    episode: target ? String(target.episode) : null,
    episodes,
    currentEpisode,
    sourceId: p.hit.source.id,
    sourceName: p.hit.source.name,
    // Меню озвучек — по всем источникам сразу. Каждый пункт помнит, откуда он.
    choices: choicesOf(st),
    choice: at,
    hideFileTracks: v.hideTracks || undefined,
  };
}

/**
 * ПЕРВАЯ ЖИВАЯ ССЫЛКА — в порядке предпочтения, пропуская испробованные.
 *
 * Кончились известные варианты, а источники ещё ищут — ждём следующего ответа и пробуем его:
 * быстрый старт не должен означать «не нашлось», если годный источник просто медленнее.
 */
async function firstLive(st: State, s: Session): Promise<PlaybackRequest | null> {
  for (;;) {
    for (const i of st.order) {
      if (st.tried.has(i)) continue;
      st.tried.add(i);
      const p = st.picks[i];
      const url = await realize(p.variants[p.index], s.ctrl.signal);
      if (!url) {
        say(`ЛЮМЬЕР · ${p.hit.source.name} · «${p.variants[p.index].voice}» — ссылку не дал, беру следующий`);
        continue;
      }
      st.at = i;
      const req = build(st, i, url, s.ids.imdb);
      states.set(req.mediaKey, st);
      return req;
    }
    if (absorb(st, s)) continue;
    if (s.search.isSettled() || s.ctrl.signal.aborted) return null;
    await new Promise<void>((resolve) => {
      const off = s.search.onChange(() => {
        off();
        resolve();
      });
    });
  }
}

async function start(item: MediaItem, target: Target, prefer?: Prefer) {
  /*
    СКАЧАННОЕ — БЕЗ СЕТИ И ПЕРВЫМ ДЕЛОМ.

    Если эта серия или фильм уже лежат на телефоне, источники не спрашиваются вовсе: открывается
    файл с устройства — в самолёте, в метро, где угодно. Как у планшетного Люмьера: «можно
    смотреть без интернета».
  */
  const offline = localRequest(item, target);
  if (offline) {
    enrichOffline(item, target, prefer, offline);
    return offline;
  }

  // Голос, выбранный для тайтла раньше (voicePrefs), — если вызывающий не сказал иного.
  if (!prefer?.voice) {
    const voice = await voiceForAsync(titleKey(item.type, item.id));
    if (voice) prefer = { ...prefer, voice };
  }
  const s = await sessionFor(item);
  const ranked = rank(await firstUsable(s, target, prefer), target);
  logChoice(s, target, ranked, 'старт');
  const st: State = {
    item,
    target,
    prefer,
    picks: picksOf(ranked, target),
    order: [],
    tried: new Set(),
    at: 0,
    have: new Set(ranked.map((h) => h.source.id)),
  };
  arrange(st, ranked);
  const req = await firstLive(st, s);
  if (req) keepGrowing(st, s);
  return req;
}

// ─────────────────────────────── вход для экранов ───────────────────────────────

/**
 * ПРОГРЕВ — ПОИСК ДО НАЖАТИЯ «СМОТРЕТЬ».

 * Пока человек читает страницу тайтла, источники уже опрашиваются: номер Кинопоиска, список
 * озвучек, а у фильма — и ссылка на первый вариант. К нажатию «Смотреть» всё это обычно готово,
 * и плеер открывается почти сразу. Если человек ушёл, не нажав, — это несколько лёгких запросов.
 */
export function prewarm(item: MediaItem): void {
  void (async () => {
    const s = await sessionFor(item);
    if (item.type !== 'movie') return;
    const hits = rank(await firstUsable(s, null), null);
    const first = picksOf(hits, null)[0];
    if (first) await realize(first.variants[first.index], s.ctrl.signal);
  })().catch(() => undefined);
}

/** Запрос на фильм: лучший источник, первая живая ссылка. */
export async function movieRequest(item: MediaItem): Promise<PlaybackRequest | null> {
  return start(item, null);
}

/** Запрос на серию. */
export async function episodeRequest(
  item: MediaItem,
  season: number,
  episode: number,
  prefer?: Prefer,
): Promise<PlaybackRequest | null> {
  return start(item, { season, episode }, prefer);
}

function itemOf(req: PlaybackRequest): MediaItem {
  return {
    id: req.mediaId,
    type: req.mediaType,
    title: req.title,
    originalTitle: '',
    overview: '',
    posterUrl: req.posterUrl,
    backdropUrl: req.backdropUrl,
    year: null,
    rating: 0,
    releaseDate: null,
    originalLanguage: null,
    genreIds: [],
    voteCount: 0,
  };
}

/** Другая серия, не выходя из плеера: тот же голос и тот же источник — если они у неё есть. */
export async function changeEpisode(req: PlaybackRequest, season: number, episode: number): Promise<PlaybackRequest | null> {
  const item = states.get(req.mediaKey)?.item ?? itemOf(req);
  // По номеру пункта, а не по месту в массиве: порядок меню и номера вариантов — разные вещи.
  const voice = req.choices.find((c) => c.index === req.choice)?.voice;
  return episodeRequest(item, season, episode, { source: req.sourceId, voice });
}

/**
 * ЗАПАСНОЙ ВАРИАНТ. Плеер не поднял поток — берём следующий по качеству из тех, что ещё не
 * пробовали. Null — варианты кончились во всех источниках.
 */
export async function nextFallback(req: PlaybackRequest): Promise<PlaybackRequest | null> {
  const st = states.get(req.mediaKey);
  if (!st) return null;
  const s = await sessionFor(st.item);
  return firstLive(st, s);
}

/** Выбор озвучки из меню — она может быть у другого источника; тогда это просто другая ссылка. */
export async function pickChoice(req: PlaybackRequest, index: number, track?: string): Promise<PlaybackRequest | null> {
  const st = states.get(req.mediaKey);
  // Назад к скачанной озвучке — файл с телефона, меню остаётся полным.
  if (index === OFFLINE_CHOICE && st?.offline) {
    const local = localRequest(st.item, st.target);
    if (!local) return null;
    st.at = OFFLINE_CHOICE;
    return { ...local, choices: choicesOf(st), choice: OFFLINE_CHOICE };
  }
  if (!st || !st.picks[index]) return null;
  const s = await sessionFor(st.item);
  const p = st.picks[index];
  const url = await realize(p.variants[p.index], s.ctrl.signal);
  if (!url) return null;
  st.at = index;
  st.tried.add(index);
  // Выбор из меню запоминается за тайтлом: следующая серия и загрузка возьмут этот же голос.
  // Голос-дорожка (Collaps) — он и включится в файле при старте (preferTrack).
  const voice = track ?? p.variants[p.index].voice;
  setVoiceFor(titleKey(st.item.type, st.item.id), voice);
  st.prefer = { ...st.prefer, voice };
  return build(st, index, url, s.ids.imdb);
}

/**
 * ИСТОЧНИК ДЛЯ ЗАГРУЗКИ: ссылка, заголовки и голос — без плеера.
 *
 * Тот же выбор, что при просмотре (тот же голос, если его выбирали), но ссылка берётся каждый раз
 * заново: загрузка может начаться через час после постановки в очередь, а ссылки живут недолго.
 */
export type DownloadSource = {
  url: string;
  headers: Record<string, string>;
  voice: string;
  quality: string | null;
  voices: string[];
  /** Готовый файл MP4 (а не поток): качается кусками по диапазонам байт и складывается подряд. */
  direct?: boolean;
  /**
   * Номер звуковой дорожки в плейлисте (по порядку в группе) — когда голоса лежат дорожками
   * внутри одного файла (Collaps). Без него качается дорожка по умолчанию.
   */
  audio?: number;
  /** Субтитры источника (у Collaps — VTT на раздаче) — их тоже скачать (downloads/subs.ts). */
  captions?: { name: string; url: string }[];
  /** Номер IMDb — для поиска субтитров онлайн. */
  imdb?: string | null;
};

export async function downloadSource(
  item: MediaItem,
  target: Target,
  voice?: string,
): Promise<DownloadSource | null> {
  const want = voice ?? (await voiceForAsync(titleKey(item.type, item.id)));
  const s = await sessionFor(item);
  const ranked = rank(await firstUsable(s, target, want ? { voice: want } : undefined), target);
  const st: State = {
    item,
    target,
    prefer: want ? { voice: want } : undefined,
    picks: picksOf(ranked, target),
    order: [],
    tried: new Set(),
    at: 0,
    have: new Set(ranked.map((h) => h.source.id)),
  };
  arrange(st, ranked);
  const voices = voicesOfTop(ranked, target);
  for (const i of st.order) {
    const p = st.picks[i];
    const v = p.variants[p.index];
    // Голос — дорожка внутри файла (Collaps): качаем ту же ссылку, но нужную дорожку.
    const track = matchTrack(v.tracks, want);
    if (track && v.tracks) {
      const url = await realize(v, s.ctrl.signal);
      if (url) return { url, headers: v.headers, voice: track, quality: v.quality, voices, audio: v.tracks.indexOf(track), captions: v.captions, imdb: s.ids.imdb };
      continue;
    }
    /*
      Сперва — готовый файл, если источник его даёт: самое высокое качество не выше 1080p (как и у
      потока). Один файл надёжнее сотен кусков потока: собирать нечего, играет с диска всегда.
    */
    const files = v.files ? await v.files(s.ctrl.signal).catch(() => []) : [];
    const fit = files.filter((f) => f.height <= 1080).sort((a, b) => b.height - a.height)[0];
    if (fit) return { url: fit.url, headers: v.headers, voice: v.voice, quality: `${fit.height}p`, voices, direct: true, captions: v.captions, imdb: s.ids.imdb };
    const url = await realize(v, s.ctrl.signal);
    if (url) return { url, headers: v.headers, voice: v.tracks?.[0] ?? v.voice, quality: v.quality, voices, audio: v.tracks?.length ? 0 : undefined, captions: v.captions, imdb: s.ids.imdb };
  }
  return null;
}

/** Голоса, которые есть у этой серии или фильма, — для выбора «Озвучка для скачивания». */
export async function voicesFor(item: MediaItem, target: Target): Promise<string[]> {
  const s = await sessionFor(item);
  const ranked = rank(await firstUsable(s, target), target);
  return voicesOfTop(ranked, target);
}

/*
  ОЗВУЧКИ ДЛЯ СКАЧИВАНИЯ — ТОЛЬКО У ОДНОГО ИСТОЧНИКА (решение Марка): у Collaps, если он ответил
  с этой серией; иначе — у следующего по рангу (CDNVideoHub). Смесь голосов разных балансеров
  здесь только путала: выбранный голос мог оказаться у источника, с которого качать не будут.
  У Collaps голоса — это дорожки внутри файла (tracks), у остальных — отдельные ссылки.
*/
function voicesOfTop(ranked: Hit[], target: Target): string[] {
  const top = ranked.find((h) => variantsFor(h, target).length > 0);
  if (!top) return [];
  const names = variantsFor(top, target).flatMap((v) => (v.tracks?.length ? v.tracks : [v.voice]));
  return [...new Set(names)];
}

/**
 * СЛЕДУЮЩАЯ СЕРИЯ после (season, episode) — по списку источника, а не «номер плюс один»:
 * в конце сезона следующая — первая серия следующего сезона.
 */
export async function nextEpisodeOf(
  item: MediaItem,
  season: number,
  episode: number,
): Promise<{ season: number; episode: number } | null> {
  const list = await openFor(item).catch(() => null);
  if (!list || list.kind !== 'serial') return null;
  const flat = list.seasons.flatMap((s) => s.episodes.map((e) => ({ season: s.season, episode: Number(e.episode) })));
  const i = flat.findIndex((x) => x.season === season && x.episode === episode);
  return i >= 0 && i + 1 < flat.length ? flat[i + 1] : null;
}

/**
 * СПИСОК СЕЗОНОВ И СЕРИЙ ДЛЯ ЭКРАНА «СМОТРЕТЬ».
 *
 * Берётся из первого ответившего источника — и дополняется теми, кто успел ответить ещё за
 * полторы секунды: у одного источника может не оказаться последнего сезона, а у другого он есть.
 * Объединение по номерам: серия попадает в список, если она есть хоть где-нибудь.
 */
export type ListSeason = { season: number; episodes: { episode: string; title: string | null }[] };

export async function openFor(item: MediaItem): Promise<{ kind: 'serial'; seasons: ListSeason[] } | { kind: 'movie' } | null> {
  const s = await sessionFor(item);
  // Кто ответил первым — по времени, а не по месту в списке: медленный первый по списку не держит остальных.
  const anyHit = () =>
    new Promise<boolean>((resolve) => {
      const check = () => {
        if (s.search.ready().length > 0) return done(true);
        if (s.search.isSettled()) return done(false);
      };
      let off: () => void = () => undefined;
      let over = false;
      const done = (v: boolean) => {
        if (over) return;
        over = true;
        off();
        resolve(v);
      };
      off = s.search.onChange(check);
      check();
    });
  if (!(await anyHit())) return null;
  if (s.ids.kind === 'movie') return { kind: 'movie' };
  await Promise.race([s.search.settled(), new Promise<void>((r) => setTimeout(r, 1500))]);
  const hits = s.search.ready();

  const map = new Map<number, Map<number, string | null>>();
  for (const h of hits) {
    if (h.found.kind !== 'serial') continue;
    for (const se of h.found.seasons) {
      const eps = map.get(se.season) ?? new Map<number, string | null>();
      for (const e of se.episodes) if (!eps.has(e.episode) || !eps.get(e.episode)) eps.set(e.episode, e.title);
      map.set(se.season, eps);
    }
  }
  const seasons: ListSeason[] = [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, eps]) => ({
      season,
      episodes: [...eps.entries()].sort((a, b) => a[0] - b[0]).map(([n, t]) => ({ episode: String(n), title: t })),
    }));
  return seasons.length ? { kind: 'serial', seasons } : null;
}

/**
 * Для настроек: каждый источник на этом тайтле — от поиска до первого куска видео (check.ts).
 * Поиск отдельный, не из памяти просмотра: проверка должна спрашивать сеть сейчас.
 */
export async function diagnose(item: MediaItem, target: CheckTarget) {
  const ids = await idsOf(item);
  const ctrl = new AbortController();
  const out = await checkTitle(ids, target, ctrl.signal);
  return { imdb: ids.imdb, ...out };
}
