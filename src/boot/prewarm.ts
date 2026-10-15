import { Image } from 'react-native';
import { cardPoster } from '../api/tmdb';
import { POSTER_WIDTH } from '../components/PosterCard';
import { homeFeed, moviesFeed, tvFeed, type TabFeed } from '../api/feed';
import type { MediaType } from '../types/media';
import { logoUrl } from '../api/tmdb';
import { primeLogoLook } from '../api/logoLook';
import { loadWatchProgress } from '../data/watchProgress';
import { loadSubtitlePrefs } from '../data/subtitlePrefs';
import { loadMine } from '../data/mine';
import { loadFeedback } from '../data/feedback';
import { loadDownloads } from '../downloads/store';
import { BOOT_DELAY_MS, kick as kickDownloads } from '../downloads/engine';

/**
 * ЧТО ГРЕЕТСЯ ПОД ЗАСТАВКОЙ.
 *
 * Смысл заставки не в том, чтобы показать логотип, а в том, чтобы за её время подготовить ПЕРВЫЙ
 * ЭКРАН целиком: и данные, и картинки, и разбор логотипов. Иначе получается то, что и было, —
 * лента появляется пустой, потом в неё по одному влетают постеры, потом на карточках подменяются
 * названия. Каждое такое появление по отдельности быстрое, а вместе они читаются как рвань.
 *
 * Греется ровно то, что видно в первые секунды:
 *  — лента главной целиком (данные);
 *  — кадры всех карточек верхней панели и постеры первых рядов;
 *  — логотипы карточек: и файл, и его разбор.
 *
 * Ленты «Фильмы» и «Сериалы» запускаются, но НЕ ОЖИДАЮТСЯ: держать ради них заставку нельзя —
 * человек пришёл на главную. К моменту, когда он переключит вкладку, они, скорее всего, уже
 * пришли, а если нет — вкладка покажет свою загрузку, как и раньше.
 *
 * ИСТОЧНИК ЗДЕСЬ БОЛЬШЕ НЕ ГРЕЕТСЯ — И ЭТО НЕ ПОТЕРЯ.
 *
 * Раньше под заставкой шла вся подготовка резки: найти живое зеркало, пройти проверку «вы не бот»
 * перебором хэшей, войти под учётной записью. Это была главная причина, по которой заставку вообще
 * держали на экране несколько секунд, — и источник всё равно нередко оказывался не готов.
 *
 * У Collaps готовиться нечему: ни зеркал, ни проверки, ни входа. Первый же запрос — он и есть
 * запрос за фильмом. Поэтому заставка теперь ровно настолько длинная, насколько нужно ленте.
 */

/** Сколько постеров из ряда греем. Больше — дольше заставка, меньше — видно дозагрузку. */
const POSTERS_PER_ROW = 8;
/** Сколько первых рядов греем. Остальные всё равно ниже экрана. */
const ROWS = 3;

async function warmLogo(type: MediaType, id: number): Promise<void> {
  try {
    const u = await logoUrl(type, id);
    if (!u) return;
    await Promise.all([Image.prefetch(u).catch(() => false), primeLogoLook(u)]);
  } catch {
    /* нет логотипа — будет текст */
  }
}

async function warmTab(feed: TabFeed): Promise<void> {
  const banners = feed.rows.filter((r) => r.style === 'BANNER').flatMap((r) => r.items.slice(0, 4));
  await Promise.all([
    ...feed.billboards.map((b) => (b.backdropUrl ? Image.prefetch(b.backdropUrl).catch(() => false) : null)),
    ...feed.billboards.map((b) => warmLogo(b.type, b.id)),
    ...banners.map((b) => warmLogo(b.type, b.id)),
  ]);
}

export async function prewarm(): Promise<void> {
  /*
    Картинки света (пятно и запечённый фон) — в память сразу при запуске: в Expo Go они грузятся с
    сервера разработки, и без этого первый показ свечения на странице был пустым.
  */
  for (const src of [require('../../assets/glow/blob.png'), require('../../assets/glow/ambient_poster.png')]) {
    const uri = Image.resolveAssetSource(src)?.uri;
    if (uri) void Image.prefetch(uri).catch(() => false);
  }


  /*
    Соседние вкладки — в фоне и без ожидания, но ЦЕЛИКОМ: лента, кадры карусели и логотипы её
    карточек (и широких карточек «Сейчас в кино»). Раньше грелась только лента, и при первом заходе
    на Фильмы/Сериалы название в карусели на глазах подменялось логотипом — тот самый «рывок текста».
  */

  // Журналы с диска: они нужны в тот момент, когда человек нажмёт «Смотреть», и читаются мгновенно.
  // «Моё» и загрузки — тоже: главная показывает их плитками с первого кадра. Загрузчик заодно
  // продолжает недокачанное с прошлого раза (downloads/engine.ts).
  await Promise.all([loadWatchProgress(), loadSubtitlePrefs(), loadMine(), loadDownloads(), loadFeedback()]);
  // Загрузки — чуть позже (см. engine.BOOT_DELAY_MS): сейчас сеть нужна ленте под заставкой.
  setTimeout(kickDownloads, BOOT_DELAY_MS);

  const feed = await homeFeed();
  /*
    Фильмы и Сериалы — ПОСЛЕ главной, а не одновременно: их два десятка запросов делили сеть и
    процессор с лентой, которую ждёт заставка. До соседних вкладок человек доберётся не раньше,
    чем через пару секунд, — к тому времени они уже готовы.
  */
  void moviesFeed().then(warmTab).catch(() => {});
  void tvFeed().then(warmTab).catch(() => {});

  const shots: string[] = [];
  for (const b of feed.billboards) if (b.backdropUrl) shots.push(b.backdropUrl);
  for (const r of feed.rows.slice(0, ROWS)) {
    for (const i of r.items.slice(0, POSTERS_PER_ROW)) if (i.posterUrl) shots.push(cardPoster(i.posterUrl, POSTER_WIDTH)); // тот же размер, что покажет карточка
  }

  await Promise.all([
    // Картинки: prefetch кладёт файл в тот же кэш, из которого потом берёт <Image>, поэтому на
    // экране они появятся уже готовыми, без проявления по одной.
    ...shots.map((u) => Image.prefetch(u).catch(() => false)),
    // Логотипы карточек верхней панели: адрес, файл и разбор — всё то, из-за чего название на
    // карточке иначе меняется на глазах.
    ...feed.rows.filter((r) => r.style === 'BANNER').flatMap((r) => r.items.slice(0, 4)).map((b) => warmLogo(b.type, b.id)),
    ...feed.billboards.map(async (b) => {
      try {
        const u = await logoUrl(b.type, b.id);
        if (!u) return;
        await Promise.all([Image.prefetch(u).catch(() => false), primeLogoLook(u)]);
      } catch {
        /* нет логотипа — карточка покажет название текстом, это нормально */
      }
    }),
  ]);
}
