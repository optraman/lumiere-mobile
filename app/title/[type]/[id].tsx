import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TitleMenuHost } from '../../../src/components/TitleMenu';
import { markPush } from '../../../src/nav/navGuard';
import { useOwnBack } from '../../../src/nav/useOwnBack';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { ScreenBackdrop } from '../../../src/components/ScreenBackdrop';
import { MaterialIcons } from '@expo/vector-icons';
import { TmdbApi, imdbId, logoUrl } from '../../../src/api/tmdb';
import { useLogoLook } from '../../../src/api/logoLook';
import { watchOnline } from '../../../src/nav/openOnline';
import { movieRequest, prewarm } from '../../../src/api/sources/playback';
import { setPendingPlayback } from '../../../src/player/request';
import { LogoMark } from '../../../src/components/LogoMark';
import { mapDetails, mapItems } from '../../../src/api/mapper';
import { formatRuDate, isFutureDate, type MediaDetails, type MediaItem, type MediaType } from '../../../src/types/media';
import { colors } from '../../../src/theme/colors';
import { PAGE_RADIUS } from '../../../src/theme/radii';
import { type as typo, font } from '../../../src/theme/fonts';
import { Motion } from '../../../src/theme/motion';
import { AppButton } from '../../../src/components/AppButton';
import { TitleActions } from '../../../src/components/TitleActions';
import { HeroRating, TitleRatings } from '../../../src/components/TitleRatings';
import { TitleExtras } from '../../../src/components/TitleExtras';
import { MetaPill } from '../../../src/components/MetaPill';
import { TitleMark } from '../../../src/components/TitleMark';
import { PersonChip } from '../../../src/components/PersonChip';
import { PosterCard } from '../../../src/components/PosterCard';
import { FadeInImage } from '../../../src/components/FadeInImage';
import { ExpandableText } from '../../../src/components/ExpandableText';
import { useScreenZoom } from '../../../src/nav/useScreenZoom';
import { useZoomBack } from '../../../src/nav/zoomBack';
import { usePortraitInsets, usePortraitWindow } from '../../../src/nav/portrait';
import { GlassBack, BACK_GAP, BACK_SIZE } from '../../../src/components/GlassBack';

/** На сколько обложка опущена от верха блока. Освободившаяся полоса — чёрный фон страницы, в
 * который растворяется верх кадра (coverFade). */
const COVER_DROP = 54;

/**
 * Высота шва: на столько растворяются верхняя и нижняя кромки постера.
 *
 * Считается В КООРДИНАТАХ САМОГО ПОСТЕРА, поэтому при оттягивании растёт вместе с ним — шов
 * остаётся швом, а не превращается в полоску, отставшую от края.
 */
const SEAM_H = 44;

/** Поля шапки по бокам: слева за ними стоит стрелка «назад». */
// Поля шапки: стрелка (14 + BACK_SIZE) и ещё BACK_GAP — название не касается стеклянной кнопки.
const TOP_BAR_SIDES = 14 + BACK_SIZE + BACK_GAP;
/** Высота марки в шапке: чуть меньше самой строки, чтобы марка не упиралась в её края. */
const TOP_BAR_MARK_H = 30;

/** На сколько максимум может растянуться обложка при оттягивании. */
const MAX_PULL = 600;

