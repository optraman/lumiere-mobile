import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Reanimated, { interpolateColor, useAnimatedProps, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

import { K, MORPH, type MorphScene } from './film/morphShapes';

/*
  МОРФИНГ МЕЖДУ СЦЕНАМИ «НАСТРОЕНИЯ». Пока листаешь карусель, фигуры одной сцены перетекают в
  фигуры следующей: полосы боевика вздуваются в круги романтики, круги — в солнце комедии,
  солнце сжимается в арку ужасов, арка раздувается в планету. Ровно на столько, на сколько
  сдвинут палец, — и обратно, если вернуть.

  Как устроено. У каждой сцены четыре фигуры-«актёра» с одинаковым числом точек (morphShapes):
  в потоке отрисовки (worklet Reanimated) точки и цвета смешиваются по положению карусели, и
  контуры перестраиваются. Перерисовка идёт ТОЛЬКО пока палец двигает карусель; в покое слой
  невидим и ничего не стоит.

  Морфинг рисует фигуры плоским цветом (градиенты не переливаются), поэтому у самого края
  перехода он подменяется настоящей сценой со светом и градиентами: в первые и последние 25 %
  хода слой морфинга проявляется поверх сцены и гаснет над следующей. Формы в этот момент
  совпадают, и подмены не видно.
*/
const EDGE = 0.25;
const HALF = 0.5;

const APath = Reanimated.createAnimatedComponent(Path);
const ARect = Reanimated.createAnimatedComponent(Rect);

/** Где мы между сценами: номер левой сцены и сглаженная доля перехода к правой. */
function seg(p: number, n: number) {
  'worklet';
  const c = Math.min(n - 1, Math.max(0, p));
  const i = Math.min(n - 2, Math.floor(c));
  const t = c - i;
  // Сглаживание: фигура трогается и прибывает мягко, а не с постоянной скоростью пальца.
  // Плавнее smoothstep: у smootherstep нулевое и ускорение на краях — нет «толчка» при старте.
  return { i, t: t * t * t * (t * (t * 6 - 15) + 10) };
}

function Actor({ scenes, a, pos }: { scenes: MorphScene[]; a: number; pos: SharedValue<number> }) {
  const n = scenes.length;
  const pts = scenes.map((s) => s.actors[a].pts);
  const cols = scenes.map((s) => s.actors[a].color);
  const props = useAnimatedProps(() => {
    const { i, t } = seg(pos.value, n);
    const p = pts[i];
    const q = pts[i + 1];
    let d = '';
    for (let j = 0; j < K; j++) {
      const x = p[2 * j] + (q[2 * j] - p[2 * j]) * t;
      const y = p[2 * j + 1] + (q[2 * j + 1] - p[2 * j + 1]) * t;
      d += (j ? 'L' : 'M') + Math.round(x * 10) / 10 + ',' + Math.round(y * 10) / 10;
    }
    // HSV, а не RGB: между оранжевым и лиловым RGB даёт грязно-бурый, HSV идёт через пурпур.
    return { d: d + 'Z', fill: interpolateColor(t, [0, 1], [cols[i], cols[i + 1]], 'HSV') };
  });
  return <APath animatedProps={props} />;
}

export const MoodMorph = memo(function MoodMorph({ keys, pos, w, h }: { keys: string[]; pos: SharedValue<number>; w: number; h: number }) {
  const scenes = useMemo(() => keys.map((k) => MORPH[k]).filter(Boolean), [keys]);
  const n = scenes.length;
  const bgs = scenes.map((s) => s.bg);
  const layer = useAnimatedStyle(() => {
    const c = Math.min(n - 1, Math.max(0, pos.value));
    const f = c - Math.floor(c);
    const s = (v: number) => {
      const x = Math.min(1, Math.max(0, v));
      return x * x * x * (x * (x * 6 - 15) + 10);
    };
    return { opacity: s(f / EDGE) * s((1 - f) / EDGE) };
  });
  const bg = useAnimatedProps(() => {
    const { i, t } = seg(pos.value, n);
    return { fill: interpolateColor(t, [0, 1], [bgs[i], bgs[i + 1]], 'HSV') };
  });
  if (n < 2) return null;
  return (
    <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, layer]}>
      {/*
        Подвижные контуры — на своём полотне в половину разрешения (растянуто обратно): пока
        палец ведёт карусель, полотно перерисовывается каждый кадр, и в полном 3x-размере это
        был миллион с лишним точек на кадр — листание подтормаживало. Плоские фигуры под зерном
        в половинном разрешении неотличимы.
      */}
      <View style={{ width: w * HALF, height: h * HALF, transformOrigin: 'top left', transform: [{ scale: 1 / HALF }] }}>
        <Svg width={w * HALF} height={h * HALF} viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">
          <ARect x={0} y={0} width={400} height={300} animatedProps={bg} />
          {[0, 1, 2, 3].map((a) => (
            <Actor key={a} scenes={scenes} a={a} pos={pos} />
          ))}
        </Svg>
      </View>
      {/* Свет и тень поверх — отдельным НЕПОДВИЖНЫМ полотном: нарисованы один раз и не
          перерисовываются вместе с контурами. */}
      <Svg style={StyleSheet.absoluteFill} width={w} height={h} viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">
        <Defs>
          <RadialGradient id="mm-l" cx="0.3" cy="0.2" r="0.8">
            <Stop offset="0" stopColor="#fff" stopOpacity={0.1} />
            <Stop offset="1" stopColor="#fff" stopOpacity={0} />
          </RadialGradient>
          <LinearGradient id="mm-d" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0.5" stopColor="#000" stopOpacity={0} />
            <Stop offset="1" stopColor="#000" stopOpacity={0.22} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={400} height={300} fill="url(#mm-l)" />
        <Rect x={0} y={0} width={400} height={300} fill="url(#mm-d)" />
      </Svg>
    </Reanimated.View>
  );
});
