import type { MediaItem } from '../types/media';
import { TmdbApi, tvState } from '../api/tmdb';
import { mapItem, mapItems } from '../api/mapper';
import { loadMine, mineItems } from './mine';
import { furthestEpisode, titlesByRecent, type TitleProgress, type WatchEntry } from './watchProgress';

/**
 * СПИСКИ ИЗ ЖУРНАЛА ПРОСМОТРА — те, что есть у Влада на телевизоре:
 *   «Новые серии» — сериалы, которые смотришь, а у них вышла серия дальше той, где остановился
 *                   (у Влада — пометка «Новая серия» на карточке);
 *   «Похоже на …» — рекомендации ТМДБ к последнему, что смотрел («Потому что вы смотрели»).
 * «Продолжить просмотр» и «История» живут в watchProgress, «Моё» — в mine.ts.
 */

/** Тайтл из записи журнала — минимальный, но достаточный для страницы и для поиска источника. */
export function itemOfEntry(t: Pick<TitleProgress, 'type' | 'id'>, e: WatchEntry): MediaItem {
  return {
    id: t.id,
    type: t.type,
    title: e.title,
    originalTitle: '',
    overview: '',
    posterUrl: e.posterUrl ?? null,
    backdropUrl: e.backdropUrl ?? null,
    year: null,
    rating: 0,
    releaseDate: null,
    originalLanguage: null,
    genreIds: [],
    voteCount: 0,
  };
}

export type NewEpisode = {
  item: MediaItem;
  season: number;
  episode: number;
  airDate: string | null;
  name: string | null;
  /** Сколько вышло после той, где остановился (в пределах сезона — точно, через сезон — «новый сезон»). */
  ahead: number | null;
};

/** Сериалы из журнала, у которых вышла серия дальше самой дальней просмотренной. */
export async function newEpisodes(limit = 20): Promise<NewEpisode[]> {
  const shows = titlesByRecent()
    .filter((t) => t.type === 'tv')
    .slice(0, limit);
  const found = await Promise.all(
    shows.map(async (t): Promise<NewEpisode | null> => {
      const seen = furthestEpisode('tv', t.id);
      if (!seen) return null;
      const st = await tvState(t.id).catch(() => null);
      const last = st?.last;
      if (!st || !last) return null;
      const newer = last.season > seen.season || (last.season === seen.season && last.episode > seen.episode);
      if (!newer) return null;
      // «Досмотрел до конца» по последней серии: если не досмотрел даже её — это не «новая серия».
      const item = mapItem(st.dto, 'tv') ?? itemOfEntry(t, t.last);
      return {
        item,
        season: last.season,
        episode: last.episode,
        airDate: last.airDate,
        name: last.name,
        ahead: last.season === seen.season ? last.episode - seen.episode : null,
      };
    }),
  );
  return found
    .filter((x): x is NewEpisode => !!x)
    .sort((a, b) => (b.airDate ?? '').localeCompare(a.airDate ?? ''));
}

/** «Похоже на …» — рекомендации к последнему просмотренному. Без истории — популярное за неделю. */
export async function becauseYouWatched(): Promise<{ title: string | null; items: MediaItem[] }> {
  const last = titlesByRecent()[0];
  if (!last) {
    const p = await TmdbApi.trending();
    return { title: null, items: mapItems(p.results) };
  }
  const p = await TmdbApi.recommendations(last.type, last.id);
  return { title: last.last.title, items: mapItems(p.results, last.type) };
}

/**
 * «РЕКОМЕНДАЦИИ» — подборка не к одному тайтлу, а ко всему вкусу сразу.
 *
 * «Похоже на …» берёт рекомендации к последнему просмотренному; здесь же — к пяти последним из
 * истории и трём из «Моё». Что рекомендуют сразу к нескольким, то и выше: совпадение вкусов
 * важнее места в чужом списке. Уже начатое и сохранённое в «Моё» не предлагается — его и так видно.
 */
export async function recommendedForYou(): Promise<MediaItem[]> {
  const recent = titlesByRecent().slice(0, 5).map((t) => ({ type: t.type, id: t.id }));
  await loadMine().catch(() => undefined);
  const mine = mineItems().slice(0, 3).map((m) => ({ type: m.type, id: m.id }));
  const seeds = [...recent, ...mine].filter((s, i, a) => a.findIndex((x) => x.type === s.type && x.id === s.id) === i);
  if (!seeds.length) {
    const p = await TmdbApi.trending();
    return mapItems(p.results);
  }
  const known = new Set([...titlesByRecent().map((t) => `${t.type}-${t.id}`), ...seeds.map((s) => `${s.type}-${s.id}`)]);
  const pages = await Promise.all(
    seeds.map((s) =>
      TmdbApi.recommendations(s.type, s.id)
        .then((p) => mapItems(p.results, s.type))
        .catch(() => [] as MediaItem[]),
    ),
  );
  const score = new Map<string, { item: MediaItem; score: number }>();
  pages.forEach((items, seedIndex) =>
    items.forEach((item, rank) => {
      const k = `${item.type}-${item.id}`;
      if (known.has(k)) return;
      // Ближе к началу чужого списка и к свежему в истории — весомее; повтор складывается.
      const w = 1 / (1 + rank * 0.15) + 1 / (1 + seedIndex * 0.5);
      const have = score.get(k);
      score.set(k, { item, score: (have?.score ?? 0) + w });
    }),
  );
  return [...score.values()].sort((a, b) => b.score - a.score).map((x) => x.item).slice(0, 60);
}