export default function DetailsScreen() {
  const params = useLocalSearchParams<{
    type: MediaType;
    id: string;
    poster?: string;
    backdrop?: string;
    title?: string;
  }>();
  const { type, id } = params;
  const { width, height: winH } = usePortraitWindow();
  const insets = usePortraitInsets();

  const [details, setDetails] = useState<MediaDetails | null>(null);
  const [logo, setLogo] = useState<string | null>(null);
  const [recs, setRecs] = useState<MediaItem[]>([]);
  // Разбор логотипа общий с TitleMark (кэш один), поэтому шапка ничего не догружает.
  const logoLook = useLogoLook(logo);
  const [error, setError] = useState<string | null>(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  /**
   * Появление блока людей. Ноль до прихода подробностей, единица — после.
   *
   * Значение живёт в ref и обнуляется вместе с загрузкой: анимация обязана играть РОВНО ОДИН РАЗ,
   * при открытии страницы, а не при каждой перерисовке и не на других экранах.
   */
  const intro = useRef(new Animated.Value(0)).current;
  /**
   * Анимация людей играет, КОГДА БЛОК ДОЕХАЛ ДО ЭКРАНА, и ровно один раз за открытие.
   *
   * Раньше она запускалась по приходу подробностей — то есть почти всегда за кадром: блок стоит
   * ниже полноэкранной обложки, и к моменту, когда до него долистают, движение давно кончилось.
   * Человек видел его только если успевал промотать за первые треть секунды.
   *
   * Поэтому положение блока замеряется (onLayout), а прокрутка сверяется с ним. Флаг снимается
   * вместе с загрузкой страницы: при каждом НОВОМ открытии анимация играет заново, но повторно на
   * той же странице — никогда, иначе она превратилась бы в мигание при каждом проходе мимо.
   */
  const introFired = useRef(false);
  const bodyY = useRef(0);
  const peopleY = useRef(0);
  const lastScroll = useRef(0);
  /**
   * Готовность к показу: страница ещё ОТКРЫВАЕТСЯ примерно треть секунды, и всё это время её
   * содержимое едет и гаснет вместе с анимацией открытия. Анимация, сыгранная в этот момент,
   * не видна вообще — именно это и происходило: блок людей у большинства фильмов помещается на
   * экран сразу, проверка видимости срабатывала на первой же раскладке, и движение проходило
   * под анимацией открытия.
   */
  const introReady = useRef(false);
  /** Блок оценок: где стоит и пора ли играть набегание числа (один раз за открытие). */
  const ratingsY = useRef(0);
  const [ratingsPlay, setRatingsPlay] = useState(false);
  const [imdb, setImdb] = useState<string | null>(null);

  const maybeIntro = useCallback(() => {
    if (!introReady.current) return;
    if (introFired.current) return;
    const top = bodyY.current + peopleY.current;
    // Ноль означает «ещё не замерено»: до первой раскладки судить не о чем.
    if (top === 0) return;
    // Порог в 80 точек: движение должно начинаться, когда блок уже показался, а не когда его
    // верхняя кромка ровно совпала с нижним краем экрана.
    if (lastScroll.current + winH - 80 <= top) return;
    introFired.current = true;
    Animated.timing(intro, {
      toValue: 1,
      duration: Motion.ENTER,
      easing: Motion.curve,
      useNativeDriver: true,
    }).start();
  }, [intro, winH]);

  /*
    СНЯТИЯ СОДЕРЖИМОГО ПЕРЕД УХОДОМ БОЛЬШЕ НЕТ.

    Здесь стоял флаг «закрываюсь»: в момент нажатия страница перерисовывалась без списков, чтобы
    разбор тяжёлого дерева прошёл под анимацией. Смысл был, пока ряды создавали все свои элементы
    разом — шесть десятков картинок. Теперь ряды виртуализованы (см. Rail) и держат по четыре
    элемента, а лишняя перерисовка ровно в момент нажатия стоила дороже, чем экономила: она шла в
    те же миллисекунды, что и анимация закрытия, и не давала ей доиграть.

    Экран снимается один раз — целиком, по окончании движения.
  */
  const goBack = useOwnBack();
  const zoom = useScreenZoom(goBack);

  /*
    ФИЛЬМ ИДЁТ В ПЛЕЕР НАПРЯМУЮ, БЕЗ ЭКРАНА ВЫБОРА.

    Экран «Смотреть онлайн» существует ради одного вопроса — какую серию. У фильма этого вопроса
    нет, и всё, что он там делал, — показывал чёрный прямоугольник с кружком, пока идёт поиск на
    резке, а потом сам себя заменял плеером. Лишний экран в цепочке и лишняя вспышка на глазах.

    Теперь ожидание живёт в самой кнопке: страница остаётся на месте, «Смотреть» крутится, и
    открывается сразу плеер. Ровно как в приложении на телевизоре, где playMovie держит экран
    источника и переводит в плеер уже с готовой ссылкой.

    Не получилось — уходим на тот же экран выбора: он умеет объяснить, ЧТО именно не вышло, и
    страницу резки к этому времени держит короткая память клиента, так что второй заход дешёвый.
  */
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const startWatching = useCallback(async (it: MediaItem) => {
    if (it.type !== 'movie') {
      watchOnline(it);
      return;
    }
    if (startingRef.current) return;

    /*
      УЖЕ ОТКРЫВАЛИ — ЗНАЧИТ ОТКРЫВАЕМ МГНОВЕННО.

      Спрашиваем это ПЕРВЫМ делом, до всякого поиска. Адрес у резки одноразовый и со сроком; пока
      прежний годен, к ней идти незачем вовсе — ни за страницей, ни за потоками, — а кэш на диске
      попадает именно в тот адрес, который уже качали.
    */
    const ready = null;
    if (ready) {
      setPendingPlayback(ready);
      (markPush(), router.push('/watch'));
      return;
    }

    startingRef.current = true;
    setStarting(true);
    try {
      const req = await movieRequest(it);
      // Не нашли или это оказался сериал — отдаём экрану «Смотреть»: он покажет либо список серий,
      // либо честный отказ. Решать это здесь значило бы дублировать его логику.
      if (!req) {
        watchOnline(it);
        return;
      }
      setPendingPlayback(req);
      (markPush(), router.push('/watch'));
    } catch {
      watchOnline(it);
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, []);
  const startClose = useCallback((v = 0) => zoom.close(v), [zoom]);

  /*
    ПРОГРЕВ ИСТОЧНИКОВ — пока человек читает страницу. К нажатию «Смотреть» номер Кинопоиска,
    список озвучек и ссылка на фильм обычно уже готовы, и плеер открывается почти сразу.
  */
  const warmItem = details?.item ?? null;
  useEffect(() => {
    if (!warmItem) return;
    // Не в момент открытия страницы: опрос источников — тяжёлая работа JS, и в первые доли
    // секунды она отнимала кадры у разворота и прокрутки. Через 1.2 с человек ещё читает.
    const t = setTimeout(() => prewarm(warmItem), 1200);
    return () => clearTimeout(t);
  }, [warmItem]);

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    intro.setValue(0);
    introFired.current = false;
    introReady.current = false;
    bodyY.current = 0;
    peopleY.current = 0;
    ratingsY.current = 0;
    setRatingsPlay(false);
    setImdb(null);
    setLogo(null);
    setRecs([]);
    setError(null);

    TmdbApi.details(type, Number(id))
      .then((dto) => {
        if (cancelled) return;
        const mapped = mapDetails(dto, type);
        if (!mapped) setError('Не удалось разобрать ответ TMDB');
        else setDetails(mapped);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));

    // Логотип и рекомендации — отдельными запросами: у многих тайтлов нет ни того, ни другого, и
    // это нормальное состояние, а не ошибка, роняющая страницу.
    imdbId(type, Number(id))
      .then((v) => !cancelled && setImdb(v))
      .catch(() => {});
    logoUrl(type, Number(id))
      .then((u) => !cancelled && setLogo(u))
      .catch(() => {});
    TmdbApi.recommendations(type, Number(id))
      .then((p) => !cancelled && setRecs(mapItems(p.results, type).filter((m) => m.posterUrl)))
      .catch(() => {});

    // Ждём, пока отыграет открытие страницы, и только потом смотрим, виден ли блок людей. Если
    // виден — он въезжает прямо сейчас; если нет — дождётся прокрутки.
    const t = setTimeout(() => {
      introReady.current = true;
      setRatingsPlay(true);
      maybeIntro();
    }, 420);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [type, id, intro, maybeIntro]);


  // Жест «назад» тянет ту же величину в обратную сторону: страница уменьшается и гаснет под пальцем.
  /*
    ЖЕСТ РАБОТАЕТ В JS-ПОТОКЕ, И ЭТО НАМЕРЕННО.

    По умолчанию обработчики жеста — ворклеты: они выполняются в потоке отрисовки, а всё, к чему
    прикасаются, должно уметь туда скопироваться. Наши анимации на этой странице построены на
    Animated из React Native, и Animated.Value скопировать туда нельзя — отсюда и «Cannot copy
    value of type AnimatedValue» после обновления: раньше обёртка runOnJS брала функцию по ссылке,
    теперь она копирует и всё её замыкание, а в замыкании как раз лежит эта величина.

    Выход не в том, чтобы переписать страницу на общие величины reanimated — она и не нуждается в
    потоке отрисовки, вся её анимация и так идёт нативным драйвером. Достаточно сказать жесту, где
    ему работать: runOnJS(true) — и обработчики становятся обычными функциями, а обёртки не нужны
    вовсе.
  */
  const back = useZoomBack({
    setProgress: zoom.setProgress,
    settleOpen: zoom.settleOpen,
    close: startClose,
  });

  // Шапка страницы — КАДР (широкая афиша), как и было раньше. Вертикальный постер занимал почти
  // весь экран и оставлял содержимому щель внизу.
  //
  // Ссылка приходит параметрами от карточки, поэтому картинка есть уже в ПЕРВОМ кадре анимации —
  // иначе разворачивался бы пустой прямоугольник, пока идёт запрос. Вертикальный постер оставлен
  // запасным вариантом: у части тайтлов кадра в TMDB просто нет.
  const cover = params.backdrop || details?.item.backdropUrl || params.poster || null;
  const coverH = Math.round(width * 1.02);
  /*
    ПОДЛОЖКА БЕРЁТСЯ ИЗ МАЛЕНЬКОЙ КОПИИ КАДРА.

    blurRadius в iOS — это не «свойство вида», а настоящий проход по пикселям: система размывает
    ДЕКОДИРОВАННУЮ картинку, и делает это на главном потоке в момент показа. Для кадра шириной в
    1280 точек и радиуса 28 это заметная работа — как раз в те миллисекунды, когда открывается
    страница.
    Размытому изображению разрешение не нужно: копия в 300 точек, размытая и увеличенная втрое,
    неотличима от такой же из большой, а стоит в двадцать раз дешевле.
  */

  /**
   * ПОЯВЛЯЮЩАЯСЯ ШАПКА.
   *
   * Название фильма живёт внизу обложки. Когда его подтягивает к верху экрана, читать его там уже
   * нельзя — оно уезжает под часы и под стрелку «назад». Поэтому в этот момент оно переходит в
   * шапку: тот же логотип, только мелкий и на стеклянной полосе.
   *
   * Порог считается от ВЫСОТЫ ОБЛОЖКИ, а не от фиксированного числа: обложка занимает разную долю
   * экрана на разных телефонах, и жёсткий порог срабатывал бы то рано, то поздно. Переход занимает
   * 60 точек прокрутки — достаточно, чтобы не мигать на дрожании пальца.
   */
  /*
    ВЕСЬ ГРАФ АНИМАЦИИ СТРОИТСЯ ОДИН РАЗ (useMemo по scrollY и coverH), а не на каждой перерисовке.
    Страница при открытии перерисовывается 6–8 раз (подробности, логотип, рекомендации, IMDb...), и
    каждый раз заново создавались полтора десятка интерполяций: Animated отвязывал старые узлы от
    нативного драйвера и привязывал новые — ровно во время анимации разворота. Значения и формулы
    те же самые, меняется только то, что объекты больше не пересоздаются.
  */
  const anim = useMemo(() => {
  const headerAt = Math.max(coverH - 150, 60);
  const headerIn = scrollY.interpolate({
    inputRange: [headerAt, headerAt + 60],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });


  /**
   * Оттягивание страницы вниз ведёт себя как на главной: обложка растягивается вниз, оставаясь
   * приколотой к верху, а кадр внутри РАВНОМЕРНО увеличивается.
   *
   * Обратная величина берётся через Animated.divide, а не второй интерполяцией: обратное к
   * линейному росту нелинейно, и линейная «компенсация» сходилась бы только в крайних точках, а на
   * полпути кадр заметно вытягивало.
   */
  const holdTop = scrollY.interpolate({
    inputRange: [-MAX_PULL, 0, 1],
    outputRange: [-MAX_PULL, 0, 0],
  });
  const stretch = scrollY.interpolate({
    inputRange: [-MAX_PULL, 0, 1],
    outputRange: [1 + MAX_PULL / coverH, 1, 1],
  });
  const unstretch = Animated.divide(1, stretch);
  /**
   * Обложка остаётся на месте, пока страница уезжает вверх: сдвигается вниз ровно на величину
   * прокрутки, поэтому на экране стоит неподвижно, а страница «проезжает» по ней.
   *
   * Стоит ПЕРВЫМ среди преобразований: они применяются как умножение матриц, и то, что раньше,
   * действует в координатах родителя и не масштабируется последующими scale.
   */
  const pin = scrollY.interpolate({
    inputRange: [0, coverH],
    outputRange: [0, coverH],
    extrapolate: 'clamp',
  });

  // Сильнее, чем было (1.5): постер должен заметно расти под пальцем (просьба Марка).
  const pullZoom = scrollY.interpolate({
    inputRange: [-MAX_PULL, 0],
    outputRange: [2.3, 1],
    extrapolate: 'clamp',
  });

  /**
   * ОТТЯГИВАНИЕ ШАПКИ: чем сильнее тянут страницу вниз, тем шире расходится её содержимое.
   *
   * Каждая строка едет вниз СВОИМ множителем — слоган меньше всех, кнопка сильнее, строка с
   * оценкой сильнее всех, а текст страницы под ними — сильнее её (иначе строка с оценкой наезжала
   * бы на описание).
   *
   * Множители подобраны с двух попыток: вдвое больших нынешних хватало, чтобы блок разлетался на
   * части, вдвое меньших — чтобы движение перестало читаться вовсе. Ориентир простой: на обычной
   * оттяжке пальцем строки должны заметно разойтись, но остаться одним блоком. Одинаковый сдвиг был бы просто сдвигом блока; разные множители
   * РАЗДВИГАЮТ строки между собой, и от этого возникает ощущение, что растягивается само
   * пространство, а не едет картинка.
   *
   * Название не едет, а РАСТЁТ — тем же приёмом, каким на главной растёт логотип «Люмьера»: оно
   * стоит в вершине блока, и сдвигать его некуда, а рост читается как то же самое усилие.
   *
   * Обратно всё возвращает СОБСТВЕННЫЙ отбой прокрутки iOS: значения считаются прямо из
   * scrollY, поэтому отпущенная страница пружинит их назад ровно так же, как саму себя.
   * Своя пружина поверх системной спорила бы с ней и давала бы двойное движение.
   */
  const pull = scrollY.interpolate({
    inputRange: [-MAX_PULL, 0],
    outputRange: [MAX_PULL, 0],
    extrapolate: 'clamp',
  });
  const spread = (k: number) => Animated.multiply(pull, k);

  const titleGrow = scrollY.interpolate({
    inputRange: [-260, 0],
    outputRange: [1.10, 1],
    extrapolate: 'clamp',
  });

  /**
   * Преобразование кадра — ОДНО на все его копии.
   *
   * Копий теперь несколько: сама обложка и слои перехода в размытие сверху. Все они обязаны
   * двигаться совершенно одинаково, иначе на прокрутке резкий слой поедет относительно размытого и
   * кромка «раздвоится». Общий массив гарантирует это лучше любого копирования.
   */
  const coverTransform = [
    { translateY: pin },
    { scaleX: pullZoom },
    // Вертикаль делится на растяжение: кадр увеличивается равномерно и не вытягивается вслед за
    // обложкой.
    { scaleY: Animated.multiply(pullZoom, unstretch) },
  ];

  // Готовые стили для анимированных блоков — тоже один раз: новые объекты стилей с Animated-
  // узлами на каждой перерисовке заставляли Animated заново подключать их к нативному драйверу.
  return {
    headerIn,
    coverTransform,
    coverBoxStyle: {
      height: coverH,
      overflow: 'hidden' as const,
      // Скругление НА САМОЙ ОБЛОЖКЕ, а не только на листе страницы.
      //
      // Лист скруглён тоже, но этого мало: у обложки собственный трансформ (привязка к
      // верху и растяжение при оттягивании), а трансформированный ребёнок не обязан
      // обрезаться скруглением родителя — на практике углы картинки оставались прямыми и
      // перекрывали скругление листа. Своё скругление снимает этот вопрос целиком.
      //
      // Радиус тот же, что у листа: обложка лежит вплотную к его краям, без отступа,
      // поэтому по концентричности их контуры совпадают.
      borderTopLeftRadius: PAGE_RADIUS,
      borderTopRightRadius: PAGE_RADIUS,
      // Верх обложки ПРИКОЛОТ к верху экрана, низ уходит вниз — то же поведение, что у
      // карточки на главной. Без обратного сдвига обложка уезжала бы вниз вместе со всей
      // страницей, открывая над собой полосу фона.
      transform: [{ translateY: holdTop }, { scaleY: stretch }],
      transformOrigin: 'top' as const,
    },
    vignetteStyle: [
      styles.vignette,
      { height: Math.round(coverH * 0.58), transform: [{ scaleY: unstretch }] },
    ],
    titleGrowStyle: { width: '100%' as const, transform: [{ scale: titleGrow }] },
    taglineStyle: [styles.heroTagline, { transform: [{ translateY: spread(0.045) }] }],
    ctaStyle: [styles.ctaRow, { transform: [{ translateY: spread(0.11) }] }],
    metaStyle: [styles.metaRow, { transform: [{ translateY: spread(0.19) }] }],
    bodyStyle: [styles.body, { transform: [{ translateY: spread(0.23) }] }],
    // Обработчик прокрутки — тоже один: новый Animated.event на каждой перерисовке
    // перепривязывался к нативному событию прокрутки.
    onScroll: Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
      useNativeDriver: true,
    }),
  };
  }, [scrollY, coverH]);
  const { headerIn, coverTransform } = anim;

  // Въезд блока людей: интерполяция и стиль строятся один раз, а не на каждой перерисовке.
  const introStyle = useMemo(
    () => ({
      opacity: intro,
      transform: [{ translateX: intro.interpolate({ inputRange: [0, 1], outputRange: [36, 0] }) }],
    }),
    [intro],
  );

  /*
    НЕВЫШЕДШЕЕ — БЕЗ «СМОТРЕТЬ» (просьба: «фильмы, которые ещё не вышли, должны быть без кнопки
    „смотреть“»). Смотреть ещё нечего: кнопка вела бы в поиск источников, который заведомо пуст.
    Фильм: даты выхода нет (и TMDB не считает его вышедшим) или она ещё впереди. Сериал: нет даты
    первого показа или она впереди. Сравнение — с сегодняшним днём по местному времени (isFutureDate).
    Остальные действия («Моё», кинофест и т.д.) остаются.
  */
  const releaseDate = details?.item.releaseDate || null;
  const unreleased = details
    ? releaseDate
      ? isFutureDate(releaseDate)
      : !(details.item.type === 'movie' && details.status === 'Released')
    : false;
  // Вместо года — дата выхода тем же тегом: у невышедшего это и есть главный ответ «когда».
  const releaseLabel = unreleased ? formatRuDate(releaseDate) : null;

  return (
    <View style={styles.root} pointerEvents={zoom.interactive ? 'auto' : 'none'}>
      {/*
        Фон позади ЗАТЕМНЯЕТСЯ, а не размывается, — см. ScreenBackdrop, там причина расписана
        целиком. Коротко: полноэкранное размытие с анимируемой прозрачностью поверх экрана с
        движущимся свечением пересчитывается каждый кадр и не даёт анимации доехать до конца. Под
        непрозрачной страницей его всё равно не видно.
      */}
      <ScreenBackdrop style={zoom.backdropStyle} />

      <GestureDetector gesture={back}>
        <Animated.View
          style={[styles.page, zoom.pageStyle]}
        >
          <Animated.ScrollView
            contentContainerStyle={{ paddingBottom: 96 }}
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={anim.onScroll}
            /*
              Положение для «пора ли показать блок людей» — только когда палец отпустил и когда
              инерция кончилась. Раньше сюда приходил КАЖДЫЙ кадр прокрутки (слушатель на событии),
              то есть JS работал всё время, пока листают страницу.
            */
            onScrollEndDrag={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
              lastScroll.current = e.nativeEvent.contentOffset.y;
              maybeIntro();
            }}
            onMomentumScrollEnd={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
              lastScroll.current = e.nativeEvent.contentOffset.y;
              maybeIntro();
            }}
            // БЕЗ ЭТОГО СВЕРХУ ЧЁРНАЯ ПОЛОСА. iOS по умолчанию сама отодвигает содержимое списка
            // из-под строки состояния, и обложка съезжала вниз, открывая почти чёрный фон страницы.
            // Полосу давала не шапка — её здесь нет вовсе — а этот автоматический отступ.
            contentInsetAdjustmentBehavior="never"
          >
            {/* Стиль обложки (скругление, привязка к верху, растяжение) — в anim выше. */}
            <Animated.View style={anim.coverBoxStyle}>
              {cover && (
                <>
                  {/*
                    СВЕРХУ — ФЕЙД В ЧЁРНЫЙ (октябрь). Здесь была размытая копия кадра «по среднему
                    цвету», и верх страницы окрашивался в цвет афиши. Теперь полоса над кадром —
                    просто чёрный фон страницы, а сам кадр растворяется в него (см. CoverArt).
                  */}
                  <CoverArt
                    uri={cover}
                    width={width}
                    height={coverH - COVER_DROP}
                    transform={coverTransform}
                  />
                  {/*
                    ВИНЬЕТКА — ОТДЕЛЬНЫЙ СЛОЙ НАД ПОСТЕРОМ И ПОД НАЗВАНИЕМ. Не часть кадра: она
                    затемняет не картинку, а то место экрана, где под ней стоит название, и обязана
                    накрывать всё, что там окажется, — хоть постер, хоть подложку.

                    ПРИКОЛОТА К НИЗУ ОБЛОЖКИ и не растягивается вместе с ней: собственный масштаб
                    обратен растяжению, точка отсчёта — низ. Нижний край обложки при оттягивании
                    стоит на экране неподвижно, поэтому и виньетка стоит неподвижно, какой бы
                    длины ни была оттяжка. Без этой поправки она растягивалась впятеро и уезжала
                    вниз вместе со страницей.

                    Последний отрезок доводится до ПЛОТНОГО цвета фона: иначе у самого низа
                    остаётся десятая доля картинки, и ровно она рисует границу, за которой
                    начинается фон страницы.
                  */}
                  <Animated.View style={anim.vignetteStyle} pointerEvents="none">
                    <LinearGradient
                      colors={['transparent', 'rgba(8,8,10,0.15)', 'rgba(8,8,10,0.75)', colors.bg]}
                      locations={[0, 0.45, 0.82, 1]}
                      style={StyleSheet.absoluteFill}
                    />
                  </Animated.View>
                </>
              )}

            </Animated.View>

            {/* Название, строка с оценкой и кнопка — ПО ЦЕНТРУ, единым блоком под обложкой. */}
            <View style={styles.hero}>
              {/* Ширина обязана остаться полной: марка внутри центрируется по ней, а обёртка
                  только масштабирует. */}
              <Animated.View style={anim.titleGrowStyle}>
                <TitleMark
                  logoUrl={logo}
                  title={details?.item.title ?? params.title ?? ''}
                  textStyle={styles.titleText}
                />
              </Animated.View>

              {details && (
                <>
                  {/*
                    ПОРЯДОК: название → слоган → «Смотреть» → оценка и теги.

                    Слоган поднят сюда из текста страницы: это подпись к названию, фраза с афиши, и
                    стоять она должна при названии, а не через экран от него. Кнопка идёт сразу за
                    ней, потому что она и есть ответ на вопрос, ради которого страницу открыли.
                    Оценка с тегами — уточнение, которое читают уже после решения, поэтому они
                    уходят под кнопку.
                  */}
                  {details.tagline ? (
                    <Animated.Text
                      style={anim.taglineStyle}
                      numberOfLines={3}
                    >
                      {details.tagline}
                    </Animated.Text>
                  ) : null}
                  {/*
                    «Смотреть», «Моё» и «Скачать» — ОДНОЙ СТРОКОЙ: круглые кнопки стоят рядом со
                    «Смотреть», той же высоты, а не отдельным рядом под ней.
                  */}
                  <Animated.View style={anim.ctaStyle}>
                  {/* Не вышло — кнопки нет (см. unreleased); круглые кнопки остаются по центру. */}
                  {!unreleased && (
                  <AppButton
                    text="Смотреть"
                    icon="play-arrow"
                    variant="Primary"
                    style={styles.watchButton}
                    /*
                      «Смотреть» ведёт СРАЗУ к просмотру, без промежуточных вопросов: у фильма —
                      прямо в плеер, у сериала — к выбору серии. Откуда возьмётся поток, человека
                      не спрашивают: это наша забота, а не его (правило Влада).
                    */
                    busy={starting}
                    outline
                    onPress={() => void startWatching(details.item)}
                  />
                  )}
                  <TitleActions item={details.item} unreleased={unreleased} />
                  </Animated.View>
                  {/* Оценка стоит В ОДНОЙ СТРОКЕ с годом, длительностью и жанрами — это всё
                      ответ на один вопрос «что это за фильм», и разносить его на две строки незачем. */}
                  <Animated.View
                    style={anim.metaStyle}
                  >
                    {/* Оценка TMDB — на прежнем месте, но набегает от нуля, как у Влада. */}
                    <HeroRating rating={details.item.rating} play={ratingsPlay} />
                    {releaseLabel ? (
                      <MetaPill text={`Выйдет ${releaseLabel}`} />
                    ) : details.item.year ? (
                      <MetaPill text={details.item.year} />
                    ) : null}
                    {details.runtimeMinutes ? (
                      <MetaPill text={`${details.runtimeMinutes} мин`} />
                    ) : null}
                    {details.genres.slice(0, 4).map((g) => (
                      <MetaPill key={g.id} text={g.name} />
                    ))}
                    {/* Студии — тем же видом, что жанры, только текст. */}
                    {details.studios.map((st) => (
                      <MetaPill key={`s-${st}`} text={st} />
                    ))}
                  </Animated.View>
                </>
              )}
            </View>

            <Animated.View
              style={anim.bodyStyle}
              onLayout={(e) => {
                bodyY.current = e.nativeEvent.layout.y;
                maybeIntro();
              }}
            >
              {details && (
                <>
                  {details.item.overview ? (
                    <ExpandableText text={details.item.overview} style={styles.overview} />
                  ) : null}

                  {/* Оценки (Rotten Tomatoes, IMDb) и награды — сразу за описанием; люди — ниже. */}
                  <TitleRatings imdb={imdb} />

                  {/* Режиссёр отдельной строкой перед актёрами: он один, и в общем ряду его бы не
                      нашли. У сериалов вместо него создатели — режиссёра сериала не бывает. */}
                  {(details.director || details.creators.length > 0) && (
                    /*
                      Блок ВЪЕЗЖАЕТ СПРАВА и проявляется — только здесь и только при открытии
                      страницы (см. intro). Смысл в том, что режиссёр и создатели появляются не
                      «уже лежащими» на странице, а приходят на неё: взгляд в этот момент как раз
                      спускается с постера, и движение его подхватывает.
                    */
                    <Animated.View
                      onLayout={(e) => {
                        peopleY.current = e.nativeEvent.layout.y;
                        maybeIntro();
                      }}
                      style={introStyle}
                    >
                      <Text style={styles.sectionTitle}>
                        {details.director ? 'Режиссёр' : 'Создатели'}
                      </Text>
                      <Rail
                        data={details.director ? [details.director] : details.creators}
                        keyOf={(p) => String(p.id)}
                        render={(p) => <PersonChip person={p} />}
                      />
                    </Animated.View>
                  )}

                  {details.cast.length > 0 && (
                    <>
                      <Text style={styles.sectionTitle}>В ролях</Text>
                      <Rail
                        data={details.cast.slice(0, 15)}
                        keyOf={(c) => String(c.id)}
                        render={(c) => <PersonChip person={c} />}
                      />
                    </>
                  )}

                  {recs.length > 0 && (
                    <>
                      <Text style={styles.sectionTitle}>Похожее</Text>
                      <Rail
                        data={recs.slice(0, 20)}
                        keyOf={(m) => `${m.type}-${m.id}`}
                        render={(m) => <PosterCard item={m} />}
                      />
                    </>
                  )}

                  <TitleExtras type={type} id={Number(id)} />
                </>
              )}

              {!details && !error && <ActivityIndicator color={colors.accent} style={{ marginTop: 24 }} />}
              {error && <Text style={styles.errorText}>{error}</Text>}
            </Animated.View>
          </Animated.ScrollView>

          {/*
            ПОЛОСА ПОД СИСТЕМНЫМИ ЧАСАМИ. Часы, заряд и связь рисует iOS, поверх нашего кадра, и на
            светлой афише белые значки пропадают.

            Стоит НА СТРАНИЦЕ, а не в обложке, и это принципиально: часы нарисованы у верхнего края
            экрана и никуда оттуда не деваются, значит и подложка под ними обязана стоять там же.
            Внутри обложки она ехала и растягивалась вместе с ней — при оттягивании уползала вниз
            тёмной полосой поперёк кадра, то есть делала ровно обратное тому, зачем нужна.

            Настоящая инверсия значков требует знать светлоту картинки, а её нельзя вычислить:
            доступа к пикселям у Image в React Native нет. Поэтому решается обратная задача — не
            подстроить значки под картинку, а гарантировать им фон: очень мягкое затемнение
            сверху, заметно слабее нижней виньетки. На тёмных афишах его почти не видно, на
            светлых оно и держит читаемость.
          */}
          <LinearGradient
            colors={['rgba(8,8,10,0.55)', 'rgba(8,8,10,0.18)', 'transparent']}
            locations={[0, 0.55, 1]}
            style={styles.topScrim}
            pointerEvents="none"
          />

          {/* Шапка ПОВЕРХ содержимого: она не занимает места в потоке, поэтому её появление
              ничего не сдвигает. pointerEvents none — чтобы не перехватывать касания у страницы. */}
          <Animated.View
            style={[styles.topBar, { paddingTop: insets.top + 4, opacity: headerIn }]}
            pointerEvents="none"
          >
            <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
            <View style={styles.topBarTint} />
            <View style={styles.topBarInner}>
              {logo ? (
                /*
                  В шапке действуют ТЕ ЖЕ правила, что и всюду: размер по площади самой марки и
                  силуэт для чёрных логотипов. Площадь своя и маленькая — здесь марка не заголовок,
                  а ярлык строки: она должна называть фильм, а не спорить с содержимым страницы.
                  Не разобрался файл — как и раньше, вписываем целиком.
                */
                <LogoMark
                  url={logo}
                  look={logoLook ?? null}
                  maxWidth={width - TOP_BAR_SIDES * 2}
                  maxHeight={TOP_BAR_MARK_H}
                  area={3400}
                  minHeight={16}
                />
              ) : (
                <Text style={styles.topBarTitle} numberOfLines={1}>
                  {details?.item.title ?? params.title ?? ''}
                </Text>
              )}
            </View>
          </Animated.View>

          <GlassBack onPress={() => startClose()} style={[styles.close, { top: insets.top + 2 }]} />
        </Animated.View>
      </GestureDetector>
      {/* Своё меню тайтла поверх страницы (корневое — под модальным окном, см. TitleMenu). */}
      <TitleMenuHost />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  /**
   * Верхние углы страницы СКРУГЛЕНЫ, как у листа, поднятого поверх экрана.
   *
   * Радиус — радиус самого дисплея (см. theme/radii): лист лежит вплотную к краям, без отступа,
   * поэтому по правилу концентричности его скругление совпадает с контуром экрана. Меньший радиус
   * дал бы второй контур внутри первого, больший — «съел» бы углы картинки.
   *
   * overflow: 'hidden' обязателен, иначе обложка внутри перекроет скругление своими прямыми углами.
   * В этих углах видна предыдущая страница — она и должна там быть: это признак того, что лист
   * поднят НАД ней, а не заменил её.
   */
  page: {
    flex: 1,
    backgroundColor: colors.bg,
    borderTopLeftRadius: PAGE_RADIUS,
    borderTopRightRadius: PAGE_RADIUS,
    overflow: 'hidden',
  },
  /**
   * Обложка ОПУЩЕНА на COVER_DROP и на столько же ниже ростом, поэтому её нижний край остаётся на
   * прежнем месте — содержимое под ней не сдвигается ни на точку.
   */
  cover: {
    position: 'absolute',
    top: COVER_DROP,
    left: 0,
    right: 0,
    bottom: 0,
  },
  topScrim: { position: 'absolute', left: 0, right: 0, top: 0, height: 130 },
  // Полоса перехода начинается ровно там же, где сам постер (COVER_DROP), — размывается ТОЛЬКО он.
  // Середина постера: та же коробка, что у кадра, но без полос швов сверху и снизу.
  coverCore: {
    position: 'absolute',
    top: SEAM_H,
    left: 0,
    right: 0,
    bottom: SEAM_H,
    overflow: 'hidden',
  },
  seam: { position: 'absolute', left: 0, right: 0, height: SEAM_H, overflow: 'hidden' },
  vignette: { position: 'absolute', left: 0, right: 0, bottom: 0, transformOrigin: 'bottom' },
  coverFade: { position: 'absolute', top: 0, left: 0, right: 0, height: SEAM_H + 170 },
  coverWash: {
    ...StyleSheet.absoluteFill,
    width: '100%',
    height: '100%',
    // Втрое крупнее: в видимую полосу попадает небольшой участок кадра, и он читается как ровный
    // цвет афиши, а не как её уменьшенная копия.
    transform: [{ scale: 3 }],
  },
  // Блок под обложкой: всё по центру. Отрицательный отступ — название заходит на нижний край
  // обложки, где виньетка уже тёмная, поэтому читается без отдельной подложки.
  hero: { alignItems: 'center', paddingHorizontal: 20, marginTop: -54 },
  logo: { width: '80%', height: 58 },
  /**
   * Дисплейный Bounded ВЕРНУЛСЯ, но утолщён.
   *
   * В гарнитуре ровно один вес (700) — другого файла просто нет, а системный псевдожирный для
   * шрифтов, подключённых файлом, не работает. Поэтому толщина добирается тенью ТОГО ЖЕ ЦВЕТА с
   * нулевым смещением: она обводит глиф по контуру и делает штрих чуть плотнее, не трогая форму
   * букв. Радиус намеренно маленький — больше единицы уже читается как размытие, а не как вес.
   */
  titleText: {
    fontFamily: font.display,
    fontSize: 26,
    letterSpacing: -0.5,
    color: colors.onBg,
    textShadowColor: colors.onBg,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 0.7,
    textAlign: 'center',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    // Перенос вернулся: теперь это не «плашка плюс длинный текст», а набор отдельных тегов —
    // они переносятся поштучно и строятся в аккуратные строки, а не уезжают целым абзацем.
    // Небольшой зазор: плашка оценки — часть той же фразы, что и год с жанрами, а не отдельный
    // элемент рядом. С крупным зазором она читалась как оторванная от строки.
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 14,
    paddingHorizontal: 8,
  },
  // textAlign нужен ОТДЕЛЬНО от justifyContent контейнера: контейнер центрирует сам блок
  // текста, а строки ВНУТРИ него по умолчанию прижимаются влево — и при переносе вторая
  // строка стояла не по центру.
  meta: { ...typo.labelMedium, color: colors.mutedWarm, flexShrink: 1, textAlign: 'center' },
  watchButton: {},
  ctaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 },
  body: { paddingHorizontal: 16, paddingTop: 8 },
  heroTagline: {
    ...typo.bodyMedium,
    color: colors.muted,
    fontStyle: 'italic',
    marginTop: 10,
    textAlign: 'center',
  },
  overview: { marginTop: 16 },
  sectionTitle: { ...typo.headlineLarge, color: colors.onBg, marginTop: 26, marginBottom: 12 },
  // Пропорции кадра — 16:9, как у любого кинокадра: другое соотношение обрезало бы композицию.
  frame: { width: 232, height: 130, borderRadius: 0, marginRight: 10 },
  errorText: { ...typo.bodyMedium, color: colors.muted, textAlign: 'center', marginTop: 24 },
  topBar: { position: 'absolute', left: 0, right: 0, top: 0, paddingBottom: 8, overflow: 'hidden' },
  topBarTint: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(8,8,10,0.5)' },
  // Отступы по бокам оставляют место стрелке «назад» слева, чтобы название не наезжало на неё.
  topBarInner: {
    height: 34,
    marginHorizontal: TOP_BAR_SIDES,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topBarLogo: { width: '100%', height: '100%' },
  topBarTitle: { ...typo.titleMedium, color: colors.onBg, textAlign: 'center' },
  close: { position: 'absolute', left: 14 },
  closeCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(8,8,10,0.5)',
  },
});

