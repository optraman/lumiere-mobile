import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Reanimated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { TopGlow } from '../../src/components/TopGlow';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { colors } from '../../src/theme/colors';
import { type as typo } from '../../src/theme/fonts';
import { usePortraitInsets, usePortraitWindow } from '../../src/nav/portrait';
import { PosterCard } from '../../src/components/PosterCard';
import { ContinueCard } from '../../src/components/HomeShelf';
import { FadeInImage } from '../../src/components/FadeInImage';
import { continueTitles, forgetTitleProgress, titlesByRecent, useWatchVersion, type TitleProgress } from '../../src/data/watchProgress';
import { forgetTitle } from '../../src/api/sources/playback';
import { toItem, useMine } from '../../src/data/mine';
import { becauseYouWatched, itemOfEntry, newEpisodes, recommendedForYou, type NewEpisode } from '../../src/data/library';
import { askClearHistory } from '../../src/data/clearHistory';
import { openTitle } from '../../src/nav/openTitle';
import { watchOnline } from '../../src/nav/openOnline';
import type { MediaItem } from '../../src/types/media';
import { ZoomPage, useZoomClose } from '../../src/nav/ZoomPage';
import { moodByKey } from '../../src/data/moods';
import { TmdbApi } from '../../src/api/tmdb';
import { mapItems } from '../../src/api/mapper';
import { mainstream } from '../../src/api/curate';
import { GlassBack, BACK_GAP } from '../../src/components/GlassBack';

/**
 * ЭКРАН СПИСКА — куда ведут плитки главной.
 *
 *   continue — «Продолжить просмотр»: крупные кадры, касание — сразу в плеер с места остановки;
 *   mine     — «Моё»: постеры, касание — страница тайтла;
 *   history  — «История»: всё, что смотрели, по дням («Сегодня», «Вчера», «Ранее» — как у Влада);
 *   new      — «Новые серии»: сериалы, у которых вышло продолжение дальше места остановки;
 *   because  — «Похоже на …»: рекомендации к последнему просмотренному;
 *   recommended — «Рекомендации»: подборка ко всей истории и «Моё» сразу (data/library.ts).
 */
export default function LibraryScreen() {
  return (
    <ZoomPage>
      <LibraryScreenBody />
    </ZoomPage>
  );
}

