import { memo, useRef } from 'react';
import { cardPoster } from '../api/tmdb';
import { openTitleMenu } from './TitleMenu';
import { Animated, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { MediaItem } from '../types/media';
import { colors } from '../theme/colors';
import { font, type as typo } from '../theme/fonts';
import { Motion } from '../theme/motion';
import { RatingChip } from './RatingChip';
import { FadeInImage } from './FadeInImage';
import { openTitle } from '../nav/openTitle';

export const POSTER_WIDTH = 112;

export const PosterCard = memo(function PosterCard({
  item,
  width = POSTER_WIDTH,
  imageScale,
  style,
  onLongPress,
}: {
  item: MediaItem;
  /** Долгое нажатие — своё действие экрана (например, «убрать из плейлиста»). */
  onLongPress?: () => void;
  width?: number;
  /** Масштаб КАРТИНКИ внутри рамки. Рамку масштабирует тот, кто ставит карточку, — так получается
   * внутренний параллакс: изображение растёт быстрее своей оправы. */
  imageScale?: Animated.AnimatedInterpolation<number> | number;
  style?: StyleProp<ViewStyle>;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  // Этот прямоугольник страница фильма использует как точку старта морфинга — она вырастает
  // именно отсюда, а не из середины экрана.
  const posterRef = useRef<View>(null);

  const dip = (to: number) =>
    Animated.timing(scale, {
      toValue: to,
      duration: Motion.FOCUS,
      easing: Motion.curve,
      useNativeDriver: true,
    }).start();

  return (
    <Pressable
      onPressIn={() => dip(0.96)}
      onPressOut={() => dip(1)}
      onPress={() => openTitle(item, posterRef)}
      // Своё действие (например, «убрать из кинофеста») — если дали; иначе меню тайтла.
      onLongPress={onLongPress ?? (() => openTitleMenu({ item }))}
      delayLongPress={350}
      style={[styles.wrap, { width }, style]}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <View
          ref={posterRef}
          collapsable={false}
          style={[styles.posterBox, { width, height: width * 1.5 }]}
        >
          {item.posterUrl ? (
            <FadeInImage
              // Постер под размер карточки (w342 вместо w500 — см. cardPoster).
              source={{ uri: cardPoster(item.posterUrl, width) }}
              style={styles.poster}
              imageStyle={imageScale ? { transform: [{ scale: imageScale }] } : undefined}
            />
          ) : (
            <View style={styles.posterFallback}>
              <Text style={styles.fallbackText} numberOfLines={4}>
                {item.title}
              </Text>
            </View>
          )}
          <RatingChip rating={item.rating} fontSize={11} variant="solid" style={styles.rating} />
        </View>
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
        {item.year ? <Text style={styles.year}>{item.year}</Text> : null}
      </Animated.View>
    </Pressable>
  );
})

const styles = StyleSheet.create({
  wrap: { marginRight: 10 },
  posterBox: {
    // Острые углы — у всех карточек и кадров (решение Марка); скругления — только у капсул и стекла.
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: colors.surfaceHi,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.stroke,
  },
  poster: { width: '100%', height: '100%' },
  posterFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 8 },
  fallbackText: { ...typo.labelMedium, color: colors.faint, textAlign: 'center' },
  rating: { position: 'absolute', top: 6, left: 6 },
  // SemiBold вместо Medium: на мелком кегле под постером Medium читался как обычный текст, а
  // название карточки должно держать взгляд чуть крепче года под ним.
  title: { ...typo.labelMedium, color: colors.onBg, marginTop: 6, fontFamily: font.semibold },
  year: { ...typo.labelMedium, color: colors.mutedWarm, fontSize: 11, marginTop: 1 },
});
