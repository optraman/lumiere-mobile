import { memo, useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  useAnimatedProps,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient as SvgLinear, Path, Stop } from 'react-native-svg';
import { font } from '../theme/fonts';

/*
  ОЦЕНКА TMDB НА СТРАНИЦЕ ТАЙТЛА.

  ЧИСЛО — ТАЙМЕРОМ С ЗАЛИВКОЙ снизу вверх (см. RatingClock), за 1600 мс по кривой Влада
  (0.4, 0, 0.2, 1). Место под число отведено заранее — строка с годом и жанрами не дёргается.

  ПРАЗДНИК ДЛЯ ВЫСОКОЙ ОЦЕНКИ — ровно как в APK (c5/f0, c5/Z, c5/a0, b5/E0):
    • больше 8.0 и меньше 8.7 — один «салют» (2.1 с): вспышка и 40 частиц веером вверх с
      гравитацией и мерцанием, каждая пятая — вращающаяся звёздочка;
    • от 8.7 — четыре «прожектора»: конусы цвета оценки из-под числа, перекрещиваются над ним и
      медленно покачиваются; загораются за 1.2 с, светят 7 с и гаснут за 2.2 с — и ВСЁ, движение
      останавливается (раньше лучи крутились бесконечно).
  Оба начинаются через 1450 мс — когда число почти досчитало.
*/

const EASE = Easing.bezier(0.4, 0, 0.2, 1);

export function ratingTone(r: number): string {
  return r >= 7 ? '#6FCF4F' : r >= 5 ? '#E9C45C' : '#9B9BA6';
}

// ─── счётчик ───────────────────────────────────────────────────────────────────────────────────

const AnimatedInput = Animated.createAnimatedComponent(TextInput);

/*
  ТАЙМЕР С ЗАЛИВКОЙ. Число набегает от 0.0 до оценки, как секундомер (десятые щёлкают), и
  ОДНОВРЕМЕННО цифры заливаются цветом оценки снизу вверх: под ними бледная копия того же числа
  (как у Влада — цвет оценки, прозрачность 22%), а цветной слой растёт от нижнего края. Цифры
  моноширинные (tabular-nums) и коробка постоянной ширины — число не «ездит», строка не дёргается.
*/
export const RatingClock = memo(function RatingClock({ rating, size = 26, play }: { rating: number; size?: number; play: boolean }) {
  const t = useSharedValue(0);
  const color = ratingTone(rating);
  const line = Math.round(size * 1.28);
  useEffect(() => {
    if (play) t.value = withTiming(1, { duration: 1600, easing: EASE });
  }, [play, t]);
  const text = useAnimatedProps(() => {
    const v = (t.value * rating).toFixed(1);
    return { text: v, defaultValue: v } as never;
  });
  /*
    Заливка — СДВИГОМ, а не высотой. Раньше каждый кадр менялась height окна, то есть шла
    раскладка (layout) на каждом кадре 1.6-секундной анимации. Теперь окно постоянной высоты
    съезжает вниз на непоказанную долю, а цифры внутри — ровно на столько же вверх и стоят на
    месте. Видимая часть та же самая: полоса от низа высотой line * t.
  */
  const fill = useAnimatedStyle(() => ({ transform: [{ translateY: line * (1 - t.value) }] }));
  const fillInner = useAnimatedStyle(() => ({ transform: [{ translateY: -line * (1 - t.value) }] }));
  const style = [styles.digit, { fontSize: size, lineHeight: line, height: line }];
  return (
    <View style={{ height: line, alignSelf: 'stretch' }}>
      <AnimatedInput editable={false} underlineColorAndroid="transparent" defaultValue="0.0" animatedProps={text} style={[style, { color, opacity: 0.22 }]} />
      <Animated.View style={[styles.fill, { height: line }, fill]}>
        <Animated.View style={[{ position: 'absolute', left: 0, right: 0, bottom: 0, height: line }, fillInner]}>
          <AnimatedInput editable={false} underlineColorAndroid="transparent" defaultValue="0.0" animatedProps={text} style={[style, { color }]} />
        </Animated.View>
      </Animated.View>
    </View>
  );
});

// ─── прожекторы (≥ 8.7) ────────────────────────────────────────────────────────────────────────

const BEAMS = [
  { x: -0.08, base: 52, amp: 15, freq: 1, off: 0 },
  { x: 0.28, base: 19, amp: 12, freq: 2, off: 1.7 },
  { x: 0.72, base: -19, amp: 13, freq: 3, off: 3.1 },
  { x: 1.08, base: -52, amp: 16, freq: 2, off: 4.6 },
];

