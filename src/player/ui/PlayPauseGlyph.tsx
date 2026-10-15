import { useEffect } from 'react';
import Animated, { Easing, interpolate, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

/**
 * «ИГРАТЬ» ПЕРЕТЕКАЕТ В «ПАУЗУ» — ОДНОЙ ФИГУРОЙ, А НЕ ПОДМЕНОЙ ЗНАЧКА.
 *
 * Треугольник разрезан по вертикали на две половины, каждая — четырёхугольник (у правой две
 * вершины совпадают в острие). Столбики паузы — тоже два четырёхугольника. При нажатии каждая
 * вершина плавно едет из одной фигуры в другую: левая половина треугольника становится левым
 * столбиком, правая — правым. Так это делает и ютуб: значок не мигает, а меняет форму под пальцем.
 *
 * Пропорции — те же, что у PlayGlyph и PauseGlyph Влада (Glyphs.tsx), приведённые к одному полю:
 *   треугольник (0.26, 0.16) → (0.82, 0.5) → (0.26, 0.84);
 *   столбики шириной 0.185, высотой 0.81, зазор 0.18 — как 5×22 с зазором 5 у Влада.
 * Углы скругляет обводка того же цвета — у Влада столбики скруглены.
 */
const AnimatedPath = Animated.createAnimatedComponent(Path);

type Pt = [number, number];
// Левая половина треугольника → левый столбик.
const PLAY_L: Pt[] = [[0.26, 0.16], [0.54, 0.33], [0.54, 0.67], [0.26, 0.84]];
const PAUSE_L: Pt[] = [[0.225, 0.095], [0.41, 0.095], [0.41, 0.905], [0.225, 0.905]];
// Правая половина (острие — две совпавшие вершины) → правый столбик.
const PLAY_R: Pt[] = [[0.54, 0.33], [0.82, 0.5], [0.82, 0.5], [0.54, 0.67]];
const PAUSE_R: Pt[] = [[0.59, 0.095], [0.775, 0.095], [0.775, 0.905], [0.59, 0.905]];

function shape(a: Pt[], b: Pt[], p: number, s: number): string {
  'worklet';
  let d = '';
  for (let i = 0; i < a.length; i++) {
    const x = interpolate(p, [0, 1], [a[i][0], b[i][0]]) * s;
    const y = interpolate(p, [0, 1], [a[i][1], b[i][1]]) * s;
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)} `;
  }
  return `${d}Z`;
}

export function PlayPauseGlyph({ playing, color, size = 34 }: { playing: boolean; color: string; size?: number }) {
  // 0 — «играть» (сейчас пауза), 1 — «пауза» (сейчас играет).
  const p = useSharedValue(playing ? 1 : 0);
  useEffect(() => {
    p.value = withTiming(playing ? 1 : 0, { duration: 220, easing: Easing.bezier(0.4, 0, 0.2, 1) });
  }, [playing, p]);

  const left = useAnimatedProps(() => ({ d: shape(PLAY_L, PAUSE_L, p.value, size) }));
  const right = useAnimatedProps(() => ({ d: shape(PLAY_R, PAUSE_R, p.value, size) }));
  const round = size * 0.05;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <AnimatedPath animatedProps={left} fill={color} stroke={color} strokeWidth={round} strokeLinejoin="round" />
      <AnimatedPath animatedProps={right} fill={color} stroke={color} strokeWidth={round} strokeLinejoin="round" />
    </Svg>
  );
}
