import { useTabReselect } from '../nav/useTabReselect';
import { go } from '../nav/navGuard';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { router } from 'expo-router';
import { useNavigation } from 'expo-router';
import Reanimated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { GlassButton } from '../player/ui/GlassButton';
import { MoodRow } from './MoodRow';
import { moodsFor } from '../data/moods';
import { useTabFocus } from '../nav/useTabFocus';
import { LinearGradient } from 'expo-linear-gradient';
import { personalize, type TabFeed } from '../api/feed';
import { useFeedbackVersion } from '../data/feedback';
import { Billboard } from './Billboard';
import { FeedRowList } from './FeedRowList';
import { AmbientGlow, setGlowMood } from './AmbientGlow';
import { LogoWordmark } from './Logo';
import { colors } from '../theme/colors';
import { type as typo } from '../theme/fonts';
import { Motion } from '../theme/motion';
import { usePortraitInsets, usePortraitWindow } from '../nav/portrait';

/**
 * Что происходит при возвращении на вкладку: вспышка света и — если это была именно СМЕНА вкладки —
 * сброс ленты в начало.
 *
 * Отдельным компонентом, и в этом весь смысл: следить за фокусом должен тот, кому это нужно, а не
 * экран целиком. Компонент ничего не рисует, поэтому его собственная пересборка не стоит ничего.
 */
const FocusEffects = memo(function FocusEffects({
  tab,
  enter,
  scrollRef,
}: {
  tab: string;
  enter: Animated.Value;
  scrollRef: React.RefObject<{ scrollTo: (o: { y: number; animated: boolean }) => void } | null>;
}) {
  /*
    Лента перематывается в начало НА ВЫХОДЕ со вкладки, пока её никто не видит (см. useTabFocus).
    Тогда же она ставится в начальное положение появления (прозрачная и чуть ниже) — и при
    возвращении на вкладку въезжает и проявляется. Всё, что нужно для первого кадра, сделано,
    пока экран невидим: системная смена вкладки показывает уже начальное положение, а не
    «готовую страницу, которая потом дёргается».
  */
  const { focused, switched } = useTabFocus(tab, () => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    enter.setValue(0);
  });
  /*
    Вкладка, собранная заранее и невидимая, — в начальное положение появления. Иначе въезд
    проигрывался сразу при сборке (фокус в первый миг считается «есть»), и при первом заходе
    на Фильмы или Сериалы лента стояла уже на месте — «без анимации».
  */
  const nav = useNavigation();
  useEffect(() => {
    if (!nav.isFocused()) enter.setValue(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // «Фокус» в первый миг сборки считается «есть» и у невидимой вкладки — спрашиваем навигацию.
    if (!focused || !nav.isFocused()) return;
    Animated.timing(enter, { toValue: 1, duration: 280, easing: Motion.curve, useNativeDriver: true }).start();
  }, [focused, switched, enter, nav]);

  return null;
});

/*
  ПУНКТЫ ПРОЯВЛЯЮТСЯ ИЗ ПУСТОТЫ — по очереди, при первом показе ленты: каждый следующий блок
  чуть позже предыдущего и слегка снизу. Только первые восемь — то, что ниже экрана, появляется
  без задержки (до него всё равно долистают позже).
*/
const enterAt = (i: number) => FadeInDown.duration(420).delay(Math.min(i, 8) * 70 + 120);

