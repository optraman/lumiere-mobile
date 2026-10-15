import type { ImageSourcePropType } from 'react-native';

/**
 * «НАСТРОЕНИЕ» — пять жанровых плиток главной, как у Влада (APK: f5/AbstractC1557j0.f16029b).
 * У каждой свой кадр из APK, жанр фильмов и (если есть) парный жанр сериалов: «Боевики» — это
 * 28 у фильмов и 10759 «Боевик и приключения» у сериалов; у «Романтики» и «Ужасов» сериального
 * жанра нет, там только фильмы.
 */
/**
 * glow — оттенок свечения фона, когда до плитки долистали (у Влада экран за плиткой жанра
 * окрашивается её цветом; его цвета — тёмные фоны #331314 и т. д., здесь — те же тона, только
 * светом: на чёрном свечение должно быть ярче фона).
 */
export type Mood = {
  key: string;
  title: string;
  image: ImageSourcePropType;
  movie: number;
  tv: number | null;
  glow: string;
  /** Подпись на странице настроения — написана в духе самого настроения. */
  word: string;
  blurb: string;
};

export const MOODS: Mood[] = [
  { key: 'action', title: 'Боевики', image: require('../../assets/genres/genre_action.png'), movie: 28, tv: 10759, glow: '#E0563E', word: 'Боевое', blurb: 'Погони на пределе, драки без правил и герои, которые не сдаются до последнего кадра.' },
  { key: 'romance', title: 'Романтика', image: require('../../assets/genres/genre_romance.png'), movie: 10749, tv: null, glow: '#E05C93', word: 'Романтичное', blurb: 'Взгляды, которые говорят больше слов, и истории, после которых хочется кому-нибудь позвонить.' },
  { key: 'comedy', title: 'Комедия', image: require('../../assets/genres/genre_comedy.png'), movie: 35, tv: 35, glow: '#E0A23E', word: 'Смешное', blurb: 'Нелепые ситуации, точные реплики и смех, который не отпускает до самых титров.' },
  { key: 'horror', title: 'Ужасы', image: require('../../assets/genres/genre_horror.png'), movie: 27, tv: null, glow: '#8D5CE0', word: 'Жуткое', blurb: 'Скрип половиц, шёпот в темноте и дверь, которую лучше не открывать. Свет не выключайте.' },
  { key: 'scifi', title: 'Фантастика', image: require('../../assets/genres/genre_scifi.png'), movie: 878, tv: 10765, glow: '#4C8FE0', word: 'Фантастическое', blurb: 'Другие миры, далёкие звёзды и будущее, которое наступило чуть раньше, чем мы ждали.' },
];

export const moodByKey = (k: string) => MOODS.find((m) => m.key === k);

/** Плитки для каталога: у сериалов — только жанры, которые у сериалов есть. */
export const moodsFor = (kind: 'all' | 'movie' | 'tv') => (kind === 'tv' ? MOODS.filter((m) => m.tv != null) : MOODS);
