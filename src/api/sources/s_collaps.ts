import { open as openCollaps, streamHeaders, streamOf } from '../collaps';
import type { Found, Source } from './types';

/**
 * COLLAPS — ВЕСЬ СЕРИАЛ ОДНОЙ СТРАНИЦЕЙ.
 *
 * Обёртка над уже написанным модулем src/api/collaps: тот же запрос, просто ответ переведён на
 * общий язык. Озвучки здесь лежат дорожками внутри файла, поэтому вариант на серию один, а список
 * озвучек уходит в `tracks`.
 */
export const collaps: Source = {
  id: 'collaps',
  typical: 1080,
  name: 'Collaps',
  movie: true,
  serial: true,
  needs: ['imdb', 'kp'],
  async open(ids, signal) {
    /*
      Сначала по IMDb (номер есть сразу), не нашлось — по номеру Кинопоиска. Раньше второй шаг
      срабатывал, только если номер Кинопоиска уже был известен к старту, а обычно его ещё ищут —
      и фильмы, которые Collaps знает только по Кинопоиску, уходили в CDNVideoHub. Теперь номер
      дожидается (ids.kpLater, не дольше 8 с).
    */
    let title = ids.imdb ? await openCollaps({ imdb: ids.imdb }, signal) : null;
    if (!title) {
      const kp = ids.kp ?? (await ids.kpLater?.()) ?? null;
      if (kp) title = await openCollaps({ kp }, signal);
    }
    if (!title) return null;

    const headers = streamHeaders();
    if (title.kind === 'movie') {
      const url = streamOf(title.movie);
      if (!url) return null;
      return {
        kind: 'movie',
        variants: [{ voice: title.movie.voices[0] ?? 'По умолчанию', quality: null, url, headers, captions: title.movie.captions, tracks: title.movie.voices }],
      } satisfies Found;
    }
    return {
      kind: 'serial',
      seasons: title.seasons.map((s) => ({
        season: s.season,
        episodes: s.episodes
          .map((e) => ({
            episode: Number(e.episode),
            title: e.title,
            variants: [
              {
                voice: e.voices[0] ?? 'По умолчанию',
                quality: null,
                url: streamOf(e) as string,
                headers,
                captions: e.captions,
                tracks: e.voices,
              },
            ],
          }))
          .filter((e) => Number.isFinite(e.episode) && e.variants[0].url),
      })),
    };
  },
};
