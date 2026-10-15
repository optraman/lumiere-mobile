import type { SubtitleTrack } from './request';
import { decodeSmart, gunzip } from './inflate';

/**
 * СУБТИТРЫ С OPENSUBTITLES — перенесено из data/subs/OpenSubtitlesRepository.kt Влада.
 *
 * Его слова: «надёжные русские, английские и немецкие субтитры через СТАРЫЙ открытый API
 * OpenSubtitles — без ключа, только заголовок X-User-Agent (тот же путь, что у бесчисленных
 * дополнений Kodi)». Ровно так и здесь:
 *   — поиск по номеру IMDB, у сериала ещё по сезону и серии;
 *   — на каждый язык берётся самый скачиваемый вариант;
 *   — файл приходит сжатым (.gz) и часто в windows-1251 — распаковывается и перекодируется
 *     (src/player/inflate.ts), как decodeSmart у Влада.
 *
 * Список ищется сразу при открытии серии, а сами файлы качаются только тот, что выбрали: из трёх
 * языков человек смотрит один.
 *
 * ИСТОЧНИКОВ ДВА (findOnlineSubtitles): старый API Влада и Wyzie Subs — у старого объявлено
 * закрытие, и, судя по тому, что субтитров в плеере не появлялось, он уже не отвечает.
 */
const LANGS: { iso: string; label: string }[] = [
  { iso: 'ru', label: 'Русские' },
  { iso: 'en', label: 'Английские' },
  { iso: 'de', label: 'Немецкие' },
];

type Item = { ISO639?: string; SubDownloadLink?: string; SubFormat?: string; SubDownloadsCnt?: string };

/** Ссылка-ярлык в списке субтитров → настоящий адрес архива. */
const links = new Map<string, string>();
/** Уже скачанное — повторно не качаем. */
const texts = new Map<string, string>();
const lists = new Map<string, SubtitleTrack[]>();

export const OPENSUBS = 'opensubs:';

/** Итог поиска для журнала: кто что ответил. Ни ключей, ни адресов с ключами здесь нет. */
export type SubsSearch = { tracks: SubtitleTrack[]; note: string };

/**
 * СТАРЫЙ ОТКРЫТЫЙ API OPENSUBTITLES (rest.opensubtitles.org) — как у Влада.
 *
 * Его закрытие объявлено ещё в 2023-м; где-то он ещё отвечает, где-то уже нет. Поэтому он
 * остался, но больше не единственный: рядом Wyzie Subs (ниже), если в .env есть ключ.
 */
async function legacy(num: string, season: number | null, episode: number | null): Promise<{ items: { iso: string; link: string; score: number }[]; note: string }> {
  let url = 'https://rest.opensubtitles.org/search';
  if (season && episode) url += `/episode-${episode}`;
  url += `/imdbid-${num}`;
  if (season && episode) url += `/season-${season}`;
  url += '/sublanguageid-rus,eng,ger';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, { headers: { 'X-User-Agent': 'TemporaryUserAgent' }, signal: ctrl.signal });
    if (!res.ok) return { items: [], note: `OpenSubtitles ${res.status}` };
    const list = (await res.json()) as Item[];
    if (!Array.isArray(list)) return { items: [], note: 'OpenSubtitles: не список' };
    const items = list
      .filter((i) => i.SubDownloadLink && i.ISO639)
      .map((i) => ({ iso: (i.ISO639 as string).toLowerCase(), link: i.SubDownloadLink as string, score: Number(i.SubDownloadsCnt) || 0 }));
    return { items, note: `OpenSubtitles ${items.length}` };
  } catch (e) {
    return { items: [], note: `OpenSubtitles: ${ctrl.signal.aborted ? 'срок' : 'нет связи'}` };
  } finally {
    clearTimeout(t);
  }
}

/**
 * WYZIE SUBS — сборщик субтитров с нескольких сайтов, по номеру IMDB или ТМДБ.
 *
 * Нужен бесплатный ключ (store.wyzie.io/redeem) в .env: EXPO_PUBLIC_WYZIE_KEY. Ключ вписывает сам
 * Марк — в чат его не присылать и в коде не держать. Нет ключа — этот путь просто молчит.
 * Ответ: список файлов с прямой ссылкой на SRT, языком (ISO 639-1) и числом скачиваний.
 */