/**
 * ПОСТЕР С РАСТВОРЁННЫМИ КРОМКАМИ.
 *
 * Задача — чтобы у постера не было видимых границ ни сверху (там подложка из размытой копии
 * кадра), ни снизу (там фон страницы). Не размыть кромку, а сделать так, чтобы её нельзя было
 * показать пальцем.
 *
 * ВСЁ ЛЕЖИТ В ОДНОЙ ПРЕОБРАЗУЕМОЙ ОБЁРТКЕ — и это главное. Прежняя полоса стояла в координатах
 * обложки, а обложка при оттягивании растягивается и едет иначе, чем кадр внутри неё: полоса
 * отставала от кромки, и граница снова открывалась глазу ровно в тот момент, когда её тянут.
 * Здесь кромка и её растворение — части одного элемента и разъехаться не могут в принципе.
 *
 * ГРАДИЕНТ НАСТОЯЩИЙ, А НЕ СТУПЕНЧАТЫЙ. Прозрачность по вертикали средствами React Native не
 * задать, и в первой версии переход был набран десятком полосок разной плотности — их и было
 * видно. Здесь тот же кадр рисуется через SVG с маской-градиентом: плотность меняется попиксельно,
 * ступеням взяться неоткуда.
 *
 * Середина постера при этом обрезана ровно на высоту швов: иначе непрозрачная картинка лежала бы
 * под полупрозрачной кромкой и никакого растворения не получилось бы.
 */
