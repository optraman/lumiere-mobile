import { StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

/**
 * ЗНАЧКИ ПЛЕЕРА — ПЕРЕНЕСЕНЫ ИЗ PlayerGlyphs.kt ВЛАДА.
 *
 * У него это не чужой набор иконок, а собственные фигуры, нарисованные путём. Его слова в коде:
 * «треугольник и полоска, нарисованные — чётче и больше похоже на плеер, чем стрелка». Поэтому
 * здесь они воспроизведены теми же пропорциями, а не подобраны «похожие» из системного набора:
 * подобранные неизбежно оказались бы другой толщины и другого характера.
 *
 * Пропорции взяты дословно:
 *   SkipGlyph      — треугольник 0.12…0.72 по ширине, концевая полоска на 0.86, толщина 0.11;
 *   PauseGlyph     — два столбика 5×22 со скруглением 2 и зазором 5;
 *   SubtitlesGlyph — три полосы 24 / 16 / 24 высотой 3, зазор 3.
 */

/** «К следующей серии» / «к предыдущей»: треугольник и концевая полоска. */
export function SkipGlyph({ forward, color, size = 24 }: { forward: boolean; color: string; size?: number }) {
  const w = size;
  const h = size;
  return (
    <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={forward ? undefined : styles.mirrored}>
      <Path
        d={`M${w * 0.12} ${h * 0.18} L${w * 0.72} ${h * 0.5} L${w * 0.12} ${h * 0.82} Z`}
        fill={color}
      />
      <Path
        d={`M${w * 0.86} ${h * 0.18} L${w * 0.86} ${h * 0.82}`}
        stroke={color}
        strokeWidth={w * 0.11}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Треугольник «играть» — тот же, что у него в Icons.Filled.PlayArrow, но своей рукой. */
export function PlayGlyph({ color, size = 34 }: { color: string; size?: number }) {
  const s = size;
  return (
    <Svg width={s} height={s} viewBox={`0 0 ${s} ${s}`}>
      <Path d={`M${s * 0.26} ${s * 0.16} L${s * 0.82} ${s * 0.5} L${s * 0.26} ${s * 0.84} Z`} fill={color} />
    </Svg>
  );
}

/** Пауза: два столбика со скруглением. */
export function PauseGlyph({ color, size = 24 }: { color: string; size?: number }) {
  const barW = size * 0.21;
  const barH = size * 0.92;
  return (
    <View style={[styles.pauseRow, { gap: size * 0.21 }]}>
      <View style={{ width: barW, height: barH, borderRadius: size * 0.084, backgroundColor: color }} />
      <View style={{ width: barW, height: barH, borderRadius: size * 0.084, backgroundColor: color }} />
    </View>
  );
}

/** Субтитры: три полосы — длинная, короткая, длинная. */
export function SubtitlesGlyph({ color, size = 20 }: { color: string; size?: number }) {
  const long = size;
  const short = size * 0.67;
  const bar = Math.max(2, size * 0.125);
  const gap = Math.max(2, size * 0.125);
  const line = { height: bar, borderRadius: bar / 2, backgroundColor: color };
  return (
    <View style={[styles.subsCol, { gap }]}>
      <View style={[line, { width: long }]} />
      <View style={[line, { width: short }]} />
      <View style={[line, { width: long }]} />
    </View>
  );
}

/*
  ЗНАЧКИ ИЗ ПЛЕЕРА ВЛАДА (APK Lumiere 11.20.83, i5/AbstractC1708q) — те же векторы Material, что
  он кладёт на кнопки: «Озвучка» — Filled.RecordVoiceOver, «Субтитры» — Filled.Subtitles,
  «Скорость» — Filled.Speed, «Пропустить вступление» — Filled.KeyboardArrowRight. Пути перенесены
  дословно (сетка 24×24), без замены на «похожие».
*/
function Material({ d, color, size }: { d: string[]; color: string; size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {d.map((x, i) => (
        <Path key={i} d={x} fill={color} />
      ))}
    </Svg>
  );
}

export function VoiceGlyph({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <Material
      color={color}
      size={size}
      d={[
        'M9 9m-4 0a4 4 0 1 1 8 0a4 4 0 1 1 -8 0',
        'M9 15c-2.67 0 -8 1.34 -8 4v2h16v-2c0 -2.66 -5.33 -4 -8 -4ZM16.76 5.36l-1.68 1.69c0.84 1.18 0.84 2.71 0 3.89l1.68 1.69c2.02 -2.02 2.02 -5.07 0 -7.27ZM20.07 2l-1.63 1.63c2.77 3.02 2.77 7.56 0 10.74L20.07 16c3.9 -3.89 3.91 -9.95 0 -14Z',
      ]}
    />
  );
}

export function SubsGlyph({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <Material
      color={color}
      size={size}
      d={['M20 4L4 4c-1.1 0 -2 0.9 -2 2v12c0 1.1 0.9 2 2 2h16c1.1 0 2 -0.9 2 -2L22 6c0 -1.1 -0.9 -2 -2 -2ZM4 12h4v2L4 14v-2ZM14 18L4 18v-2h10v2ZM20 18h-4v-2h4v2ZM20 14L10 14v-2h10v2Z']}
    />
  );
}

export function SpeedGlyph({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <Material
      color={color}
      size={size}
      d={['M20.38 8.57l-1.23 1.85a8 8 0 0 1 -0.22 7.58L5.07 18A8 8 0 0 1 15.58 6.85l1.85 -1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74 -1a10 10 0 0 0 -0.27 -10.44ZM10.59 15.41a2 2 0 0 0 2.83 0l5.66 -8.49l-8.49 5.66a2 2 0 0 0 0 2.83Z']}
    />
  );
}

export function ArrowRightGlyph({ color, size = 22 }: { color: string; size?: number }) {
  return <Material color={color} size={size} d={['M8.59 16.59L13.17 12L8.59 7.41L10 6l6 6l-6 6l-1.41 -1.41Z']} />;
}

/** Кубок наград со страницы тайтла (A/C0012f case 11). */
export function TrophyGlyph({ color, size = 26 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 26 26" fill="none">
      <Path d="M7.28 2.6 L18.72 2.6 L17.68 11.96 Q13 16.12 8.32 11.96 Z" fill={color} />
      <Path d="M4.94 9.88 A3.38 3.38 0 0 1 4.94 3.12 M21.06 3.12 A3.38 3.38 0 0 1 21.06 9.88" stroke={color} strokeWidth={2.34} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M13 15.6 L13 20.28" stroke={color} strokeWidth={2.34} strokeLinecap="round" />
      <Path d="M7.8 22.88 L18.2 22.88" stroke={color} strokeWidth={3.276} strokeLinecap="round" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  // Назад — это тот же значок, отражённый: ровно так он и делает (rotationY = 180).
  mirrored: { transform: [{ scaleX: -1 }] },
  pauseRow: { flexDirection: 'row', alignItems: 'center' },
  subsCol: { alignItems: 'center' },
});