function Beam({ b, w, h, color, up, phase, idx }: { b: (typeof BEAMS)[number]; w: number; h: number; color: string; up: SharedValue<number>; phase: SharedValue<number>; idx: number }) {
  const bw = 1.38 * h;
  const bh = 5 * h;
  const st = useAnimatedStyle(() => ({
    opacity: up.value,
    transform: [{ rotate: `${b.base + b.amp * Math.sin(phase.value * b.freq + b.off)}deg` }],
  }));
  // Трапеция: узкий конец (0.1h) внизу, у точки опоры, широкий (1.38h) — в 5h выше.
  const cx = bw / 2;
  const outer = `M${cx - 0.05 * h} ${bh} L${cx + 0.05 * h} ${bh} L${bw} 0 L0 0 Z`;
  const k = 0.34;
  const core = `M${cx - 0.05 * h * k} ${bh} L${cx + 0.05 * h * k} ${bh} L${cx + (bw / 2) * k} ${bh * 0.2} L${cx - (bw / 2) * k} ${bh * 0.2} Z`;
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: 'absolute', width: bw, height: bh, left: b.x * w - bw / 2, top: 1.15 * h - bh, transformOrigin: 'bottom' }, st]}
    >
      <Svg width={bw} height={bh}>
        <Defs>
          <SvgLinear id={`bo${idx}`} x1="0" y1={bh} x2="0" y2="0" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={color} stopOpacity={0.3} />
            <Stop offset="0.3" stopColor={color} stopOpacity={0.15} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </SvgLinear>
          <SvgLinear id={`bc${idx}`} x1="0" y1={bh} x2="0" y2={bh * 0.2} gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.13} />
            <Stop offset="0.5" stopColor={color} stopOpacity={0.06} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </SvgLinear>
        </Defs>
        <Path d={outer} fill={`url(#bo${idx})`} />
        <Path d={core} fill={`url(#bc${idx})`} />
      </Svg>
    </Animated.View>
  );
}

export const RatingBeams = memo(function RatingBeams({ w, h, color, play }: { w: number; h: number; color: string; play: boolean }) {
  const up = useSharedValue(0);
  const phase = useSharedValue(0);
  /*
    Лучи СУЩЕСТВУЮТ, только пока светят. Раньше четыре SVG-конуса с градиентами и свечение
    монтировались сразу с подробностями — то есть посреди анимации открытия страницы — и
    оставались навсегда, уже погасшими (прозрачность 0). Теперь они появляются незадолго до
    своего старта (ещё невидимыми) и снимаются, когда погасли: на экране всё то же самое.
  */
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!play) return;
    const on = setTimeout(() => setLive(true), 1000);
    const off = setTimeout(() => setLive(false), 1450 + 1200 + 5800 + 2200 + 150);
    return () => {
      clearTimeout(on);
      clearTimeout(off);
    };
  }, [play]);
  useEffect(() => {
    if (!play) return;
    const ease = Easing.bezier(0.4, 0, 0.2, 1);
    up.value = withDelay(1450, withSequence(withTiming(1, { duration: 1200, easing: ease }), withDelay(5800, withTiming(0, { duration: 2200, easing: ease }))));
    phase.value = withDelay(1450, withRepeat(withTiming(Math.PI * 2, { duration: 14000, easing: Easing.linear }), -1, false));
    // Погасли — качание останавливается: невидимая анимация не должна работать.
    const stop = setTimeout(() => cancelAnimation(phase), 1450 + 1200 + 5800 + 2200 + 100);
    return () => {
      clearTimeout(stop);
      cancelAnimation(phase);
    };
  }, [play, up, phase]);
  const glow = useAnimatedStyle(() => ({ opacity: up.value * 0.1 }));
  if (!live) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View style={[{ position: 'absolute', left: w / 2 - 0.7 * h, top: 0.55 * h - 0.7 * h, width: 1.4 * h, height: 1.4 * h, borderRadius: 0.7 * h, backgroundColor: color }, glow]} />
      {BEAMS.map((b, i) => (
        <Beam key={i} idx={i} b={b} w={w} h={h} color={color} up={up} phase={phase} />
      ))}
    </View>
  );
});

// ─── салют (8.0 < r < 8.7) ─────────────────────────────────────────────────────────────────────

const PALETTE = ['#E7D9A8', '#E49BB6', '#8C7BC9', '#7FD1C1', '#E0823C'];
const PARTS = Array.from({ length: 40 }, (_, i) => {
  const th = ((((i * 67) % 264) - 207) * Math.PI) / 180;
  const k = 0.45 + ((i * 29) % 56) / 100;
  const v = (((i * 7) % 11) * 1.05 + 3.2) * k;
  const life = 0.62 + 0.075 * (i % 5);
  const x0 = 0.1 + ((i * 37) % 80) / 100;
  return { i, th, k, v, life, x0, star: i % 5 === 0, alt: i % 5 === 4 };
});

