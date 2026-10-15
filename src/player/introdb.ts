import { KEYS } from '../api/sources/keys';

/**
 * ПРОПУСК ЗАСТАВКИ — по TheIntroDB, как у Влада (com.lighttv.data.introdb.IntroDbClient).
 *
 * База знает, где у серии (или фильма) вступление, «ранее в сериале» и титры. Запрос:
 * tmdb_id, у сериала ещё сезон и серия, и длительность файла — по ней база выбирает разметку под
 * нашу версию. Из ответа берётся первое осмысленное вступление (иначе — «ранее в сериале») и
 * начало титров. Ответ помнится на время работы приложения: серия не меняется.
 */
export type Segments = { introStartMs: number; introEndMs: number; creditsStartMs: number | null };

type Seg = { start_ms?: number | null; end_ms?: number | null };
type Dto = { intro?: Seg[]; recap?: Seg[]; credits?: Seg[]; preview?: Seg[] };

const kept = new Map<string, Segments | null>();

function pick(d: Dto): Segments | null {
  const ok = (x: Seg) => x.end_ms != null && x.end_ms > (x.start_ms ?? 0);
  const intro = (d.intro ?? []).find(ok) ?? (d.recap ?? []).find(ok) ?? null;
  const credits = (d.credits ?? []).find((x) => (x.start_ms ?? 0) > 0) ?? null;
  if (!intro && !credits) return null;
  return {
    introStartMs: intro?.start_ms ?? 0,
    introEndMs: intro?.end_ms ?? 0,
    creditsStartMs: credits?.start_ms ?? null,
  };
}

export async function introSegments(
  tmdbId: number,
  isMovie: boolean,
  season: number | null,
  episode: number | null,
  durationMs: number | null,
): Promise<Segments | null> {
  if (!(tmdbId > 0)) return null;
  if (!isMovie && (season == null || episode == null)) return null;
  const key = `${tmdbId}|${season ?? -1}|${episode ?? -1}`;
  if (kept.has(key)) return kept.get(key) ?? null;
  let q = `tmdb_id=${tmdbId}`;
  if (!isMovie) q += `&season=${season}&episode=${episode}`;
  if (durationMs && durationMs > 0) q += `&duration_ms=${Math.round(durationMs)}`;
  try {
    const res = await fetch(`https://api.theintrodb.org/v3/media?${q}`, {
      headers: { Authorization: `Bearer ${KEYS.introDb}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      kept.set(key, null);
      return null;
    }
    const seg = pick((await res.json()) as Dto);
    kept.set(key, seg);
    return seg;
  } catch {
    return null;
  }
}