function LibraryScreenBody() {
  const close = useZoomClose();
  const { list } = useLocalSearchParams<{ list: string }>();
  const insets = usePortraitInsets();
  const { width } = usePortraitWindow();
  const ver = useWatchVersion();
  const mine = useMine();
  /*
    СПИСКИ ПРОСМОТРА — ПО ВЕРСИИ ЖУРНАЛА, а не на каждую перерисовку. titlesByRecent() и
    continueTitles() перебирают весь журнал и сортируют его; раньше это шло при каждой отрисовке
    экрана (в том числе дважды за раз — в шапке и в «Истории»). Журнал сообщает о каждом видимом
    изменении через версию, по ней и пересчитываем.
  */
  const continueItems = useMemo(() => (list === 'continue' ? continueTitles() : []), [list, ver]);
  const historyAll = useMemo(() => (list === 'history' ? titlesByRecent() : []), [list, ver]);

  const [extra, setExtra] = useState<{ title: string | null; items: MediaItem[] } | null>(null);
  const [fresh, setFresh] = useState<NewEpisode[] | null>(null);

  useEffect(() => {
    if (list === 'because') void becauseYouWatched().then(setExtra).catch(() => setExtra({ title: null, items: [] }));
    if (list === 'recommended')
      void recommendedForYou()
        .then((items) => setExtra({ title: null, items }))
        .catch(() => setExtra({ title: null, items: [] }));
    // «Настроение»: жанр фильмов и парный сериальный жанр — две первые страницы каждого, вперемешку
    // по популярности (так плитка жанра у Влада ведёт сразу в оба каталога).
    // mood:жанр:каталог — каталог «all» (Главная), «movie» (Фильмы) или «tv» (Сериалы).
    const [, mKey, mKind = 'all'] = (list ?? '').split(':');
    const mood = list?.startsWith('mood:') ? moodByKey(mKey) : undefined;
    if (mood) {
      const mv = mKind !== 'tv';
      const tvOn = mKind !== 'movie' && mood.tv != null;
      const pages = [
        ...(mv ? [TmdbApi.discover('movie', { with_genres: String(mood.movie), 'vote_count.gte': '200' }, 1)] : [Promise.resolve({ results: [] } as never)]),
        ...(mv ? [TmdbApi.discover('movie', { with_genres: String(mood.movie), 'vote_count.gte': '200' }, 2)] : [Promise.resolve({ results: [] } as never)]),
        ...(tvOn ? [TmdbApi.discover('tv', { with_genres: String(mood.tv), 'vote_count.gte': '200' }, 1)] : []),
        ...(tvOn && !mv ? [TmdbApi.discover('tv', { with_genres: String(mood.tv), 'vote_count.gte': '200' }, 2)] : []),
      ];
      void Promise.allSettled(pages).then((rs) => {
        const lists = rs.map((r, i) => (r.status === 'fulfilled' ? mainstream(mapItems(r.value.results ?? [], i < 2 ? 'movie' : 'tv')) : []));
        const movies = [...lists[0], ...(lists[1] ?? [])];
        const shows = [...(lists[2] ?? []), ...(lists[3] ?? [])];
        // Ответы ТМДБ уже по популярности — сериалы вплетаем через каждые два фильма.
        const seen = new Set<string>();
        const items: MediaItem[] = [];
        for (let i = 0, t = 0; i < movies.length || t < shows.length; i++) {
          for (const m of [movies[i], i % 2 === 1 ? shows[t++] : undefined]) {
            if (!m || seen.has(`${m.type}-${m.id}`)) continue;
            seen.add(`${m.type}-${m.id}`);
            items.push(m);
          }
        }
        setExtra({ title: null, items });
      });
    }
    // Тег со страницы тайтла: подборка по ключевому слову TMDB (kw:тип:номер:название).
    if (list?.startsWith('kw:')) {
      const [, kt, kid] = list.split(':');
      const t = kt === 'tv' ? 'tv' : 'movie';
      void TmdbApi.discover(t, { with_keywords: kid, 'vote_count.gte': '50' })
        .then((r) => setExtra({ title: null, items: mapItems(r.results, t) }))
        .catch(() => setExtra({ title: null, items: [] }));
    }
    if (list === 'new') void newEpisodes().then(setFresh).catch(() => setFresh([]));
  }, [list]);

  const title =
    list === 'continue'
      ? 'Продолжить просмотр'
      : list === 'mine'
        ? 'Моё'
        : list === 'history'
          ? 'История'
          : list === 'new'
            ? 'Новые серии'
            : list === 'recommended'
              ? 'Рекомендации'
              : list?.startsWith('kw:')
              ? list.split(':').slice(3).join(':') || 'Тег'
              : list?.startsWith('mood:')
              ? moodByKey(list.split(':')[1])?.title ?? 'Жанр'
              : extra?.title
              ? `Похоже на «${extra.title}»`
              : 'Подборка для вас';

  const cols = 3;
  const posterW = Math.floor((width - 32 - (cols - 1) * 10) / cols);

  const body = (() => {
    if (list === 'continue') {
      const items = continueItems;
      if (!items.length) return <Empty text="Здесь появится всё, что начали смотреть и не досмотрели." />;
      return (
        <FlatList
          data={items}
          keyExtractor={(t) => `${t.type}-${t.id}`}
          contentContainerStyle={[styles.listPad, { paddingBottom: insets.bottom + 30 }]}
          ItemSeparatorComponent={Sep18}
          renderItem={({ item }) => <ContinueCard t={item} wide />}
        />
      );
    }
    if (list === 'history') return <History bottom={insets.bottom} all={historyAll} />;
    if (list === 'new') {
      if (!fresh) return <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />;
      if (!fresh.length) return <Empty text="Новых серий в сериалах, которые вы смотрите, пока нет." />;
      return (
        <FlatList
          data={fresh}
          keyExtractor={(n) => `${n.item.id}`}
          contentContainerStyle={[styles.listPad, { paddingBottom: insets.bottom + 30 }]}
          ItemSeparatorComponent={Sep12}
          renderItem={({ item: n }) => (
            <Row
              image={n.item.backdropUrl ?? n.item.posterUrl}
              title={n.item.title}
              sub={`Вышла: сезон ${n.season} · серия ${n.episode}${n.airDate ? ` · ${humanDate(n.airDate)}` : ''}`}
              note={n.ahead && n.ahead > 1 ? `ещё ${n.ahead} серий после вашей` : n.ahead === null ? 'новый сезон' : 'следующая после вашей'}
              onPress={() => watchOnline(n.item)}
            />
          )}
        />
      );
    }
    const items = list === 'mine' ? mine.map(toItem) : extra?.items ?? null;
    if (!items) return <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />;
    if (!items.length)
      return (
        <Empty
          text={
            list === 'mine'
              ? 'Откройте фильм или сериал и нажмите «В Моё» — он появится здесь.'
              : 'Пока нечего предложить — посмотрите что-нибудь.'
          }
        />
      );
    return (
      <FlatList
        data={items}
        numColumns={cols}
        keyExtractor={(m) => `${m.type}-${m.id}`}
        contentContainerStyle={[styles.listPad, { paddingBottom: insets.bottom + 30 }]}
        columnWrapperStyle={styles.colGap}
        ItemSeparatorComponent={Sep14}
        renderItem={({ item }) => <PosterCard item={item} width={posterW} style={styles.noMargin} />}
      />
    );
  })();

  return (
    <View style={styles.screen}>
      <TopGlow />
      <View style={[styles.head, { paddingTop: insets.top + 8 }]}>
        <GlassBack onPress={close} />
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {list === 'history' && historyAll.length > 0 ? (
          <Pressable onPress={() => askClearHistory()} hitSlop={10} style={({ pressed }) => [styles.clear, pressed && { opacity: 0.6 }]}>
            <Text style={styles.clearText}>Очистить</Text>
          </Pressable>
        ) : null}
      </View>
      {body}
    </View>
  );
}

