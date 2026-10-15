import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * СТЕКЛЯННАЯ КАРТОЧКА СНИЗУ — общая оболочка меню в стиле плеера: «Озвучка для скачивания»,
 * «В плейлист», создание плейлиста.
 *
 * Движение — только сдвигом (карточка всегда непрозрачна: полупрозрачное жидкое стекло система
 * иногда не рисует), тает лишь затемнение. Под стеклом своя тёмная подложка — карточку видно всегда.
 * Закрытие — тем же путём вниз, и только потом окно снимается.
 */
const SLIDE = 560;

export function GlassSheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(open);
  const dim = useSharedValue(0);
  const y = useSharedValue(SLIDE);
  const first = useRef(true);

  // Снимаем, только если окно так и осталось закрытым (его могли тут же открыть снова).
  const openRef = useRef(open);
  openRef.current = open;
  const unmountIfClosed = () => {
    if (!openRef.current) setMounted(false);
  };

  useEffect(() => {
    if (open) {
      setMounted(true);
      dim.value = withTiming(1, { duration: 160 });
      y.value = withSpring(0, { damping: 30, stiffness: 420, mass: 0.7, overshootClamping: true });
    } else if (!first.current) {
      dim.value = withTiming(0, { duration: 170 });
      /*
        Окно снимается ВСЕГДА — и когда уход доиграл, и когда его перебили (раньше только при
        «доиграл»): перебитый уход оставлял невидимое модальное окно поверх приложения, и оно
        забирало все касания. Плюс страховка по таймеру.
      */
      y.value = withTiming(SLIDE, { duration: 190, easing: Easing.in(Easing.cubic) }, () => {
        runOnJS(unmountIfClosed)();
      });
      const t = setTimeout(unmountIfClosed, 450);
      first.current = false;
      return () => clearTimeout(t);
    }
    first.current = false;
  }, [open, dim, y]);

  /*
    СМАХНУТЬ ВНИЗ — ЗА ПАЛЬЦЕМ (решение Марка). Карточка едет ровно столько, сколько протянут
    палец, затемнение тает вместе с ней; вверх — лишь чуть-чуть, с сопротивлением. Отпустил ниже
    порога или смахнул быстро — меню уходит тем же движением дальше вниз; иначе — пружиной на место.
    Жест срабатывает только на движение вниз: прокрутка списков внутри меню вверх не страдает.
  */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeFromDrag = () => onCloseRef.current();
  const drag = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(10)
        .failOffsetY(-8)
        .failOffsetX([-20, 20])
        .onUpdate((e) => {
          const t = e.translationY;
          y.value = t > 0 ? t : -Math.min(18, Math.sqrt(-t) * 2);
          dim.value = 1 - Math.min(0.85, Math.max(0, t) / 420);
        })
        .onEnd((e) => {
          if (e.translationY > 110 || e.velocityY > 800) {
            runOnJS(closeFromDrag)();
          } else {
            y.value = withSpring(0, { damping: 30, stiffness: 420, mass: 0.7, overshootClamping: true });
            dim.value = withTiming(1, { duration: 160 });
          }
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [y, dim],
  );

  const dimStyle = useAnimatedStyle(() => ({ opacity: dim.value }));
  const card = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));

  if (!mounted) return null;
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={onClose}>
      {/* Внутри модального окна жестам нужен свой корень — иначе смахивание не ловится. */}
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.dim, dimStyle]} />
      </Pressable>
      <KeyboardAvoidingView behavior="padding" style={styles.slot} pointerEvents="box-none">
        <View style={{ paddingBottom: insets.bottom + 10, paddingHorizontal: 10 }} pointerEvents="box-none">
          <GestureDetector gesture={drag}>
            <Animated.View style={[styles.wrap, card]}>
              {/* Плотная тёмная карточка: стекло на всю карточку тормозило движение (см. VoicePicker). */}
              <View style={styles.base}>
                {/* Язычок сверху — подсказка, что карточку можно смахнуть. */}
                <View style={styles.grabber} />
                <View style={styles.card}>{children}</View>
              </View>
            </Animated.View>
          </GestureDetector>
        </View>
      </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dim: { backgroundColor: 'rgba(0,0,0,0.55)' },
  slot: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end' },
  wrap: { maxHeight: '78%' },
  base: { borderRadius: 30, overflow: 'hidden', backgroundColor: '#16161A', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.1)' },
  card: { paddingTop: 10, paddingBottom: 8 },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, marginTop: 8, backgroundColor: 'rgba(255,255,255,0.22)' },
});