// memo: все пропсы теперь стабильны (transform строится один раз), и обложка с двумя градиентами
// больше не перерисовывается вместе со страницей на каждый пришедший ответ.
const CoverArt = memo(function CoverArt({
  uri,
  width,
  height,
  transform,
}: {
  uri: string;
  width: number;
  height: number;
  transform: ViewStyle['transform'];
}) {
  return (
    /*
      ТОЧКА ОТСЧЁТА — НИЗ КАДРА, и это не мелочь. Приближение при оттягивании считалось от центра,
      поэтому нижняя кромка постера уезжала вверх, открывая под собой светлую размытую подложку —
      ровно ту полосу, которой там быть не должно. От низа кадр растёт ВВЕРХ: низ остаётся на своём
      месте (там же, где название), а верх уходит за край экрана, заодно закрывая подложку и сверху.
    */
    <Animated.View style={[styles.cover, { transform, transformOrigin: 'bottom' }]}>
      {/*
        КРОМКИ — ГРАДИЕНТАМИ, БЕЗ SVG-МАСОК. Раньше верхний и нижний швы были SVG-полотнами с маской,
        в каждое заново рисовался ВЕСЬ кадр в полном размере — дважды на открытие страницы и на
        каждый кадр оттягивания. Это была самая дорогая часть страницы. Кадр теперь один, а кромки
        уходят в чёрное градиентами того же профиля.
      */}
      <Image source={{ uri }} style={StyleSheet.absoluteFill} />
      {/* Верх кадра уходит в чёрный — плотно у края, мягко к середине (раньше это делал SVG-шов). */}
      <LinearGradient
        colors={[colors.bg, 'rgba(8,8,10,0.62)', 'rgba(8,8,10,0.18)', 'rgba(8,8,10,0)']}
        locations={[0, 0.3, 0.62, 1]}
        style={styles.coverFade}
        pointerEvents="none"
      />
      <LinearGradient
        colors={['rgba(8,8,10,0)', colors.bg]}
        style={[styles.seam, { bottom: 0 }]}
        pointerEvents="none"
      />
    </Animated.View>
  );
});

