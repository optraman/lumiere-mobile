import { kinopoiskId } from './ids';
import { traceSignal, type Step } from './http';
import { cdnvideohub } from './s_cdnvideohub';
import { collaps } from './s_collaps';
import { vixsrc } from './s_vixsrc';
import type { Found, Ids, Source } from './types';

export type { Caption, Episode, Found, Ids, Season, Source, Variant } from './types';

/**
 * КАСКАД ИСТОЧНИКОВ — РУССКИЕ ГОЛОСА И ОРИГИНАЛ.
 *
 * Меню озвучек собирается из ВСЕХ ответивших источников сразу, поэтому «русский и английский» —
 * это не один волшебный балансер, а их сочетание. Кто ИГРАЕТ первым — решает playback.ts:
 *   • Collaps     — ОСНОВНОЙ (решение Марка): ОДИН файл, внутри которого дорожками лежат и русские
 *     озвучки, и оригинал; они уходят в `tracks`, и дорожка переключается прямо в плеере;
 *   • CDNVideoHub — русские озвучки студий (плеер LostFilm) — играет, если Collaps не ответил,
 *     не нашёл тайтл или не дал ссылки;
 *   • VixSrc      — оригинальная (английская) дорожка по номеру ТМДБ; в меню это один пункт
 *     «Оригинал», итальянская дорожка скрыта (hideTracks). Первым не играет.
 *
 * Остальные балансеры (Kodik, Lumex, Filmix, Obrut, RuDub, Rutube, VK и маленькие сайты) — только
 * русские озвучки; их код лежит в tools/_to_delete/sources-removed, вернуть любой — добавить
 * импорт и строку в список ниже.
 *
 * ВАЖНО: Collaps и VixSrc убирали отсюда именно потому, что с этого телефона они молчали. Код у
 * них рабочий (их проверки — tools/collaps-check.js и tools/vixsrc-check.js), но ответит ли
 * сервер — покажет зонд в настройках: не ответят — каскад просто пойдёт дальше, как и раньше.
 */
export const SOURCES: Source[] = [collaps, cdnvideohub, vixsrc];

/** Сколько ждать одного источника целиком, со всеми его шагами. */
const SOURCE_BUDGET_MS = 20_000;

export type Hit = { source: Source; found: Found };

export type Outcome = { source: Source; ok: boolean; ms: number; note?: string; steps: Step[] };

export type { Step } from './http';

/** Сигнал, который гаснет вместе с внешним, но со своим журналом запросов. */
function child(signal: AbortSignal): { signal: AbortSignal; steps: Step[] } {
  const c = new AbortController();
  if (signal.aborted) c.abort();
  else signal.addEventListener('abort', () => c.abort(), { once: true });
  return { signal: c.signal, steps: traceSignal(c.signal) };
}

export type Search = {
  /**
   * Ответы в порядке предпочтения, по мере готовности. Пропускает отказавших.
   * Функция, а не готовый перебор: перебирать его нужно не раз — для серии, для запасного
   * варианта, для соседней серии, — а перебор в JS одноразовый.
   */
  hits(): AsyncGenerator<Hit>;
  /** Все удачные ответы — когда опрос закончится целиком. */
  settled(): Promise<Hit[]>;
  /** Кто уже ответил удачно к этой секунде — без ожидания остальных. */
  ready(): Hit[];
  /** Кто что ответил — для проверки в настройках и для зонда. */
  report(): Promise<Outcome[]>;
  /** Как искали номер Кинопоиска и чем кончилось — от него зависит половина источников. */
  kp(): { value: number | null | undefined; steps: Step[] };
  /** Ответили все — удачно или нет. */
  isSettled(): boolean;
  /** Этот источник опрашивается и ещё не ответил (ни удачей, ни отказом). */
  pending(id: string): boolean;
  /** Сообщать о каждом новом ответе (удачном или нет). Возвращает отписку. */
  onChange(cb: () => void): () => void;
};

function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

function canTry(s: Source, ids: Ids): boolean {
  if (ids.kind === 'movie' ? !s.movie : !s.serial) return false;
  return s.needs.some((k) =>
    k === 'imdb' ? !!ids.imdb : k === 'kp' ? true : k === 'tmdb' ? !!ids.tmdb : !!ids.title,
  );
}

