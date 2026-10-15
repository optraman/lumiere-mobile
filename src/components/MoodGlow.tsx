import { memo, useEffect } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import Reanimated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

/*
  СВЕЧЕНИЕ НАСТРОЕНИЯ — три мягких пятна цвета жанра на чёрном: одна и та же картинка пятна,
  которую система раскрашивает (tintColor). Пятна медленно дышат и плывут по общим часам.

  На карточке «Настроение» слоёв по числу жанров, и прозрачность каждого — от положения прокрутки
  (pos): пока листаешь, один цвет перетекает в другой без рывков. Видны одновременно не больше
  двух слоёв — невидимые система не рисует.
*/
const breath = new Animated.Value(0);
let started = false;
function start() {
  if (started) return;
  started = true;
  Animated.loop(
    Animated.sequence([
      Animated.timing(breath, { toValue: 1, duration: 6000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(breath, { toValue: 0, duration: 6000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]),
  ).start();
}

/*
  Пятна нарисованы ВЕКТОРОМ (радиальные градиенты), а не картинкой: картинка в Expo Go приходит с
  сервера разработки, и при входе на страницу настроения свет появлялся с задержкой. Вектор есть с
  первого кадра; нарисован один раз (shouldRasterizeIOS), дальше слой только «дышит» —
  масштабом на нативном драйвере.
*/
function Layer({ color, w, h, k, pos, on }: { color: string; w: number; h: number; k: number; pos?: SharedValue<number>; on?: boolean }) {
  const st = useAnimatedStyle(() => ({ opacity: pos ? Math.max(0, 1 - Math.abs(pos.value - k)) : on ? 1 : 0 }));
  const swell = breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const m = Math.max(w, h);
  const spots = [
    { x: w * 0.34, y: h * 0.52, r: m * 0.62, o: 0.85 },
    { x: w * 0.7, y: h * 0.48, r: m * 0.5, o: 0.75 },
    { x: w * 0.52, y: h * 0.3, r: m * 0.38, o: 0.6 },
  ];
  const id = `mg${k}${color.replace('#', '')}`;
  return (
    <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, st]}>
      <Animated.View shouldRasterizeIOS style={[StyleSheet.absoluteFill, { transform: [{ scale: swell }] }]}>
        <Svg width={w} height={h}>
          <Defs>
            {spots.map((p, i) => (
              <RadialGradient key={i} id={`${id}-${i}`} cx={p.x} cy={p.y} r={p.r} gradientUnits="userSpaceOnUse">
                <Stop offset="0" stopColor={color} stopOpacity={p.o} />
                <Stop offset="0.55" stopColor={color} stopOpacity={p.o * 0.32} />
                <Stop offset="1" stopColor={color} stopOpacity={0} />
              </RadialGradient>
            ))}
          </Defs>
          {spots.map((_, i) => (
            <Rect key={i} x="0" y="0" width={w} height={h} fill={`url(#${id}-${i})`} />
          ))}
        </Svg>
      </Animated.View>
    </Reanimated.View>
  );
}

export const MoodGlow = memo(function MoodGlow({
  colors,
  w,
  h,
  pos,
  index = 0,
}: {
  colors: string[];
  w: number;
  h: number;
  pos?: SharedValue<number>;
  /** Без pos — горит только этот цвет. */
  index?: number;
}) {
  useEffect(start, []);
  return (
    <>
      {colors.map((c, k) => (
        <Layer key={`${c}-${k}`} color={c} w={w} h={h} k={k} pos={pos} on={k === index} />
      ))}
    </>
  );
});
