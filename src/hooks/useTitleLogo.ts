import { useEffect, useState } from 'react';
import { logoUrl } from '../api/tmdb';
import type { MediaItem } from '../types/media';

/**
 * Титульный логотип фильма. Кэш живёт в самом logoUrl(), поэтому пролистывание туда-обратно не
 * дёргает сеть повторно.
 *
 * Возвращает undefined, пока ответа нет, и null, когда логотипа у фильма нет — это РАЗНЫЕ вещи:
 * пока undefined, показывать название текстом рано (иначе оно мигнёт и сменится картинкой), а при
 * null текст — единственный правильный вариант.
 */
export function useTitleLogo(item: MediaItem | null | undefined): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const key = item ? `${item.type}_${item.id}` : null;

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setUrl(undefined);
    logoUrl(item.type, item.id).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
    // key, а не item: объект пересоздаётся при каждом рендере ленты, а фильм тот же.
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return url;
}
