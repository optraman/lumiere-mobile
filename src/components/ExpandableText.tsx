import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import Reanimated, { Easing as REasing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { type as typo } from '../theme/fonts';
import { Motion } from '../theme/motion';

/** Сколько слов остаётся в свёрнутом виде. */
const WORD_LIMIT = 24;

/**
 * Текст, свёрнутый до одного предложения, со стрелкой вместо подписи.
 *
 * Свёрнуто по СЛОВАМ, а не по строкам и не по предложениям.
 *
 * По строкам нельзя: обрезка рвёт текст посреди слова. По предложениям было хуже: синопсисы у
 * TMDB очень разные, и три предложения — это то абзац на полэкрана, то полторы строки, поэтому
 * блок всё время менял высоту от фильма к фильму. Ровно двадцать четыре слова дают предсказуемый
 * размер при любом тексте, а многоточие честно показывает, что фраза оборвана.
 *
 * Вместо слова «Развернуть» — виньетка и стрелка. Слово занимает место и требует чтения ради
 * действия, которое и так очевидно; растворяющийся книзу текст сам говорит «здесь есть ещё», а
 * стрелка показывает, куда нажать. Это тот же приём, которым системные приложения показывают
 * обрезанный текст.
 *
 * Виньетка красится в ЦВЕТ ФОНА, а не в чёрный: фон приложения не чёрный, а с тёплым свечением, и
 * чёрная растушёвка проступила бы на нём пятном.
 */
/**
 * РАСКРЫТИЕ — ТОЛЬКО ОКНОМ. Текст отрисован ЦЕЛИКОМ с самого начала и больше никогда не
 * переформатируется: ни подмены «короткой версии» на полную, ни переноса строк на ходу. Блок —
 * это окно с обрезкой (overflow hidden) поверх готового текста; свёрнуто — видно первые
 * LINES строк, раскрыто — все. Высота окна плавно едет (Reanimated, в потоке отрисовки), и
 * страница ниже едет вместе с ней.
 *
 * Высоты берутся из раскладки самого текста (onTextLayout, невидимый двойник той же ширины):
 * свёрнутая — низ строки № LINES, полная — низ последней. До замера окно уже стоит на расчётной
 * высоте LINES × межстрочный интервал — первый кадр выглядит так же, как после замера.
 */
const OPEN_MS = 340;
/** Сколько строк видно в свёрнутом виде (~24 слова — прежний размер блока). */
const LINES = 4;

export function ExpandableText({
  text,
  style,
}: {
  text: string;
  style?: object;
}) {
  const [open, setOpen] = useState(false);
  const arrow = useRef(new Animated.Value(0)).current;

  const words = text.trim().split(/\s+/);
  const lineH = (StyleSheet.flatten([styles.text, style]) as { lineHeight?: number }).lineHeight ?? 22;
  const [lines, setLines] = useState(0);
  const [shortH, setShortH] = useState(LINES * lineH);
  const [fullH, setFullH] = useState(0);
  // Есть что раскрывать: до замера — по числу слов (как раньше), после — по числу строк.
  const hasMore = lines > 0 ? lines > LINES : words.length > WORD_LIMIT;
  const hv = useSharedValue(LINES * lineH);
  const fade = useSharedValue(1);
  const first = useRef(true);

  useEffect(() => {
    const target = open ? fullH || shortH : shortH;
    // Первая установка после замера — без движения; дальше — плавно.
    if (first.current) {
      if (fullH) first.current = false;
      hv.value = target;
      return;
    }
    hv.value = withTiming(target, { duration: OPEN_MS, easing: REasing.bezier(0.2, 0, 0, 1) });
    fade.value = withTiming(open ? 0 : 1, { duration: open ? OPEN_MS * 0.6 : OPEN_MS });
  }, [open, shortH, fullH, hv, fade]);

  useEffect(() => {
    Animated.timing(arrow, {
      toValue: open ? 1 : 0,
      duration: OPEN_MS,
      easing: Motion.curve,
      useNativeDriver: true,
    }).start();
  }, [open, arrow]);

  const box = useAnimatedStyle(() => ({ height: hv.value }));
  const fadeSt = useAnimatedStyle(() => ({ opacity: fade.value }));

  if (!hasMore) return <Text style={[styles.text, style]}>{text}</Text>;

  return (
    <Pressable onPress={() => setOpen((v) => !v)}>
      <View>
        {/* Невидимый двойник той же ширины — только чтобы узнать строки и их высоты. */}
        <View style={styles.probe} pointerEvents="none">
          <Text
            style={[styles.text, style]}
            onTextLayout={(e) => {
              const ls = e.nativeEvent.lines;
              if (!ls.length) return;
              const last = ls[ls.length - 1];
              const cut = ls[Math.min(LINES, ls.length) - 1];
              setLines(ls.length);
              setShortH(Math.ceil(cut.y + cut.height));
              setFullH(Math.ceil(last.y + last.height));
            }}
          >
            {text}
          </Text>
        </View>
        <Reanimated.View style={[styles.window, box]}>
          <Text style={[styles.text, style]}>{text}</Text>
        </Reanimated.View>
        {/* Растушёвка: в свёрнутом виде гасит обрезанный низ, при раскрытии плавно уходит. */}
        <Reanimated.View style={[styles.fade, fadeSt]} pointerEvents="none">
          <LinearGradient colors={['transparent', colors.bg]} style={StyleSheet.absoluteFill} />
        </Reanimated.View>
      </View>
      <View style={styles.arrowRow}>
        {/* Стрелка ПОВОРАЧИВАЕТСЯ, а не подменяется другой иконкой: подмена — это мгновенный
            скачок в середине плавного движения блока, и глаз цепляется именно за неё. */}
        <Animated.View
          style={{
            transform: [
              {
                rotate: arrow.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0deg', '180deg'],
                }),
              },
            ],
          }}
        >
          <MaterialIcons name="keyboard-arrow-down" size={22} color={colors.muted} />
        </Animated.View>
        {/* Растушёвка и ПОД стрелкой тоже: сверху она гасит текст, снизу — саму строку со стрелкой,
            чтобы блок не обрывался ровной линией по низу, а сходил на нет. */}
        <LinearGradient
          colors={[colors.bg, 'transparent']}
          style={styles.arrowFade}
          pointerEvents="none"
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  text: { ...typo.bodyLarge, color: colors.onBg, lineHeight: 22 },
  fade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 26 },
  window: { overflow: 'hidden' },
  // Замер вне потока: по ширине блока, невидимо, не занимает места.
  probe: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 },
  arrowRow: { alignItems: 'center', marginTop: 2 },
  arrowFade: { position: 'absolute', left: 0, right: 0, top: '100%', height: 22 },
});
