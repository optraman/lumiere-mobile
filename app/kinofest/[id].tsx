import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../../src/theme/colors';
import { font, type as typo } from '../../src/theme/fonts';
import { usePortraitInsets, usePortraitWindow } from '../../src/nav/portrait';
import { ZoomPage, useZoomClose } from '../../src/nav/ZoomPage';
import { countdown, kinofestById, type KinofestEntry } from '../../src/data/kinofests';
import { FadeInImage } from '../../src/components/FadeInImage';
import { TmdbApi } from '../../src/api/tmdb';
import { mapItem } from '../../src/api/mapper';
import { openTitle } from '../../src/nav/openTitle';
import type { MediaItem } from '../../src/types/media';
import { GlassBack, BACK_GAP, BACK_SIZE } from '../../src/components/GlassBack';

/**
 * ОДИН КИНОФЕСТ — как у Влада: задник главного фильма во всю ширину, название, описание и отсчёт
 * (для праздничных), ниже фильмы ПО ПОРЯДКУ — номер, постер, название, год и его строка «зачем
 * смотреть». Касание — страница фильма.
 */
export default function KinofestScreen() {
  return (
    <ZoomPage>
      <Body />
    </ZoomPage>
  );
}

/** Постер и полный тайтл — у ТМДБ (ответы помнятся, см. tmdb.ts). */
function useTitle(id: number, type: 'movie' | 'tv'): MediaItem | null {
  const [m, setM] = useState<MediaItem | null>(null);
  useEffect(() => {
    let dead = false;
    TmdbApi.detailsLite(type, id) // постер и слоган — без актёров и кадров
      .then((d) => {
        const it = mapItem(d, type);
        if (!dead && it) setM({ ...it, tagline: d.tagline?.trim() || null });
      })
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [id, type]);
  return m;
}

/*
  МИНИАТЮРА — ИЗ МАЛЕНЬКОЙ КОПИИ ПОСТЕРА. Рамка 62 точки — 186 пикселей на тройной плотности, а
  грузился и разжимался постер w500 (втрое больше по стороне, вдевятеро по памяти) на каждой строке.
  w185 по размеру ровно та же картинка на экране. Сам m.posterUrl не трогаем — его получает
  страница фильма, где постер бывает обложкой во весь экран.
*/
const thumb = (u: string) => u.replace('/t/p/w500/', '/t/p/w185/');

function EntryRow({ e, n }: { e: KinofestEntry; n: number }) {
  const m = useTitle(e.id, e.type);
  return (
    <Pressable onPress={() => m && openTitle(m)} style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
      {/* Одной строкой и с местом под две цифры: «10», «11»… больше не переносятся. */}
      <Text style={styles.num} numberOfLines={1}>
        {n}
      </Text>
      <View style={styles.poster}>
        {m?.posterUrl ? <FadeInImage source={{ uri: thumb(m.posterUrl) }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {e.title}
        </Text>
        <Text style={styles.year}>{e.year}</Text>
        {/* Слоган с афиши; пока он не пришёл (или его у фильма нет) — строка Влада «зачем смотреть». */}
        <Text style={[styles.note, m?.tagline ? styles.tagline : null]} numberOfLines={3}>
          {m?.tagline ?? e.note}
        </Text>
      </View>
    </Pressable>
  );
}

function Body() {
  const close = useZoomClose();
  const { id } = useLocalSearchParams<{ id: string }>();
  const k = kinofestById(id ?? '');
  const insets = usePortraitInsets();
  const { width } = usePortraitWindow();
  /*
    ОТТЯГИВАНИЕ ВНИЗ — ПОСТЕР РАСТЁТ, как на страницах фильмов и в карточках лент: верх кадра
    приколот к верху экрана, низ уезжает вслед за пальцем, кадр увеличивается равномерно.
    Всё на нативном драйвере — от прокрутки, без участия JS.
  */
  const scrollY = useRef(new Animated.Value(0)).current;
  const heroH = width * 0.78;
  const PULL = 400;
  const pin = scrollY.interpolate({ inputRange: [-PULL, 0], outputRange: [-PULL, 0], extrapolateRight: 'clamp' });
  const grow = scrollY.interpolate({ inputRange: [-PULL, 0], outputRange: [(heroH + PULL) / heroH, 1], extrapolateRight: 'clamp' });
  if (!k) return null;
  const when = countdown(k);
  return (
    <View style={styles.screen}>
      <Animated.FlatList
        data={k.entries}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
        contentInsetAdjustmentBehavior="never"
        keyExtractor={(e) => String(e.id)}
        // Первой порцией — столько строк, сколько видно под шапкой (около пяти), а не десять по
        // умолчанию: каждая строка при монтировании ещё и запрашивает свой тайтл, и всё это шло
        // ровно во время анимации открытия. Остальные дорисуются следом.
        initialNumToRender={6}
        contentContainerStyle={{ paddingBottom: insets.bottom + 30 }}
        ListHeaderComponent={
          <View>
            <View style={{ width, height: heroH }}>
              <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: 'top', transform: [{ translateY: pin }, { scale: grow }] }]}>
                <FadeInImage source={{ uri: `https://image.tmdb.org/t/p/w1280${k.heroBackdrop}` }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                <LinearGradient colors={['rgba(8,8,10,0.2)', 'rgba(8,8,10,0)', colors.bg]} locations={[0, 0.35, 1]} style={StyleSheet.absoluteFill} />
              </Animated.View>
            </View>
            <View style={styles.hero}>
              {when ? <Text style={styles.when}>{when}</Text> : null}
              <Text style={styles.title}>{k.title}</Text>
              <Text style={styles.blurb}>{k.blurb}</Text>
            </View>
          </View>
        }
        renderItem={({ item, index }) => <EntryRow e={item} n={index + 1} />}
      />
      <GlassBack onPress={close} style={[styles.back, { top: insets.top + 2 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  back: { position: 'absolute', left: 14 },
  backCircle: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(8,8,10,0.5)' },
  hero: { paddingHorizontal: 20, marginTop: -40, marginBottom: 18 },
  when: { fontFamily: font.bold, fontSize: 12, color: colors.focusFill, marginBottom: 6, letterSpacing: 0.3 },
  title: { fontFamily: font.display, fontSize: 28, lineHeight: 34, color: colors.onBg },
  blurb: { ...typo.bodyMedium, color: colors.mutedWarm, marginTop: 8, lineHeight: 21 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 9 },
  num: { width: 34, fontFamily: font.display, fontSize: 16, color: colors.faint, textAlign: 'center' },
  poster: { width: 62, height: 93, overflow: 'hidden', backgroundColor: colors.surfaceHi },
  rowTitle: { ...typo.titleMedium, color: colors.onBg },
  year: { ...typo.labelMedium, color: colors.mutedWarm, marginTop: 2 },
  tagline: { fontStyle: 'italic', color: colors.mutedWarm },
  note: { ...typo.labelMedium, color: colors.muted, marginTop: 4, lineHeight: 17 },
});
