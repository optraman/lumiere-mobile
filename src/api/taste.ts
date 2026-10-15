import { TmdbApi } from './tmdb';
import { mapItems } from './mapper';
import { curated } from './curate';
import { THEMES, GENRE_GROUPS, type TasteTag } from './tasteTags';
import { liked, isDisliked } from '../data/feedback';
import { titlesByRecent, titleKey } from '../data/watchProgress';
import type { MediaItem, MediaType } from '../types/media';
import type { FeedRow } from './feed';

/*
  ПЕРСОНАЛЬНЫЕ ПОДБОРКИ — как у Влада (f5/C1574s0 «план вкуса», R4/Y2·X2·W2, f5/a1 — саги).

  «ПОТОМУ ЧТО ВАМ НРАВИТСЯ …» (не больше двух рядов):
    • семена — до 8 лайков (свежие первыми, вес ×1.2) и до 8 досмотренных тайтлов; вес семени
      падает с давностью: w / (1 + 0.2·место);
    • у семян берутся ключевые слова и жанры; кандидаты — 62 темы по ключевым словам («путешествия
      во времени», «космос», «ограбления»…) и 16 групп жанров (их вес ×0.3 — темы почти всегда
      выигрывают у «просто жанра»);
    • очко темы = её вес × сумма весов совпавших семян (семя, уже давшее ряд, — ×0.25); второй ряд
      обязан быть про другое и иметь хоть одно новое семя;
    • содержимое темы — discover по её ключевым словам (фильмы и сериалы), содержимое жанра —
      рекомендации TMDB к семенам в этом жанре; списки перемешиваются раз в час и сплетаются по
      очереди, чтобы одно семя не забило ряд; 6–14 тайтлов, без уже смотренного и без дизлайков.
  «ПРОДОЛЖИМ СМОТРЕТЬ «…»?» (не больше двух) — у досмотренного фильма есть франшиза, а в ней вышли
  части, которых в истории нет.
*/

type Seed = { type: MediaType; id: number; title: string; weight: number; keywords: Set<number>; genres: Set<number> };
type Kind = 'all' | 'movie' | 'tv';

const seen = () => new Set(titlesByRecent().map((t) => titleKey(t.type, t.id)));

async function seeds(kind: Kind): Promise<Seed[]> {
  const raw: { type: MediaType; id: number; title: string; liked: boolean }[] = [];
  const add = (type: MediaType, id: number, title: string, isLiked: boolean) => {
    if (kind !== 'all' && type !== kind) return;
    if (raw.some((r) => r.type === type && r.id === id)) return;
    raw.push({ type, id, title, liked: isLiked });
  };
  liked()
    .slice(0, 8)
    .forEach((e) => add(e.type, e.id, e.title, true));
  titlesByRecent()
    .filter((t) => t.finished && !isDisliked(t.type, t.id))
    .slice(0, 8)
    .forEach((t) => add(t.type, t.id, t.last.title, false));
  const out = await Promise.all(
    raw.map(async (r, rank) => {
      try {
        const d = (await TmdbApi.detailsKeywords(r.type, r.id)) as unknown as {
          genres?: { id: number }[];
          keywords?: { keywords?: { id: number }[]; results?: { id: number }[] };
        };
        const kw = d.keywords?.keywords ?? d.keywords?.results ?? [];
        return {
          type: r.type,
          id: r.id,
          title: r.title,
          weight: (r.liked ? 1.2 : 1) / (1 + 0.2 * rank),
          keywords: new Set(kw.map((k) => k.id)),
          genres: new Set((d.genres ?? []).map((g) => g.id)),
        } as Seed;
      } catch {
        return null;
      }
    }),
  );
  return out.filter((s): s is Seed => s !== null);
}

/** Детерминированное перемешивание: один и тот же порядок в течение часа. */
function shuffle<T>(list: T[], seed: number): T[] {
  const a = [...list];
  let x = seed || 1;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function weave(lists: MediaItem[][], limit: number, used: Set<string>): MediaItem[] {
  const out: MediaItem[] = [];
  for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const m = l[i];
      if (!m || out.length >= limit) continue;
      const k = `${m.type}-${m.id}`;
      if (used.has(k)) continue;
      used.add(k);
      out.push(m);
    }
  }
  return out;
}

const good = (watched: Set<string>) => (m: MediaItem) =>
  m.rating >= 6.5 && !!m.posterUrl && !watched.has(titleKey(m.type, m.id)) && !isDisliked(m.type, m.id);

