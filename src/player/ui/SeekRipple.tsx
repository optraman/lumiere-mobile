import { useEffect, useRef } from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { colors } from '../../theme/colors';
import { font } from '../../theme/fonts';

/**
 * ПЕРЕМОТКА ДВОЙНЫМ КАСАНИЕМ — ЧИСЛО, КОТОРОЕ ВСПЛЫВАЕТ ОТ КРАЯ.
 *
 * «+10» плавно выплывает со стороны того края, куда мотают, и встаёт на место; когда касания
 * кончились — продолжает тот же путь чуть дальше (к середине экрана) и растворяется. Недалеко:
 * восемнадцать точек, чтобы уход читался как продолжение движения, а не как отлёт. Следующие
 * касания только меняют число с лёгким вздохом (6%), без рывков.
 *
 * Тень у цифр не обрезается: у текста запас полей со всех сторон — раньше тень упиралась в
 * границу надписи и обрывалась прямой линией.
 *
 * Сторона помнится до конца угасания: иначе угасающее число на миг перескакивало к правому
 * краю, и казалось, что перемотка мигнула с обеих сторон.
 */
export type Nudge = { side: -1 | 1; total: number; tick: number; x: number; y: number };

const IN_FROM = 22;
const OUT_TO = 18;

export function SeekRipple({ nudge, width, height }: { nudge: Nudge | null; width: number; height: number }) {
  const last = useRef<Nudge | null>(null);
  if (nudge) last.current = nudge;
  const shown = nudge ?? last.current;
  const side = shown?.side ?? 1;

  /** 0 — у края (ещё не вошло), 1 — на месте, 2 — ушло дальше. */
  const phase = useSharedValue(0);
  const breath = useSharedValue(1);

  /*
    ВХОД — ТОЛЬКО ПРИ ПОЯВЛЕНИИ, А НЕ НА КАЖДОЕ НАЖАТИЕ. Раньше каждое следующее двойное касание
    сбрасывало надпись к краю и запускало вход заново — посреди входа или ухода, и анимация
    «терялась». Теперь, пока надпись на экране, новые касания только «дышат» ею (breath) и
    меняют число, а заново она входит, лишь когда успела уйти.
  */
  const active = !!nudge;
  const wasActive = useRef(false);
  useEffect(() => {
    if (active && !wasActive.current) {
      phase.value = 0;
      phase.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.cubic) });
    } else if (!active && wasActive.current) {
      phase.value = withTiming(2, { duration: 240, easing: Easing.in(Easing.quad) });
    }
    wasActive.current = active;
  }, [active, phase]);

  useEffect(() => {
    if (!nudge || nudge.total === 10) return;
    breath.value = withSequence(withTiming(1.06, { duration: 80 }), withTiming(1, { duration: 140 }));
  }, [nudge?.tick, nudge, breath]);

  const style = useAnimatedStyle(() => {
    const p = phase.value;
    // Вход: от края к месту; уход: от места дальше внутрь экрана.
    const x = p <= 1 ? side * IN_FROM * (1 - p) : -side * OUT_TO * (p - 1);
    const o = p <= 1 ? p : 2 - p;
    return { opacity: o, transform: [{ translateX: x }, { scale: breath.value }] };
  });

  const W = 120;
  const cx = side > 0 ? width * 0.82 : width * 0.18;
  return (
    <Animated.View pointerEvents="none" style={[styles.box, { width: W, left: cx - W / 2, top: height / 2 - 34 }, style]}>
      <Text style={styles.num}>{`${side > 0 ? '+' : '−'}${shown?.total ?? 10}`}</Text>
      <Text style={styles.unit}>секунд</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: { position: 'absolute', alignItems: 'center' },
  // Размер — на пятую часть меньше прежнего (30 → 24); поля вокруг — место для тени.
  num: {
    fontFamily: font.display,
    fontSize: 24,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.4,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 4,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowRadius: 9,
    textShadowOffset: { width: 0, height: 1 },
  },
  unit: {
    fontFamily: font.semibold,
    fontSize: 9,
    color: colors.onBg,
    marginTop: -4,
    paddingHorizontal: 12,
    paddingBottom: 8,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
});
