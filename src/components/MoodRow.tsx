import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { go } from '../nav/navGuard';
import { Pressable, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import Reanimated, { useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { moodsFor, type Mood } from '../data/moods';
import { MoodScene } from './MoodScene';
import { OldFilmText } from './film/OldFilmText';
import { FilmGrain } from './film/FilmGrain';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme/colors';
import { font, type as typo } from '../theme/fonts';
import { usePortraitWindow } from '../nav/portrait';

/*
  «НАСТРОЕНИЕ» — ОДНА СПЛОШНАЯ КАРТОЧКА на треть экрана, как карусель вверху Фильмов и Сериалов.

  Листаются только НАЗВАНИЯ. Фон — живые абстракции из жанровых картинок APK (MoodScene); пока
  ведёшь пальцем, фигуры одной сцены перетекают в фигуры следующей (MoodMorph) ровно на столько,
  на сколько сдвинута карусель, — в потоке отрисовки, без рывков. Поверх — зерно и потёртости
  плёнки. Края карточки мягко растворяются в фоне страницы (лёгкая виньетка, не рамка).

  Касание — страница настроения (раскрывается тем же разворотом, что и остальные страницы).
*/

/** Насколько темнота карточки уходит наружу: вверх (под заголовок и выше) и вниз. */
const OUT_UP = 150;
const OUT_DOWN = 130;

export const MoodRow = memo(function MoodRow({
  kind = 'all',
  onIndex,
  liveLink,
}: {
  kind?: 'all' | 'movie' | 'tv';
  /** Провод от ленты: «карточка в кадре или нет». Пока не видно — сцены стоят. */
  liveLink?: { current: ((on: boolean, wake: boolean) => void) | null };
  /** Какое настроение сейчас на карточке — под него окрашивается свечение фона. */
  onIndex?: (i: number) => void;
}) {
  const list = moodsFor(kind);
  const { width, height } = usePortraitWindow();
  const h = Math.round(height / 3);
  const pos = useSharedValue(0);
  const last = useRef(0);
  // На какой сцене карусель остановилась — та и «открыта» (у Фантастики на входе летит звезда).
  const [landed, setLanded] = useState(0);
  const [live, setLive] = useState(!liveLink);
  const [wake, setWake] = useState(!liveLink);
  useEffect(() => {
    if (!liveLink) return;
    liveLink.current = (on, w) => {
      setLive(on);
      if (w) setWake(true);
    };
    return () => {
      liveLink.current = null;
    };
  }, [liveLink]);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      pos.value = e.contentOffset.x / Math.max(1, e.layoutMeasurement.width);
    },
  });
  const keys = useMemo(() => moodsFor(kind).map((m) => m.key), [kind]);
  const settle = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const i = Math.round(e.nativeEvent.contentOffset.x / width);
      if (i !== last.current) {
        last.current = i;
        setLanded(i);
        void Haptics.selectionAsync();
        onIndex?.(i);
      }
    },
    [width, onIndex],
  );

  return (
    <View style={styles.wrap}>
      <Text style={styles.section}>Настроение</Text>
      <View style={[styles.card, { width, height: h }]}>
        {/*
          Заголовок «Настроение» стоит НАД карточкой, сцена под него не заходит. Зато верх
          карточки тает вверх, к заголовку: от сцены к фону — граница карточки не видна.
        */}
        {/*
          ВИНЬЕТКА НАРУЖУ. За лентой светится тёплый фон, а края карточки уходят в чёрное —
          и тёмная полоса обрывалась ровной линией. Поэтому темнота продолжается и ЗА карточкой:
          вверх — под заголовок и выше, вниз — под следующий ряд, и там плавно сходит на нет.
          Заголовок лежит поверх (zIndex), следующий ряд — тоже (он рисуется позже).
        */}
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(8,8,10,0)', 'rgba(8,8,10,0.22)', 'rgba(8,8,10,0.62)', colors.bg]}
          locations={[0, 0.35, 0.7, 1]}
          style={[styles.fade, { top: -OUT_UP, height: OUT_UP }]}
        />
        <LinearGradient
          pointerEvents="none"
          colors={[colors.bg, 'rgba(8,8,10,0.62)', 'rgba(8,8,10,0.22)', 'rgba(8,8,10,0)']}
          locations={[0, 0.3, 0.65, 1]}
          style={[styles.fade, { top: h, height: OUT_DOWN }]}
        />
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.clip]}>
          <MoodScene keys={keys} w={width} h={h} pos={pos} index={landed} live={live} wake={wake} grain={0} />
          {/* Внутри карточки виньетки нет совсем (просьба Марка) — затемнение только снаружи. */}
        </View>
        <Reanimated.ScrollView
          horizontal
          pagingEnabled
          scrollsToTop={false}
          showsHorizontalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={16}
          onMomentumScrollEnd={settle}
          style={StyleSheet.absoluteFill}
        >
          {list.map((m, i) => (
            <MoodTitle key={m.key} m={m} i={i} pos={pos} width={width} height={h} kind={kind} />
          ))}
        </Reanimated.ScrollView>
        {/* Плёнка (зерно, пыль, царапины) — ПОВЕРХ названий: слово «снято» вместе со сценой,
            а не наклеено сверху чистым. Касаний не ловит. */}
        {wake || live ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.clip]}>
            <FilmGrain w={width} h={h} />
          </View>
        ) : null}
        <View style={styles.dots} pointerEvents="none">
          {list.map((m, i) => (
            <Dot key={m.key} i={i} pos={pos} />
          ))}
        </View>
      </View>
    </View>
  );
});

