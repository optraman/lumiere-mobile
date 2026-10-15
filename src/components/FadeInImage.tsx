import { useRef } from 'react';
import { Animated, Image, StyleSheet, type ImageProps, type StyleProp, type ImageStyle } from 'react-native';
import { Motion } from '../theme/motion';
import { colors } from '../theme/colors';

/**
 * Картинка, которая ПРОЯВЛЯЕТСЯ, а не выскакивает.
 *
 * Постеры прилетают из сети вразнобой, и при обычном <Image> ряд «хлопает»: карточки заполняются
 * рывками, каждая в свой момент. Затухание превращает это в одно спокойное появление — глазу не за
 * что зацепиться, даже когда картинки приходят с разницей в полсекунды.
 *
 * Под картинкой лежит подложка цвета поверхности: пока грузится, ячейка не дырка в макете, а
 * заготовка под неё. Без подложки на тёмном фоне видно «провалы» в ряду.
 *
 * Затухание короткое (Motion.ENTER): это появление содержимого, а не переход, и длинное растворение
 * читалось бы как медленная загрузка.
 */
export function FadeInImage({
  style,
  imageStyle,
  ...props
}: ImageProps & {
  style?: StyleProp<ImageStyle>;
  /** Стиль САМОЙ картинки внутри рамки. Отдельно от [style], который относится к рамке: так можно
   * двигать и масштабировать изображение, не трогая обрезку по краям. */
  imageStyle?: StyleProp<ImageStyle>;
}) {
  const opacity = useRef(new Animated.Value(0)).current;

  return (
    <Animated.View style={[styles.holder, style]}>
      <Animated.Image
        {...props}
        style={[StyleSheet.absoluteFill, { opacity }, imageStyle]}
        onLoad={(e) => {
          Animated.timing(opacity, {
            toValue: 1,
            duration: Motion.ENTER,
            easing: Motion.curve,
            useNativeDriver: true,
          }).start();
          props.onLoad?.(e);
        }}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  holder: { overflow: 'hidden', backgroundColor: colors.surfaceHi },
});
