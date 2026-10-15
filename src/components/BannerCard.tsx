import { useRef } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { MediaItem } from '../types/media';
import { colors } from '../theme/colors';
import { type as typo, font } from '../theme/fonts';
import { RatingChip } from './RatingChip';
import { openTitle } from '../nav/openTitle';

const BANNER_W = 268;

/*
  КАДР БАННЕРА — w780, А НЕ w1280. Карточка шириной 268 точек — это ~804 пикселя на экране @3x:
  w780 покрывает её без видимой потери, а w1280 весил втрое больше и декодировался в память тоже
  втрое тяжелее — на каждой карточке ряда. Меняем только сегмент размера в адресе TMDB.
*/
const frameUrl = (u: string) => u.replace(/\/t\/p\/w\d+\//, '/t/p/w780/');

/** Широкая «кинематографическая» карточка: кадр вместо постера, поверх — название и синопсис.
 * Аналог BannerCard из Cards.kt (там она ещё и раскрывается при фокусе — на телефоне фокуса нет,
 * поэтому текст показан сразу). */
export function BannerCard({ item }: { item: MediaItem }) {
  const frameRef = useRef<View>(null);
  return (
    <Pressable
      style={({ pressed }) => [styles.wrap, { opacity: pressed ? 0.75 : 1 }]}
      onPress={() => openTitle(item, frameRef)}
    >
      <View ref={frameRef} collapsable={false} style={styles.imageBox}>
        {item.backdropUrl ? (
          <Image source={{ uri: frameUrl(item.backdropUrl) }} style={styles.image} />
        ) : (
          <View style={styles.imageFallback} />
        )}
        <View style={styles.scrim} />
        <RatingChip rating={item.rating} fontSize={12} style={styles.rating} />
        <View style={styles.caption}>
          <Text style={styles.title} numberOfLines={1}>
            {item.title}
          </Text>
          {item.overview ? (
            <Text style={styles.overview} numberOfLines={2}>
              {item.overview}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { width: BANNER_W, marginRight: 10 },
  imageBox: {
    width: BANNER_W,
    height: BANNER_W * 0.56,
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: colors.surfaceHi,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.stroke,
  },
  image: { width: '100%', height: '100%' },
  imageFallback: { flex: 1, backgroundColor: colors.surface },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(8,8,10,0.45)' },
  rating: { position: 'absolute', top: 8, right: 8 },
  caption: { position: 'absolute', left: 10, right: 10, bottom: 8 },
  title: { ...typo.titleMedium, color: colors.onBg, fontFamily: font.bold, fontSize: 15 },
  overview: { ...typo.bodyMedium, color: colors.muted, fontSize: 11, lineHeight: 15, marginTop: 2 },
});
