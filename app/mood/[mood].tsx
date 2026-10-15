import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { colors } from '../../src/theme/colors';
import { font, type as typo } from '../../src/theme/fonts';
import { usePortraitInsets, usePortraitWindow } from '../../src/nav/portrait';
import { ZoomPage, useZoomClose } from '../../src/nav/ZoomPage';
import { moodByKey } from '../../src/data/moods';
import { MoodScene } from '../../src/components/MoodScene';
import { OldFilmText } from '../../src/components/film/OldFilmText';
import { useScreenFocus } from '../../src/nav/useScreenFocus';
import { FadeInImage } from '../../src/components/FadeInImage';
import { TmdbApi } from '../../src/api/tmdb';
import { mapItems } from '../../src/api/mapper';
import { mainstream } from '../../src/api/curate';
import { openTitle } from '../../src/nav/openTitle';
import type { MediaItem } from '../../src/types/media';
import { GlassBack, BACK_GAP, BACK_SIZE } from '../../src/components/GlassBack';

/**
 * СТРАНИЦА НАСТРОЕНИЯ — устроена как страница кинофеста: сверху вместо кадра — сама карточка
 * настроения (название по центру, под ним строка в его духе: боевое, романтичное, жуткое…), за ней
 * свечение его цвета — ТОЛЬКО вверху, ровно до конца описания, дальше мягко в чёрное. Ниже —
 * фильмы (и сериалы) этого жанра: постер, название, год и первая фраза описания (без номеров —
 * это не рейтинг и не порядок просмотра).
 */
export default function MoodScreen() {
  return (
    <ZoomPage>
      <Body />
    </ZoomPage>
  );
}

function fitTitle(title: string, room: number, cap: number): number {
  return Math.min(cap, Math.floor(room / (title.length * 0.98)));
}

function firstSentence(t: string): string {
  const s = t.trim();
  const m = s.match(/^.{20,180}?[.!?…](\s|$)/);
  return (m ? m[0] : s.slice(0, 160)).trim();
}