export async function tasteRows(kind: Kind): Promise<FeedRow[]> {
  const ss = await seeds(kind);
  if (!ss.length) return [];
  const watched = seen();
  const keep = good(watched);
  const hour = Math.floor(Date.now() / 3_600_000);
  const usedSeeds = new Set<number>();
  const usedTags = new Set<string>();
  const usedItems = new Set<string>();
  const rows: FeedRow[] = [];

  type Cand = { tag: TasteTag; theme: boolean; match: Seed[] };
  const cands: Cand[] = [
    ...THEMES.map((t) => ({ tag: t, theme: true, match: ss.filter((s) => t[2].some((k) => s.keywords.has(k))) })),
    ...GENRE_GROUPS.map((t) => ({ tag: t, theme: false, match: ss.filter((s) => t[2].some((g) => s.genres.has(g))) })),
  ].filter((c) => c.match.length > 0);

  for (let r = 0; r < 2; r++) {
    let best: { c: Cand; score: number } | null = null;
    for (const c of cands) {
      if (usedTags.has(c.tag[0])) continue;
      if (!c.match.some((s) => !usedSeeds.has(s.id))) continue;
      const w = c.theme ? c.tag[3] : c.tag[3] * 0.3;
      const score = w * c.match.reduce((n, s) => n + s.weight * (usedSeeds.has(s.id) ? 0.25 : 1), 0);
      if (!best || score > best.score) best = { c, score };
    }
    if (!best) break;
    const { c } = best;
    usedTags.add(c.tag[0]);
    const rowSeeds = [...c.match.filter((s) => !usedSeeds.has(s.id)), ...c.match.filter((s) => usedSeeds.has(s.id))].slice(0, 4);
    rowSeeds.forEach((s) => usedSeeds.add(s.id));

    let lists: MediaItem[][] = [];
    try {
      if (c.theme) {
        const q = (type: MediaType, votes: string) =>
          TmdbApi.discover(type, { with_keywords: c.tag[2].join('|'), sort_by: 'vote_count.desc', 'vote_average.gte': '6.5', 'vote_count.gte': votes })
            .then((p) => curated(mapItems(p.results, type)).filter(keep).slice(0, 24))
            .catch(() => [] as MediaItem[]);
        lists = await Promise.all([kind !== 'tv' ? q('movie', '150') : Promise.resolve([]), kind !== 'movie' ? q('tv', '50') : Promise.resolve([])]);
      } else {
        lists = await Promise.all(
          rowSeeds.map((s) =>
            TmdbApi.recommendations(s.type, s.id)
              .then((p) =>
                curated(mapItems(p.results, s.type))
                  .filter(keep)
                  .filter((m) => m.genreIds.some((g) => c.tag[2].includes(g)))
                  .sort((a, b) => b.rating - a.rating)
                  .slice(0, 24),
              )
              .catch(() => [] as MediaItem[]),
          ),
        );
      }
    } catch {
      lists = [];
    }
    lists = lists.map((l, i) => shuffle(l, 31 * hour + 7 * r + i));
    let items = weave(lists, 14, usedItems);
    if (items.length < 6) {
      // Дотягиваем рекомендациями семян без фильтра жанра — лучшие по оценке.
      const extra = await Promise.all(
        rowSeeds.map((s) =>
          TmdbApi.recommendations(s.type, s.id)
            .then((p) => curated(mapItems(p.results, s.type)).filter(keep))
            .catch(() => [] as MediaItem[]),
        ),
      );
      items = [...items, ...weave([extra.flat().sort((a, b) => b.rating - a.rating)], 6 - items.length, usedItems)];
    }
    if (items.length < 6) {
      items.forEach((m) => usedItems.delete(`${m.type}-${m.id}`));
      continue;
    }
    rows.push({ key: `TASTE:${c.tag[0]}:${kind}`, title: c.tag[1], items, style: 'POSTER', role: 'PLAIN' });
  }
  return rows;
}

/** «Продолжим смотреть «…»?» — следующие части франшиз досмотренных фильмов. */
export async function sagaRows(): Promise<FeedRow[]> {
  const watched = seen();
  const done = titlesByRecent().filter((t) => t.type === 'movie' && t.finished && !isDisliked('movie', t.id));
  const rows: FeedRow[] = [];
  const usedColl = new Set<number>();
  const today = new Date().toISOString().slice(0, 10);
  /*
    Подробности первых двенадцати досмотренных — РАЗОМ, а не по одной: раньше каждый фильм ждал
    предыдущий, и у того, кто досмотрел много фильмов без продолжений, заставка висела до своего
    аварийного выхода. Обход ниже — в том же порядке, результат тот же.
  */
  const heads = done.slice(0, 12).map((t) => TmdbApi.detailsLite('movie', t.id).catch(() => null));
  for (let k = 0; k < done.length; k++) {
    const t = done[k];
    if (rows.length >= 2) break;
    try {
      const d = (await (heads[k] ?? TmdbApi.detailsLite('movie', t.id))) as unknown as { belongs_to_collection?: { id: number; name?: string } | null } | null;
      if (!d) continue;
      const coll = d.belongs_to_collection;
      if (!coll || usedColl.has(coll.id)) continue;
      usedColl.add(coll.id);
      const c = await TmdbApi.collection(coll.id);
      const parts = (c.parts ?? []).slice().sort((a, b) => (a.release_date ?? '9').localeCompare(b.release_date ?? '9'));
      if (parts.length < 2) continue;
      const items = mapItems(parts, 'movie').filter(
        (m) => !watched.has(titleKey('movie', m.id)) && !isDisliked('movie', m.id) && (m.releaseDate ?? '9') <= today,
      );
      if (!items.length) continue;
      const name = (c.name ?? coll.name ?? '').replace(/\s*[(\[]?\s*(коллекция|collection|сага|saga|серия фильмов)\s*[)\]]?\s*$/i, '').trim();
      rows.push({ key: `SAGA:${coll.id}`, title: `Продолжим смотреть «${name}»?`, items, style: 'POSTER', role: 'PLAIN' });
    } catch {
      /* без саги */
    }
  }
  return rows;
}
