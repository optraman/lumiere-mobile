import { memo, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { MediaItem } from '../types/media';
import { colors } from '../theme/colors';
import { font } from '../theme/fonts';
import { RatingChip } from './RatingChip';
import { openTitle } from '../nav/openTitle';
import { BillboardTitle } from './BillboardTitle';
import { openTitleMenu } from './TitleMenu';

const ONE = new Animated.Value(1).interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

/*
  «СЕЙЧАС В КИНО» — ОДНА БОЛЬШАЯ КАРТОЧКА НА ЭКРАН (как на телевизоре): кадр на треть экрана,
  оценка в квадрате в углу — как на постерах главной, внизу название и СЛОГАН вместо пересказа
  сюжета (слоган — фраза с афиши, ради неё карточка и есть). Кадр при перелистывании едет чуть
  медленнее карточки — параллакс.
*/
export const BigBannerCard = memo(function BigBannerCard({
  item,
  i,
  w,
  h,
  scrollX,
}: {
  item: MediaItem;
  i: number;
  w: number;
  h: number;
  scrollX: Animated.Value;
}) {
  const frame = useRef<View>(null);
  const step = w + 12;
  const at = i * step;
  const drift = scrollX.interpolate({ inputRange: [at - step, at + step], outputRange: [-w * 0.12, w * 0.12], extrapolate: 'clamp' });
  const uri = item.backdropUrl?.replace(/\/w\d+\//, '/w780/') ?? item.posterUrl;
  return (
    <Pressable onPress={() => openTitle(item, frame)} onLongPress={() => openTitleMenu({ item })} delayLongPress={380} style={({ pressed }) => [{ width: w, height: h }, pressed && { opacity: 0.85 }]}>
      <View ref={frame} collapsable={false} style={styles.box}>
        {uri ? (
          <Animated.Image
            source={{ uri }}
            style={{ position: 'absolute', top: 0, bottom: 0, left: -w * 0.12, width: w * 1.24, transform: [{ translateX: drift }] }}
            resizeMode="cover"
          />
        ) : null}
        {/* Лёгкая виньетка к краям и затемнение под подпись — кадр остаётся ярким. */}
        <LinearGradient colors={['rgba(8,8,10,0.32)', 'rgba(8,8,10,0)', 'rgba(8,8,10,0)', 'rgba(8,8,10,0.32)']} locations={[0, 0.18, 0.82, 1]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
        <LinearGradient colors={['rgba(8,8,10,0.18)', 'rgba(8,8,10,0)', 'rgba(8,8,10,0.25)', 'rgba(8,8,10,0.9)']} locations={[0, 0.25, 0.55, 1]} style={StyleSheet.absoluteFill} />
        <RatingChip rating={item.rating} fontSize={13} variant="solid" style={styles.rating} />
        <View style={styles.caption}>
          {/* Логотип фильма вместо набранного названия (пока логотипа нет — название). */}
          <BillboardTitle item={item} maxWidth={w * 0.62} scale={ONE} textStyle={styles.title} fallback={item.title} />
          {item.tagline ? (
            <Text style={styles.tagline} numberOfLines={2}>
              {item.tagline}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  box: { flex: 1, overflow: 'hidden', backgroundColor: colors.surfaceHi, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.stroke },
  rating: { position: 'absolute', top: 10, right: 10 },
  caption: { position: 'absolute', left: 16, right: 16, bottom: 14 },
  title: { fontFamily: font.display, fontSize: 22, lineHeight: 28, color: colors.onBg },
  tagline: { fontFamily: font.semibold, fontSize: 14, lineHeight: 19, color: colors.mutedWarm, marginTop: 4, fontStyle: 'italic' },
});
