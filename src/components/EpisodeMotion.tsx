import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Image, Pressable, StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Animated, {
  type SharedValue,
  Easing,
  interpolateColor,
  Keyframe,
  cancelAnimation,
  makeMutable,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { colors } from '../theme/colors';

/**
 * ДВИЖЕНИЕ В СПИСКАХ СЕРИЙ — одно и то же на странице серий и в ленте серий плеера.
 *
 *   StillImage   — кадр серии. Пока он грузится, пустая рамка мягко «дышит», пришедший кадр
 *                  проявляется — без движения внутри рамки.
 *   SeasonSwap   — смена сезона: список уезжает не рывком, а въезжает со стороны выбранного
 *                  сезона (правее — справа, левее — слева) и проявляется.
 *   SeasonChip   — капсула сезона: заливка перетекает за 200 мс, а не перещёлкивается.
 */

const AImage = Animated.createAnimatedComponent(Image);

/*
  ОДНО «ДЫХАНИЕ» НА ВСЕ КАДРЫ. Раньше у каждого кадра был свой бегущий блик (своя анимация, свой
  градиент, свой замер ширины) — на списке из двадцати серий это и лагало. Теперь пустые рамки
  все вместе мягко пульсируют одним общим значением, а пришедший кадр просто проявляется — без
  движения внутри рамки (сдвиг и «посадка» картинки выглядели странно).
*/
const pulse = makeMutable(0);
/*
  «Дыхание» идёт, только пока хоть одна рамка ждёт кадр. Раньше оно, раз начавшись, не
  останавливалось никогда — бесконечная анимация на весь срок работы приложения (телефон грелся).
*/
let waiting = 0;
function holdPulse() {
  waiting += 1;
  if (waiting === 1) pulse.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }), -1, true);
}
function releasePulse() {
  waiting = Math.max(0, waiting - 1);
  if (waiting === 0) {
    cancelAnimation(pulse);
    pulse.value = 0;
  }
}

/*
  КАДРЫ, КОТОРЫЕ УЖЕ ПОКАЗЫВАЛИ, ПОКАЗЫВАЮТСЯ СРАЗУ. Списки серий виртуализованы — строки за краем
  экрана снимаются и собираются снова, когда до них долистают. Картинка при этом берётся из памяти
  мгновенно, но раньше каждая новая сборка строки заново проигрывала «дыхание» пустой рамки и
  проявление кадра — и выглядело это как «кадры грузятся по десять раз». Теперь рамка помнит, что
  этот кадр уже приходил, и рисует его сразу, без ожидания и без проявления.
*/
const seenUris = new Set<string>();

export function StillImage({
  uri,
  waiting,
  style,
  children,
}: {
  uri: string | null | undefined;
  /** Кадр ещё может прийти (ответа справочника пока нет) — значит, рамка «дышит». */
  waiting?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const known = !!uri && seenUris.has(uri);
  const [loaded, setLoaded] = useState(known);
  const shown = useSharedValue(known ? 1 : 0);
  const busy = !loaded && (!!uri || !!waiting);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const k = !!uri && seenUris.has(uri);
    setLoaded(k);
    shown.value = k ? 1 : 0;
  }, [uri, shown]);

  useEffect(() => {
    if (!busy) return;
    holdPulse();
    return releasePulse;
  }, [busy]);

  const img = useAnimatedStyle(() => ({ opacity: shown.value }));
  const glow = useAnimatedStyle(() => ({ opacity: busy ? 0.04 + pulse.value * 0.07 : 0 }));

  return (
    <View style={[styles.frame, style]}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.glow, glow]} pointerEvents="none" />
      {uri ? (
        <AImage
          source={{ uri }}
          resizeMode="cover"
          style={[StyleSheet.absoluteFill, img]}
          /*
            onLoadEnd, а не onLoad: кадр, уже лежащий в кэше, иногда не присылает onLoad — и
            оставался невидимым («кадры повторно не прогружаются»). onLoadEnd приходит всегда.
          */
          onLoadEnd={() => {
            if (uri) seenUris.add(uri);
            if (loaded) return;
            setLoaded(true);
            shown.value = withTiming(1, { duration: 220 });
          }}
        />
      ) : null}
      {children}
    </View>
  );
}

/** Сдвиг въезда списка: со стороны, куда переключились. */
const enterFrom = (dir: number) =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateX: dir * 36 }] },
    100: { opacity: 1, transform: [{ translateX: 0 }], easing: Easing.out(Easing.cubic) },
  }).duration(280);

