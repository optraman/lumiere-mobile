import { memo } from 'react';
import { View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

/*
  СВЕЧЕНИЕ, КОТОРОЕ ЕСТЬ С ПЕРВОГО КАДРА.

  Свет на картинках-пятнах приходил не сразу: в Expo Go каждая картинка из assets грузится с
  сервера разработки (через ngrok), и пустой кадр перед ней был виден — «свечение прогружается не
  сразу». Здесь свет нарисован векторно, теми же пергаментными тонами и с тем же профилем спада
  (100% → 32% к середине → 0), что и у фона: рисовать его нечего ждать. Он неподвижен — нарисован
  один раз и дальше стоит готовой картинкой, ничего не стоя (SVG-полотно и есть картинка;
  shouldRasterizeIOS поверх него только удваивал память — снят).

  visible — сколько сверху реально видно (TopGlow показывает верхние ~300 точек): полотно
  рисуется только этой высоты, а пятна стоят там же, где стояли бы на весь экран. Раньше
  рисовался целый экран (~3 млн точек градиентов) ради его верхней трети.
*/
const SPOTS: { x: number; y: number; r: number; c: string; o: number }[] = [
  { x: 0.24, y: 0.16, r: 1.05, c: '#CCCC99', o: 0.13 },
  { x: 0.78, y: 0.24, r: 0.85, c: '#E0C89A', o: 0.1 },
  { x: 0.52, y: 0.42, r: 0.7, c: '#E6D5B0', o: 0.08 },
  { x: 0.1, y: 0.6, r: 0.9, c: '#CBC6BA', o: 0.06 },
  { x: 0.9, y: 0.72, r: 0.8, c: '#D9C38A', o: 0.06 },
];

export const StaticGlow = memo(function StaticGlow({
  width,
  height,
  strength = 1,
  visible,
}: {
  width: number;
  height: number;
  strength?: number;
  visible?: number;
}) {
  const h = Math.min(height, visible ?? height);
  return (
    <View style={{ position: 'absolute', left: 0, top: 0, width, height: h }} pointerEvents="none">
      <Svg width={width} height={h}>
        <Defs>
          {SPOTS.map((p, i) => (
            <RadialGradient key={i} id={`sg${i}`} cx={p.x * width} cy={p.y * height} r={p.r * width} gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor={p.c} stopOpacity={p.o * strength} />
              <Stop offset="0.55" stopColor={p.c} stopOpacity={p.o * 0.32 * strength} />
              <Stop offset="1" stopColor={p.c} stopOpacity={0} />
            </RadialGradient>
          ))}
        </Defs>
        <Rect x="0" y="0" width={width} height={h} fill="#08080A" />
        {SPOTS.map((_, i) => (
          <Rect key={i} x="0" y="0" width={width} height={h} fill={`url(#sg${i})`} />
        ))}
      </Svg>
    </View>
  );
});
