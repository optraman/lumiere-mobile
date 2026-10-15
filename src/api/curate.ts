// Портировано из data/tmdb/TmdbRepository.kt (curated/isDroppedLang/hasCjk) и
// data/tmdb/TmdbMapper.kt (mainstream). Это фильтры ЛЕНТЫ, а не поиска: если человек набрал
// название чего-то редкого — он этого хочет, и лента не вправе это прятать. Поэтому поиск через
// них НЕ проходит, ровно как в оригинале.

import type { MediaItem } from '../types/media';

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;

function hasCjk(s: string): boolean {
  return CJK.test(s);
}

// Индийские/филиппинские оригиналы отбрасываются безусловно («полностью удали»).
const HARD_DROP_LANGS = new Set(['hi', 'ta', 'te', 'ml', 'bn', 'kn', 'mr', 'pa', 'gu', 'ur', 'tl', 'fil']);
// Азиатские, кроме корейского — корейский намеренно не входит ни в один из списков.
const ASIAN_NON_KO = new Set(['ja', 'zh', 'cn', 'th', 'vi', 'id', 'ms']);
// Испанский/французский/итальянский/немецкий — тоже безусловно, без исключения для культовых.
const EURO_DROP_LANGS = new Set(['es', 'fr', 'it', 'de']);

/** Проверка по ОРИГИНАЛЬНОМУ языку, не по названию: TMDB отдаёт названия по-русски, так что
 * иероглифов в тексте не видно и одной проверки названия недостаточно. Азиатское неевропейское
 * пропускается только при культовом рейтинге 8.2+ («аниме кроме культовых»). */
function isDroppedLang(item: MediaItem): boolean {
  const lang = item.originalLanguage;
  if (!lang) return false;
  return (
    HARD_DROP_LANGS.has(lang) ||
    EURO_DROP_LANGS.has(lang) ||
    (ASIAN_NON_KO.has(lang) && item.rating < 8.2)
  );
}

/** Ток-шоу / новости / реалити — это отдельные жанры TMDB, поэтому отбрасываются по id, без
 * угадывания по названию. */
const FORMAT_GENRES = new Set([10763, 10764, 10767]);

/**
 * «Малоизвестное» определяется по ЧИСЛУ оценок, а не по самой оценке: тайтл, которому четыре
 * человека поставили 9.1 — это не скрытая жемчужина в ленте, это шум, и сортировка по рейтингу
 * продвигает именно его. Порог намеренно низкий, чтобы по-настоящему нишевое кино, которое люди
 * всё-таки смотрели, осталось.
 */
export function mainstream(items: MediaItem[], minVotes = 200): MediaItem[] {
  return items.filter(
    (i) => !i.genreIds.some((g) => FORMAT_GENRES.has(g)) && i.voteCount >= minVotes,
  );
}

/** Отбрасывает кино с иероглифами в названии, неевропейские оригиналы (культовые 8.2+ — исключение)
 * и всё слабее 6.4. Только для ленты, не для поиска. */
export function curated(items: MediaItem[]): MediaItem[] {
  return items.filter((i) => i.rating >= 6.4 && !hasCjk(i.title) && !isDroppedLang(i));
}
