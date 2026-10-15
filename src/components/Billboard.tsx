import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Reanimated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollOffset,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useIsFocused } from 'expo-router';
import type { MediaItem } from '../types/media';
import { colors } from '../theme/colors';
import { type as typo, font } from '../theme/fonts';
import { RatingChip } from './RatingChip';
import { MetaPill } from './MetaPill';
import { AppButton } from './AppButton';
import { openTitle } from '../nav/openTitle';
import { openTitleMenu } from './TitleMenu';
import { useA11ySettings } from '../theme/a11y';
import { BillboardTitle } from './BillboardTitle';
import { usePortraitInsets, usePortraitWindow } from '../nav/portrait';

/** На сколько максимум может растянуться панель при оттягивании. */
const MAX_PULL = 600;
/** Сколько карточка стоит перед автоматической сменой. Девять секунд: семи не хватало, чтобы
 * прочитать слоган и решить, интересно ли. */
const DWELL_MS = 9000;
/**
 * Сколько длится сама автоматическая смена карточки.
 *
 * Столько же, сколько занимала системная анимация прокрутки, которая была здесь раньше — темп
 * не изменился, изменилась только кривая (см. advance).
 */
const GLIDE_MS = 520;
/**
 * ЗАПАС ПРОХОДОВ СЛЕВА — то, чем лента бесконечна В ОБЕ СТОРОНЫ.
 *
 * Вперёд лента дописывается на ходу, а назад дописать нельзя: любая вставка в начало сдвигает всё
 * содержимое, и лента прыгает под пальцем. Поэтому запас назад делается сразу — лента начинается
 * не с первой карточки, а с четвёртого прохода по кругу, и слева от старта лежит два десятка
 * карточек. Свайп вправо с первой карточки показывает последнюю, как и положено кругу.
 */
const LEAD = 4;
/** Сколько проходов дописано вперёд в начале. */
const AHEAD = 3;
/**
 * Насколько кадр отстаёт от пальца при листании, в долях ширины экрана.
 *
 * Ровно столько же составляет запас кадра с каждой стороны (см. стиль image): сдвиг не может
 * выйти за него, поэтому подложка не покажется. Менять эти два числа только вместе.
 */
const PARALLAX = 0.12;
/** Высота кнопки «Смотреть»: подпись 16 + отступы 14 сверху и снизу. Нужна, чтобы поставить
 * указатель ровно на её линию. */
const BUTTON_H = 46;
/** Точка в покое. */
/** Боковые отступы подписи карточки — нужны, чтобы знать, сколько места есть под марку. */
const CAPTION_PAD = 20;
const DOT_W = 6;
/** Во что она вырастает, став активной. */
const BAR_W = 26;

/** Список с анимируемой прокруткой: нужен, чтобы Animated.event работал на нативном драйвере. */
const AnimatedFlatList = Animated.createAnimatedComponent(FlatList);

/** Ключ — номер в ленте: элементы ленты повторяются по кругу, и тайтл сам по себе не уникален. */
const keyByIndex = (_: unknown, i: number) => `${i}`;

/**
 * Верхняя панель с фильмами: бесконечная лента с автопрокруткой.
 *
 * БЕСКОНЕЧНОСТЬ сделана тремя копиями списка и тихим возвратом в середину. Когда прокрутка уходит в
 * первую или третью копию, позиция мгновенно (без анимации) переставляется на такую же карточку в
 * средней — человек этого не видит, потому что картинка под пальцем не меняется, а запас для
 * листания в обе стороны восстанавливается. Это дешевле и надёжнее, чем достраивать список на лету:
 * никакой перерисовки в момент листания.
 *
 * АВТОПРОКРУТКА показана заполняющейся полоской вместо точки у текущей карточки: точки говорят
 * «где я», а полоска — ещё и «сколько осталось». Заполнилась — карточка сменилась, поэтому смена не
 * выглядит внезапной. Палец останавливает отсчёт: пока человек листает сам, автопрокрутка не спорит
 * с ним, и отсчёт начинается заново после того, как он отпустил.
 */
