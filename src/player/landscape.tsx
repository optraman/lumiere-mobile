import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import type { PanGesture } from 'react-native-gesture-handler';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { usePortraitInsets } from '../nav/portrait';

/**
 * ПЛЕЕР ВСЕГДА ЛЕЖИТ, А ПРИЛОЖЕНИЕ ВСЕГДА СТОИТ (просьба Марка).
 *
 * Раньше плеер снимал замок ориентации, и система поворачивала окно целиком: вместе с плеером
 * ложились и страницы под ним, а на закрытии их приходилось возвращать в портрет — с чёрной
 * шторкой и с рывками, потому что системный поворот крутит всё окно разом.
 *
 * Теперь окно не поворачивается никогда. Плеер — это «лежачий» прямоугольник, нарисованный
 * внутри стоячего экрана и повёрнутый на четверть оборота. Куда именно повёрнут — решает
 * акселерометр: телефон повернули верхом влево — кадр лёг влево, перевернули — кадр за ним
 * развернулся (полуоборотом, плавно). Стоячего положения у плеера нет: держат телефон стоя — кадр
 * остаётся лежать, как лежал. Страница под плеером при этом не шевелится вовсе — она и не знает,
 * что что-то поворачивалось, а смахнутый кадр улетает поверх неё, стоящей.
 *
 * Внутри сцены всё раскладывается в лежачих размерах: для этого usePlayerWindow и
 * usePlayerInsets вместо размеров окна и системных полей.
 *
 * ЖЕСТЫ. Касания внутри повёрнутого слоя система пересчитывает сама (кнопки, прокрутка), но
 * обработчик жестов отдаёт СМЕЩЕНИЕ и СКОРОСТЬ в координатах окна — то есть стоячих. Для них
 * есть stageMotion (перевод в лежачие) и orientPan (пороги «по вертикали/горизонтали» — тоже в
 * лежачих осях).
 */

/** +1 — кадр повёрнут по часовой (телефон лёг верхом вправо), −1 — против (верхом влево). */
export type Side = 1 | -1;

type Stage = { width: number; height: number; insets: EdgeInsets; side: Side };

const Ctx = createContext<Stage | null>(null);

/*
  ЗНАК АКСЕЛЕРОМЕТРА. Расчёт был по CoreMotion (ось, что смотрит в пол, даёт −1), но на телефоне
  кадр ложился вверх ногами — Expo отдаёт ускорение с обратным знаком. Поэтому −1: проверено
  Марком на iPhone.
*/
const ACCEL_SIGN = -1;
/** Без датчика (или пока он молчит) — как держат чаще всего: верхом влево. */
const DEFAULT_SIDE: Side = -1;

type Accel = { x: number; y: number; z: number };
type AccelModule = {
  addListener?: (event: string, cb: (a: Accel) => void) => { remove: () => void };
  setUpdateInterval?: (ms: number) => void;
};

let lastSide: Side = DEFAULT_SIDE;

/** Сторона, куда лечь, — по наклону телефона. Пока неясно (стоит, лежит на столе) — прежняя. */
function useDeviceSide(): Side {
  const [side, setSide] = useState<Side>(lastSide);
  useEffect(() => {
    // Датчик — по возможности: не вышло подписаться — кадр просто лежит на привычном боку.
    let mod: AccelModule | null = null;
    try {
      mod = requireOptionalNativeModule<AccelModule>('ExponentAccelerometer');
    } catch {
      mod = null;
    }
    if (!mod || typeof mod.addListener !== 'function') return;
    try {
      // Четыре раза в секунду хватает: поворот телефона длится дольше, а лишние вызовы — нагрузка.
      mod.setUpdateInterval?.(250);
    } catch {
      // интервал по умолчанию тоже годится
    }
    /*
      ГИСТЕРЕЗИС. Повернуть кадр можно, только когда телефон явно лёг на бок: наклон по x больше
      0.6 и заметно больше наклона по y. Иначе на границе (телефон под 45°) кадр метался бы.
    */
    let sub: { remove: () => void } | undefined;
    try {
      sub = mod.addListener('accelerometerDidUpdate', (a) => {
      if (!a || typeof a.x !== 'number') return;
      const x = a.x * ACCEL_SIGN;
      if (Math.abs(x) < 0.6 || Math.abs(x) < Math.abs(a.y) + 0.2) return;
      const next: Side = x < 0 ? -1 : 1;
      if (next !== lastSide) {
        lastSide = next;
        setSide(next);
      }
      });
    } catch {
      sub = undefined;
    }
    return () => {
      try {
        sub?.remove?.();
      } catch {
        // уже отписан
      }
    };
  }, []);
  return side;
}

