import { router } from 'expo-router';
import { markPush } from './navGuard';
import { episodeRequest, movieRequest, nextEpisodeOf } from '../api/sources/playback';
import { setPendingPlayback } from '../player/request';
import { itemOfEntry } from '../data/library';
import type { TitleProgress } from '../data/watchProgress';
import { watchOnline } from './openOnline';

/**
 * «ПРОДОЛЖИТЬ» — СРАЗУ В ПЛЕЕР, С ТОГО ЖЕ МЕСТА.
 *
 * Как «Продолжить: …» у Влада: фильм открывается с места остановки; сериал — с серии, на которой
 * остановились, а если она досмотрена — со СЛЕДУЮЩЕЙ (по списку источника: в конце сезона это
 * первая серия следующего). Не нашлось — экран выбора серии, он объяснит, что не так.
 */
export async function resumeTitle(t: TitleProgress): Promise<void> {
  const item = itemOfEntry(t, t.last);
  if (t.type === 'movie') {
    const req = await movieRequest(item).catch(() => null);
    if (req) {
      setPendingPlayback(req);
      (markPush(), router.push('/watch'));
    } else watchOnline(item);
    return;
  }
  let season = Number(t.last.season);
  let episode = Number(t.last.episode);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) {
    watchOnline(item);
    return;
  }
  if (t.finished) {
    const next = await nextEpisodeOf(item, season, episode).catch(() => null);
    if (next) {
      season = next.season;
      episode = next.episode;
    }
  }
  const req = await episodeRequest(item, season, episode).catch(() => null);
  if (req) {
    setPendingPlayback(req);
    (markPush(), router.push('/watch'));
  } else watchOnline(item, { season: String(season), episode: String(episode) });
}
