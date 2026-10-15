import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { colors } from '../theme/colors';
import { useScreenFocus } from '../nav/useScreenFocus';
import {
  fontFamilyOf,
  PLAQUE,
  POSITION_LIFT,
  PREVIEW_SIZE,
  type SubtitlePrefs,
} from '../data/subtitlePrefs';

const WORDMARK = require('../../assets/brand/brand_wordmark.png');
const WORDMARK_RATIO = 333 / 1469;

const APath = Animated.createAnimatedComponent(Path);

/**
 * ОКНО ПРЕДПРОСМОТРА СУБТИТРОВ — перенесено из SubtitlePreview в SettingsScreen.kt Влада.
 *
 * Его мысль дословно: «за подписью должно что-то двигаться, иначе не с чем сравнивать
 * читаемость, — и это должно быть тусклым и спокойным, потому что смысл окна в субтитрах».
 * Поэтому:
 *   — по тёмно-серому полю, как заставка DVD, плавает знак «Люмьер» и меняет цвет на каждом отскоке;
 *     две пилообразные траектории с РАЗНЫМИ периодами (9,4 и 6,1 с), сложенные в треугольник, —
 *     поэтому знак отражается от краёв и не ходит по одной диагонали;
 *   — каждый раз окно открывается в случайной фазе: знак сразу где-то посреди пути и уже в движении;
 *   — раз в две минуты снизу выбирается динозавр и четыре секунды рычит, расходясь дугами звука.
 *
 * Отличие одно: по касанию окна динозавр рычит сразу. Ждать две минуты, чтобы проверить, как
 * подпись читается поверх него, — лишнее.
 *
 * Картинки динозавра в передаче не оказалось (та же история, что со знаком: папку с растрами
 * не перенесли), поэтому он нарисован здесь контуром.
 */
const DVD_COLORS = ['#E7D9A8', '#7FD1C1', '#E49BB6', '#9CB7E8', '#D8B27A', '#A8CE8E'];
const PERIOD_X = 9400;
const PERIOD_Y = 6100;
const CYCLE = 120_000;
const ROAR_MS = 4000;

/** Силуэт динозавра в поле 120×100, мордой вправо, с открытой пастью. */
const DINO_D =
  'M5 70 Q30 55 55 52 Q75 50 82 40 L86 28 Q88 18 98 16 L112 16 Q118 17 118 23 L118 27 L104 28 ' +
  'L104 31 L114 32 Q116 36 112 38 L100 38 Q94 40 92 48 Q90 60 80 66 L76 70 L80 92 L72 92 L68 72 ' +
  'Q60 74 52 73 L50 92 L42 92 L42 72 Q25 72 5 70 Z M88 50 L96 54 L94 57 L87 53 Z';