const MoodTitle = memo(function MoodTitle({
  m,
  i,
  pos,
  width,
  height,
  kind,
}: {
  m: Mood;
  i: number;
  pos: SharedValue<number>;
  width: number;
  height: number;
  kind: string;
}) {
  // Название уходит чуть медленнее пальца и гаснет к краю — листаются слова, а не карточки.
  const st = useAnimatedStyle(() => {
    const d = pos.value - i;
    return { opacity: Math.max(0, 1 - Math.abs(d) * 1.4), transform: [{ translateX: d * width * 0.35 }, { scale: 1 - Math.min(0.12, Math.abs(d) * 0.12) }] };
  });
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        go({ pathname: '/mood/[mood]', params: { mood: m.key, kind } });
      }}
      style={{ width, height, alignItems: 'center', justifyContent: 'center' }}
    >
      {/* Без «подгонки по ширине» и без разрядки: подгонка сжимала строку, а разрядку — нет,
          и в длинных словах («ФАНТАСТИКА») последняя буква выбивалась. Размер — по ширине экрана. */}
      {/* Слово — как титр старого фильма: ореол, мягкий край, мерцание и дрожание кадра (OldFilmText). */}
      <Reanimated.View style={st}>
        <OldFilmText text={m.title.toUpperCase()} style={[styles.name, { fontSize: Math.min(36, Math.floor((width - 56) / (m.title.length * 0.98))) }]} />
      </Reanimated.View>
    </Pressable>
  );
});

function Dot({ i, pos }: { i: number; pos: SharedValue<number> }) {
  const st = useAnimatedStyle(() => {
    const v = Math.max(0, 1 - Math.abs(pos.value - i));
    return { width: 6 + 14 * v, opacity: 0.35 + 0.65 * v };
  });
  return <Reanimated.View style={[styles.dot, st]} />;
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 22 },
  // Заголовок поверх выходящего вверх свечения.
  section: { ...typo.headlineLarge, color: colors.onBg, marginBottom: 10, marginLeft: 16, zIndex: 2 },
  card: {},
  clip: { overflow: 'hidden' },
  fade: { position: 'absolute', left: 0, right: 0 },
  // Шрифт Люмьера (Bounded), утолщённый тенью того же цвета — жирнее обычного.
  // Ровно как оценка на постерах (RatingChip): Bounded с весом 800 — очень жирно.
  // Лёгкая тень — чтобы белое слово читалось и на розовом, и на оранжевом фоне.
  name: { fontFamily: font.display, fontWeight: '800', color: '#fff', paddingHorizontal: 28, textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.28)', textShadowRadius: 14, textShadowOffset: { width: 0, height: 2 } },
  dots: { position: 'absolute', bottom: 14, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { height: 4, borderRadius: 2, backgroundColor: '#fff' },
});