/**
 * РЯД СТРАНИЦЫ — ВИРТУАЛИЗОВАННЫЙ, и это главное лекарство от «после возврата секунду ничего
 * нельзя».
 *
 * Здесь стояли обычные ScrollView, а они создают ВСЕ свои элементы разом: пятнадцать портретов,
 * два десятка кадров, два десятка постеров — под шесть десятков картинок на одной странице. Столько
 * же их потом и разбирается при уходе, и обе операции занимают JS-поток целиком, то есть ровно тот
 * поток, который в этот момент должен отвечать на касания.
 *
 * FlatList держит на экране только видимое: четыре-пять элементов вместо двадцати. Ряд листается
 * так же, а появление и уход страницы становятся в несколько раз дешевле.
 *
 * removeClippedSubviews здесь НЕ ставится: в горизонтальных списках он отвязывает ушедшие за край
 * элементы, и на возврате они появляются пустыми — уже наступали.
 */
function Rail<T>({
  data,
  keyOf,
  render,
}: {
  data: T[];
  keyOf: (item: T) => string;
  render: (item: T) => React.ReactElement;
}) {
  return (
    <FlatList
      data={data}
      horizontal
      scrollsToTop={false}
      showsHorizontalScrollIndicator={false}
      keyExtractor={keyOf}
      renderItem={({ item }) => render(item)}
      initialNumToRender={4}
      maxToRenderPerBatch={4}
      windowSize={3}
    />
  );
}

