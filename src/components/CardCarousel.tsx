import { memo, useCallback, useRef } from 'react';
import { Animated, FlatList, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme/colors';
import { type as typo } from '../theme/fonts';
import { usePortraitWindow } from '../nav/portrait';

/*
  КАРУСЕЛЬ КРУПНЫХ КАРТОЧЕК — как на телевизоре: на экране ОДНА карточка во всю ширину (на треть
  высоты экрана), следующие смахиваются свайпом. Соседняя на подходе чуть меньше и темнее и
  дорастает до полного размера, пока её тянут к центру, — то же «дыхание», что у карусели на
  Фильмах и Сериалах. Всё движение — от прокрутки на нативном драйвере, без JS на кадр.

  Одна общая обёртка для «Настроения» и «Сейчас в кино».
*/
const GAP = 12;
const SIDE = 16;

const AnimatedFlatList = Animated.createAnimatedComponent(FlatList);

export function useCardSize() {
  const { width, height } = usePortraitWindow();
  return { w: width - SIDE * 2, h: Math.round(height / 3) };
}

export const CardCarousel = memo(function CardCarousel<T>({
  title,
  data,
  keyOf,
  renderCard,
  onIndex,
}: {
  title: string;
  data: T[];
  keyOf: (item: T) => string;
  renderCard: (item: T, index: number, w: number, h: number, scrollX: Animated.Value) => React.ReactElement;
  /** Карточка встала в центр — номер. */
  onIndex?: (i: number) => void;
}) {
  const { w, h } = useCardSize();
  const step = w + GAP;
  const scrollX = useRef(new Animated.Value(0)).current;
  const last = useRef(0);

  const settle = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const i = Math.round(e.nativeEvent.contentOffset.x / step);
      if (i !== last.current) {
        last.current = i;
        void Haptics.selectionAsync();
        onIndex?.(i);
      }
    },
    [step, onIndex],
  );

  const render = useCallback(
    ({ item, index }: { item: unknown; index: number }) => {
      const at = index * step;
      const scale = scrollX.interpolate({ inputRange: [at - step, at, at + step], outputRange: [0.9, 1, 0.9], extrapolate: 'clamp' });
      const dim = scrollX.interpolate({ inputRange: [at - step, at, at + step], outputRange: [0.45, 1, 0.45], extrapolate: 'clamp' });
      return (
        <Animated.View style={{ width: w, height: h, marginRight: GAP, opacity: dim, transform: [{ scale }] }}>
          {renderCard(item as T, index, w, h, scrollX)}
        </Animated.View>
      );
    },
    [w, h, step, scrollX, renderCard],
  );

  if (data.length === 0) return null;
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{title}</Text>
      <View>
      {/*
        ФОН ПОЗАДИ КАРТОЧЕК ПРИГЛУШЁН: полоса чуть шире карточек темнеет к их середине и мягко
        сходит на нет выше и ниже — свет фона не спорит с кадром.
      */}
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(8,8,10,0)', 'rgba(8,8,10,0.78)', 'rgba(8,8,10,0.78)', 'rgba(8,8,10,0)']}
        locations={[0, 0.25, 0.75, 1]}
        style={{ position: 'absolute', left: 0, right: 0, top: -40, height: h + 80 }}
      />
      <AnimatedFlatList
        horizontal
        data={data}
        keyExtractor={(it: unknown) => keyOf(it as T)}
        renderItem={render}
        showsHorizontalScrollIndicator={false}
        scrollsToTop={false}
        decelerationRate="fast"
        snapToInterval={step}
        disableIntervalMomentum
        contentContainerStyle={{ paddingHorizontal: SIDE }}
        getItemLayout={(_: unknown, i: number) => ({ length: step, offset: step * i, index: i })}
        initialNumToRender={2}
        maxToRenderPerBatch={2}
        windowSize={3}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: true })}
        onMomentumScrollEnd={settle}
      />
      </View>
    </View>
  );
}) as <T>(p: {
  title: string;
  data: T[];
  keyOf: (item: T) => string;
  renderCard: (item: T, index: number, w: number, h: number, scrollX: Animated.Value) => React.ReactElement;
  onIndex?: (i: number) => void;
}) => React.ReactElement | null;

const styles = StyleSheet.create({
  wrap: { marginBottom: 22 },
  title: { ...typo.headlineLarge, color: colors.onBg, marginBottom: 10, marginLeft: 16 },
});
