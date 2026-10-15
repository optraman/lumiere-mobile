import { memo, useMemo, type ReactNode } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { G } from './clock';
import { GRAIN } from './grain';

/*
  ПЛЁНКА ПОВЕРХ СЦЕНЫ: зерно и пыль. Без затемнённых краёв —
  виньетку внутри карточки Марк попросил убрать.

  Всё — готовые картинки, которые только прыгают: зерно — плитка (grain.ts), каждые 1/24 с она
  встаёт в новое место, как зерно на следующем кадре плёнки. Пыль — две россыпи соринок, видна
  то одна, то другая.
  Шаги посчитаны заранее «лесенкой» интерполяции на нативном драйвере — JS не участвует.

  Плёнка «чуть пошарпанная»: всё приглушено, чтобы абстракция читалась, а не тонула в мусоре.
*/
// 24 шага в секунду — как кадры плёнки: зерно «кипит» ровно, а не дёргается рывками.
const STEPS = 24;

/** «Лесенка» по быстрым часам: на каждом из STEPS шагов секунды — своё значение. */
function stepped(values: number[], clock: Animated.Value = G) {
  const n = values.length;
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  for (let i = 0; i < n; i++) {
    inputRange.push(i / n, (i + 1) / n - 1e-4);
    outputRange.push(values[i], values[i]);
  }
  return clock.interpolate({ inputRange, outputRange, extrapolate: 'clamp' });
}

/** Предсказуемый «случай» — одна и та же россыпь при каждом запуске. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}
const R = rng(97);
const JX = Array.from({ length: STEPS }, () => -Math.round(R() * 90));
const JY = Array.from({ length: STEPS }, () => -Math.round(R() * 90));

function Dust({ w, h, seed }: { w: number; h: number; seed: number }) {
  const out: ReactNode[] = [];
  const r = rng(seed);
  for (let i = 0; i < 9; i++) {
    const dark = r() < 0.6;
    out.push(<Circle key={`d${i}`} cx={r() * w} cy={r() * h} r={0.5 + r() * 1.1} fill={dark ? '#000' : '#fff'} opacity={dark ? 0.5 : 0.35} />);
  }
  // Волосок: короткая кривая.
  const x = r() * w;
  const y = r() * h;
  const a = r() * Math.PI;
  const L = 10 + r() * 16;
  out.push(
    <Path
      key="hair"
      d={`M${x},${y} q${Math.cos(a) * L * 0.5 + 4},${Math.sin(a) * L * 0.5 - 3} ${Math.cos(a) * L},${Math.sin(a) * L}`}
      stroke="#000"
      strokeWidth={0.7}
      fill="none"
      opacity={0.45}
    />,
  );
  return <>{out}</>;
}

export const FilmGrain = memo(function FilmGrain({ w, h, strength = 1 }: { w: number; h: number; strength?: number }) {
  const anim = useMemo(() => {
    // Какая россыпь пыли видна на каком шаге: чаще — никакой.
    // Две россыпи, не три: каждая — полотно во весь кадр в памяти видеокарты.
    const dustOn = [
      [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0],
    ];
    return {
      gx: stepped(JX),
      gy: stepped(JY),
      dust: dustOn.map((v) => stepped(v)),
    };
  }, []);
  const k = Math.max(0, Math.min(1.5, strength));
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.Image
        source={GRAIN}
        resizeMode="repeat"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: w + 96,
          height: h + 96,
          opacity: 0.4 * k,
          transform: [{ translateX: anim.gx }, { translateY: anim.gy }],
        }}
      />
      {anim.dust.map((o, i) => (
        <Animated.View key={i} style={[StyleSheet.absoluteFill, { opacity: Animated.multiply(o, k) }]}>
          <Svg width={w} height={h}>
            <Dust w={w} h={h} seed={31 + i * 17} />
          </Svg>
        </Animated.View>
      ))}
      {/* Вертикальных царапин нет — Марк попросил убрать две полосы; остались зерно и пыль. */}
    </View>
  );
});