/*
  В memo: экран ленты пересобирается часто (свечение, вкладки), а у панели пропсы — те же лента и
  то же значение прокрутки. Без memo каждая такая сборка пересоздавала список и все обработчики.
*/
export const Billboard = memo(function Billboard({ items, scrollY }: { items: MediaItem[]; scrollY?: Animated.Value }) {
  /*
    ФОКУС ВКЛАДКИ СПРАШИВАЕМ ЗДЕСЬ, а не получаем сверху.

    Раньше его знал экран ленты и передавал сюда пропом — а значит, при каждом переключении вкладок
    перерисовывался ВЕСЬ экран: свечение, все ряды, все карточки. Работа шла в JS-потоке ровно в тот
    момент, когда человек ждёт отклика: отсюда и «вибрация отстаёт», и «нельзя листать сразу».
    Панели фокус действительно нужен — ей и знать.
  */
  const focused = useIsFocused();
  const { width, height } = usePortraitWindow();
  const insets = usePortraitInsets();
  const { reduceMotion } = useA11ySettings();
  const scrollX = useRef(new Animated.Value(0)).current;
  /*
    ССЫЛКА НА СПИСОК — из Reanimated (useAnimatedRef). Она умеет всё, что умел прежний ref
    (scrollToOffset из JS), и вдобавок даёт потоку интерфейса две вещи: читать прокрутку списка
    (useScrollOffset) и прокручивать его самому (scrollTo) — без JS на каждый кадр.
  */
  const listRef = useAnimatedRef<FlatList>();
  const progress = useRef(new Animated.Value(0)).current;
  /**
   * Сдвиг ленты для точек и для запаса проходов — В ПОТОКЕ ИНТЕРФЕЙСА.
   *
   * scrollX считается на нативном драйвере ради параллакса кадра, а ширина точек — свойство
   * раскладки, которое нативный драйвер не умеет. Раньше позиция поэтому дублировалась JS-слушателем
   * у того же события: на каждый кадр листания — вызов в JS, setReps и пересчёт ширины всех точек
   * JS-анимацией. Теперь сдвиг читает Reanimated прямо из событий прокрутки, а точки считают свою
   * ширину и заливку в потоке интерфейса — так же ровно под пальцем, но JS в листании не участвует.
   */
  // Пустая лента списка не рисует — тогда и слушать нечего (иначе Reanimated предупреждает о
  // ссылке, которая так и не привязалась). Появятся фильмы — подписка встанет сама.
  const scrollOff = useScrollOffset(items.length > 0 ? listRef : null);

  const [active, setActive] = useState(0);
  /**
   * Сколько раз список повторён. РАСТЁТ по мере листания вместо перемотки назад.
   *
   * Раньше бесконечность делалась тремя копиями и тихой перемоткой в середину — и ровно на этой
   * перемотке картинка мигала: список не успевал отрисовать карточку, на которую его мгновенно
   * переставили. Здесь перемотки нет вообще: когда до конца остаётся пара карточек, вперёд
   * дописывается ещё один проход. Виртуализация держит в памяти всё те же несколько штук, а
   * элементы списка — это ссылки на те же объекты, они ничего не весят.
   */
  const [reps, setReps] = useState(LEAD + AHEAD);
  /** Стартовая страница — начало «своего» прохода, с запасом кругов позади. */
  const start = LEAD * items.length;
  const pageRef = useRef(start);
  const paused = useRef(false);
  /**
   * Ведущее значение автоматического перехода: сдвиг ленты в пикселях. Живёт в потоке интерфейса
   * (см. advance) — каждый кадр перехода прокручивает список прямо там, без JS.
   */
  const glide = useSharedValue(0);
  /** То же «идёт ли переход», но для потока интерфейса: только пока оно true, glide двигает список. */
  const glideOn = useSharedValue(false);
  /** Номер перехода: завершение старого, пришедшее после начала нового, не должно в него вмешаться. */
  const glideId = useRef(0);
  /** Идёт ли сейчас автоматический переход. См. onMomentumEnd — он обязан молчать, пока идёт. */
  const gliding = useRef(false);

  const panelH = Math.round(height * 0.7);
  const n = items.length;
  // Лента — reps проходов по кругу. Собирается заново только когда растёт запас или меняются
  // фильмы, а не на каждой сборке панели: новый массив заставлял список перепроверять все ячейки.
  const data = useMemo(() => (n > 0 ? Array.from({ length: reps * n }, (_, i) => items[i % n]) : []), [items, n, reps]);

  /*
    ЗАПАС ПРОХОДОВ ПРОВЕРЯЕТСЯ В ПОТОКЕ ИНТЕРФЕЙСА НА КАЖДОМ КАДРЕ, а в JS приходит только в момент
    пересечения порога. Раньше — на каждый кадр через JS-слушатель. Почему вообще по ходу, а не на
    остановке: быстрый бросок через несколько карточек доезжал до конца ленты раньше, чем
    приходило onMomentumScrollEnd, и бесконечность кончалась. Порог тот же — за 2.5 карточки до конца.
  */
  const repsSv = useSharedValue(reps);
  useEffect(() => {
    repsSv.value = reps;
  }, [reps, repsSv]);
  const grow = useCallback(
    (p: number) => setReps((r) => (p >= r * n - 2.5 ? r + 3 : r)),
    [n],
  );
  useAnimatedReaction(
    () => n > 0 && width > 0 && scrollOff.value / width >= repsSv.value * n - 2.5,
    (need, was) => {
      if (need && !was) runOnJS(grow)(scrollOff.value / width);
    },
    [n, width, grow],
  );

  // Переход ведёт список кадр за кадром: значение glide → scrollTo в том же потоке.
  useAnimatedReaction(
    () => glide.value,
    (v) => {
      if (glideOn.value) scrollTo(listRef, v, 0, false);
    },
  );

  const goTo = useCallback(
    (page: number, animated: boolean) => {
      listRef.current?.scrollToOffset({ offset: page * width, animated });
      pageRef.current = page;
    },
    [width],
  );

  // Стартовая позиция задаётся через initialScrollIndex списка — отдельный прыжок после
  // отрисовки был бы виден.

  const stopGlide = useCallback(() => {
    gliding.current = false;
    glideOn.value = false;
    // Обрыв приходит в onGlideEnd как «не доиграл» — там и решается, доводить ли до карточки.
    cancelAnimation(glide);
  }, [glide, glideOn]);

  /** Конец автоматического перехода — доигранного или оборванного. Логика прежняя, см. advance. */
  const onGlideEnd = useCallback(
    (id: number, finished: boolean, page: number) => {
      // Завершение перехода, который уже сменился новым (или панель ушла), — не наше.
      if (id !== glideId.current) return;
      const byFinger = paused.current;
      gliding.current = false;
      glideOn.value = false;
      if (!finished) {
        // Оборвалось пальцем — дальше распоряжается он, позицию досчитает onMomentumScrollEnd.
        // Оборвалось само (уход со вкладки) — ДОВОДИМ до ближайшей карточки: лента,
        // застывшая в разрезе между двумя, это худшее из возможных состояний.
        if (!byFinger) {
          const near = Math.round(scrollOff.value / width);
          pageRef.current = near;
          listRef.current?.scrollToOffset({ offset: near * width, animated: true });
          setActive(((near % n) + n) % n);
        }
        return;
      }
      pageRef.current = page;
      // Доводим до границы страницы: последний кадр анимации мог не совпасть с ней в точности.
      listRef.current?.scrollToOffset({ offset: page * width, animated: false });
      // Подходим к концу — дописываем ещё проход (см. reps).
      setReps((r) => (page >= r * n - 2 ? r + 3 : r));
      setActive(((page % n) + n) % n);
    },
    [glideOn, scrollOff, width, n, listRef],
  );

  /**
   * ПЛАВНАЯ АВТОМАТИЧЕСКАЯ СМЕНА КАРТОЧКИ.
   *
   * Раньше смену отдавали системе: scrollToOffset({ animated: true }). Системная анимация прокрутки
   * рассчитана на бросок пальцем — она трогается рывком и почти без выката, потому что предполагает
   * скорость, уже набранную рукой. Для перехода, которого никто не просил, это читается как
   * подёргивание: лента дёргается и встаёт насухо.
   *
   * Поэтому кадр ведём сами, ровно за то же время, но по симметричной кривой: мягко с места и так
   * же мягко в упор. Движение без начальной скорости обязано её набирать — ease-out тут врал бы.
   *
   * КАДРЫ ПЕРЕХОДА СЧИТАЮТСЯ В ПОТОКЕ ИНТЕРФЕЙСА. Раньше значение было JS-стороннее: нативного
   * драйвера для программной прокрутки в React Native нет, и полсекунды каждый кадр шёл через JS
   * (слушатель → scrollToOffset). Теперь та же кривая и то же время идут в Reanimated (withTiming), а
   * список двигает scrollTo там же — JS узнаёт только о конце перехода. Если JS в этот момент занят
   * (открывается страница фильма), переход всё равно идёт ровно.
   */
  const advance = useCallback(() => {
    stopGlide();
    gliding.current = true;
    glideId.current += 1;
    const id = glideId.current;
    const page = pageRef.current + 1;
    // Старт — точно с границы текущей карточки, как и раньше (setValue перед анимацией).
    glide.value = pageRef.current * width;
    glideOn.value = true;
    glide.value = withTiming(page * width, { duration: GLIDE_MS, easing: Easing.inOut(Easing.cubic) }, (finished) => {
      'worklet';
      runOnJS(onGlideEnd)(id, !!finished, page);
    });
  }, [glide, glideOn, stopGlide, onGlideEnd, width]);

  /** Отсчёт до смены карточки. Заново — после каждой смены и после того, как человек отпустил. */
  const runTimer = useCallback(() => {
    if (n <= 1 || reduceMotion) return;
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: DWELL_MS,
      // Линейно и намеренно: полоска показывает ВРЕМЯ, а ускоряющаяся шкала врала бы о том,
      // сколько осталось.
      //
      // ДРАЙВЕР НАТИВНЫЙ, и теперь это можно. Когда-то заполнение считалось шириной, ширина
      // нативному драйверу недоступна, и всё падало с «Style property 'width' is not supported by
      // native animated module» — тогда отсчёт и переехал в JS. С тех пор заполнение рисуется
      // МАСШТАБОМ (см. Dots), а масштаб нативному драйверу доступен.
      //
      // Разница огромна: это девятисекундная анимация, которая идёт непрерывно всё время, пока
      // видна главная. В JS она занимала поток каждый кадр — тот самый поток, который в этот
      // момент должен отвечать на касания, закрывать страницу фильма и подавать отклик вкладки.
      // Ширина точек считается из ДРУГОГО значения (pos), поэтому драйверы не встречаются.
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !paused.current) advance();
    });
  }, [n, reduceMotion, progress, advance]);

  useEffect(() => {
    /*
      ПОД ОТКРЫТОЙ СТРАНИЦЕЙ ФИЛЬМА ОТСЧЁТ СТОИТ.

      Он крутился всегда: страница фильма открыта, панель под ней не видна, а девятисекундная
      анимация продолжает идти и в конце сама пролистывает карточку, которую никто не смотрит.
      Работа впустую — и ровно в те секунды, когда всё нужно отдать открытию и закрытию страницы.
    */
    if (!focused) {
      progress.stopAnimation();
      return;
    }
    runTimer();
    return () => progress.stopAnimation();
    // stopGlide СЮДА НЕ ВХОДИТ. Этот эффект перезапускается при каждой смене карточки, и обрыв
    // перехода в его уборке означал бы, что переход убивает сам себя на полпути: лента вставала
    // между карточками. Автоматический переход живёт своей жизнью и прерывается только пальцем,
    // уходом со вкладки и размонтированием.
  }, [active, focused, runTimer, progress]);

  /** Размонтирование: stopGlide стабилен, поэтому уборка сработает ровно один раз — в конце.
   * Номер перехода сбивается, чтобы запоздалое завершение не трогало уже снятую панель. */
  useEffect(
    () => () => {
      glideId.current += 1;
      stopGlide();
    },
    [stopGlide],
  );

  /**
   * ВЫРАВНИВАНИЕ ПОСЛЕ ВОЗВРАТА НА ВКЛАДКУ.
   *
   * Если вкладку переключили в момент, когда карточка ещё летела по инерции, прокрутка замирает
   * между страницами: onMomentumScrollEnd на скрытом экране уже не приходит, и панель остаётся
   * стоять «в разрезе» между двумя карточками. Возвращаясь на вкладку, доводим её до ближайшей.
   */
  useEffect(() => {
    if (focused === false) {
      // Уходя со вкладки, обрываем начатый переход: доигрывать его в невидимом списке незачем.
      stopGlide();
      return;
    }
    goTo(pageRef.current, false);
  }, [focused, goTo, stopGlide]);

  const onMomentumEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (n === 0) return;
      // Во время автоматического перехода iOS тоже успевает прислать это событие — с координатой
      // где-то посередине пути. Раньше оно ставило setActive, экран перерисовывался, уборка
      // эффекта обрывала переход, и карточка застревала в разрезе. Пока ведём сами — молчим.
      if (gliding.current) return;
      const page = Math.round(e.nativeEvent.contentOffset.x / width);
      pageRef.current = page;
      // Подходим к концу — дописываем ещё проход. Никакой перемотки, поэтому и мигать нечему.
      // Решение — внутри обновления: так обработчику не нужен reps, и он не пересоздаётся с ним.
      setReps((r) => (page >= r * n - 2 ? r + 3 : r));
      paused.current = false;
      setActive(((page % n) + n) % n);
    },
    [n, width],
  );

  /*
    ОБРАБОТЧИКИ СПИСКА — СТАБИЛЬНЫЕ. Раньше событие прокрутки, renderItem, keyExtractor и
    getItemLayout создавались заново на каждой сборке панели: список перепривязывал нативное
    событие и перепроверял все смонтированные карточки. Теперь они меняются только вместе с тем,
    от чего действительно зависят (ширина экрана, высота панели).
  */
  const onScroll = useMemo(
    () => Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: true }),
    [scrollX],
  );
  const getItemLayout = useCallback(
    (_: unknown, i: number) => ({ length: width, offset: width * i, index: i }),
    [width],
  );
  const onScrollBeginDrag = useCallback(() => {
    // Палец главнее таймера И начатого перехода: и отсчёт, и автоматическое движение
    // замирают, пока человек листает сам.
    paused.current = true;
    stopGlide();
    progress.stopAnimation();
    progress.setValue(0);
  }, [stopGlide, progress]);

  /*
    Величины растяжения ЗАПОМИНАЮТСЯ. Считались они дёшево, но создавались заново на каждую
    перерисовку — а карточки получают их пропами, и новый объект означает, что карточка обязана
    перерисоваться, даже если в ней ничего не изменилось. Со стабильными величинами карточки
    пропускают перерисовку целиком (см. memo у BillboardCard).
  */
  const holdTop = useMemo(
    () =>
      scrollY
        ? scrollY.interpolate({ inputRange: [-MAX_PULL, 0, 1], outputRange: [-MAX_PULL, 0, 0] })
        : 0,
    [scrollY],
  );
  const stretch = useMemo(
    () =>
      scrollY
        ? scrollY.interpolate({
            inputRange: [-MAX_PULL, 0, 1],
            outputRange: [1 + MAX_PULL / panelH, 1, 1],
          })
        : new Animated.Value(1),
    [scrollY, panelH],
  );
  /** Точная обратная величина: обратное к линейному росту нелинейно, и вторая интерполяция
   * сходилась бы только в крайних точках, а на полпути текст и кнопку плющило. */
  const unstretch = useMemo(() => Animated.divide(1, stretch), [stretch]);

  const renderItem = useCallback(
    ({ item, index }: { item: unknown; index: number }) => (
      <BillboardCard
        item={item as MediaItem}
        index={index}
        width={width}
        height={panelH}
        scrollX={scrollX}
        scrollY={scrollY}
        stretch={stretch}
        unstretch={unstretch}
      />
    ),
    [width, panelH, scrollX, scrollY, stretch, unstretch],
  );

  if (n === 0) return null;

  return (
    <Animated.View
      style={{
        height: panelH,
        transform: [{ translateY: holdTop }, { scaleY: stretch }],
        transformOrigin: 'top',
      }}
    >
      {/*
        ВИРТУАЛИЗИРОВАННЫЙ список, а не ScrollView. Тройная копия ради бесконечности означает втрое
        больше карточек, и в ScrollView все они существуют одновременно — при шести фильмах это
        восемнадцать полноэкранных картинок разом. Именно на этом приложение вставало колом.
        FlatList держит в памяти только соседние.
      */}
      <AnimatedFlatList
        ref={listRef as never}
        data={data}
        horizontal
        pagingEnabled
        scrollsToTop={false}
        showsHorizontalScrollIndicator={false}
        keyExtractor={keyByIndex}
        // Ширина карточки известна заранее, поэтому список не должен её измерять — без этого
        // initialScrollIndex не работает, а прокрутка к странице считается неточно.
        getItemLayout={getItemLayout}
        // Старт — не с края, а с запасом проходов позади (см. LEAD): иначе с первой карточки
        // некуда свайпнуть вправо. Через initialScrollIndex, а не прыжком после отрисовки:
        // прыжок был бы виден.
        initialScrollIndex={start}
        // removeClippedSubviews здесь УБРАН намеренно: в горизонтальных списках он отвязывает
        // ушедшие за край вью и на возврате они появляются пустыми — это и было «глючной»
        // прокруткой. Виртуализация всё равно работает, просто окно чуть шире.
        initialNumToRender={3}
        maxToRenderPerBatch={3}
        windowSize={5}
        scrollEventThrottle={16}
        // Только нативный драйвер, без JS-слушателя: точки и запас проходов считает поток
        // интерфейса (см. scrollOff), а прежний слушатель гонял JS на каждом кадре листания.
        onScroll={onScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        onMomentumScrollEnd={onMomentumEnd}
        renderItem={renderItem}
      />

      {/*
        УКАЗАТЕЛЬ ЖИВЁТ НАД СПИСКОМ, а не внутри карточки, и по двум причинам.
        Внутри карточки он, во-первых, гас вместе с подписью при листании — а он и нужен именно
        тогда, когда листаешь. Во-вторых, в трёх копиях списка их было бы столько же, сколько
        карточек, и все анимировали бы одно и то же.
        Позиция подобрана так, чтобы он стоял на одной линии с кнопкой «Смотреть»: тот же нижний
        отступ, что у подписи, плюс половина высоты кнопки. Растяжение гасится тем же множителем,
        поэтому при оттягивании он едет вниз вместе с кнопкой, но не вытягивается.
      */}
      <Animated.View
        style={[
          styles.dotsHolder,
          {
            bottom: 22 + insets.bottom * 0.2 + BUTTON_H / 2 - 3,
            transform: [{ scaleY: unstretch }],
            transformOrigin: 'bottom',
          },
        ]}
        pointerEvents="none"
      >
        <Dots total={n} off={scrollOff} width={width} active={active} progress={progress} />
      </Animated.View>
    </Animated.View>
  );
});

