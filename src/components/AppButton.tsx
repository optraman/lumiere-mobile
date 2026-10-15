import { useRef, useState } from 'react';
import { BusyOutline } from './BusyOutline';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { type as typo } from '../theme/fonts';
import { Motion } from '../theme/motion';

export type AppButtonStyle = 'Primary' | 'Tonal' | 'Ghost';

/**
 * Портировано из ui/components/AppButton.kt. «Одна кнопка везде» — метрики намеренно одинаковые с
 * кнопками на странице фильма («кнопку смотреть в торрентах — такой же, как на странице фильма по
 * форме»): пилюля с радиусом 30, подпись titleMedium, увеличение на нажатии.
 *
 * Ключевое правило контраста: в НАЖАТОМ состоянии кнопка становится сплошной белой с ЧЁРНЫМ текстом.
 * В ТВ-версии это состояние фокуса, и оно появилось потому, что стандартные tv-material кнопки
 * превращались в белое-на-белом и исчезали. На телефоне фокуса нет, поэтому то же самое показывается
 * на касании.
 */
/** На сколько рамка ожидания отступает от кнопки: на пергаментной заливке линия того же цвета не видна. */
const OUT = 4;

export function AppButton({
  text,
  onPress,
  icon,
  variant = 'Tonal',
  style,
  busy = false,
  outline = false,
}: {
  text: string;
  onPress: () => void;
  icon?: React.ComponentProps<typeof MaterialIcons>['name'];
  variant?: AppButtonStyle;
  style?: StyleProp<ViewStyle>;
  /**
   * ЖДЁМ. Вместо значка — кружок, нажатия не проходят.
   *
   * Кнопка «Смотреть» у фильма теперь сама добывает поток, а не отправляет за ним на отдельный
   * экран. Значит ожидание должно быть видно ЗДЕСЬ: иначе человек жмёт, ничего не происходит, и
   * он жмёт ещё раз.
   */
  busy?: boolean;
  /**
   * Ожидание не спиннером, а линией, бегущей ВОКРУГ кнопки, — как у кадра «Продолжить просмотр».
   * Кнопка при этом остаётся собой (значок и надпись на месте), а конец ожидания виден по тому,
   * как рамка замыкается и растворяется.
   */
  outline?: boolean;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const press = useRef(new Animated.Value(0)).current;
  /** Та же величина нажатия, но для нативного драйвера: ею проявляется чёрный значок. */
  const pressN = useRef(new Animated.Value(0)).current;

  const animate = (down: boolean) => {
    Animated.parallel([
      /*
        МАСШТАБ — НАТИВНЫМ ДРАЙВЕРОМ. Раньше он шёл JS-драйвером, потому что жил в одном стиле с
        заливкой (цвет фона нативный драйвер здесь не ведёт), а два драйвера в одном стиле нельзя.
        Теперь масштаб стоит на отдельной обёртке (см. ниже) — и идёт в потоке отрисовки, не
        завися от занятости JS. Длительность и кривая те же, стартуют вместе с заливкой.
      */
      Animated.timing(scale, {
        toValue: down ? 1.06 : 1,
        duration: Motion.FOCUS,
        easing: Motion.curve,
        useNativeDriver: true,
      }),
      Animated.timing(press, {
        toValue: down ? 1 : 0,
        duration: Motion.FOCUS,
        easing: Motion.curve,
        // Цвет фона и подписи — только JS-драйвером.
        useNativeDriver: false,
      }),
      // Прозрачность чёрного значка — нативно (тот же ход, что у press).
      Animated.timing(pressN, {
        toValue: down ? 1 : 0,
        duration: Motion.FOCUS,
        easing: Motion.curve,
        useNativeDriver: true,
      }),
    ]).start();
  };

  /**
   * Primary заливается ПЕРГАМЕНТОМ #CCCC99 — это акцент приложения из Theme.kt, тот самый цвет,
   * которым у Влада заливается элемент в фокусе («акцентный цвет для всего приложения — cccc99»).
   * Раньше здесь стоял ColorSurfaceHi, и главная кнопка экрана ничем не отличалась от фона.
   *
   * Текст на пергаменте — ЧЁРНЫЙ: белый по светлому даёт контраст около 1.5:1 и не читается. Это то
   * же правило, по которому у Влада кнопка в фокусе становится светлой с чёрной подписью.
   */
  const idleBg =
    variant === 'Ghost' ? 'transparent' : variant === 'Primary' ? colors.focusFill : colors.surface;
  const idleFg = variant === 'Primary' ? '#000000' : colors.onBg;
  const bg = press.interpolate({ inputRange: [0, 1], outputRange: [idleBg, colors.onBg] });
  const fg = press.interpolate({ inputRange: [0, 1], outputRange: [idleFg, '#000000'] });

  return (
    <Pressable
      onPressIn={() => animate(true)}
      onPressOut={() => animate(false)}
      onPress={busy ? undefined : onPress}
      disabled={busy}
      style={style}
      onLayout={outline ? (e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height }) : undefined}
    >
      {outline && box ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: -OUT, top: -OUT, width: box.w + OUT * 2, height: box.h + OUT * 2 }}>
          <BusyOutline w={box.w + OUT * 2} h={box.h + OUT * 2} on={busy} radius={30 + OUT} />
        </View>
      ) : null}
      {/* Обёртка только ради масштаба на нативном драйвере: в одном стиле с JS-заливкой нельзя. */}
      <Animated.View style={{ transform: [{ scale }] }}>
      <Animated.View
        style={[
          styles.pill,
          variant === 'Ghost' && styles.ghostBorder,
          { backgroundColor: bg },
        ]}
      >
        {busy && !outline ? (
          <View style={styles.icon}>
            <ActivityIndicator size="small" color={idleFg} />
          </View>
        ) : icon ? (
          /*
            ДВА ЗНАЧКА, А НЕ ОДИН АНИМИРОВАННЫЙ.

            Раньше цвет значка анимировался напрямую — Animated.createAnimatedComponent поверх
            MaterialIcons. На новой архитектуре React Native это падает: обновляя свойства, он зовёт
            у компонента setNativeProps, а у значка внутри уже нет узла, который это умеет
            («this._icon.setNativeProps is not a function»). Валилось на первом же нажатии кнопки.

            Значок — не то место, где нужна анимация свойств: достаточно положить друг на друга две
            его копии, обычную и чёрную, и менять ПРОЗРАЧНОСТЬ верхней. Прозрачность — свойство
            вида, а не значка, и никаких особых узлов ей не нужно.
          */
          <View style={styles.icon}>
            <MaterialIcons name={icon} size={18} color={idleFg} />
            <Animated.View style={[StyleSheet.absoluteFill, { opacity: pressN }]}>
              <MaterialIcons name={icon} size={18} color="#000000" />
            </Animated.View>
          </View>
        ) : null}
        <Animated.Text style={[styles.label, { color: fg }]}>{text}</Animated.Text>
      </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    // Радиус 30 — форма из AppButton.kt.
    borderRadius: 30,
    paddingHorizontal: 24,
    paddingVertical: 14,
    gap: 11,
  },
  ghostBorder: { borderWidth: 1.5, borderColor: colors.stroke },
  icon: { width: 18, height: 18 },
  label: { ...typo.titleMedium },
});