/**
 * Смена сезона. Держит прошлый номер сам: направление въезда — по тому, в какую сторону
 * переключились, и первому показу въезда нет (страница и так только что открылась).
 */
export function SeasonSwap({
  season,
  order,
  style,
  children,
}: {
  season: string | number;
  /** Все сезоны по порядку — чтобы понять, вправо переключились или влево. */
  order: (string | number)[];
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const prev = useRef<string | number | null>(null);
  const first = prev.current === null;
  const dir = first ? 0 : Math.sign(order.indexOf(season) - order.indexOf(prev.current as string | number)) || 1;
  useEffect(() => {
    prev.current = season;
  }, [season]);
  return (
    <Animated.View key={String(season)} entering={first ? undefined : enterFrom(dir)} style={style}>
      {children}
    </Animated.View>
  );
}

export function SeasonChip({
  label,
  on,
  onPress,
  style,
  onStyle,
  textStyle,
  pos,
  index,
}: {
  label: string;
  on: boolean;
  /** Положение листалки сезонов (номер страницы, дробный): заливка перетекает прямо под пальцем. */
  pos?: SharedValue<number>;
  index?: number;
  onPress: () => void;
  style: StyleProp<ViewStyle>;
  /** Фон выбранной капсулы; невыбранной — из style. */
  onStyle?: { backgroundColor: string };
  textStyle: StyleProp<TextStyle>;
}) {
  const t = useSharedValue(on ? 1 : 0);
  /*
    Цвета берутся ЗДЕСЬ, в обычном коде, а в анимацию идут готовыми строками. Анимация живёт в
    отдельном потоке отрисовки, и звать оттуда обычные функции (StyleSheet.flatten) нельзя —
    приложение от этого падало целиком, как только открывался список сезонов.
  */
  const flat = StyleSheet.flatten(style) ?? {};
  const base = String(flat.backgroundColor ?? 'rgba(255,255,255,0.12)');
  const edge = String(flat.borderColor ?? 'rgba(0,0,0,0)');
  const inkOff = colors.onBg;
  const fill = onStyle?.backgroundColor ?? colors.focusFill;
  useEffect(() => {
    t.value = withTiming(on ? 1 : 0, { duration: 200, easing: Easing.out(Easing.quad) });
  }, [on, t]);
  const k = index ?? 0;
  const bg = useAnimatedStyle(() => {
    const v = pos ? Math.max(0, 1 - Math.abs(pos.value - k)) : t.value;
    return {
      backgroundColor: interpolateColor(v, [0, 1], [base, fill]),
      borderColor: interpolateColor(v, [0, 1], [edge, fill]),
    };
  });
  /*
    ЦВЕТ ПОДПИСИ — ДВУМЯ СЛОЯМИ ТЕКСТА, а не анимацией color. Цвет текста не идёт быстрым путём:
    каждый кадр листания сезонов он пересобирал текст в дереве раскладки — на каждой капсуле.
    Теперь светлая подпись стоит неподвижно, а чёрная копия поверх неё проявляется прозрачностью.

    Прозрачность подобрана так, чтобы цвет совпал с прежним interpolateColor: тот смешивает в
    линейном пространстве с гаммой 2.2, и между светлым и чёрным даёт inkOff · (1 − v)^(1/2.2) —
    ровно то же даёт чёрный слой с прозрачностью 1 − (1 − v)^(1/2.2) поверх светлого. В конце хода
    (v ≈ 1) светлый слой убирается, чтобы по краям букв не оставалось светлой каймы.
  */
  const inkOn = useAnimatedStyle(() => {
    const v = pos ? Math.max(0, 1 - Math.abs(pos.value - k)) : t.value;
    return { opacity: 1 - Math.pow(Math.max(0, 1 - v), 1 / 2.2) };
  });
  const inkBase = useAnimatedStyle(() => {
    const v = pos ? Math.max(0, 1 - Math.abs(pos.value - k)) : t.value;
    return { opacity: v > 0.995 ? 0 : 1 };
  });
  return (
    <Pressable onPress={onPress} hitSlop={4}>
      {({ pressed }) => (
        <Animated.View style={[style, bg, pressed && { opacity: 0.6 }]}>
          <View>
            <Animated.Text style={[textStyle, { color: inkOff }, inkBase]}>{label}</Animated.Text>
            <Animated.Text style={[textStyle, styles.inkTop, inkOn]} aria-hidden>
              {label}
            </Animated.Text>
          </View>
        </Animated.View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: colors.surfaceHi },
  glow: { backgroundColor: '#ffffff' },
  // Чёрная копия подписи — точно поверх светлой (см. SeasonChip).
  inkTop: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, color: '#000000' },
});