function Particle({ p, w, h, color, t }: { p: (typeof PARTS)[number]; w: number; h: number; color: string; t: SharedValue<number> }) {
  const size = p.star ? 0.26 * h : 0.07 * h;
  const st = useAnimatedStyle(() => {
    const tt = t.value / p.life;
    if (t.value <= 0 || tt >= 1) return { opacity: 0 };
    const e = (1 - Math.exp(-2.5 * tt)) / 2.5;
    const x = p.x0 * w + Math.cos(p.th) * p.v * h * e;
    const y = 0.06 * h + Math.sin(p.th) * p.v * h * e + 5.4 * h * tt * tt;
    const a = Math.min(1, Math.max(0, (1 - tt) * 2.2)) * (0.72 + 0.28 * Math.sin(26 * tt + p.i)) * p.k;
    const s = (1 - 0.4 * tt) * p.k;
    const rot = p.star ? (1 - Math.exp(-2.5 * tt)) * 430 * (p.i % 2 === 0 ? 1 : -1) + 47 * p.i : 0;
    return {
      opacity: a <= 0.02 ? 0 : a,
      transform: [{ translateX: x - size / 2 }, { translateY: y - size / 2 }, { rotate: `${rot}deg` }, { scale: s }],
    };
  });
  const c = p.alt ? PALETTE[4] : color;
  return (
    <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: size, height: size }, st]}>
      {p.star ? (
        <Svg width={size} height={size} viewBox="-1 -1 2 2">
          <Path d={STAR} fill={c} />
        </Svg>
      ) : (
        <View style={{ flex: 1, borderRadius: size / 2, backgroundColor: c }} />
      )}
    </Animated.View>
  );
}

// Десятилучевая звезда: внешний радиус 1, внутренний 0.42, первый луч — вверх.
const STAR = Array.from({ length: 20 }, (_, i) => {
  const r = i % 2 === 0 ? 1 : 0.42;
  const a = -Math.PI / 2 + (i * Math.PI) / 10;
  return `${i === 0 ? 'M' : 'L'}${(r * Math.cos(a)).toFixed(3)} ${(r * Math.sin(a)).toFixed(3)}`;
}).join(' ') + 'Z';

export const RatingConfetti = memo(function RatingConfetti({ w, h, color, play }: { w: number; h: number; color: string; play: boolean }) {
  const t = useSharedValue(0);
  /*
    Салют СУЩЕСТВУЕТ, только пока летит. Раньше 40 частиц (из них 8 SVG-звёзд) и две вспышки
    монтировались сразу с подробностями — посреди анимации открытия страницы — и оставались
    навсегда невидимыми. Теперь они появляются за ~0.45 с до старта (ещё с нулевой
    прозрачностью: t = 0) и снимаются, когда все частицы догорели. Видимое — то же самое.
  */
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!play) return;
    t.value = withDelay(1450, withTiming(1, { duration: 2100, easing: Easing.linear }));
    const on = setTimeout(() => setLive(true), 1000);
    const off = setTimeout(() => setLive(false), 1450 + 2100 + 150);
    return () => {
      clearTimeout(on);
      clearTimeout(off);
    };
  }, [play, t]);
  /*
    Вспышки — КРУГ ПОСТОЯННОГО РАЗМЕРА С МАСШТАБОМ. Раньше каждый кадр менялись width/height/
    borderRadius/left/top, то есть шла раскладка. Теперь круг сразу наибольшего радиуса (1.85h —
    значение r при q → 1) стоит по тому же центру, а масштаб r / R даёт ровно тот же круг.
  */
  const R1 = 1.85 * h;
  const R2 = 0.45 * 1.85 * h;
  const flash = useAnimatedStyle(() => {
    const q = t.value / 0.2;
    if (t.value <= 0 || q >= 1) return { opacity: 0 };
    const f = 1 - q;
    const r = (0.35 + 1.5 * q) * h;
    return { opacity: 0.3 * f * f, transform: [{ scale: r / R1 }] };
  });
  const flash2 = useAnimatedStyle(() => {
    const q = t.value / 0.2;
    if (t.value <= 0 || q >= 1) return { opacity: 0 };
    const f = 1 - q;
    const r = 0.45 * (0.35 + 1.5 * q) * h;
    return { opacity: 0.22 * f * f * f, transform: [{ scale: r / R2 }] };
  });
  if (!live) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View
        style={[{ position: 'absolute', backgroundColor: color, width: R1 * 2, height: R1 * 2, borderRadius: R1, left: w / 2 - R1, top: 0.06 * h - R1, opacity: 0 }, flash]}
      />
      <Animated.View
        style={[{ position: 'absolute', backgroundColor: '#fff', width: R2 * 2, height: R2 * 2, borderRadius: R2, left: w / 2 - R2, top: 0.06 * h - R2, opacity: 0 }, flash2]}
      />
      {PARTS.map((p) => (
        <Particle key={p.i} p={p} w={w} h={h} color={color} t={t} />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  // Тот же вес, что у оценки на постерах (RatingChip); цифры одной ширины.
  digit: { fontFamily: font.display, fontWeight: '800', fontVariant: ['tabular-nums'], padding: 0, margin: 0 },
  fill: { position: 'absolute', left: 0, right: 0, bottom: 0, overflow: 'hidden' },
});
