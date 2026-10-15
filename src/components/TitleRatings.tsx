import { memo, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme/colors';
import { font, type as typo } from '../theme/fonts';
import { TrophyGlyph } from '../player/ui/Glyphs';
import { RatingBeams, RatingClock, RatingConfetti, ratingTone } from './RatingFx';
import Svg, { Circle, Ellipse, Path } from 'react-native-svg';
import { titleAwards, titleScores, type Award, type TitleAwards, type TitleScores } from '../api/awards';

/*
  «ОЦЕНКИ» и «НАГРАДЫ» на странице тайтла — как у Влада.

  Оценка TMDB стоит НА СВОЁМ ПРЕЖНЕМ МЕСТЕ — в строке с годом и жанрами (HeroRating), а ниже, после
  режиссёра и актёров, — остальные оценки и награды (TitleRatings): без рамок, жирным шрифтом.

  Оценка TMDB не появляется готовой: число НАБЕГАЕТ от нуля за 1600 мс (кривая 0.4, 0, 0.2, 1),
  а сама плитка открывается слева направо мягкой шторкой (край 22%). Цвет — по оценке:
  от 7 зелёный, от 5 янтарный, ниже серый. Высокая оценка празднуется: 8.0–8.7 — горсть
  конфетти, от 8.7 — медленные лучи за числом. Играет один раз, когда блок доехал до экрана.

  Rotten Tomatoes и IMDb — только если OMDb их знает (как у Влада): «свежий» помидор красный от 60%,
  «гнилой» — зелёный; IMDb — жёлтая марка.
*/

const AnimatedText = Animated.createAnimatedComponent(TextInput);
const EASE = Easing.bezier(0.4, 0, 0.2, 1);

const tmdbTone = (r: number) => (r >= 7 ? '#6FCF4F' : r >= 5 ? '#E9C45C' : '#9B9BA6');

export const TitleRatings = memo(function TitleRatings({ imdb }: { imdb: string | null }) {
  const [scores, setScores] = useState<TitleScores | null>(null);
  const [awards, setAwards] = useState<TitleAwards | null>(null);

  useEffect(() => {
    let dead = false;
    setScores(null);
    setAwards(null);
    if (!imdb) return;
    void titleScores(imdb).then((s) => !dead && setScores(s));
    void titleAwards(imdb).then((a) => !dead && setAwards(a));
    return () => {
      dead = true;
    };
  }, [imdb]);

  const hasScores = scores?.rt != null || scores?.imdb != null;
  const hasAwards = !!awards && (awards.won.length > 0 || awards.nominated.length > 0);

  return (
    <View>
      {hasScores ? (
        <>
          <Text style={styles.section}>ОЦЕНКИ</Text>
          <View style={styles.row}>
            {scores?.rt != null ? (
              <Tile label="Rotten Tomatoes" note={scores.rt >= 75 ? 'очень свежий' : scores.rt >= 60 ? 'свежий' : 'гнилой'}>
                <View style={styles.imdbRow}>
                  <TomatoGlyph score={scores.rt} size={30} />
                  <Text style={[styles.big, { color: scores.rt >= 60 ? '#FA320A' : '#3F8A2E' }]}>{scores.rt}%</Text>
                </View>
              </Tile>
            ) : null}
            {scores?.imdb != null ? (
              <Tile label="IMDb">
                <View style={styles.imdbRow}>
                  <View style={styles.imdbMark}>
                    <Text style={styles.imdbMarkText}>IMDb</Text>
                  </View>
                  <Text style={[styles.big, { color: '#F5C518' }]}>{scores.imdb.toFixed(1)}</Text>
                </View>
              </Tile>
            ) : null}
          </View>
        </>
      ) : null}

      {hasAwards && awards ? (
        <>
          <Text style={styles.section}>НАГРАДЫ</Text>
          <View style={styles.cols}>
            {awards.won.length ? <AwardCol title="ПОБЕДЫ" list={awards.won} /> : null}
            {awards.nominated.length ? <AwardCol title="НОМИНАЦИИ" list={awards.nominated} /> : null}
          </View>
        </>
      ) : null}
    </View>
  );
});

/*
  ПОМИДОР У ОЦЕНКИ ROTTEN TOMATOES — по тем же порогам, что у самого сайта: от 60% «свежий»
  (красный помидор с зелёной звёздочкой листьев), от 75% «очень свежий» (тот же помидор с золотой
  звёздочкой-знаком, как у их «сертифицированно свежих»), ниже 60% — «гнилой» (зелёная клякса).
  Рисунок свой, не их значок: просто помидор и клякса.
*/
export function TomatoGlyph({ score, size = 28 }: { score: number; size?: number }) {
  if (score < 60) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path
          d="M12 4.2c1.3 0 1.9 1.6 3.1 1.9 1.4.4 2.9-.9 3.9.2 1 1.1-.4 2.6 0 3.9.4 1.3 2.2 1.9 2 3.3-.2 1.5-2.2 1.6-2.7 2.9-.5 1.3.6 3.1-.6 4-1.2.9-2.7-.5-4.1-.2-1.4.3-2.1 2.1-3.6 2.1s-2.1-1.7-3.5-2.1c-1.4-.4-3 .9-4.1-.1-1-.9.1-2.6-.4-3.9-.5-1.3-2.5-1.6-2.6-3.1-.1-1.4 1.8-1.9 2.2-3.2.4-1.3-.9-2.9.1-3.9 1-1 2.6.3 4-.1C10.1 5.8 10.7 4.2 12 4.2z"
          fill="#3F8A2E"
        />
        <Circle cx="20.6" cy="5.2" r="1.1" fill="#3F8A2E" />
        <Circle cx="3.4" cy="19.6" r="0.9" fill="#3F8A2E" />
        <Circle cx="9.5" cy="11" r="1.6" fill="#5FA84B" opacity={0.6} />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Ellipse cx="12" cy="14.2" rx="9" ry="8" fill="#FA320A" />
      <Ellipse cx="8.6" cy="11.4" rx="2.4" ry="1.5" fill="#FF8A66" opacity={0.55} />
      <Path d="M12 5.2 9.4 3.4l1.2 2.4-3.6-.3 3.1 1.6L8.4 9.2l3.6-1.4 3.6 1.4-1.7-2.1 3.1-1.6-3.6.3 1.2-2.4z" fill="#2E8B3A" />
      {score >= 75 ? <Path d="M19 15.6l1 2.1 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3z" fill="#F5C518" stroke="#08080A" strokeWidth={0.6} /> : null}
    </Svg>
  );
}