export function SubtitlePreview({ prefs, active = true }: { prefs: SubtitlePrefs; active?: boolean }) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const W = useSharedValue(0);
  const H = useSharedValue(0);

  // Случайная фаза — один раз на открытие окна, как StartOffset(…, FastForward) у Влада.
  const [phase] = useState(() => ({ x: Math.random() * PERIOD_X, y: Math.random() * PERIOD_Y }));
  const clock = useSharedValue(0);
  /** Когда рычать вне очереди (по касанию). −1 — не надо. */
  const roarAt = useSharedValue(-1);

  /*
    ЧАСЫ ИДУТ, ТОЛЬКО КОГДА ОКНО МОЖНО УВИДЕТЬ: экран настроек в фокусе (не закрыт сверху
    «Загрузками» и т.п.) и окно рядом с видимой частью прокрутки (active от настроек). Раньше
    колбэк кадра работал на каждом кадре всё время, пока настройки смонтированы, — в том числе под
    другими экранами. Время берётся абсолютное (f.timestamp), поэтому после паузы знак оказывается
    ровно там, где был бы и без неё: для глаза ничего не меняется.
  */
  const focused = useScreenFocus();
  const run = focused && active;
  const frame = useFrameCallback((f) => {
    clock.value = f.timestamp;
  }, false);
  useEffect(() => {
    frame.setActive(run);
  }, [frame, run]);

  const fold = (v: number) => {
    'worklet';
    return v < 0.5 ? v * 2 : (1 - v) * 2;
  };

  // Размеры знака и динозавра — ОБЫЧНЫМ стилем от размера окна (он меняется только при
  // раскладке), а не в анимированном стиле: width/height на каждом кадре означали раскладку на
  // каждом кадре. Значения те же: 30% ширины окна и 46% его высоты.
  const logoSize = { width: box.w * 0.3, height: box.w * 0.3 * WORDMARK_RATIO };
  const dinoSize = { height: box.h * 0.46, width: box.h * 0.46 * 1.2 };

  const logo = useAnimatedStyle(() => {
    const lw = W.value * 0.3;
    const lh = lw * WORDMARK_RATIO;
    const rx = ((clock.value + phase.x) % PERIOD_X) / PERIOD_X;
    const ry = ((clock.value + phase.y) % PERIOD_Y) / PERIOD_Y;
    const bounces = Math.floor(rx * 2) + Math.floor(ry * 2);
    return {
      transform: [{ translateX: (W.value - lw) * fold(rx) }, { translateY: (H.value - lh) * fold(ry) }],
      tintColor: DVD_COLORS[bounces % DVD_COLORS.length],
    };
  });

  /** 0…1 — ход рыка; 0 — динозавра нет. Плановый раз в две минуты или вне очереди по касанию. */
  const roar = useDerivedValue(() => {
    if (roarAt.value >= 0) {
      const p = (clock.value - roarAt.value) / ROAR_MS;
      if (p >= 0 && p <= 1) return p;
    }
    const cycle = (clock.value % CYCLE) / CYCLE;
    const share = ROAR_MS / CYCLE;
    return Math.min(1, Math.max(0, (cycle - (1 - share)) / share));
  });

  const dino = useAnimatedStyle(() => {
    const r = roar.value;
    const dinoH = H.value * 0.46;
    const rise = r <= 0 ? 0 : r < 0.22 ? r / 0.22 : r > 0.8 ? (1 - r) / 0.2 : 1;
    const shake = r >= 0.22 && r <= 0.8 ? Math.sin(((r - 0.22) / 0.58) * Math.PI * 9) * 0.035 : 0;
    return {
      opacity: r > 0 ? 1 : 0,
      // Растёт от ног: масштаб от нижнего края, как TransformOrigin(0.5, 1) у Влада.
      transform: [
        { translateY: (1 - rise) * dinoH },
        { translateY: (dinoH * shake) / 2 },
        { scaleX: 1 + shake },
        { scaleY: 1 - shake },
      ],
    };
  });

  /** Три дуги звука, каждая чуть позади предыдущей. */
  const arc = (i: number) =>
    useAnimatedProps(() => {
      const r = roar.value;
      if (r < 0.22 || r > 0.8 || W.value === 0) return { d: 'M0 0', opacity: 0, strokeWidth: 0 };
      const t = (r - 0.22) / 0.58;
      const p = (t * 3 + i / 3) % 1;
      const dinoH = H.value * 0.46;
      const mx = W.value * 0.05 + dinoH * 1.2 * (118 / 120);
      const my = H.value - dinoH * 0.7;
      const rad = dinoH * (0.12 + p * 0.42);
      const a = (38 * Math.PI) / 180;
      const x1 = mx + rad * Math.cos(-a);
      const y1 = my + rad * Math.sin(-a);
      const x2 = mx + rad * Math.cos(a);
      const y2 = my + rad * Math.sin(a);
      return { d: `M${x1} ${y1} A${rad} ${rad} 0 0 1 ${x2} ${y2}`, opacity: (1 - p) * 0.5, strokeWidth: H.value * 0.014 };
    });
  const arc0 = arc(0);
  const arc1 = arc(1);
  const arc2 = arc(2);

  // Дуги звука МОНТИРУЮТСЯ, только пока идёт рык (r > 0; видны они с r = 0.22, так что запас почти
  // секунда). Остальные ~116 секунд из двух минут три SVG-пути получали новое «d» каждый кадр, хотя
  // были невидимы.
  const [roaring, setRoaring] = useState(false);
  useAnimatedReaction(
    () => roar.value > 0,
    (on, prev) => {
      if (on !== prev) runOnJS(setRoaring)(on);
    },
  );

  // Смена положения не прыжком, а пружиной: видно, куда переехала подпись.
  const lift = useSharedValue(POSITION_LIFT[prefs.position] ?? 0);
  useEffect(() => {
    lift.value = withSpring(POSITION_LIFT[prefs.position] ?? 0, { damping: 20, stiffness: 220 });
  }, [prefs.position, lift]);
  const caption = useAnimatedStyle(() => ({ bottom: H.value * lift.value + H.value * 0.04 }));

  const bg = prefs.background;
  return (
    <Pressable
      onPress={() => {
        roarAt.value = clock.value;
      }}
      style={styles.frame}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        W.value = width;
        H.value = height;
        setBox({ w: width, h: height });
      }}
    >
      <Animated.Image source={WORDMARK} resizeMode="contain" style={[styles.logo, logoSize, logo]} />

      <Animated.View style={[styles.dino, dinoSize, dino]} pointerEvents="none">
        <Svg width="100%" height="100%" viewBox="0 0 120 100">
          <Path d={DINO_D} fill="#8FB57A" />
          <Circle cx={108} cy={21} r={1.8} fill="#232326" />
        </Svg>
      </Animated.View>
      {roaring ? (
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          <APath animatedProps={arc0} stroke="#E7D9A8" fill="none" />
          <APath animatedProps={arc1} stroke="#E7D9A8" fill="none" />
          <APath animatedProps={arc2} stroke="#E7D9A8" fill="none" />
        </Svg>
      ) : null}

      {box.h > 0 ? (
        <Animated.View style={[styles.captionRow, caption]} pointerEvents="none">
          <Animated.Text
            numberOfLines={1}
            style={[
              styles.caption,
              {
                fontSize: Math.max(9, box.h * (PREVIEW_SIZE[prefs.size] ?? 0.06)),
                fontFamily: fontFamilyOf(prefs.font),
                backgroundColor: PLAQUE[bg] ?? PLAQUE[1],
              },
              // «Без фона» в плеере рисуется обводкой; плотная тень — её ближайший родственник.
              bg === 0 ? styles.outline : null,
            ]}
          >
            Пример субтитров
          </Animated.Text>
        </Animated.View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#232326',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.stroke,
    overflow: 'hidden',
  },
  logo: { position: 'absolute', left: 0, top: 0 },
  dino: { position: 'absolute', left: '5%', bottom: 0 },
  captionRow: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  caption: { color: '#ffffff', paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  outline: { textShadowColor: '#000000', textShadowRadius: 6, textShadowOffset: { width: 0, height: 0 } },
});
