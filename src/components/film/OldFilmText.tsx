import { memo } from 'react';
import { Animated, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { FRAME_X, FRAME_Y, steppedG } from './clock';

/*
  НАДПИСЬ КАК В СТАРОМ КИНО. Титры старых фильмов не бывают «цифрово» чёткими: белые буквы
  на плёнке слегка расплываются (свет растекается в эмульсии — ореол), края чуть мажут, яркость
  дышит от кадра к кадру, а сам кадр подрагивает в проекторе. Здесь всё это — слоями одного
  и того же слова, без размытия и шейдеров (их нет в Expo Go):
  • ОРЕОЛ — нижний слой: полупрозрачные буквы с тёплым свечением вокруг (тень с большим радиусом);
  • РАСТЁК — две бледные копии, сдвинутые на долю точки вправо и вниз: край буквы мягкий,
    «пропечатанный», а не векторный;
  • САМО СЛОВО — не чисто белое, а тёплое, «плёночное» (#F2EADB), и чуть прозрачное;
  • МЕРЦАНИЕ — яркость всей надписи гуляет на несколько процентов, 24 раза в секунду (как кадры);
  • ДРОЖАНИЕ — ВМЕСТЕ С КАДРОМ: те же шаги, что у абстракции под словом (FRAME), — надпись
    впечатана в плёнку и гуляет с ней одним куском, а не отдельно.
  Слои рисуются один раз; двигаются и мерцают они как одна готовая картинка — на нативном драйвере.
*/
const FLICKER = steppedG([1, 0.94, 0.98, 0.9, 1, 0.96, 0.91, 1, 0.97, 0.93, 1, 0.95, 0.99, 0.9, 0.97, 1, 0.94, 0.98, 0.92, 1, 0.96, 0.93, 0.99, 0.95]);

const INK = '#F2EADB';

export const OldFilmText = memo(function OldFilmText({ text, style }: { text: string; style: TextStyle | TextStyle[] }) {
  const base = StyleSheet.flatten(style);
  return (
    <Animated.View style={{ opacity: FLICKER, transform: [{ translateX: FRAME_X }, { translateY: FRAME_Y }] }}>
      <View>
        {/* Ореол: этот слой в потоке и задаёт размер — остальные лежат точно поверх. */}
        <Text style={[base, styles.halo]} numberOfLines={1}>
          {text}
        </Text>
        <Text style={[base, styles.layer, styles.bleed, { transform: [{ translateX: 0.7 }] }]} numberOfLines={1}>
          {text}
        </Text>
        <Text style={[base, styles.layer, styles.bleed, { transform: [{ translateY: 0.7 }] }]} numberOfLines={1}>
          {text}
        </Text>
        <Text style={[base, styles.layer, styles.ink]} numberOfLines={1}>
          {text}
        </Text>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 0, right: 0, top: 0 },
  halo: { color: 'rgba(242,234,219,0.3)', textShadowColor: 'rgba(255,232,200,0.55)', textShadowRadius: 10, textShadowOffset: { width: 0, height: 0 } },
  bleed: { color: 'rgba(242,234,219,0.32)', textShadowColor: 'transparent', textShadowRadius: 0 },
  ink: { color: INK, opacity: 0.92, textShadowColor: 'rgba(0,0,0,0.28)', textShadowRadius: 14, textShadowOffset: { width: 0, height: 2 } },
});