/** Строка фильма: слоган с афиши (TMDB, ответ помнится); нет слогана — первая фраза описания. */
function MoodEntry({ item }: { item: MediaItem }) {
  const [tagline, setTagline] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let dead = false;
    TmdbApi.detailsLite(item.type, item.id) // нужен только слоган
      .then((d) => !dead && setTagline(d.tagline?.trim() || null))
      .catch(() => !dead && setTagline(null));
    return () => {
      dead = true;
    };
  }, [item.type, item.id]);
  const text = tagline ?? (tagline === null && item.overview ? firstSentence(item.overview) : '');
  return (
    <Pressable onPress={() => openTitle(item)} style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
      <View style={styles.poster}>
        {item.posterUrl ? <FadeInImage source={{ uri: item.posterUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {item.title}
        </Text>
        <Text style={styles.year}>
          {item.year ?? ''}
          {item.type === 'tv' ? ' · сериал' : ''}
        </Text>
        {text ? (
          <Text style={[styles.note, tagline ? styles.tagline : null]} numberOfLines={3}>
            {text}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function Body() {
  const close = useZoomClose();
  // Параметр называется mood, а не key: «key» у маршрута — служебное поле навигации.
  const { mood: moodKey, kind = 'all' } = useLocalSearchParams<{ mood: string; kind?: string }>();
  const mood = moodByKey(moodKey ?? '');
  const insets = usePortraitInsets();
  const { width } = usePortraitWindow();
  const [items, setItems] = useState<MediaItem[] | null>(null);
  // Высота шапки заранее (до первого замера) — свет стоит на месте с первого кадра, а не
  // вырастает, когда шапка измерилась.
  const [heroH, setHeroH] = useState(() => insets.top + 70 + 170);
  /*
    ОТТЯГИВАНИЕ ВНИЗ — СВЕТ РАСТЁТ, как постер в кинофесте: верх приколот к верху экрана, свет
    тянется вслед за пальцем. На нативном драйвере, без JS.
  */
  // Один и тот же массив между перерисовками — иначе сцена пересобирала бы свои анимации.
  const sceneKeys = useMemo(() => [moodKey ?? ''], [moodKey]);
  /*
    Высота сцены — постоянная, с запасом, а не по замеру шапки: замер приходил уже во время
    раскрытия страницы, сцена меняла размер и перерисовывала все полотна — страница дёргалась.
    Лишнее обрезает контейнер (overflow hidden), низ уходит в чёрное градиентом.
  */
  const [sceneH] = useState(() => insets.top + 70 + 300);
  // Страница под другой (открыт фильм поверх) — сцена и плёнка стоят: их всё равно не видно.
  const focused = useScreenFocus();
  const scrollY = useRef(new Animated.Value(0)).current;
  const PULL = 400;
  const baseH = Math.max(heroH, 1) + 40;
  const pin = scrollY.interpolate({ inputRange: [-PULL, 0], outputRange: [-PULL, 0], extrapolateRight: 'clamp' });
  /*
    ШАПКА С НАЗВАНИЕМ — как у страниц фильмов: пока крупное название на экране, её нет; когда
    оно уезжает под верх, сверху проявляется стеклянная полоса с названием настроения. Лежит
    поверх списка и ничего не сдвигает; касаний не ловит — стрелка «назад» остаётся над ней.
  */
  const headerIn = useMemo(() => {
    const at = Math.max(heroH - 150, 60);
    return scrollY.interpolate({ inputRange: [at, at + 60], outputRange: [0, 1], extrapolate: 'clamp' });
  }, [scrollY, heroH]);
  const grow = scrollY.interpolate({ inputRange: [-PULL, 0], outputRange: [(baseH + PULL) / baseH, 1], extrapolateRight: 'clamp' });

  useEffect(() => {
    if (!mood) return;
    let dead = false;
    const mv = kind !== 'tv';
    const tv = kind !== 'movie' && mood.tv != null;
    const q = { 'vote_count.gte': '300', 'vote_average.gte': '6.8' };
    void Promise.allSettled([
      mv ? TmdbApi.discover('movie', { with_genres: String(mood.movie), ...q }) : Promise.reject(),
      tv ? TmdbApi.discover('tv', { with_genres: String(mood.tv), ...q }) : Promise.reject(),
    ]).then(([a, b]) => {
      const movies = a.status === 'fulfilled' ? mainstream(mapItems(a.value.results, 'movie')) : [];
      const shows = b.status === 'fulfilled' ? mainstream(mapItems(b.value.results, 'tv')) : [];
      // Сериалы — через каждые два фильма; всего двадцать, как длинный кинофест.
      const out: MediaItem[] = [];
      for (let i = 0, t = 0; out.length < 20 && (i < movies.length || t < shows.length); i++) {
        if (movies[i]) out.push(movies[i]);
        if (i % 2 === 1 && shows[t]) out.push(shows[t++]);
      }
      if (!dead) setItems(out.slice(0, 20));
    });
    return () => {
      dead = true;
    };
  }, [mood, kind]);

  if (!mood) return null;
  return (
    <View style={styles.screen}>
      <Animated.FlatList
        data={items ?? []}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
        contentInsetAdjustmentBehavior="never"
        keyExtractor={(m) => `${m.type}-${m.id}`}
        contentContainerStyle={{ paddingBottom: insets.bottom + 30 }}
        ListHeaderComponent={
          <View onLayout={(e) => setHeroH(e.nativeEvent.layout.height)}>
            {/* Живая сцена настроения (та же, что на карточке) с зерном плёнки — до конца описания,
                ниже мягко уходит в чёрное. Тянется вслед за пальцем при оттягивании вниз. */}
            <Animated.View
              style={[styles.glow, { height: Math.max(heroH, 1) + 40, transformOrigin: 'top', transform: [{ translateY: pin }, { scale: grow }] }]}
              pointerEvents="none"
            >
              <MoodScene keys={sceneKeys} w={width} h={sceneH} live={focused} />
              {/* Виньетка чуть слабее прежней: сцена гаснет только к самому низу, под описанием. */}
              <LinearGradient colors={['rgba(8,8,10,0)', 'rgba(8,8,10,0.35)', colors.bg]} locations={[0, 0.6, 1]} style={StyleSheet.absoluteFill} />
            </Animated.View>
            <View style={[styles.hero, { paddingTop: insets.top + 70, width }]}>
              {/* Одной строкой: размер — по длине слова и ширине экрана (Bounded широкий: ~0.95 кегля
                  на заглавную букву), иначе «ФАНТАСТИКА» переносила последнюю «А». */}
              {/* Тот же «титр старого фильма», что на карточке (OldFilmText). */}
              <OldFilmText text={mood.title.toUpperCase()} style={[styles.title, { fontSize: fitTitle(mood.title, width - 48, 38) }]} />
              <Text style={styles.blurb}>{mood.blurb}</Text>
            </View>
          </View>
        }
        renderItem={({ item }) => <MoodEntry item={item} />}
      />
      <Animated.View style={[styles.topBar, { paddingTop: insets.top + 4, opacity: headerIn }]} pointerEvents="none">
        <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={styles.topBarTint} />
        <View style={styles.topBarInner}>
          <Text style={styles.topBarTitle} numberOfLines={1}>
            {mood.title.toUpperCase()}
          </Text>
        </View>
      </Animated.View>
      <GlassBack onPress={close} style={[styles.back, { top: insets.top + 2 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  glow: { position: 'absolute', left: 0, right: 0, top: 0, overflow: 'hidden', backgroundColor: '#050506' },
  back: { position: 'absolute', left: 14 },
  // Те же размеры, что у шапки страницы фильма: полоса 34 точки, по бокам место под стрелку.
  topBar: { position: 'absolute', left: 0, right: 0, top: 0, paddingBottom: 8, overflow: 'hidden' },
  topBarTint: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(8,8,10,0.5)' },
  // Поля по бокам: стрелка (14 + BACK_SIZE) и ещё BACK_GAP — название в шапке её не касается.
  topBarInner: { height: 34, marginHorizontal: 14 + BACK_SIZE + BACK_GAP, alignItems: 'center', justifyContent: 'center' },
  topBarTitle: { fontFamily: font.display, fontWeight: '800', fontSize: 17, letterSpacing: 0.5, color: colors.onBg, textAlign: 'center' },
  backCircle: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(8,8,10,0.5)' },
  hero: { alignItems: 'center', paddingHorizontal: 28, paddingBottom: 30 },
  title: { fontFamily: font.display, fontWeight: '800', color: '#fff', textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.3)', textShadowRadius: 16, textShadowOffset: { width: 0, height: 2 } },
  word: { fontFamily: font.extrabold, fontSize: 18, marginTop: 10, letterSpacing: 0.5 },
  blurb: { ...typo.bodyMedium, color: colors.onBg, textAlign: 'center', marginTop: 8, lineHeight: 21, opacity: 0.9, textShadowColor: 'rgba(0,0,0,0.45)', textShadowRadius: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 9 },
  num: { width: 22, fontFamily: font.display, fontSize: 16, color: colors.faint, textAlign: 'center' },
  poster: { width: 62, height: 93, overflow: 'hidden', backgroundColor: colors.surfaceHi },
  rowTitle: { ...typo.titleMedium, color: colors.onBg },
  year: { ...typo.labelMedium, color: colors.mutedWarm, marginTop: 2 },
  tagline: { fontStyle: 'italic', color: colors.mutedWarm },
  note: { ...typo.labelMedium, color: colors.muted, marginTop: 4, lineHeight: 17 },
});