/** Общий экран ленты — под ним живут «Главная», «Фильмы» и «Сериалы». */
export const FeedScreen = memo(function FeedScreen({
  load,
  tab,
  shelf,
}: {
  load: () => Promise<TabFeed>;
  /** Имя вкладки — нужно, чтобы отличить смену вкладки от возвращения с карточки. */
  tab: string;
  /**
   * Что стоит наверху вместо карусели. У «Главной» — свои списки плитками (HomeShelf), у «Фильмов»
   * и «Сериалов» его нет, и там остаётся карусель.
   */
  shelf?: React.ReactNode;
}) {
  const insets = usePortraitInsets();
  const [feed, setFeed] = useState<TabFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fade = useRef(new Animated.Value(0)).current;
  const scrollY = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<{ scrollTo: (o: { y: number; animated: boolean }) => void } | null>(null);
  // Ещё раз нажали вкладку, на которой стоишь, — лента плавно уезжает к началу.
  useTabReselect(() => scrollRef.current?.scrollTo({ y: 0, animated: true }));

  /**
   * СВОЕЙ АНИМАЦИИ ПЕРЕХОДА МЕЖДУ ВКЛАДКАМИ НЕТ, и это осознанно.
   *
   * Здесь стояло проявление со сдвигом снизу вверх. Родная панель показывает новый экран сразу, а
   * useIsFocused узнаёт о переключении уже после кадра — поэтому своё движение начиналось не
   * вместе с переходом, а спустя долю секунды после него, и читалось не как появление экрана, а
   * как прыжок уже показанного содержимого. Системной смены экрана достаточно.
   *
   * САМ ЭКРАН БОЛЬШЕ НЕ СЛЕДИТ ЗА ФОКУСОМ. Он это делал ради двух мелочей — всплеска свечения и
   * подсказки верхней панели, — а платил за них перерисовкой всего дерева при каждом переключении
   * вкладки: свечение, ряды, карточки. Это и есть та работа, из-за которой отклик приходил с
   * задержкой. Теперь про фокус знают только те двое, кому он нужен: вспышка света (FocusPulse) и
   * сама панель.
   */
  const surge = useRef(new Animated.Value(0)).current;
  /*
    Появление вкладки — с НУЛЯ при первом входе. Системные вкладки собирают экраны заранее, при
    запуске приложения, и любая анимация «при монтировании» успевала проиграть невидимо: при
    первом заходе на Фильмы или Сериалы страница просто стояла готовой. Теперь лента ждёт фокуса
    в начальном положении и въезжает, когда вкладку действительно открыли.
  */
  const enter = useRef(new Animated.Value(0)).current;

  // Прокрутку наверх по повторному нажатию на вкладку iOS делает САМА: родная панель знает про
  // список под собой. Свой обработчик здесь был лишним и всё равно не срабатывал — события
  // нажатия нативные вкладки не шлют.

  const run = useCallback(async () => {
    try {
      const f = await load();
      setFeed(f);
      setError(null);
      Animated.timing(fade, {
        toValue: 1,
        duration: Motion.ENTER,
        easing: Motion.curve,
        useNativeDriver: true,
      }).start();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load, fade]);

  useEffect(() => {
    run();
  }, [run]);

  /*
    ВИНЬЕТКА СВЕРХУ — заметнее (октябрь): она есть всегда, уже в покое — больше половины силы, а при прокрутке
    дорастает до полной. Под ней лента уходит под строку состояния не обрезом, а в темноту.
  */
  // useMemo у всех узлов анимации: лента перерисовывается при смене вкладки и открытии страниц,
  // и каждый новый узел — это отцепить и заново прицепить нативную анимацию прямо во время перехода.
  const logoFadeOpacity = useMemo(
    () => scrollY.interpolate({ inputRange: [0, 90], outputRange: [0.55, 1], extrapolate: 'clamp' }),
    [scrollY],
  );

  /*
    ЛОГОТИП И ШЕСТЕРЁНКА НЕ УЕЗЖАЮТ С ЛЕНТОЙ — они стоят на месте и ТАЮТ, когда ленту листают
    вниз, и ВОЗВРАЩАЮТСЯ, как только её потянули вверх (как панели в Safari): за ними не нужно
    листать до самого верха. Решение — по направлению прокрутки, с порогом в несколько точек,
    чтобы дрожание пальца не мигало шапкой. Растаявшие, они не ловят касания (headerLive).

    Заодно здесь же — «Настроение»: ряд жанров на экране — свечение фона окрашивается жанром.
  */
  /*
    ШАПКА СЛЕДУЕТ ЗА ПАЛЬЦЕМ, а не включается анимацией: прозрачность логотипа и шестерёнки —
    это «зажатая» прокрутка (diffClamp) в пределах 56 точек. Листаешь вниз — тают ровно на столько,
    на сколько сдвинул; потянул вверх — проявляются так же, под пальцем, как при смахивании
    страницы. Считается на нативной стороне, без JS.
  */
  const HIDE = 56;
  /*
    Запас «зажатия» больше, чем нужно, чтобы растаять: вниз шапка тает за 56 точек, а обратно
    начинает проявляться, только когда ленту потянули вверх ещё на ~240 точек сверх этого, — от
    случайного движения пальца вверх она больше не выскакивает.
  */
  const HIDE_MAX = 300;
  const headerOpacity = useMemo(
    () =>
      // Оттягивание вниз за верх ленты (отрицательная прокрутка) в счёт не идёт: иначе на отскоке
      // назад к нулю «зажатие» росло, и шапка пропадала. Вверху ленты шапка — постоянная.
      Animated.diffClamp(scrollY.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolateLeft: 'clamp' }), 0, HIDE_MAX).interpolate({
        inputRange: [0, HIDE],
        outputRange: [1, 0],
        extrapolate: 'clamp',
      }),
    [scrollY],
  );
  const [headerLive, setHeaderLive] = useState(true);
  const moodY = useRef<{ y: number; h: number } | null>(null);
  const moodIdx = useRef(0);
  const moodOn = useRef(false);
  /*
    Видна ли карточка настроения хоть краем — тогда её сцены живут; ушла за край или вкладка
    ушла в фон — часы сцен стоят. Проверяется там же, где цвет свечения: по концам движений.
  */
  /*
    Не состояние ленты, а прямой «провод» к карточке: раньше смена видимости перерисовывала ВСЮ
    ленту (все ряды) ровно в момент, когда палец отпускал прокрутку, — отсюда рывок.
  */
  const moodLink = useRef<((on: boolean, wake: boolean) => void) | null>(null);
  const moodLiveNow = useRef(false);
  const moodWake = useRef(false);
  const setMoodLive = useCallback((on: boolean) => {
    if (moodLiveNow.current === on) return;
    moodLiveNow.current = on;
    moodLink.current?.(on, moodWake.current);
  }, []);
  const moodSeen = useRef(false);
  // Вкладки смонтированы заранее: невидимая вкладка не должна гонять сцены настроения.
  const navNow = useNavigation();
  /*
    ПЕРВЫЙ ПОКАЗ ВКЛАДКИ — С АНИМАЦИЕЙ. Фильмы и Сериалы собираются заранее, пока их не видно, и
    поочерёдное проявление рядов проигрывалось в пустоту: при первом заходе лента стояла готовой,
    без движения. Теперь до первого показа лента собирается «впрок» (картинки и логотипы греются),
    а в момент первого показа пересобирается один раз — и ряды проявляются по очереди, как на Главной.
  */
  const [shownOnce, setShownOnce] = useState(() => navNow.isFocused());
  useEffect(() => {
    if (shownOnce) return;
    return navNow.addListener('focus', () => setShownOnce(true));
  }, [navNow, shownOnce]);
  const moodKind = feed?.rows.find((r) => r.style === 'MOOD')?.mood ?? 'all';
  const { height: winH } = usePortraitWindow();
  const applyMood = useCallback(() => {
    const list = moodsFor(moodKind);
    setGlowMood(moodOn.current ? list[Math.min(moodIdx.current, list.length - 1)]?.key ?? null : null);
  }, [moodKind]);
  /*
    НИКАКОЙ РАБОТЫ JS НА КАЖДЫЙ КАДР ПРОКРУТКИ. Раньше за прокруткой следил слушатель значения —
    тридцать-шестьдесят раз в секунду в JS, и на Главной это было заметно (лагало и грело).
    Шапке и свечению «настроения» хватает трёх моментов: палец лёг, палец отпустил (с его
    скоростью — она и говорит, вверх или вниз листают), инерция кончилась.
  */
  // То же «зажатие», что у прозрачности, но в JS и только по концам движений: можно ли касаться
  // шестерёнки (растаявшая не должна ловить нажатия).
  const hdr = useRef({ live: true, clamp: 0, lastY: 0 }).current;
  const track = useCallback(
    (y: number) => {
      const yy = Math.max(0, y);
      hdr.clamp = Math.min(HIDE_MAX, Math.max(0, hdr.clamp + (yy - hdr.lastY)));
      hdr.lastY = yy;
      const next = hdr.clamp < HIDE / 2;
      if (next !== hdr.live) {
        hdr.live = next;
        setHeaderLive(next);
      }
    },
    [hdr],
  );
  const showHeader = useCallback(
    (_: boolean) => {
      hdr.clamp = 0;
      hdr.lastY = 0;
      if (!hdr.live) {
        hdr.live = true;
        setHeaderLive(true);
      }
    },
    [hdr],
  );
  const checkMood = useCallback(
    (y: number) => {
      const m = moodY.current;
      const on = !!m && m.y + m.h * 0.5 > y + winH * 0.12 && m.y + m.h * 0.5 < y + winH * 0.88;
      // Сцены живут, только когда карточка видна хотя бы на треть: краешек у края экрана может
      // и постоять — так анимация не крутится зря, пока листаешь мимо.
      moodSeen.current = !!m && Math.min(m.y + m.h, y + winH) - Math.max(m.y, y) > m.h * 0.35;
      // «Скоро покажется» (до двух экранов) — пора нарисовать сцену заранее, чтобы карточка
      // въезжала уже готовой, а не чёрной.
      if (!moodWake.current && m && m.y < y + winH * 2 && navNow.isFocused()) {
        moodWake.current = true;
        moodLink.current?.(moodLiveNow.current, true);
      }
      setMoodLive(navNow.isFocused() && moodSeen.current);
      if (on !== moodOn.current) {
        moodOn.current = on;
        applyMood();
      }
    },
    [winH, applyMood, navNow, setMoodLive],
  );
  const onDragStart = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      track(e.nativeEvent.contentOffset.y);
      checkMood(e.nativeEvent.contentOffset.y);
    },
    [track, checkMood],
  );
  const onDragEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y;
      track(y);
      checkMood(y);
    },
    [track, checkMood],
  );
  const onGlideEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y;
      track(y);
      checkMood(y);
    },
    [track, checkMood],
  );
  // Ушли с вкладки (или поверх открылась страница) — свет возвращается к своему.
  const nav = useNavigation();
  useEffect(() => {
    const offBlur = nav.addListener('blur', () => {
      setMoodLive(false);
      setGlowMood(null);
    });
    const offFocus = nav.addListener('focus', () => {
      setMoodLive(moodSeen.current);
      applyMood();
      // Лента уже перемотана в начало (см. FocusEffects) — шапка на месте.
      showHeader(true);
    });
    return () => {
      offBlur();
      offFocus();
      setGlowMood(null);
    };
  }, [nav, applyMood, showHeader]);
  const onMoodIndex = useCallback(
    (i: number) => {
      moodIdx.current = i;
      if (moodOn.current) applyMood();
    },
    [applyMood],
  );

  const rowsY = useRef(0);
  const glowShade = useMemo(() => scrollY.interpolate({ inputRange: [0, 320], outputRange: [0, 1], extrapolate: 'clamp' }), [scrollY]);
  const openSettings = useCallback(() => go('/settings'), []);

  const logoScale = useMemo(
    () => scrollY.interpolate({ inputRange: [-120, 0], outputRange: [1.3, 1], extrapolate: 'clamp' }),
    [scrollY],
  );

  // Лайки и дизлайки меняют ленту сразу (см. personalize).
  const fbv = useFeedbackVersion();
  const rows = useMemo(() => (feed ? personalize(feed.rows) : []), [feed, fbv]);
  // Стиль появления ленты и привязка прокрутки — тоже один раз (см. выше про узлы анимации).
  const listStyle = useMemo(
    () => ({
      opacity: Animated.multiply(fade, enter),
      transform: [{ translateY: Animated.add(fade.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }), enter.interpolate({ inputRange: [0, 1], outputRange: [16, 0] })) }],
    }),
    [fade, enter],
  );
  const onListScroll = useMemo(() => Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true }), [scrollY]);

  if (error) {
    return (
      <View style={styles.center}>
        <AmbientGlow />
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (!feed) {
    return (
      <View style={styles.center}>
        <AmbientGlow />
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {/* Живой фон лежит ПОД лентой и не прокручивается вместе с ней: он свет в комнате, а не
          часть содержимого. */}
      <AmbientGlow surge={surge} mood />
      {/*
        СВЕТ ПОДНИМАЕТСЯ ВВЕРХ ПРИ ПРОКРУТКЕ. Наверху ленты свечение — на весь экран; листаешь вниз —
        нижняя часть экрана плавно уходит в чёрное, и свет остаётся только вверху (как на страницах
        с TopGlow); вернулся наверх — снова весь экран. Прозрачность «шторки» следует за прокруткой
        на нативном драйвере.
      */}
      {shelf ? (
        /*
          ГЛАВНАЯ — СВЕТ ТОЛЬКО ВВЕРХУ, у логотипа и шестерёнки и чуть ниже (решение Марка): дальше
          вниз — ровный тёмный фон. Граница — длинным спадом, чтобы свет не обрывался линией.
        */
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(8,8,10,0)', 'rgba(8,8,10,0)', 'rgba(8,8,10,0.7)', colors.bg]}
          locations={[0, (insets.top + 70) / winH, (insets.top + 190) / winH, (insets.top + 300) / winH]}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {/*
        ЛИСТАЕШЬ ВНИЗ — СВЕТ УХОДИТ СОВСЕМ (решение Марка), на всех трёх вкладках: тёмная шторка
        проявляется за первые 320 точек прокрутки; вернулся наверх — свет снова на месте. Прозрачность
        следует за прокруткой на нативном драйвере.
      */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.shade, { opacity: glowShade }]} />
      <FocusEffects tab={tab} enter={enter} scrollRef={scrollRef} />

      <Animated.ScrollView
        key={shownOnce ? 'shown' : 'warm'}
        ref={scrollRef as never}
        // Проявление ОДНО и только при первой загрузке: лента не должна возникать рывком, когда
        // данные наконец пришли. К переключению вкладок это отношения не имеет.
        // Появление — проявлением и подъёмом на 16 точек: и при первой загрузке, и при входе на вкладку.
        style={listStyle}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onListScroll}
        onScrollBeginDrag={onDragStart}
        onScrollEndDrag={onDragEnd}
        onMomentumScrollEnd={onGlideEnd}
        // Пружина с обеих сторон — родное поведение iOS; без неё список ощущается приклеенным.
        bounces
        alwaysBounceVertical
        // БЕЗ ЭТОГО ЛЕНТА СТОИТ СЛИШКОМ НИЗКО. iOS сама добавляет прокручиваемому списку отступ
        // под строку состояния и под панель вкладок, и лента начиналась ниже верха экрана, а после
        // оттягивания возвращалась в это опущенное положение. Верхняя панель должна доходить до
        // самого верха, поэтому автоотступ здесь только мешает.
        contentInsetAdjustmentBehavior="never"
      >
        <Reanimated.View entering={FadeIn.duration(420)}>{shelf ?? <Billboard items={feed.billboards} scrollY={scrollY} />}</Reanimated.View>
        {/* Виньетка ровно под панелью: её нижний край тёмный, а за лентой светится тёплый фон, и без
            растушёвки между ними видна резкая линия. Градиент продолжает темноту карточки и гасит её
            КНИЗУ, в прозрачность, поэтому свечение проступает постепенно. */}
        {shelf ? null : (
        <LinearGradient
          colors={['rgba(8,8,10,1)', 'rgba(8,8,10,0.66)', 'rgba(8,8,10,0.24)', 'transparent']}
          // Четыре точки вместо двух: двухточечный градиент гаснет линейно, и глаз ловит момент,
          // где он «кончился». Промежуточные сгущают спад у начала и растягивают хвост — граница
          // перестаёт читаться вовсе.
          locations={[0, 0.28, 0.6, 1]}
          style={styles.panelFade}
          pointerEvents="none"
        />
        )}
        <View style={styles.rows} onLayout={(e) => (rowsY.current = e.nativeEvent.layout.y)}>
          {rows.map((row, i) =>
            row.style === 'MOOD' ? (
              <Reanimated.View
                key={row.key}
                entering={enterAt(i)}
                onLayout={(e) => {
                  // Положение ряда в ленте: по нему решается, «на экране ли настроение».
                  moodY.current = { y: e.nativeEvent.layout.y + rowsY.current, h: e.nativeEvent.layout.height };
                  checkMood(hdr.lastY);
                }}
              >
                <MoodRow kind={row.mood ?? 'all'} onIndex={onMoodIndex} liveLink={moodLink} />
              </Reanimated.View>
            ) : (
              <Reanimated.View key={row.key} entering={enterAt(i)}>
                <FeedRowList row={row} />
              </Reanimated.View>
            ),
          )}
        </View>
      </Animated.ScrollView>

      {/* Растушёвка под логотипом: пока лента вверху, логотип лежит на тёмной части кадра и
          читается сам; когда прокручиваешь, под него подъезжает светлое место кадра, и надпись
          теряется. Растушёвка проявляется по мере прокрутки — вверху её нет, чтобы не затемнять
          кадр без нужды. */}
      <Animated.View style={[styles.logoFade, { opacity: logoFadeOpacity }]} pointerEvents="none">
        <LinearGradient
          colors={['rgba(8,8,10,0.96)', 'rgba(8,8,10,0.7)', 'rgba(8,8,10,0.28)', 'transparent']}
          locations={[0, 0.4, 0.72, 1]}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      {/* Логотип ПОВЕРХ панели: панель занимает верх экрана целиком, и место в потоке для шапки
          больше не отводится. */}
      {/* Логотип поверх панели: панель занимает верх экрана целиком, места в потоке для шапки не
          отводится. Поиск отсюда убран — он вернулся в нижнюю панель отдельной вкладкой. */}
      <Animated.View
        style={[styles.logo, { top: insets.top + 4, opacity: headerOpacity, transform: [{ scale: logoScale }] }]}
        pointerEvents="none"
      >
        <LogoWordmark />
      </Animated.View>

      {/* Настройки — шестерёнка справа, на одной линии с логотипом и тает вместе с ним. */}
      <Animated.View
        style={[styles.gear, { top: insets.top - 5, opacity: headerOpacity }]}
        pointerEvents={headerLive ? 'auto' : 'none'}
      >
        {/* Стеклянная кнопка — тот же материал и тот же отклик под пальцем, что у кнопок плеера. */}
        <GlassButton icon="gearshape.fill" size={21} diameter={46} upright onPress={openSettings} />
      </Animated.View>
    </View>
  );
})

const styles = StyleSheet.create({
  shade: { backgroundColor: colors.bg },
  screen: { flex: 1, backgroundColor: colors.bg },
  // Родная панель вкладок плавает поверх содержимого, поэтому лента отступает снизу.
  content: { paddingBottom: 96 },
  // Отрицательный отступ: растушёвка заходит НА нижний край панели, иначе она начиналась бы
  // ниже границы и сама эта граница осталась бы видимой.
  /**
   * Растушёвка начинается РОВНО ПОД карточкой и уходит вниз.
   *
   * Два предыдущих варианта были неверны с разных сторон: обычным блоком в 140 точек она честно
   * отодвигала всю ленту вниз, а с отрицательным верхним отступом ложилась НА карточку и
   * закрывала её подпись с кнопкой.
   *
   * Здесь верхний край стоит на границе карточки, а нижний отступ втягивает следующий блок
   * обратно: в раскладке остаётся всего 14 точек — тот же зазор, что был, — а сам градиент
   * лежит поверх пустого места над первым рядом и гаснет раньше, чем дойдёт до его заголовка.
   */
  panelFade: { height: 90, marginBottom: -76 },
  rows: { paddingTop: 0 },
  logo: { position: 'absolute', left: 18, transformOrigin: 'left center' },
  logoFade: { position: 'absolute', left: 0, right: 0, top: 0, height: 160 },
  gear: { position: 'absolute', right: 12 },
  gearBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { ...typo.bodyMedium, color: colors.muted, textAlign: 'center' },
});
