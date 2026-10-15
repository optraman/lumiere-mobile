import { useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import Reanimated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../theme/colors';

/**
 * ОЖИДАНИЕ — ЛИНИЯ, БЕГУЩАЯ ПО КРАЮ. Одна и та же в кадре «Продолжить просмотр» и в поле поиска.
 *
 * Пока идёт работа (ищется источник, идёт поиск), по периметру бежит отрезок пергаментной линии.
 * Закончилось — линия не исчезает рывком: рамка за долю секунды замыкается целиком и растворяется.
 * Углы острые — линия идёт ровно по краю квадратной рамки.
 *
 * Анимируются только сдвиг штриха и прозрачность — то, что считается в потоке отрисовки без
 * участия JS. Длину штриха на ходу не меняем: «замыкание» — это вторая, сплошная рамка, которая
 * проявляется поверх бегущей.
 */
const AnimatedPath = Reanimated.createAnimatedComponent(Path);

/**
 * Контур рамки — ПУТЬ, а не прямоугольник со скруглением: так точно известно, где линия
 * начинается (посередине верхней кромки) и какой она длины. У прямоугольника со скруглением
 * начало и длину считает сама библиотека, и на кнопке-пилюле бегущий штрих на стыке цикла
 * перескакивал — линия шла «не по кнопке», а рывками.
 */
function outline(w: number, h: number, r: number): string {
  const x0 = LINE / 2;
  const y0 = LINE / 2;
  const x1 = w - LINE / 2;
  const y1 = h - LINE / 2;
  const cx = w / 2;
  return [
    `M${cx} ${y0}`,
    `H${x1 - r}`,
    r ? `A${r} ${r} 0 0 1 ${x1} ${y0 + r}` : '',
    `V${y1 - r}`,
    r ? `A${r} ${r} 0 0 1 ${x1 - r} ${y1}` : '',
    `H${x0 + r}`,
    r ? `A${r} ${r} 0 0 1 ${x0} ${y1 - r}` : '',
    `V${y0 + r}`,
    r ? `A${r} ${r} 0 0 1 ${x0 + r} ${y0}` : '',
    'Z',
  ].join(' ');
}
export const LINE = 2.5;

/** Периметр и длина бегущего штриха прямоугольной рамки — нужны пасхалке поиска (SnakeEgg). */
export function outlineMetrics(w: number, h: number) {
  const per = 2 * (w + h - 2 * LINE);
  return { per, seg: per * 0.24 };
}

export function BusyOutline({
  w,
  h,
  on,
  radius = 0,
  offset,
}: {
  w: number;
  h: number;
  on: boolean;
  radius?: number;
  /** Своё значение сдвига штриха снаружи — чтобы знать, где штрих сейчас (пасхалка поиска). */
  offset?: SharedValue<number>;
}) {
  // Скруглённая рамка (вокруг «Смотреть»): периметр меньше прямоугольного на (8 − 2π)·r — иначе
  // штрих на круге шёл бы рывком на стыке.
  const r = Math.max(0, Math.min(radius - LINE / 2, (h - LINE) / 2, (w - LINE) / 2));
  const per = 2 * (w + h - 2 * LINE) - (8 - 2 * Math.PI) * r;
  const d = outline(w, h, r);
  const seg = per * 0.24;
  const own = useSharedValue(0);
  const off = offset ?? own;
  const runA = useSharedValue(0);
  const fullA = useSharedValue(0);
  /** Белизна замкнувшейся рамки и её свечение (0…1). */
  const white = useSharedValue(0);
  const was = useRef(false);

  useEffect(() => {
    if (on) {
      was.current = true;
      cancelAnimation(fullA);
      cancelAnimation(white);
      fullA.value = 0;
      white.value = 0;
      runA.value = withTiming(1, { duration: 140 });
      off.value = 0;
      off.value = withRepeat(withTiming(-per, { duration: 1150, easing: Easing.linear }), -1, false);
      return;
    }
    if (!was.current) return;
    was.current = false;
    // Нашлось: рамка замыкается (сплошная проявляется), бегущий штрих гаснет под ней, потом гаснет всё.
    /*
      НАШЛОСЬ: рамка замыкается по всему периметру, затем линия плавно БЕЛЕЕТ и начинает светиться
      (свечение — тень того же контура белым светом), держится мгновение и растворяется целиком.
    */
    fullA.value = withSequence(
      withTiming(1, { duration: 170, easing: Easing.out(Easing.cubic) }),
      withDelay(230, withTiming(0, { duration: 240, easing: Easing.in(Easing.quad) })),
    );
    white.value = withSequence(withDelay(50, withTiming(1, { duration: 170, easing: Easing.inOut(Easing.quad) })), withDelay(440, withTiming(0, { duration: 10 })));
    runA.value = withTiming(0, { duration: 170 }, () => {
      cancelAnimation(off);
    });
  }, [on, per, off, runA, fullA, white]);

  const line = useAnimatedProps(() => ({ strokeDashoffset: off.value }));
  const runStyle = useAnimatedStyle(() => ({ opacity: runA.value }));
  const fullStyle = useAnimatedStyle(() => ({ opacity: fullA.value, shadowOpacity: white.value * 0.95 }));
  const whiteStyle = useAnimatedStyle(() => ({ opacity: white.value }));

  return (
    <>
      <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, runStyle]}>
        <Svg width={w} height={h}>
          <AnimatedPath
            d={d}
            fill="none"
            stroke={colors.focusFill}
            strokeWidth={LINE}
            strokeLinecap="round"
            strokeDasharray={`${seg} ${per - seg}`}
            animatedProps={line}
          />
        </Svg>
      </Reanimated.View>
      <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.glow, fullStyle]}>
        <Svg width={w} height={h}>
          <Path d={d} fill="none" stroke={colors.focusFill} strokeWidth={LINE} />
        </Svg>
        <Reanimated.View style={[StyleSheet.absoluteFill, whiteStyle]}>
          <Svg width={w} height={h}>
            <Path d={d} fill="none" stroke="#FFFFFF" strokeWidth={LINE} />
          </Svg>
        </Reanimated.View>
      </Reanimated.View>
    </>
  );
}

const styles = StyleSheet.create({
  // Свечение замкнувшейся рамки: белая тень по контуру линии (iOS считает её по прозрачности).
  glow: { shadowColor: '#FFFFFF', shadowOffset: { width: 0, height: 0 }, shadowRadius: 7, shadowOpacity: 0 },
});
