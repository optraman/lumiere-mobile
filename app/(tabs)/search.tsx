import { useCallback, useEffect, useRef, useState } from 'react';
import { go } from '../../src/nav/navGuard';
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useTabReselect } from '../../src/nav/useTabReselect';
import { BusyOutline } from '../../src/components/BusyOutline';
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { searchAll, byGenre, type GenreHit, type PersonHit, type SearchResults } from '../../src/api/search';
import type { MediaItem } from '../../src/types/media';
import { PosterCard } from '../../src/components/PosterCard';
import { FadeInImage } from '../../src/components/FadeInImage';
import { AmbientGlow } from '../../src/components/AmbientGlow';
import { useSearchHistory } from '../../src/data/searchHistory';
import { useTabFocus } from '../../src/nav/useTabFocus';
import { colors } from '../../src/theme/colors';
import { type as typo, font } from '../../src/theme/fonts';
import { usePortraitInsets, usePortraitWindow } from '../../src/nav/portrait';
import { SnakeEgg } from '../../src/components/SnakeEgg';
import { useSharedValue } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

/**
 * Поиск отдельной вкладкой — как и было до попытки унести его в шапку.
 *
 * Поле стоит СВЕРХУ: клавиатура его не перекрывает, поэтому ни поднимать поле, ни
 * обходить клавиатуру не нужно — результаты просто уходят под неё, как в любом списке.
 */