function Tile({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {children}
      {note ? <Text style={styles.note}>{note}</Text> : null}
    </View>
  );
}

/**
 * ОЦЕНКА TMDB В СТРОКЕ С ГОДОМ И ЖАНРАМИ — «часами» и с праздником из APK (см. RatingFx).
 * Место под неё отведено заранее по размеру итогового числа: строка не дёргается.
 */
export const HeroRating = memo(function HeroRating({ rating, play }: { rating: number; play: boolean }) {
  if (rating <= 0.1) return null;
  const size = 26;
  // Ширина итогового числа с запасом («10.0» или «8.8»), моноширинные цифры Bounded.
  const w = Math.round(size * (rating >= 10 ? 2.75 : 2.05));
  const h = Math.round(size * 1.28);
  const color = ratingTone(rating);
  return (
    <View style={{ width: w, height: h }}>
      {rating >= 8.7 ? <RatingBeams w={w} h={h} color={color} play={play} /> : null}
      <RatingClock rating={rating} size={size} play={play} />
      {rating > 8 && rating < 8.7 ? <RatingConfetti w={w} h={h} color={color} play={play} /> : null}
    </View>
  );
});

function AwardCol({ title, list }: { title: string; list: Award[] }) {
  return (
    <View style={styles.col}>
      <Text style={styles.colTitle}>{title}</Text>
      {list.map((a, i) => (
        <View key={`${a.name}-${i}`} style={styles.award}>
          <View style={{ opacity: a.won ? 1 : 0.45 }}>
            <TrophyGlyph color="#E9C45C" size={18} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.awardName} numberOfLines={2}>
              {a.name}
            </Text>
            {a.year ? <Text style={styles.awardYear}>{a.year}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { fontFamily: font.bold, fontSize: 13, letterSpacing: 1.4, color: colors.mutedWarm, marginTop: 26, marginBottom: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tile: { minWidth: 110, paddingRight: 18, gap: 2 },
  label: { fontFamily: font.bold, fontSize: 13, color: colors.mutedWarm },
  note: { ...typo.labelMedium, color: colors.faint, marginTop: 2 },
  // Числа — фирменным Bounded, утолщённым тенью того же цвета (как название на странице).
  big: { fontFamily: font.display, fontWeight: '800', fontSize: 30, lineHeight: 38 },
  hero: { minWidth: 46, height: 34, justifyContent: 'center' },
  heroNum: { fontFamily: font.display, fontWeight: '800', fontSize: 26, padding: 0, margin: 0 },
  heroBeams: { position: 'absolute', left: -70, right: -70, top: -70, bottom: -70, alignItems: 'center', justifyContent: 'center' },
  count: { padding: 0, margin: 0 },
  imdbRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  imdbMark: { backgroundColor: '#F5C518', paddingHorizontal: 5, paddingVertical: 1 },
  imdbMarkText: { fontFamily: font.bold, fontSize: 12, color: '#000' },
  shade: { position: 'absolute', top: 0, bottom: 0, left: -80, width: 360 },
  beams: { position: 'absolute', left: -40, right: -40, top: -40, bottom: -40, alignItems: 'center', justifyContent: 'center' },
  beam: { position: 'absolute', width: 260, height: 14 },
  confetti: { position: 'absolute', left: 22, top: 16, width: 1, height: 1 },
  piece: { position: 'absolute', width: 5, height: 8 },
  cols: { flexDirection: 'row', gap: 14 },
  col: { flex: 1, gap: 10 },
  colTitle: { fontFamily: font.bold, fontSize: 11, letterSpacing: 1.2, color: colors.faint },
  award: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  awardName: { fontFamily: font.bold, fontSize: 14, lineHeight: 19, color: colors.onBg },
  awardYear: { ...typo.labelMedium, color: colors.mutedWarm, marginTop: 1 },
});
