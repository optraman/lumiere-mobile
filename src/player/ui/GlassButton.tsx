import { useCallback, useMemo, useRef } from 'react';
import { StyleSheet, Text, View, type ViewProps, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { BlurView } from 'expo-blur';
import { colors } from '../../theme/colors';
import { type as typo } from '../../theme/fonts';
import { orientPan, stageMotion, useStageSide } from '../landscape';

/**
 * КНОПКА ИЗ СТЕКЛА.
 *
 * Три вещи здесь сделаны не так, как напрашивается, и каждая — исправление того, что было видно
 * на устройстве.
 *
 * 1. СТЕКЛО НЕ АНИМИРУЕТСЯ. Раньше сам GlassView оборачивался в анимированный компонент и на него
 *    вешалось превращение. Материал от этого иногда пропадал совсем — система пересоздаёт слой
 *    эффекта, и в этот момент его просто нет. Теперь двигается ОБЁРТКА, а стекло лежит под
 *    содержимым неподвижным слоем и живёт своей жизнью. Пропадать ему больше не от чего.
 *
 * 2. ОБОЛОЧКУ НЕ МАСШТАБИРУЮТ. Значок у SF Symbols — изображение, и масштабирование слоя целиком
 *    пересчитывает его из готовых точек: отсюда падала чёткость под пальцем. Обёртка только едет
 *    (сдвиг ничего не пересчитывает), а сжимается лишь содержимое и только вниз.
 *
 * 3. ОТКЛИК ЕДВА ЗАМЕТЕН. Первая версия ходила за пальцем на шестнадцать точек — это читалось как
 *    игрушка, а не как материал. У Apple смещение на грани различимости: его не видишь, а
 *    чувствуешь. Кнопкам под ползунком оно не положено вовсе — там их шесть в ряд, и шевеление
 *    каждой превращает панель в кисель.
 */

/** Дальше этого кнопка за пальцем не идёт. Четыре точки — ровно на грани различимости. */
const PULL_LIMIT = 4;

/**
 * ВЯЗКОСТЬ: во сколько раз палец обгоняет кнопку в самом начале движения.
 *
 * Одного ограничения хода мало. Если кнопка на первых точках идёт за пальцем один к одному и
 * только потом упирается, она читается тягучей — как будто её держат на резинке. Настоящая кнопка
 * почти не поддаётся: палец уезжает, она лишь обозначает, что его чувствует. Пятёрка означает,
 * что на пять точек пальца кнопка отвечает одной.
 */
const PULL_VISCOSITY = 5;

/** Сопротивление: мягко у нуля, упор у предела. Без ветвлений — это worklet. */
function pull(v: number, limit: number): number {
  'worklet';
  return (limit * v) / (Math.abs(v) * PULL_VISCOSITY + limit);
}

export function GlassButton({
  icon,
  glyph,
  label,
  size = 17,
  radius = 20,
  diameter,
  style,
  onPress,
  tone = 'clear',
  axis = 'both',
  active = false,
  pullable = true,
  bare = false,
  onLayout,
  upright = false,
}: {
  icon?: SFSymbol;
  /** Нарисованная фигура вместо системного значка. Получает цвет, чтобы чернеть на белой кнопке. */
  glyph?: (color: string) => React.ReactNode;
  label?: string;
  size?: number;
  radius?: number;
  /** Круглая кнопка заданного поперечника: ширина, высота и скругление берутся отсюда. */
  diameter?: number;
  style?: ViewStyle;
  onPress: () => void;
  /**
   * ВИД СТЕКЛА. По умолчанию «clear» — и это теперь единственный вид на всю панель.
   *
   * Было: «плей» прозрачная, а всё остальное — «regular» с тёмной подкраской. Рядом они читались
   * как кнопки из разных материалов: мелкие заметно темнее крупной. Один материал на всю панель —
   * и разница в размере перестаёт выглядеть разницей в веществе.
   */
  tone?: 'regular' | 'clear';
  /** Нажата и держит открытым своё меню: белая заливка, чёрное содержимое. */
  active?: boolean;
  /**
   * ПО КАКИМ НАПРАВЛЕНИЯМ КНОПКА ТЯНЕТСЯ.
   *
   * Внутри строки, которая сама мотается пальцем, тянуть кнопку вбок нельзя: два жеста спорят за
   * одно движение, и побеждает обычно не тот, которого ждали.
   */
  axis?: 'both' | 'y';
  /** false — кнопка не ходит за пальцем вовсе, только подаётся под нажатием. */
  pullable?: boolean;
  /**
   * БЕЗ СТЕКЛА ВООБЩЕ — один значок.
   *
   * Стекло уместно там, где кнопка главная. У «назад» оно мозолит глаз: это служебная кнопка,
   * которую ищут глазами раз за просмотр. Без оправы она не исчезает — значок делается плотнее и
   * получает тень, чтобы читаться и на светлом кадре.
   */
  bare?: boolean;
  /** Пробрасывается наружу: по координате кнопки меню встаёт рядом с ней. */
  onLayout?: ViewProps['onLayout'];
  /** Кнопка в обычном (стоячем) интерфейсе, а не в повёрнутом плеере: оси жеста — оси экрана. */
  upright?: boolean;
}) {
  const press = useSharedValue(0);
  const dx = useSharedValue(0);
  const dy = useSharedValue(0);

  const buzz = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);
  const side = useStageSide();
  /*
    НАЖАТИЕ — ЧЕРЕЗ ССЫЛКУ. onPress почти всегда приходит новой функцией из разметки, и жесты кнопки
    (они зависят от fire) пересобирались на каждой перерисовке панели — у каждой из кнопок. Ссылка
    держит свежий обработчик, а жесты собираются, только когда меняется их настройка.
  */
  const pressRef = useRef(onPress);
  pressRef.current = onPress;
  const fire = useCallback(() => {
    void Haptics.selectionAsync();
    pressRef.current();
  }, []);

  /*
    Ведение и нажатие — два жеста на одной кнопке, работающие ОДНОВРЕМЕННО. Разводить их по
    очереди нельзя: тогда любое дрожание пальца отменяло бы нажатие.
  */
  // Пороги и смещение — в осях лежачего кадра (плеер повёрнут внутри стоячего окна).
  const gesture = useMemo(() => {
    const base = Gesture.Pan();
    const drag = (upright ? base : orientPan(base, side, {
      activeY: axis === 'y' ? [-6, 6] : [-1e9, 1e9],
      failX: axis === 'y' ? [-12, 12] : [-1e9, 1e9],
    }))

      .minDistance(0)
      .onBegin(() => {
        press.value = withSpring(1, { damping: 26, stiffness: 520, mass: 0.5 });
        runOnJS(buzz)();
      })
      .onUpdate((e) => {
        if (!pullable) return;
        const m = upright ? { tx: e.translationX, ty: e.translationY } : stageMotion(e, side);
        if (axis === 'both') dx.value = pull(m.tx, PULL_LIMIT);
        dy.value = pull(m.ty, PULL_LIMIT);
      })
      .onFinalize(() => {
        press.value = withSpring(0, { damping: 15, stiffness: 300, mass: 0.6 });
        dx.value = withSpring(0, { damping: 14, stiffness: 260, mass: 0.7 });
        dy.value = withSpring(0, { damping: 14, stiffness: 260, mass: 0.7 });
      });

    const tap = Gesture.Tap()
      .maxDuration(10_000)
      .maxDistance(pullable ? 24 : 10)
      .onBegin(() => {
        // Кнопке без ведения отклик только видимый: нажатие подсвечивается, но телефон не вибрирует,
        // пока не ясно, нажатие это или начало прокрутки.
        if (!pullable) press.value = withSpring(1, { damping: 26, stiffness: 520, mass: 0.5 });
      })
      .onEnd((_e, success) => {
        if (success) runOnJS(fire)();
      })
      .onFinalize(() => {
        if (!pullable) press.value = withSpring(0, { damping: 15, stiffness: 300, mass: 0.6 });
      });

    /*
      КНОПКЕ БЕЗ ВЕДЕНИЯ — ТОЛЬКО НАЖАТИЕ.

      Раньше и у кнопок под ползунком висел жест ведения, просто «без хода». Он просыпался от первого
      же касания, забирал палец себе — и строка не мотелась: палец «залипал» в кнопке, а телефон ещё
      и вибрировал, решив, что это нажатие. Теперь у таких кнопок жеста ведения нет вовсе, а нажатие
      сдаётся, как только палец ушёл на десять точек, — дальше это прокрутка строки.
    */
    return pullable ? Gesture.Simultaneous(drag, tap) : tap;
  }, [upright, side, axis, pullable, press, dx, dy, buzz, fire]);

  const shell = useAnimatedStyle(() => ({
    transform: [{ translateX: dx.value }, { translateY: dy.value }],
  }));
  /** Содержимое уходит вглубь. Только уменьшение: увеличение изображения и есть потеря чёткости. */
  const inner = useAnimatedStyle(() => ({ transform: [{ scale: 1 - press.value * 0.07 }] }));

  const round = diameter ? { width: diameter, height: diameter, borderRadius: diameter / 2 } : null;
  const shape = { borderRadius: diameter ? diameter / 2 : radius };
  const glass = isLiquidGlassAvailable() && !bare;

  return (
    <Animated.View
      style={[styles.wrap, shape, round, glass || bare ? null : styles.clip, style, shell]}
      onLayout={onLayout}
    >
      {/*
        СТЕКЛО — ОТДЕЛЬНЫМ СЛОЕМ ПОД СОДЕРЖИМЫМ, А НЕ ОБЁРТКОЙ ВОКРУГ НЕГО.
        Так его не трогает ни одно превращение, и исчезать ему не от чего.
      */}
      {active ? (
        // Выбранная кнопка не подсвечивается стеклом, а становится белой — как переключатель у Apple.
        <View style={[StyleSheet.absoluteFill, shape, styles.active]} />
      ) : glass ? (
        <GlassView
          style={[StyleSheet.absoluteFill, shape]}
          glassEffectStyle={tone}
          colorScheme="dark"
          // Настоящий материал сам отзывается на касание — просить его об этом и есть «по-эпловски».
          isInteractive
        />
      ) : bare ? null : (
        <BlurView intensity={40} tint="dark" style={[StyleSheet.absoluteFill, shape, styles.fallback]} />
      )}
      <GestureDetector gesture={gesture}>
        <View style={[styles.hit, label ? styles.withLabel : null, diameter ? styles.hitRound : null]}>
          <Animated.View style={[styles.row, inner]}>
            {/*
              СВОЙ ЗНАК ВАЖНЕЕ СИСТЕМНОГО.

              Там, где Влад рисовал фигуру сам (пауза, переход по сериям, субтитры), стоит именно
              она — см. ui/Glyphs. Системный набор подставляется только туда, где у него был
              обычный значок из набора Material.
            */}
            {glyph ? (
              glyph(active ? '#000000' : colors.onBg)
            ) : icon ? (
              <SymbolView
                name={icon}
                size={size}
                tintColor={active ? '#000000' : colors.onBg}
                // Без оправы значок обязан держаться сам: плотное начертание вместо иерархического.
                type={bare ? 'monochrome' : 'hierarchical'}
                weight={bare ? 'semibold' : 'regular'}
                style={bare ? styles.bareIcon : undefined}
              />
            ) : null}
            {label ? (
              <Text style={[styles.label, active && styles.labelOn]} numberOfLines={1}>
                {label}
              </Text>
            ) : null}
          </Animated.View>
        </View>
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  /*
    alignSelf: 'center' — не косметика. С 'flex-start' кнопка прижималась к верху своей строки, и
    «10 секунд» вставали ВЫШЕ большой кнопки «плей»: у соседей разная высота, и выравнивание по
    центру, заданное строке, кнопка сама себе отменяла.

    flexShrink: 0 — в мотающейся строке кнопки иначе сжимаются, чтобы «поместиться», и кнопка со
    значком превращается в узкий овал.
  */
  wrap: { alignSelf: 'center', flexShrink: 0, overflow: 'visible' },
  /** Обрезка нужна только размытию: без неё оно вылезает прямоугольником из-под скруглений. */
  clip: { overflow: 'hidden' },
  fallback: { backgroundColor: 'rgba(10,10,12,0.22)' },
  active: { backgroundColor: '#FFFFFF' },
  hit: {
    flexGrow: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  /** У круглой кнопки поля не нужны: размер задан поперечником, содержимое стоит в центре. */
  hitRound: { paddingHorizontal: 0, paddingVertical: 0 },
  withLabel: { paddingHorizontal: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  /** Тень — единственное, что отделяет голый значок от светлого кадра под ним. */
  bareIcon: { shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 5, shadowOffset: { width: 0, height: 1 } },
  label: { ...typo.labelMedium, color: colors.onBg },
  labelOn: { color: '#000000' },
});