/** «История»: по дням, у каждой — где остановились или «просмотрено». */
function History({ bottom, all }: { bottom: number; all: TitleProgress[] }) {
  const groups = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const today = start.getTime();
    const yesterday = today - 86_400_000;
    const out: { name: string; items: TitleProgress[] }[] = [
      { name: 'Сегодня', items: [] },
      { name: 'Вчера', items: [] },
      { name: 'Ранее', items: [] },
    ];
    for (const t of all) {
      const at = t.last.updatedAt;
      (at >= today ? out[0] : at >= yesterday ? out[1] : out[2]).items.push(t);
    }
    return out.filter((g) => g.items.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all.length, all[0]?.last.updatedAt]);
  if (!all.length) return <Empty text="Здесь появится всё, что вы смотрели." />;
  const rows = groups.flatMap((g) => [{ head: g.name } as const, ...g.items.map((t) => ({ t }))]);
  return (
    <FlatList
      data={rows}
      // Ключ без номера в списке: после удаления строки нижние сдвигаются, и с номером в ключе
      // они пересоздавались бы — кадры заново проявлялись бы вспышкой. Тайтл в истории один раз.
      keyExtractor={(r) => ('head' in r ? `h-${r.head}` : `${r.t.type}-${r.t.id}`)}
      contentContainerStyle={[styles.listPad, { paddingBottom: bottom + 30 }]}
      renderItem={({ item: r }) =>
        'head' in r ? (
          <Text style={styles.group}>{r.head}</Text>
        ) : (
          <HistoryRow t={r.t} />
        )
      }
    />
  );
}

/*
  СТРОКА ИСТОРИИ С КРЕСТИКОМ — убрать один тайтл, не трогая остальные.

  Строка не пропадает рывком: сначала гаснет (160 мс), потом схлопывается по высоте (240 мс), и
  нижние строки плавно поднимаются на её место. Только после этого тайтл стирается из журнала —
  иначе список перестроился бы раньше, чем строка успела уйти. Высоту меряем по факту (onLayout):
  название и подпись бывают в две строки, и строка выходит выше кадра.
*/
function HistoryRow({ t }: { t: TitleProgress }) {
  const h = useSharedValue(-1);
  const op = useSharedValue(1);
  const going = useRef(false);
  const st = useAnimatedStyle(() => (h.value < 0 ? { opacity: op.value } : { opacity: op.value, height: h.value, overflow: 'hidden' }));
  const measured = useRef(0);
  const forget = useCallback(() => {
    forgetTitle({ type: t.type, id: t.id });
    forgetTitleProgress(t.type, t.id);
  }, [t.type, t.id]);
  const remove = useCallback(() => {
    if (going.current) return;
    going.current = true;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    h.value = measured.current;
    op.value = withTiming(0, { duration: 160 }, (ok) => {
      if (!ok) return;
      h.value = withTiming(0, { duration: 240, easing: Easing.out(Easing.cubic) }, (done) => {
        if (done) runOnJS(forget)();
      });
    });
  }, [forget, h, op]);
  const e = t.last;
  return (
    <Reanimated.View style={st}>
      <View style={styles.histRow} onLayout={(ev) => (measured.current = ev.nativeEvent.layout.height)}>
        <View style={{ flex: 1 }}>
          <Row
            image={e.backdropUrl ?? e.posterUrl}
            title={e.title}
            sub={
              t.type === 'tv' && e.season
                ? `Сезон ${e.season} · Серия ${e.episode}`
                : t.finished
                  ? 'Просмотрено'
                  : `Остановились на ${clock(e.positionMs)}`
            }
            progress={e.durationMs > 0 ? e.positionMs / e.durationMs : 0}
            onPress={() => openTitle(itemOfEntry(t, e))}
          />
        </View>
        <Pressable onPress={remove} hitSlop={10} style={({ pressed }) => [styles.histX, pressed && { opacity: 0.5 }]}>
          <SymbolView name="xmark" size={14} weight="semibold" tintColor={colors.mutedWarm} />
        </Pressable>
      </View>
    </Reanimated.View>
  );
}