/**
 * ЗАПУСТИТЬ ПОИСК ВО ВСЕХ ИСТОЧНИКАХ.
 *
 * Номер Кинопоиска добывается ПАРАЛЛЕЛЬНО с теми, кому он не нужен: Collaps по IMDB и площадки по
 * названию стартуют сразу, а те, кому нужен номер, — как только он найдётся. Не нашёлся — они
 * просто молча отказываются, остальным это не мешает.
 */
export function search(base: Ids, signal: AbortSignal): Search {
  const kpTrace = child(signal);
  let kpValue: number | null | undefined = base.kp ?? undefined;
  const kpPromise: Promise<number | null> = base.kp
    ? Promise.resolve(base.kp)
    : kinopoiskId(base, kpTrace.signal)
        .catch(() => null)
        .then((v) => (kpValue = v));

  const runs = SOURCES.filter((s) => canTry(s, base)).map((source) => {
    const started = Date.now();
    const own = child(signal);
    const steps = own.steps;
    const promise = (async (): Promise<{ hit: Hit | null; outcome: Outcome }> => {
      let ids: Ids = { ...base, kpLater: () => withBudget(kpPromise, 8_000).then((v) => v ?? null) };
      const onlyKp = source.needs.length === 1 && source.needs[0] === 'kp';
      const hasImdbPath = source.needs.includes('imdb') && !!base.imdb;
      if (onlyKp) {
        // Без номера такому источнику спрашивать нечего — ждём его целиком.
        const kp = await kpPromise;
        if (!kp) return { hit: null, outcome: { source, ok: false, ms: Date.now() - started, note: 'нет номера Кинопоиска', steps } };
        ids = { ...ids, kp };
      } else if (source.needs.includes('kp') && !hasImdbPath) {
        // Номер желателен, но есть и другой путь: подождём его недолго, потом пойдём без него.
        const kp = await withBudget(kpPromise, 6_000);
        ids = { ...ids, kp: kp ?? null };
      }
      let crash: string | null = null;
      const found = await withBudget(
        source.open(ids, own.signal).catch((e: unknown) => {
          // Исключение внутри источника — это ошибка в коде, а не «нет фильма». Её надо видеть.
          crash = String((e as Error)?.message ?? e).slice(0, 90);
          return null;
        }),
        SOURCE_BUDGET_MS,
      );
      const ok = !!found && (found.kind === 'movie' ? found.variants.length > 0 : found.seasons.length > 0);
      const ms = Date.now() - started;
      const note = ok
        ? undefined
        : crash
          ? `сбой: ${crash}`
          : found === null
            ? ms >= SOURCE_BUDGET_MS
              ? 'не успел'
              : 'не нашёл'
            : 'пусто';
      return { hit: ok ? { source, found: found as Found } : null, outcome: { source, ok, ms, note, steps } };
    })();
    return { source, promise };
  });

  const done: (Hit | null)[] = runs.map(() => null);
  const finished: boolean[] = runs.map(() => false);
  const listeners = new Set<() => void>();
  let left = runs.length;
  runs.forEach((r, i) => {
    r.promise.then((x) => {
      done[i] = x.hit;
      finished[i] = true;
      left -= 1;
      listeners.forEach((cb) => cb());
    });
  });

  async function* ordered(): AsyncGenerator<Hit> {
    for (const r of runs) {
      const { hit } = await r.promise;
      if (hit) yield hit;
    }
  }

  return {
    hits: ordered,
    ready: () => done.filter((h): h is Hit => !!h),
    settled: async () => (await Promise.all(runs.map((r) => r.promise))).map((x) => x.hit).filter((h): h is Hit => !!h),
    report: async () => (await Promise.all(runs.map((r) => r.promise))).map((x) => x.outcome),
    kp: () => ({ value: kpValue, steps: kpTrace.steps }),
    isSettled: () => left === 0,
    pending: (id) => runs.some((r, i) => r.source.id === id && !finished[i]),
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
