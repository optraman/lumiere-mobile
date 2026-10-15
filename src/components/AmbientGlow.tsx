import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Image, StyleSheet, View } from 'react-native';
import Reanimated, { Easing as REasing, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { usePortraitWindow } from '../nav/portrait';
import { MOODS } from '../data/moods';
import { StaticGlow } from './StaticGlow';
import { useScreenFocus } from '../nav/useScreenFocus';

/**
 * ФОН ПРИЛОЖЕНИЯ — тёплое свечение пергаментных пятен на чёрном.
 *
 * ЗАПЕЧЁННАЯ КАРТИНКА + ДВА МЕДЛЕННЫХ ПЯТНА.
 *
 * Было восемь живых полупрозрачных пятен в полтора-два экрана (и ещё четыре слоя перелива): на
 * iPhone с ProMotion система смешивала эту стопку до 120 раз в секунду — нагрев и просадки
 * везде, где есть фон. Потом была попытка сделать фон видеопетлёй — она сломала касания после
 * закрытия страниц (системный видеослой в модальных окнах) и виньетки. От видео отказались.
 *
 * Теперь: весь рисунок восьми пятен запечён в одну непрозрачную картинку (assets/glow/
 * ambient_poster.png, кадр той же отрисовки — tools/glow-bake.py). Поверх неё ходят ВСЕГО ДВА
 * пятна — очень медленно (48 с туда-обратно), по общим часам на всё приложение, так что фон живой,
 * но смешиваются на экране два слоя, а не двенадцать. На страницах со свечением сверху (TopGlow)
 * пятна не ходят вовсе — там свет стоит, и страница открывается с ним сразу, без подгрузки.
 */
const POSTER = require('../../assets/glow/ambient_poster.png');

/*
  ЧАСЫ ДРЕЙФА — фаза 0→1 за 32 с, по кругу; сам «туда-обратно по синусу» — в интерполяции (DRIFT).
  Бережём телефон:
  • Ходят, только пока хотя бы один экран со свечением ВИДЕН (glowHold): раньше пятна плыли
    всегда — под страницами фильмов (лента остаётся под ними), во вкладках, куда не заходили, —
    и экран перерисовывался до 120 раз в секунду впустую.
  • Шагают 24 раза в секунду, как плёнка: пятна сдвигаются на ~6 точек в секунду, и на глаз
    шаги неотличимы от плавного хода, а экран между шагами не перерисовывается.
  • Пауза не сбрасывает фазу: после возвращения пятна продолжают с того же места.
*/
// 32 с на круг (было 48): пятна плывут заметнее, но всё ещё спокойно (просьба Марка).
const LOOP_MS = 32000;
const STEPS = Math.round((LOOP_MS / 1000) * 24);
const phase = new Animated.Value(0);
const stepEase = (x: number) => Math.floor(x * STEPS) / STEPS;
// 0→1→0 по синусу за круг — то же движение, что прежняя пара «туда-обратно» по inOut(sin).
const DRIFT = (() => {
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  for (let i = 0; i <= 48; i++) {
    inputRange.push(i / 48);
    outputRange.push(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 48));
  }
  return phase.interpolate({ inputRange, outputRange });
})();
const drift = DRIFT;
let running = false;
let paused = false;
const holders = new Set<string>();
let anim: Animated.CompositeAnimation | null = null;
function runDrift() {
  if (running || paused || holders.size === 0) return;
  running = true;
  phase.stopAnimation((v) => {
    if (!running) return;
    const from = v >= 1 ? 0 : v;
    if (from === 0) phase.setValue(0);
    // Сначала — остаток круга от текущей фазы, потом обычная петля с нуля.
    anim = Animated.timing(phase, {
      toValue: 1,
      duration: Math.max(1, (1 - from) * LOOP_MS),
      easing: (x) => {
        const t = from + (1 - from) * x;
        return (stepEase(t) - from) / (1 - from);
      },
      useNativeDriver: true,
    });
    anim.start(({ finished }) => {
      if (!finished || !running) return;
      phase.setValue(0);
      anim = Animated.loop(Animated.timing(phase, { toValue: 1, duration: LOOP_MS, easing: stepEase, useNativeDriver: true }));
      anim.start();
    });
  });
}
function stopDrift() {
  running = false;
  anim?.stop();
  anim = null;
}
/** Экран со свечением виден (on) или нет. Пока не виден ни один — пятна стоят. */
export function glowHold(id: string, on: boolean): void {
  if (on) holders.add(id);
  else holders.delete(id);
  if (holders.size && !paused) runDrift();
  else stopDrift();
}

