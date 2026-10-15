import { memo, useCallback, useMemo, useRef } from 'react';
import { Animated, FlatList, StyleSheet, Text, View } from 'react-native';
import type { FeedRow } from '../api/feed';
import type { MediaItem } from '../types/media';
import { POSTER_WIDTH, PosterCard } from './PosterCard';
import { TOP10_ITEM_W, Top10Card } from './Top10Card';
import { BannerCard } from './BannerCard';
import { MoodRow } from './MoodRow';
import { CardCarousel } from './CardCarousel';
import { BigBannerCard } from './BigBannerCard';
import { colors } from '../theme/colors';
import { type as typo } from '../theme/fonts';

/** Список с анимируемой прокруткой — нужен, чтобы ряд «Топ 10» мог считать свой параллакс. */
const AnimatedFlatList = Animated.createAnimatedComponent(FlatList);

/*
  КЛЮЧ И КАРТОЧКА ДЛЯ КАРУСЕЛИ — НА УРОВНЕ МОДУЛЯ, а не стрелками в разметке. CardCarousel обёрнут в
  memo, но новые функции на каждой сборке ряда делали memo бесполезным: карусель и все её карточки
  пересобирались вместе с лентой. Здесь функции одни на всё время жизни приложения.
*/
const keyOfItem = (m: MediaItem) => `${m.type}-${m.id}`;
const renderBigBanner = (m: MediaItem, i: number, w: number, h: number, x: Animated.Value) => (
  <BigBannerCard item={m} i={i} w={w} h={h} scrollX={x} />
);
const keyExtractor = (it: unknown) => keyOfItem(it as MediaItem);

/*
  ШАГ РЯДА ИЗВЕСТЕН ЗАРАНЕЕ — значит, список не обязан мерить карточки, чтобы понять, какие видны.
  Без getItemLayout горизонтальный FlatList по умолчанию монтирует первые 10 и окно в 21 экран, то
  есть почти весь ряд — а рядов в ленте двенадцать, и ленты три (вкладки держатся смонтированными).

  Шаги — ФАКТИЧЕСКИЕ, по разметке карточек:
    постер — POSTER_WIDTH (112) + собственный marginRight 10 у PosterCard;
    «Топ 10» — TOP10_ITEM_W (коробка цифры + заход постера + постер + GAP ряда) + тот же marginRight
    10 у вложенной PosterCard, который в TOP10_ITEM_W не учтён.
  Смещение начинается после левого отступа contentContainerStyle (16).
*/
const LIST_PAD = 16;
const POSTER_STEP = POSTER_WIDTH + 10;
const TOP10_STEP = TOP10_ITEM_W + 10;
const posterLayout = (_: unknown, i: number) => ({ length: POSTER_STEP, offset: LIST_PAD + POSTER_STEP * i, index: i });
const top10Layout = (_: unknown, i: number) => ({ length: TOP10_STEP, offset: LIST_PAD + TOP10_STEP * i, index: i });

export const FeedRowList = memo(function FeedRowList({ row }: { row: FeedRow }) {
  const scrollX = useRef(new Animated.Value(0)).current;
  const isTop10 = row.style === 'TOP10';
  const total = row.items.length;
  const rowStyle = row.style;

  /*
    Обработчики — ДО ранних возвратов (правило хуков) и стабильные между сборками: новый renderItem
    заставлял FlatList перерисовать все смонтированные ячейки при каждой сборке ленты.
  */
  const onScroll = useMemo(
    () =>
      isTop10
        ? Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: true })
        : undefined,
    [isTop10, scrollX],
  );
  const renderItem = useCallback(
    ({ item, index }: { item: unknown; index: number }) => {
      const m = item as MediaItem;
      if (isTop10) return <Top10Card rank={index + 1} item={m} index={index} total={total} scrollX={scrollX} />;
      if (rowStyle === 'BANNER') return <BannerCard item={m} />;
      return <PosterCard item={m} />;
    },
    [isTop10, rowStyle, total, scrollX],
  );

  // «Настроение» — свои плитки-жанры (не тайтлы), у ряда нет items.
  if (row.style === 'MOOD') return <MoodRow kind={row.mood ?? 'all'} />;
  if (row.items.length === 0) return null;
  // Широкие ряды («Сейчас в кино») — карусель по одной большой карточке, как на телевизоре.
  if (row.style === 'BANNER') {
    return (
      <CardCarousel
        title={row.title}
        data={row.items}
        keyOf={keyOfItem}
        renderCard={renderBigBanner}
      />
    );
  }
  return (
    <View style={styles.wrap}>
      {/* Заголовок секции — Bounded, как headlineLarge в ТВ-теме. */}
      <Text style={styles.title}>{row.title}</Text>
      <AnimatedFlatList
        horizontal
        // ПОЧЕМУ ЭТО ВАЖНО: iOS прокручивает наверх по тапу в строку состояния (и по повторному
        // тапу на вкладку) только когда на экране РОВНО ОДИН список claims scrollsToTop. По
        // умолчанию его требуют все, включая горизонтальные ряды, — и система, видя нескольких
        // претендентов, не делает ничего. Отказ горизонтальных рядов оставляет единственным
        // претендентом вертикальную ленту.
        scrollsToTop={false}
        data={row.items}
        keyExtractor={keyExtractor}
        // Окно виртуализации: на экране помещается 3–4 постера, монтируем чуть больше, а остальное —
        // по мере прокрутки. Порции маленькие, чтобы догрузка не занимала кадр целиком.
        initialNumToRender={5}
        maxToRenderPerBatch={4}
        windowSize={5}
        // BANNER сюда не доходит (у него своя карусель выше), поэтому шаг — постерный или «Топ 10».
        getItemLayout={isTop10 ? top10Layout : posterLayout}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.list}
        // Прокрутку слушаем ТОЛЬКО у «Топ 10»: остальным рядам она не нужна, а лишний обработчик на
        // каждом ряду — это лишняя работа на каждый кадр прокрутки.
        scrollEventThrottle={isTop10 ? 16 : undefined}
        onScroll={onScroll}
        renderItem={renderItem}
      />
    </View>
  );
})

const styles = StyleSheet.create({
  wrap: { marginBottom: 20 },
  title: { ...typo.headlineLarge, color: colors.onBg, marginBottom: 9, marginLeft: 16 },
  list: { paddingHorizontal: 16 },
});
