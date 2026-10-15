/**
 * СЕТЬ ДЛЯ ИСТОЧНИКОВ.
 *
 * Одна функция на всех, и в ней три вещи, которые каждый источник иначе писал бы сам и по-разному:
 *
 *  1. СРОК. Любой запрос ограничен по времени. Источник, который не ответил, — это не повод держать
 *     человека с крутилкой: каскад перейдёт к следующему.
 *  2. ОТМЕНА. Закрыли экран — все запросы всех источников обрываются разом, а не доигрывают в фоне.
 *  3. ОТКАЗ — ЭТО NULL, А НЕ ИСКЛЮЧЕНИЕ. Источники падают постоянно и по десятку причин (переехал
 *     домен, сменилась разметка, закрыли страну). Для каскада всё это одно и то же: «здесь нет».
 */

import { KEYS } from './keys';

/*
  ЖУРНАЛ ЗАПРОСОВ ИСТОЧНИКА.

  «Не нашёл» — это итог, а не причина. Причин десяток: домен не открылся, раздача ответила 403,
  ключ отозван (401 и «invalid token»), сервер вернул заглушку вместо данных. Пока их не видно,
  чинить приходится наугад. Поэтому каждый запрос источника оставляет строку: куда, что ответили,
  за сколько.

  Привязка — к сигналу отмены: у каждого источника в каскаде свой сигнал, и он и так проходит
  через все его запросы. Ничего не нужно протаскивать отдельно.

  В строку не попадают ни параметры запроса (там ключи), ни адреса из keys.ts — они заменяются
  именами. Журнал можно спокойно показать на экране и положить в отчёт.
*/
export type Step = {
  /** Хост и путь без параметров. */
  at: string;
  /** HTTP-код или что случилось вместо ответа. */
  status: number | 'нет связи' | 'срок' | 'отменён';
  ms: number;
  /** Начало ответа (или причина обрыва) — по нему видно «invalid token», «blocked», пустой список. */
  hint?: string;
};

const traces = new WeakMap<AbortSignal, Step[]>();

/** Начать журнал для сигнала. Всё, что спросят с этим сигналом, попадёт в возвращённый список. */
export function traceSignal(signal: AbortSignal): Step[] {
  const steps: Step[] = [];
  traces.set(signal, steps);
  return steps;
}

/** Записать шаг в журнал сигнала (если журнал ведётся). */
export function note(signal: AbortSignal | undefined, step: Step): void {
  if (signal) traces.get(signal)?.push(step);
}

/** Куда шёл запрос — без параметров и без значений из keys.ts. */
export function where(url: string): string {
  let u = url;
  for (const [name, value] of Object.entries(KEYS)) {
    if (typeof value === 'string' && value.length >= 6 && u.includes(value)) u = u.split(value).join(`‹${name}›`);
  }
  u = u.replace(/^https?:\/\//, '').replace(/[?#].*$/, '');
  return u.length > 70 ? `${u.slice(0, 67)}…` : u;
}

/** Короткая подсказка из тела ответа: без пробельной каши и без ключей. */
export function hintOf(text: string): string | undefined {
  let t = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  for (const value of Object.values(KEYS)) if (typeof value === 'string' && value.length >= 6) t = t.split(value).join('‹ключ›');
  return t ? t.slice(0, 90) : undefined;
}

/** Причина обрыва: у Node она лежит в cause.code (ENOTFOUND, ECONNRESET, сертификат…). */
export function failOf(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } } | null;
  return [err?.cause?.code, err?.message].filter(Boolean).join(' · ').slice(0, 90) || 'ошибка';
}

/** Настольный Chrome: часть источников без него отвечает заглушкой. */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Полный набор заголовков обычного браузера — замена Http.defaultFullHeaders у Lampac. */
export function browser(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    ...extra,
  };
}

export type Res = { status: number; url: string; text: string; location: string | null };

export type Ask = {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** form — application/x-www-form-urlencoded; none — пустое тело без Content-Type. */
  bodyType?: 'form' | 'json' | 'none';
  signal?: AbortSignal;
  timeoutMs?: number;
  /** manual — не идти за переходом, вернуть Location (нужно obrut). */
  redirect?: 'follow' | 'manual';
};

export async function ask(url: string, opts: Ask = {}): Promise<Res | null> {
  const ctrl = new AbortController();
  const started = Date.now();
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    ctrl.abort();
  }, opts.timeoutMs ?? 12_000);
  const onOuter = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onOuter);
  try {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined && opts.bodyType === 'form') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    }
    if (opts.body !== undefined && opts.bodyType === 'json') headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body,
      signal: ctrl.signal,
      redirect: opts.redirect ?? 'follow',
    });
    const text = await res.text();
    note(opts.signal, {
      at: where(url),
      status: res.status,
      ms: Date.now() - started,
      hint: hintOf(text) ?? '(пустой ответ)',
    });
    return { status: res.status, url: res.url || url, text, location: res.headers.get('location') };
  } catch (e) {
    note(opts.signal, {
      at: where(url),
      status: opts.signal?.aborted ? 'отменён' : late ? 'срок' : 'нет связи',
      ms: Date.now() - started,
      hint: late || opts.signal?.aborted ? undefined : failOf(e),
    });
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuter);
  }
}

/** Только удачные ответы: всё, что не 2xx, для источника значит «нет». */
export async function text(url: string, opts: Ask = {}): Promise<string | null> {
  const r = await ask(url, opts);
  return r && r.status >= 200 && r.status < 300 && r.text ? r.text : null;
}

export async function json<T = unknown>(url: string, opts: Ask = {}): Promise<T | null> {
  const t = await text(url, opts);
  if (!t) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

export function form(data: Record<string, string | number>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/** Первая группа совпадения или null — Rx.Match у Lampac. */
export function m1(s: string, re: RegExp): string | null {
  const m = re.exec(s);
  return m ? m[1] : null;
}

/** Схема и хост ссылки: «https://a.b/c» → «https://a.b». */
export function originOf(url: string): string {
  const m = /^(https?:\/\/[^/]+)/i.exec(url);
  return m ? m[1] : url;
}