export default function SearchScreen() {
  const insets = usePortraitInsets();
  const { width: winW, height: winH } = usePortraitWindow();
  const inputRef = useRef<TextInput>(null);
  const [fieldBox, setFieldBox] = useState<{ w: number; h: number } | null>(null);

  /*
    ПОВТОРНОЕ НАЖАТИЕ «ПОИСКА» — КЛАВИАТУРА. Уже стоишь на поиске и жмёшь его вкладку ещё раз —
    значит, хочешь печатать: поле получает фокус. С другой вкладки нажатие просто открывает поиск.
  */
  /*
    ПАСХАЛКА: 20 быстрых касаний лупы — по краю поля бежит линия поиска (как будто ищет);
    перестал стучать — через секунду гаснет. 30-е касание — змейка (SnakeEgg). Ушёл на другую
    вкладку — всё сбрасывается в обычный поиск.
  */
  const [eggSpin, setEggSpin] = useState(false);
  const [egg, setEgg] = useState(false);

  const taps = useRef({ n: 0, last: 0, timer: null as ReturnType<typeof setTimeout> | null });
  const fieldRef = useRef<View>(null);
  // Сдвиг бегущего штриха — снаружи, чтобы в момент 30-го касания знать, где он (с него и летит змейка).
  const busyOff = useSharedValue(0);
  const [eggTail, setEggTail] = useState(0);
  const [eggAt, setEggAt] = useState(0);
  const [fieldRect, setFieldRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const resetEgg = useCallback(() => {
    if (taps.current.timer) clearTimeout(taps.current.timer);
    taps.current = { n: 0, last: 0, timer: null };
    setEggSpin(false);
    setEgg(false);
  }, []);
  const tapLens = useCallback(() => {
    if (egg) return;
    const now = Date.now();
    const t = taps.current;
    // «Быстро» — не дольше 350 мс между касаниями; пауза длиннее — счёт сначала.
    t.n = now - t.last < 350 ? t.n + 1 : 1;
    t.last = now;
    if (t.timer) clearTimeout(t.timer);
    if (t.n >= 30) {
      t.timer = null;
      setEggSpin(false);
      Keyboard.dismiss();
      // Где штрих сейчас и когда это было: пока окно змейки соберётся, он успеет пробежать ещё
      // немного — SnakeEgg досчитает это по времени, чтобы линия продолжилась без скачка.
      const tail = -busyOff.value;
      const at = Date.now();
      fieldRef.current?.measureInWindow((x, y, w, h) => {
        setEggTail(tail);
        setEggAt(at);
        setFieldRect({ x, y, w, h });
        setEgg(true);
      });
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      return;
    }
    if (t.n >= 20) {
      setEggSpin(true);
      t.timer = setTimeout(() => {
        setEggSpin(false);
        taps.current.n = 0;
      }, 1000);
    }
  }, [egg]);
  useEffect(() => {
    eggOn.current = egg;
    if (egg) inputRef.current?.blur();
  }, [egg]);
  const veil = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(veil, { toValue: egg ? 0 : 1, duration: egg ? 320 : 0, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [egg, veil]);

  useTabFocus('search', resetEgg);
  // Во время змейки повторное нажатие вкладки клавиатуру НЕ открывает: поле поиска скрыто, и закрыть
  // её было бы нечем — она перекрывала игру.
  const eggOn = useRef(false);
  useTabReselect(() => {
    if (!eggOn.current) inputRef.current?.focus();
  });

  const [query, setQuery] = useState('');
  const [res, setRes] = useState<SearchResults | null>(null);
  const [genrePicks, setGenrePicks] = useState<{ genre: GenreHit; items: MediaItem[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Из истории берём ИМЕННО ПОЛЯ, а не объект целиком.
   *
   * useSearchHistory() возвращает новый литерал на каждый рендер, поэтому объект в зависимостях
   * эффекта менялся каждый раз — эффект перезапускался, снова ставил setLoading(true), снова искал,
   * снова дописывал историю, и так по кругу: спиннер в поиске не гас никогда. Колбэки внутри
   * обёрнуты в useCallback и стабильны, ссылаться надо на них.
   */
  const { items: recent, add: addRecent, remove: removeRecent, clear: clearRecent } = useSearchHistory();

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setRes(null);
      setGenrePicks(null);
      // Стёрли запрос — искать нечего: линия по краю поля гаснет сразу, а не ждёт ответа,
      // который уже никому не нужен (прежний поиск отменён ниже, в очистке эффекта).
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const r = await searchAll(q);
        if (!cancelled) {
          setRes(r);
          setGenrePicks(null);
          setError(null);
          // В историю попадает только то, что ЧТО-ТО НАШЛО. Запоминать запросы, не давшие
          // результата, значит предлагать человеку повторить неудачу.
          const found =
            r.movies.length + r.series.length + r.people.length + r.genres.length > 0;
          if (found) addRecent(q);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 400); // дебаунс — не бить по TMDB на каждое нажатие клавиши
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, addRecent]);

  const openGenre = useCallback(async (g: GenreHit) => {
    setLoading(true);
    try {
      setGenrePicks({ genre: g, items: await byGenre(g) });
    } catch {
      /* подборка не открылась — остальные результаты остаются на месте */
    } finally {
      setLoading(false);
    }
  }, []);

  const empty =
    res &&
    res.movies.length === 0 &&
    res.series.length === 0 &&
    res.people.length === 0 &&
    res.genres.length === 0;

  return (
    <View style={styles.screen}>
      <AmbientGlow />
      {/* Свет — только вверху, у поля поиска и чуть ниже (как на Главной); дальше — ровный тёмный фон. */}
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(8,8,10,0)', 'rgba(8,8,10,0)', 'rgba(8,8,10,0.7)', colors.bg]}
        locations={[0, (insets.top + 70) / winH, (insets.top + 190) / winH, (insets.top + 300) / winH]}
        style={StyleSheet.absoluteFill}
      />

      {/* Логотипа здесь нет — он живёт только в шапке лент. */}
      <View style={{ height: insets.top + 12 }} />

      {/* Всё содержимое поиска тает, когда начинается змейка (стеклянная панель вкладок — системная, остаётся). */}
      <Animated.View style={{ flex: 1, opacity: veil }} pointerEvents={egg ? 'none' : 'auto'}>
      <View ref={fieldRef} style={styles.field} onLayout={(e) => setFieldBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
        {/* Идёт поиск — по краю поля бежит линия, как по кадру «Продолжить просмотр»; нашлось —
            линия замыкает рамку и растворяется. */}
        {fieldBox && !egg ? <BusyOutline w={fieldBox.w} h={fieldBox.h} on={loading || eggSpin} offset={busyOff} /> : null}
        <Pressable onPress={tapLens} hitSlop={8}>
          <MaterialIcons name="search" size={19} color={colors.faint} />
        </Pressable>
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder="Фильм, сериал, актёр, режиссёр, жанр…"
          placeholderTextColor={colors.faint}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          returnKeyType="search"
        />
        {/* Своя кнопка очистки вместо системной clearButtonMode: системная рисуется мелкой серой
            иконкой iOS и выпадает из типографики поля, а на Android её нет вовсе. */}
        {query.length > 0 && (
          <Pressable onPress={() => setQuery('')} hitSlop={10}>
            <MaterialIcons name="close" size={18} color={colors.muted} />
          </Pressable>
        )}
      </View>

      {/* Спиннер только тогда, когда показывать нечего. Пока на экране уже есть результаты,
          дописанная буква их лишь уточняет — мигать индикатором на каждое нажатие значит
          изображать занятость там, где человек и так всё видит. */}
      {error && <Text style={styles.errorText}>{error}</Text>}
      {empty && !loading && <Text style={styles.errorText}>Ничего не нашлось</Text>}

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        {/* История видна, только пока поле пустое: как только человек начал печатать, ему нужны
            результаты, а не список того, что он искал вчера. */}
        {query.trim().length === 0 && recent.length > 0 && (
          <View style={styles.section}>
            <View style={styles.historyHead}>
              {/* flex: 1 — ширину заголовку задаёт строка, а не замер текста: замер, сделанный до
                  загрузки шрифта, обрезал слово до «Недавн». */}
              <Text style={[styles.sectionTitle, { flex: 1 }]} numberOfLines={1}>
                Недавнее
              </Text>
              <Pressable onPress={clearRecent} hitSlop={10}>
                <Text style={styles.clearAll}>Очистить</Text>
              </Pressable>
            </View>
            {recent.map((q) => (
              <View key={q} style={styles.historyRow}>
                <Pressable style={styles.historyTap} onPress={() => setQuery(q)}>
                  <MaterialIcons name="history" size={17} color={colors.faint} />
                  <Text style={styles.historyText} numberOfLines={1}>
                    {q}
                  </Text>
                </Pressable>
                <Pressable onPress={() => removeRecent(q)} hitSlop={12}>
                  <MaterialIcons name="close" size={16} color={colors.faint} />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {/* Жанры идут ПЕРВЫМИ: набрав «ужасы», человек почти наверняка хочет подборку, а не фильм с
            таким названием, и предложить её надо до списка тайтлов. */}
        {res && res.genres.length > 0 && (
          <Section title="Жанры">
            <View style={styles.chips}>
              {res.genres.map((g) => (
                <Pressable
                  key={`${g.type}-${g.id}`}
                  onPress={() => openGenre(g)}
                  style={[styles.chip, genrePicks?.genre.id === g.id && styles.chipActive]}
                >
                  <Text
                    style={[styles.chipText, genrePicks?.genre.id === g.id && styles.chipTextActive]}
                  >
                    {g.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Section>
        )}

        {genrePicks && genrePicks.items.length > 0 && (
          <Section title={genrePicks.genre.name}>
            <Row items={genrePicks.items} />
          </Section>
        )}

        {res && res.people.length > 0 && (
          <Section title="">
            {/* Виртуализованный ряд (как Row ниже): создаются только видимые карточки, а не все 20. */}
            <FlatList
              data={res.people.slice(0, 20)}
              horizontal
              scrollsToTop={false}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.rowPad}
              keyExtractor={personKey}
              renderItem={renderPerson}
              initialNumToRender={5}
              maxToRenderPerBatch={5}
              windowSize={5}
            />
          </Section>
        )}

        {res && res.movies.length > 0 && (
          <Section title="Фильмы">
            <Row items={res.movies} />
          </Section>
        )}

        {res && res.series.length > 0 && (
          <Section title="Сериалы">
            <Row items={res.series} />
          </Section>
        )}
      </ScrollView>
      </Animated.View>
      {egg && fieldRect ? (
        <SnakeEgg
          field={fieldRect}
          tailAt={eggTail}
          tailTime={eggAt}
          area={{ x: 16, y: insets.top + 12, w: winW - 32, h: winH - insets.top - 12 - (insets.bottom + 70) }}
        />
      ) : null}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      {/* Пустой заголовок не рисуется вовсе: иначе от него осталась бы пустая строка отступа и
          раздел выглядел бы съехавшим относительно соседних. */}
      {title ? <Text style={styles.sectionTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

/*
  РЯД РЕЗУЛЬТАТОВ — FlatList, а не ScrollView. ScrollView создаёт ВСЕ карточки разом: на каждую
  дописанную букву — до двадцати постеров в каждом ряду, с картинками, хотя на экране видно три-
  четыре. FlatList держит только видимые и ближайшие; листается ряд так же. removeClippedSubviews
  не ставится — в горизонтальных рядах он оставлял пустые карточки (см. Rail на странице фильма).
*/
const posterKey = (m: MediaItem) => `${m.type}-${m.id}`;
const renderPoster = ({ item }: { item: MediaItem }) => <PosterCard item={item} />;
const personKey = (p: PersonHit) => String(p.id);
const renderPerson = ({ item }: { item: PersonHit }) => <PersonResult person={item} />;

function Row({ items }: { items: MediaItem[] }) {
  return (
    <FlatList
      data={items}
      horizontal
      scrollsToTop={false}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.rowPad}
      keyExtractor={posterKey}
      renderItem={renderPoster}
      initialNumToRender={5}
      maxToRenderPerBatch={5}
      windowSize={5}
    />
  );
}

function PersonResult({ person }: { person: PersonHit }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.person, { opacity: pressed ? 0.6 : 1 }]}
      onPress={() =>
        go({ pathname: '/person/[id]', params: { id: String(person.id), name: person.name } })
      }
    >
      <View style={styles.personPhotoBox}>
        {person.photoUrl ? (
          <FadeInImage source={{ uri: person.photoUrl }} style={styles.personPhoto} />
        ) : (
          <MaterialIcons name="person" size={30} color={colors.faint} />
        )}
      </View>
      <Text style={styles.personName} numberOfLines={2}>
        {person.name}
      </Text>
      {person.role ? <Text style={styles.personRole}>{person.role}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingBottom: 10 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: colors.surface,
    // Квадратное, как карточки (просьба Марка): по краям бежит линия поиска.
    borderRadius: 0,
    paddingHorizontal: 12,
    // Высота задана явно: под неё рассчитана область нажатия, и на разных телефонах она не должна
    // «плавать» вслед за системным кеглем.
    height: 44,
  },
  input: { flex: 1, color: colors.onBg, fontFamily: font.regular, fontSize: 16 },
  spinner: { marginBottom: 8 },
  errorText: { ...typo.bodyMedium, color: colors.muted, textAlign: 'center', marginBottom: 12 },
  content: { paddingBottom: 96 },
  section: { marginBottom: 22 },
  historyHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginRight: 16,
  },
  clearAll: { ...typo.labelMedium, color: colors.mutedWarm },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  historyTap: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  historyText: { ...typo.bodyMedium, color: colors.onBg, flexShrink: 1 },
  sectionTitle: { ...typo.headlineLarge, color: colors.onBg, marginLeft: 16, marginBottom: 10 },
  rowPad: { paddingHorizontal: 16 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.stroke,
  },
  chipActive: { backgroundColor: colors.focusFill, borderColor: colors.focusFill },
  chipText: { ...typo.labelMedium, color: colors.onBg },
  chipTextActive: { color: '#000000' },
  person: { width: 82, marginRight: 12, alignItems: 'center' },
  personPhotoBox: {
    width: 76,
    height: 76,
    borderRadius: 38,
    overflow: 'hidden',
    backgroundColor: colors.surfaceHi,
    alignItems: 'center',
    justifyContent: 'center',
  },
  personPhoto: { width: '100%', height: '100%' },
  personName: { ...typo.labelMedium, color: colors.onBg, fontSize: 11, textAlign: 'center', marginTop: 6 },
  personRole: { ...typo.labelMedium, color: colors.faint, fontSize: 10, textAlign: 'center', marginTop: 1 },
});