const WYZIE_HOSTS = ['https://sub.wyzie.io', 'https://sub.wyzie.ru'];
type WyzieItem = { url?: string; language?: string; downloadCount?: number; isHearingImpaired?: boolean; ai?: boolean; format?: string };

async function wyzie(imdb: string, season: number | null, episode: number | null): Promise<{ items: { iso: string; link: string; score: number }[]; note: string }> {
  const key = process.env.EXPO_PUBLIC_WYZIE_KEY?.trim();
  if (!key) return { items: [], note: 'Wyzie: нет ключа в .env' };
  const q = [`id=${imdb}`, season && episode ? `season=${season}&episode=${episode}` : '', 'language=ru,en,de', 'format=srt', `key=${encodeURIComponent(key)}`]
    .filter(Boolean)
    .join('&');
  let last = 'нет связи';
  for (const host of WYZIE_HOSTS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(`${host}/search?${q}`, { signal: ctrl.signal });
      if (!res.ok) {
        last = String(res.status);
        continue;
      }
      const list = (await res.json()) as WyzieItem[];
      if (!Array.isArray(list)) return { items: [], note: 'Wyzie: не список' };
      const items = list
        .filter((i) => i.url && i.language && !i.ai)
        // Субтитры для слабослышащих («[музыка]», «[дверь скрипит]») — только если других нет.
        .map((i) => ({ iso: (i.language as string).toLowerCase(), link: i.url as string, score: (i.downloadCount ?? 0) - (i.isHearingImpaired ? 1e9 : 0) }));
      return { items, note: `Wyzie ${items.length}` };
    } catch {
      last = ctrl.signal.aborted ? 'срок' : 'нет связи';
    } finally {
      clearTimeout(t);
    }
  }
  return { items: [], note: `Wyzie: ${last}` };
}

/**
 * СУБТИТРЫ ИЗ СЕТИ ДЛЯ СЕРИИ ИЛИ ФИЛЬМА: оба поставщика сразу, на каждый язык — самый скачиваемый.
 * Wyzie первым при равных: его ссылки живые, у старого API они бывают мёртвыми.
 */
export async function findOnlineSubtitles(imdb: string, season: number | null, episode: number | null): Promise<SubsSearch> {
  const num = imdb.replace(/^tt/, '').replace(/^0+/, '');
  if (!num) return { tracks: [], note: 'нет номера IMDB' };
  const key = `${num}|${season ?? ''}|${episode ?? ''}`;
  const kept = lists.get(key);
  if (kept) return { tracks: kept, note: 'из памяти' };

  const [w, o] = await Promise.all([wyzie(imdb, season, episode), legacy(num, season, episode)]);
  const ISO: Record<string, string> = { rus: 'ru', eng: 'en', ger: 'de', ru: 'ru', en: 'en', de: 'de' };
  const out: SubtitleTrack[] = [];
  for (const { iso, label } of LANGS) {
    const best = (list: { iso: string; link: string; score: number }[]) =>
      list.filter((i) => ISO[i.iso] === iso).sort((a, b) => b.score - a.score)[0];
    const pick = best(w.items) ?? best(o.items);
    if (!pick) continue;
    const id = `${OPENSUBS}${key}:${iso}`;
    links.set(id, pick.link);
    out.push({ label, lang: iso, url: id });
  }
  if (out.length) lists.set(key, out);
  return { tracks: out, note: `${w.note}; ${o.note}` };
}

/** Прежнее имя — для старых вызовов. */
export async function findOpenSubtitles(imdb: string, season: number | null, episode: number | null): Promise<SubtitleTrack[]> {
  return (await findOnlineSubtitles(imdb, season, episode)).tracks;
}

/** Текст выбранных субтитров: скачать архив, распаковать, перекодировать. */
export async function loadOpenSubtitle(id: string): Promise<string | null> {
  const kept = texts.get(id);
  if (kept) return kept;
  const link = links.get(id);
  if (!link) return null;
  try {
    const res = await fetch(link);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Чаще всего это gzip; если вдруг пришёл уже распакованный текст — берём как есть.
    const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzip(bytes) : bytes;
    const text = decodeSmart(raw);
    texts.set(id, text);
    return text;
  } catch {
    return null;
  }
}