export const AmbientGlow = memo(function AmbientGlow({
  mood: withMood = false,
  still = false,
}: {
  surge?: Animated.Value;
  mood?: boolean;
  /** Без движения — свет просто стоит (страницы с TopGlow). */
  still?: boolean;
}) {
  const { width, height } = usePortraitWindow();
  const id = useId();
  const focused = useScreenFocus();
  useEffect(() => {
    glowHold(id, !still && focused);
    return () => glowHold(id, false);
  }, [id, still, focused]);
  /*
    Векторный свет нужен только до того, как ляжет запечённая картинка: она непрозрачная и
    закрывает его целиком. Потом он снимается — иначе это лишний слой во весь экран на каждом
    кадре (и по копии на каждую вкладку).
  */
  const [posterIn, setPosterIn] = useState(false);
  // Интерполяции — один раз на размер экрана, а не на каждую перерисовку.
  const tf = useMemo(
    () => ({
      a: [
        { translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [0, width * 0.38] }) },
        { translateY: drift.interpolate({ inputRange: [0, 1], outputRange: [0, height * 0.12] }) },
        { scale: drift.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.18, 1] }) },
      ],
      b: [
        { translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [0, -width * 0.42] }) },
        { translateY: drift.interpolate({ inputRange: [0, 1], outputRange: [0, -height * 0.1] }) },
      ],
    }),
    [width, height],
  );
  const a = width * 1.9;
  const b = width * 1.5;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* Векторный свет — с первого кадра; запечённая картинка ложится поверх, как только готова. */}
      {posterIn ? null : <StaticGlow width={width} height={height} />}
      <Image source={POSTER} style={{ position: 'absolute', left: 0, top: 0, width, height }} resizeMode="stretch" fadeDuration={0} onLoad={() => setPosterIn(true)} />
      {still ? null : (
        <>
          <Animated.Image
            source={BLOB}
            fadeDuration={0}
            style={{
              position: 'absolute',
              width: a,
              height: a,
              left: width * 0.3 - a / 2,
              top: height * 0.22 - a / 2,
              tintColor: '#E0C89A',
              opacity: 0.09,
              transform: tf.a,
            }}
          />
          <Animated.Image
            source={BLOB}
            fadeDuration={0}
            style={{
              position: 'absolute',
              width: b,
              height: b,
              left: width * 0.75 - b / 2,
              top: height * 0.7 - b / 2,
              tintColor: '#CCCC99',
              opacity: 0.07,
              transform: tf.b,
            }}
          />
        </>
      )}
      {withMood ? <MoodLayer width={width} height={height} /> : null}
    </View>
  );
});

const BLOB = require('../../assets/glow/blob.png');

function Gradient({ size, color, opacity }: { size: number; color: string; opacity: number }) {
  return <Image source={BLOB} style={{ width: size, height: size, tintColor: color, opacity }} fadeDuration={0} />;
}

let moodKey: string | null = null;
const moodSubs = new Set<(k: string | null) => void>();

export function setGlowMood(key: string | null): void {
  if (key === moodKey) return;
  moodKey = key;
  moodSubs.forEach((f) => f(key));
}

/*
  Цвет настроения — ДВЕ ячейки, а не слой на каждый жанр: новая ячейка получает цвет и проявляется,
  старая гаснет. Пока настроение не на экране, слой пуст и ничего не стоит.
*/
const MoodLayer = memo(function MoodLayer({ width, height }: { width: number; height: number }) {
  const [slots, setSlots] = useState<[string | null, string | null]>([null, null]);
  const front = useRef(0);
  const a = useSharedValue(0);
  const b = useSharedValue(0);
  useEffect(() => {
    const ease = { duration: 700, easing: REasing.inOut(REasing.quad) };
    const f = (k: string | null) => {
      const color = k ? MOODS.find((m) => m.key === k)?.glow ?? null : null;
      if (!color) {
        a.value = withTiming(0, ease);
        b.value = withTiming(0, ease);
        return;
      }
      const next = front.current === 0 ? 1 : 0;
      front.current = next;
      setSlots((sl) => (next === 0 ? [color, sl[1]] : [sl[0], color]));
      (next === 0 ? a : b).value = withTiming(1, ease);
      (next === 0 ? b : a).value = withTiming(0, ease);
    };
    moodSubs.add(f);
    if (moodKey) f(moodKey);
    return () => {
      moodSubs.delete(f);
    };
  }, [a, b]);
  return (
    <>
      {slots[0] ? <MoodTint color={slots[0]} w={a} width={width} height={height} /> : null}
      {slots[1] ? <MoodTint color={slots[1]} w={b} width={width} height={height} /> : null}
    </>
  );
});

const MoodTint = memo(function MoodTint({
  color,
  w,
  width,
  height,
}: {
  color: string;
  w: SharedValue<number>;
  width: number;
  height: number;
}) {
  const st = useAnimatedStyle(() => ({ opacity: w.value }));
  const big = width * 2.1;
  const small = width * 1.7;
  return (
    <Reanimated.View style={[StyleSheet.absoluteFill, st]} pointerEvents="none">
      <View style={{ position: 'absolute', left: width * 0.45 - big / 2, top: height * 0.28 - big / 2 }}>
        <Gradient size={big} color={color} opacity={0.2} />
      </View>
      <View style={{ position: 'absolute', left: width * 0.7 - small / 2, top: height * 0.72 - small / 2 }}>
        <Gradient size={small} color={color} opacity={0.14} />
      </View>
    </Reanimated.View>
  );
});


/** Свечение замирает под плеером: ни одного лишнего кадра под фильмом. */
export function setGlowPaused(next: boolean): void {
  if (paused === next) return;
  paused = next;
  if (next) stopDrift();
  else runDrift();
}