/*
  Разделители — постоянные компоненты. Стрелка прямо в разметке была НОВЫМ типом компонента на
  каждую отрисовку: React размонтировал и заново создавал все разделители списка.
*/
const Sep18 = () => <View style={styles.sep18} />;
const Sep12 = () => <View style={styles.sep12} />;
const Sep14 = () => <View style={styles.sep14} />;

/*
  МИНИАТЮРА КАДРА — w780 вместо w1280. Рамка 132 точки — около 400 пикселей на тройной плотности;
  кадр в 1280 разжимался в память втрое больше нужного на каждой строке. 780 — с запасом, на глаз
  то же самое. Меняем только адрес для показа, сам тайтл (и обложка его страницы) не трогается.
*/
const thumbUri = (u: string) => u.replace('/t/p/w1280/', '/t/p/w780/');

function Row({
  image,
  title,
  sub,
  note,
  progress,
  onPress,
}: {
  image?: string | null;
  title: string;
  sub: string;
  note?: string;
  progress?: number;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
      <View style={styles.thumb}>
        {image ? <FadeInImage source={{ uri: thumbUri(image) }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
        {progress && progress > 0.01 ? (
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${Math.min(100, progress * 100)}%` }]} />
          </View>
        ) : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {title}
        </Text>
        <Text style={styles.rowSub} numberOfLines={2}>
          {sub}
        </Text>
        {note ? <Text style={styles.rowNote}>{note}</Text> : null}
      </View>
    </Pressable>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

function humanDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // Заголовок — на BACK_GAP от стеклянной стрелки, а не впритык к ней.
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingBottom: 12, gap: BACK_GAP },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title: { ...typo.pageTitle, color: colors.onBg, flex: 1 },
  // Капсула, как прочие кнопки-надписи приложения: тонкая рамка, без заливки — действие редкое.
  clear: { height: 32, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', justifyContent: 'center' },
  clearText: { ...typo.labelLarge, color: colors.onBg },
  listPad: { paddingHorizontal: 16, paddingTop: 4 },
  // Постоянные объекты вместо литералов в разметке: литерал — новый объект на каждую отрисовку,
  // и memo у PosterCard из-за него не срабатывал.
  noMargin: { marginRight: 0 },
  colGap: { gap: 10 },
  sep18: { height: 18 },
  sep12: { height: 12 },
  sep14: { height: 14 },
  group: { ...typo.titleMedium, color: colors.mutedWarm, marginTop: 10, marginBottom: 10 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  // Отступ снизу — внутри измеряемой строки: при схлопывании уходит вместе с ней, без скачка.
  histRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingBottom: 12 },
  histX: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  thumb: { width: 132, aspectRatio: 16 / 9, borderRadius: 0, overflow: 'hidden', backgroundColor: colors.surfaceHi },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  barFill: { height: '100%', backgroundColor: colors.focusFill },
  rowTitle: { ...typo.titleMedium, color: colors.onBg },
  rowSub: { ...typo.labelMedium, color: colors.mutedWarm, marginTop: 3 },
  rowNote: { ...typo.labelMedium, color: colors.focusFill, marginTop: 3 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyText: { ...typo.bodyMedium, color: colors.muted, textAlign: 'center', lineHeight: 22 },
});