export function LandscapeStage({ children }: { children: ReactNode }) {
  const { width: W, height: H } = useWindowDimensions();
  const portrait = usePortraitInsets();
  const side = useDeviceSide();

  // Полуоборот при смене стороны — плавный, как у системы, а не скачок на 180°.
  const angle = useSharedValue(side * 90);
  const turning = useSharedValue(0);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      angle.value = side * 90;
      return;
    }
    turning.value = withSequence(withTiming(1, { duration: 80 }), withTiming(1, { duration: 420 }), withTiming(0, { duration: 160 }));
    angle.value = withTiming(side * 90, { duration: 520, easing: Easing.inOut(Easing.cubic) });
  }, [side, angle, turning]);

  /*
    Лёжа поля такие: сбоку — под «остров» (берётся верхнее поле стоячего экрана), и с ОБЕИХ
    сторон одинаково — так просил Марк: кнопки не должны прилипать ни к острову, ни к другому
    краю. Снизу — под полосу «домой».
  */
  const side0 = Math.max(portrait.top, 44);
  const insets: EdgeInsets = { top: 0, bottom: portrait.bottom > 0 ? 21 : 0, left: side0, right: side0 };

  const box = useAnimatedStyle(() => ({ transform: [{ rotate: `${angle.value}deg` }] }));
  // На полуобороте углы лежачего прямоугольника открывают страницу — на это время под ним чёрное.
  const under = useAnimatedStyle(() => ({ opacity: turning.value }));

  return (
    <Ctx.Provider value={{ width: H, height: W, insets, side }}>
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Animated.View style={[StyleSheet.absoluteFill, styles.under, under]} pointerEvents="none" />
        <Animated.View
          style={[styles.box, { width: H, height: W, left: (W - H) / 2, top: (H - W) / 2 }, box]}
          pointerEvents="box-none"
        >
          {children}
        </Animated.View>
      </View>
    </Ctx.Provider>
  );
}

/** Размеры плеера — всегда лежачие. */
export function usePlayerWindow(): { width: number; height: number } {
  const s = useContext(Ctx);
  const win = useWindowDimensions();
  return s ? { width: s.width, height: s.height } : win;
}

export function usePlayerInsets(): EdgeInsets {
  const s = useContext(Ctx);
  return s?.insets ?? { top: 0, bottom: 21, left: 59, right: 59 };
}

export function useStageSide(): Side {
  return useContext(Ctx)?.side ?? DEFAULT_SIDE;
}

/**
 * Смещение и скорость жеста — в осях лежачего кадра.
 *
 * Обработчик жестов меряет их в окне, а окно стоит. Кадр повёрнут по часовой (side = +1): его
 * «вправо» — это «вниз» окна, его «вниз» — «влево» окна. Против часовой — наоборот.
 */
export function stageMotion(
  e: { translationX: number; translationY: number; velocityX: number; velocityY: number },
  side: Side,
): { tx: number; ty: number; vx: number; vy: number } {
  'worklet';
  return {
    tx: side * e.translationY,
    ty: -side * e.translationX,
    vx: side * e.velocityY,
    vy: -side * e.velocityX,
  };
}

type Offset = number | [number, number];
const neg = (v: Offset): Offset => (Array.isArray(v) ? [-v[1], -v[0]] : -v);

/**
 * Пороги жеста в осях лежачего кадра: activeY(10) — «проснуться, когда палец пошёл вниз по
 * кадру», как бы кадр ни был повёрнут в окне.
 */
export function orientPan(
  g: PanGesture,
  side: Side,
  c: { activeX?: Offset; activeY?: Offset; failX?: Offset; failY?: Offset },
): PanGesture {
  const toWinY = (v: Offset) => (side === 1 ? v : neg(v));
  const toWinX = (v: Offset) => (side === 1 ? neg(v) : v);
  let out = g;
  if (c.activeX !== undefined) out = out.activeOffsetY(toWinY(c.activeX));
  if (c.activeY !== undefined) out = out.activeOffsetX(toWinX(c.activeY));
  if (c.failX !== undefined) out = out.failOffsetY(toWinY(c.failX));
  if (c.failY !== undefined) out = out.failOffsetX(toWinX(c.failY));
  return out;
}

const styles = StyleSheet.create({
  under: { backgroundColor: '#000000' },
  box: { position: 'absolute' },
});