const BillboardCard = memo(function BillboardCard({
  item,
  index,
  width,
  height,
  scrollX,
  scrollY,
  stretch,
  unstretch,
}: {
  item: MediaItem;
  index: number;
  width: number;
  height: number;
  scrollX: Animated.Value;
  scrollY?: Animated.Value;
  /** Во сколько раз растянута панель. */
  stretch: Animated.AnimatedInterpolation<number> | Animated.Value;
  unstretch: Animated.AnimatedDivision<number>;
}) {
  const insets = usePortraitInsets();
  const cardRef = useRef<View>(null);
  const range = [(index - 1) * width, index * width, (index + 1) * width];

  /**
   * ГОРИЗОНТАЛЬНЫЙ ПАРАЛЛАКС: кадр смещается ПО ходу листания, обгоняя саму карточку.
   *
   * Никакого масштабирования. Прошлая попытка добавляла кадру запас «на время листания», меняя его
   * размер по ходу жеста, — и это читалось как отдельный эффект, а не как глубина: картинка на
   * глазах раздувалась и сдувалась.
   *
   * Запас под сдвиг сделан постоянным и МИНИМАЛЬНЫМ: кадр шире карточки ровно на удвоенный сдвиг
   * (см. PARALLAX и стиль image). Шесть процентов с каждой стороны — это то, что глаз не считывает
   * как обрезку афиши, но чего хватает, чтобы подложка не показалась ни в одном кадре жеста.
   */
  const imageShift = scrollX.interpolate({
    inputRange: range,
    // Знак направления: кадр смещается ПО ходу листания, обгоняя карточку. Обратный знак
    // (кадр отстаёт) выглядел иначе и владельцу не подошёл — менять только осознанно.
    outputRange: [-width * PARALLAX, 0, width * PARALLAX],
    extrapolate: 'clamp',
  });

  const titleScale = scrollX.interpolate({
    inputRange: range,
    // Сильнее прежнего (было 0.86): название должно заметно уступать, уходя с центра, иначе
    // движение читается как дрожание, а не как смена карточки.
    outputRange: [0.72, 1, 0.72],
    extrapolate: 'clamp',
  });

  /** Подпись едет БЫСТРЕЕ кадра — за счёт разницы скоростей и возникает глубина. */
  const captionShift = scrollX.interpolate({
    inputRange: range,
    outputRange: [width * 0.4, 0, -width * 0.4],
    extrapolate: 'clamp',
  });

  const textOpacity = scrollX.interpolate({
    inputRange: [(index - 0.5) * width, index * width, (index + 0.5) * width],
    outputRange: [0, 1, 0],
    extrapolate: 'clamp',
  });

  /**
   * ПРИВЯЗКА КАДРА ПРИ ПРОКРУТКЕ: карточка уезжает вверх, кадр остаётся на месте.
   *
   * Сдвиг равен пройденному пути ровно, один к одному — тогда изображение стоит неподвижно, а
   * движется только его оправа. Ограничен высотой карточки: дальше она всё равно ушла за верхний
   * край экрана.
   *
   * Стоит ЕДИНСТВЕННЫМ преобразованием: горизонтального параллакса и увеличения больше нет —
   * и то и другое требовало, чтобы кадр был крупнее карточки, а он теперь ровно по ней.
   */
  const pin = scrollY
    ? scrollY.interpolate({ inputRange: [0, height], outputRange: [0, height], extrapolate: 'clamp' })
    : 0;

  // Настоящий слоган с афиши (дотянут в api/feed.ts). Синопсис сюда НЕ подставляется: он
  // пересказывает сюжет, а карточке нужна фраза, а не пересказ. Нет слогана — нет и строки.
  const slogan = item.tagline ?? '';

  return (
    <Pressable onPress={() => openTitle(item, cardRef)} onLongPress={() => openTitleMenu({ item })} delayLongPress={380} style={{ width, height }}>
      <View ref={cardRef} collapsable={false} style={styles.card}>
        {item.backdropUrl && (
          <Animated.Image
            source={{ uri: item.backdropUrl }}
            style={[
              styles.image,
              {
                transform: [
                  { translateY: pin },
                  { translateX: imageShift },
                  // Только выравнивание осей при оттягивании панели. Размер кадра по ходу листания
                  // не меняется — сдвиг покрывается постоянным запасом по бокам.
                  { scaleX: stretch },
                ],
              },
            ]}
          />
        )}
        <LinearGradient
          colors={['rgba(8,8,10,0.5)', 'transparent', 'rgba(8,8,10,0.2)', 'rgba(8,8,10,0.92)']}
          locations={[0, 0.3, 0.6, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {/* Подпись ПРИКЛЕЕНА К НИЗУ карточки: стоит у нижнего края, поэтому едет вниз вместе с ним
            при растяжении. Гашение растяжения от нижней грани — чтобы текст и кнопка ехали, но не
            вытягивались. */}
        <Animated.View
          style={[
            styles.caption,
            {
              opacity: textOpacity,
              paddingBottom: 22 + insets.bottom * 0.2,
              transform: [{ translateX: captionShift }, { scaleY: unstretch }],
              transformOrigin: 'bottom',
            },
          ]}
        >
          <BillboardTitle
            item={item}
            maxWidth={width - CAPTION_PAD * 2}
            scale={titleScale}
            textStyle={styles.title}
            fallback={item.title}
          />
          {slogan ? (
            <Text style={styles.slogan} numberOfLines={2}>
              {slogan}
            </Text>
          ) : null}
          {/* Оценка вдвое крупнее прочего и без подложки: она главное число карточки, а не один
              из тегов. Остальное — в тёмных подложках, чтобы читалось на любом кадре. */}
          <View style={styles.metaRow}>
            <RatingChip rating={item.rating} fontSize={26} />
            {item.year ? <MetaPill text={item.year} /> : null}
            {item.runtimeMinutes ? <MetaPill text={`${item.runtimeMinutes} мин`} /> : null}
            {(item.genreNames ?? []).slice(0, 3).map((g) => (
              <MetaPill key={g} text={g} />
            ))}
          </View>
          <View style={styles.bottomRow}>
            <AppButton
              text="Смотреть"
              icon="play-arrow"
              variant="Primary"
              onPress={() => openTitle(item, cardRef)}
            />
          </View>
        </Animated.View>
      </View>
    </Pressable>
  );
})

/**
 * Указатель: точки, из которых активная плавно вырастает в полоску.
 *
 * Значение [pos] приходит ИЗ ПРОКРУТКИ и потому едет вместе с пальцем: протащил карточку
 * наполовину — полоска наполовину сжалась, соседняя наполовину выросла.
 *
 * Диапазон охватывает ВЕСЬ круг, от −1 до n: позиция приходит как остаток от числа карточек и на
 * стыке перескакивает с n−ε сразу на 0. С узким диапазоном это выглядело как рывок полоски через
 * весь ряд обратно; здесь у первой точки пик стоит и на 0, и на n, поэтому в момент скачка ширина
 * не меняется.
 */
function Dots({
  total,
  off,
  width,
  active,
  progress,
}: {
  total: number;
  /** Сдвиг ленты в точках — из потока интерфейса (useScrollOffset). */
  off: SharedValue<number>;
  /** Ширина карточки: сдвиг делится на неё, чтобы получить дробный номер. */
  width: number;
  active: number;
  progress: Animated.Value;
}) {
  // Узлы −1…n — общие для всех точек (см. описание выше): у первой пик и на 0, и на n.
  const knots = useMemo(() => Array.from({ length: total + 2 }, (_, k) => k - 1), [total]);
  return (
    <View style={styles.dots}>
      {Array.from({ length: total }).map((_, i) => (
        <Dot key={i} i={i} total={total} knots={knots} off={off} width={width} on={i === active} progress={progress} />
      ))}
    </View>
  );
}

/*
  ОДНА ТОЧКА. Ширина и прозрачность заливки считаются в потоке интерфейса (Reanimated) от сдвига
  ленты — по тем же узлам и тем же значениям, что прежняя JS-интерполяция, поэтому выглядит она
  точно так же: «насколько эта точка сейчас активна» m ∈ [0, 1] линейно между узлами, ширина
  DOT_W → BAR_W и прозрачность 0 → 1 от того же m.
*/
function Dot({
  i,
  total,
  knots,
  off,
  width,
  on,
  progress,
}: {
  i: number;
  total: number;
  knots: number[];
  off: SharedValue<number>;
  width: number;
  on: boolean;
  progress: Animated.Value;
}) {
  const mine = useMemo(() => knots.map((k) => ((((k % total) + total) % total) === i ? 1 : 0)), [knots, total, i]);
  const track = useAnimatedStyle(() => {
    const p = width > 0 ? off.value / width : 0;
    // Остаток от числа карточек: позиция в ИСХОДНОМ списке, а не в его многократной копии.
    const pos = ((p % total) + total) % total;
    const m = interpolate(pos, knots, mine, Extrapolation.CLAMP);
    return { width: DOT_W + (BAR_W - DOT_W) * m };
  });
  const fillWrap = useAnimatedStyle(() => {
    const p = width > 0 ? off.value / width : 0;
    const pos = ((p % total) + total) % total;
    /**
     * Заливка привязана к ПОЗИЦИИ, а не к номеру активной карточки: `active`
     * обновляется только когда карточка доехала, и при быстром листании прежняя точка
     * успевала залиться до конца и оставалась белой. Здесь видна заливка только у той
     * точки, на которой сейчас стоит лента.
     */
    return { opacity: interpolate(pos, knots, mine, Extrapolation.CLAMP) };
  });
  return (
    <Reanimated.View style={[styles.dotTrack, track]}>
      {/*
        ДВА СЛОЯ, И ЭТО ВЫНУЖДЕННО. Прозрачность считается из позиции прокрутки (поток интерфейса,
        Reanimated), а заполнение — из отсчёта таймера на нативном драйвере Animated. Одно значение
        два движка вести не могут, поэтому они разведены по разным слоям: снаружи прозрачность от
        позиции, внутри масштаб от progress. Класть их в один стиль нельзя — так я однажды точки и сломал.
      */}
      <Reanimated.View style={[styles.dotFillWrap, fillWrap]}>
        <Animated.View
          style={[
            styles.dotFill,
            {
              transform: [{ scaleX: on ? progress : 0 }],
              transformOrigin: 'left',
            },
          ]}
        />
      </Reanimated.View>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    // Без скруглений: верхние углы — углы дисплея, нижний край панель делит с лентой.
    overflow: 'hidden',
    backgroundColor: colors.surface,
    justifyContent: 'flex-end',
  },
  /**
   * КАДР РОВНО ПО КАРТОЧКЕ. Ни запасов по краям, ни увеличения — 100% на 100%.
   *
   * Все прежние варианты (160% ширины, 160% высоты, множители при оттягивании) добавлялись, чтобы
   * закрыть то параллакс, то полосы, — и каждый делал видимую часть кадра меньше, то есть срезал
   * содержимое афиши. Здесь исходный размер.
   */
  /**
   * Кадр шире карточки на удвоенный PARALLAX — по 12% с каждой стороны. Это ЕДИНСТВЕННЫЙ запас,
   * который здесь есть, и нужен он только под боковой сдвиг параллакса. Прежние 160% на 160%
   * добавлялись под совсем другие эффекты и заметно срезали афишу.
   */
  image: { position: 'absolute', top: 0, bottom: 0, left: '-12%', width: '124%', height: '100%' },
  caption: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20 },
  /**
   * Дисплейный Bounded ВЕРНУЛСЯ, но утолщён.
   *
   * В гарнитуре ровно один вес (700) — другого файла просто нет, а системный псевдожирный для
   * шрифтов, подключённых файлом, не работает. Поэтому толщина добирается тенью ТОГО ЖЕ ЦВЕТА с
   * нулевым смещением: она обводит глиф по контуру и делает штрих чуть плотнее, не трогая форму
   * букв. Радиус намеренно маленький — больше единицы уже читается как размытие, а не как вес.
   */
  title: {
    fontFamily: font.display,
    fontSize: 26,
    letterSpacing: -0.5,
    color: colors.onBg,
    textShadowColor: colors.onBg,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 0.7,
    transformOrigin: 'left center',
  },
  slogan: { ...typo.bodyMedium, color: colors.onBg, marginTop: 8, lineHeight: 19 },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7, marginTop: 12 },
  meta: { ...typo.labelMedium, color: colors.mutedWarm },
  bottomRow: { marginTop: 16, alignSelf: 'flex-start' },
  dotsHolder: { position: 'absolute', right: 20 },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dotTrack: {
    height: DOT_W,
    borderRadius: DOT_W / 2,
    overflow: 'hidden',
    backgroundColor: 'rgba(246,246,248,0.3)',
  },
  dotFillWrap: { ...StyleSheet.absoluteFill },
  dotFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '100%',
    borderRadius: DOT_W / 2,
    backgroundColor: colors.onBg,
  },
});
