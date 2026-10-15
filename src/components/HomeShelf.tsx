import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { go } from '../nav/navGuard';
import { BusyOutline } from './BusyOutline';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  cancelAnimation,
  Easing,
  runOnJS,
  scrollTo,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type FrameInfo,
  type SharedValue,
} from 'react-native-reanimated';
import { openTitleMenu } from './TitleMenu';
import { itemOfEntry } from '../data/library';
import { router } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { colors } from '../theme/colors';
import { font, type as typo } from '../theme/fonts';
import { FadeInImage } from './FadeInImage';
import { continueTitles, hideFromContinue, setContinueOrder, titleKey, titlesByRecent, useWatchVersion, type TitleProgress } from '../data/watchProgress';
import { useMine } from '../data/mine';
import { useDownloads } from '../downloads/store';
import { resumeTitle } from '../nav/resume';
import { usePlaylists } from '../data/playlists';
import { kinofestsNow } from '../data/kinofests';
import { Mosaic } from './PlaylistCover';
import { usePortraitInsets, usePortraitWindow } from '../nav/portrait';

/**
 * ВЕРХ ГЛАВНОЙ — СВОИ СПИСКИ ПЛИТКАМИ, КАК НА ГЛАВНОЙ SPOTIFY.
 *
 * Карусели здесь больше нет (в «Фильмах» и «Сериалах» она осталась): главная — это не витрина,
 * а «моё»: то, что начато, отложено, скачано. Плитки в две колонки, как у Spotify под «Всё,
 * Музыка, Подкасты»: слева квадрат обложки, справа название — одним касанием в нужный список.
 *
 * Под плитками — ряд «Продолжить просмотр» (как у планшетного Люмьера и у Влада): кадр, полоса
 * просмотренного и где остановились; касание — сразу в плеер с того же места.
 */

type Tile = { key: string; title: string; icon: SFSymbol; covers: (string | null | undefined)[]; onPress: () => void };

/** До четырёх разных обложек — для мозаики плитки. */
function four(list: (string | null | undefined)[]): string[] {
  return [...new Set(list.filter((u): u is string => !!u))].slice(0, 4);
}

const open = (list: string) => go({ pathname: '/library/[list]', params: { list } });

/*
  Действия плиток — на уровне модуля: одни и те же функции на всё время жизни, поэтому плитки,
  обёрнутые в memo, не пересобираются из-за «новой» стрелки на каждой сборке полки.
*/
const openMine = () => open('mine');
const openHistory = () => open('history');
const openDownloads = () => go('/downloads');
const openKinofests = () => go('/kinofests');

export const HomeShelf = memo(function HomeShelf() {
  const insets = usePortraitInsets();
  const watchV = useWatchVersion();
  const mine = useMine();
  const playlists = usePlaylists();
  /*
    ЖУРНАЛ ПРОСМОТРА СЧИТАЕТСЯ ОДИН РАЗ НА ВЕРСИЮ. continueTitles() внутри себя заново собирает
    titlesByRecent(), то есть на каждой сборке полки журнал разбирался дважды, — а полка ещё и
    пересобиралась от каждого тика загрузок (3 раза в секунду). Теперь — только когда журнал
    действительно изменился (номер версии из useWatchVersion), и срез ряда стабилен между сборками.
  */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cont = useMemo(() => continueTitles().slice(0, 12), [watchV]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const recent = useMemo(() => titlesByRecent(), [watchV]);

  /*
    ЧЕТЫРЕ ПЛИТКИ — ВСЁ СВОЁ (просьба Марка): «Моё», «Загрузки», «Плейлисты», «История».
    Подборки («Рекомендации», «Похоже на…», «Новые серии») с главной убраны. Обложка у каждой —
    мозаика из того, что внутри: одна картинка, две, три или четыре.

    Каждая плитка собирается в useMemo от СВОИХ данных: плитка (memo) перерисовывается только
    тогда, когда изменилось то, что на ней нарисовано. «Загрузки» вынесены в DownloadsTile — она
    одна слушает частые тики прогресса.
  */
  const mineTile = useMemo<Tile>(
    () => ({ key: 'mine', title: 'Моё', icon: 'bookmark.fill', covers: mine.map((m) => m.posterUrl), onPress: openMine }),
    [mine],
  );
  const kinoTile = useMemo<Tile>(
    () => ({
      key: 'kinofest',
      title: 'Кинофест',
      icon: 'film',
      // Обложка — свои кинофесты, а если их нет — задники кинофестов Влада, что идут сейчас.
      covers: [
        ...playlists.flatMap((p) => (p.cover ? [p.cover] : p.items.slice(0, 1).map((e) => e.posterUrl))),
        ...kinofestsNow().slice(0, 4).map((k) => `https://image.tmdb.org/t/p/w300${k.heroBackdrop}`),
      ],
      onPress: openKinofests,
    }),
    [playlists],
  );
  const historyTile = useMemo<Tile>(
    () => ({ key: 'history', title: 'История', icon: 'clock.fill', covers: recent.map((t) => t.last.posterUrl), onPress: openHistory }),
    [recent],
  );

  return (
    <View style={{ paddingTop: insets.top + 58 }}>
      <View style={styles.grid}>
        <TileView tile={mineTile} />
        <DownloadsTile />
        <TileView tile={kinoTile} />
        <TileView tile={historyTile} />
      </View>
      {cont.length > 0 ? <ContinueRow list={cont} /> : null}
    </View>
  );
});

/*
  ПЛИТКА «ЗАГРУЗКИ» — ЕДИНСТВЕННАЯ, КТО СЛУШАЕТ ЗАГРУЗКИ. Список загрузок шлёт обновления по три
  раза в секунду (прогресс кусочков). Раньше на них была подписана вся полка, и каждый тик
  пересобирал плитки, ряд «Продолжить» и все его карточки. Теперь тик доходит только сюда:
  обложки держатся по ключу из адресов (прогресс их не меняет), а полоса перерисовывается лишь
  когда сменился целый процент.
*/
const DownloadsTile = memo(function DownloadsTile() {
  const downloads = useDownloads();
  const active = downloads.filter((d) => d.state === 'running' || d.state === 'queued');
  const frac = active.length
    ? active.reduce((n, d) => n + (d.piecesTotal ? d.piecesDone / d.piecesTotal : 0), 0) / active.length
    : null;
  // До процента: полосе в плитке дробнее не нужно, а то же самое число не будит плитку.
  const progress = frac == null ? null : Math.round(frac * 100) / 100;
  const coversKey = [...active, ...downloads.filter((d) => d.state === 'done')].map((d) => d.item.posterUrl ?? '').join('\n');
  const tile = useMemo<Tile>(
    () => ({
      key: 'downloads',
      title: 'Загрузки',
      icon: 'arrow.down.circle.fill',
      covers: coversKey ? coversKey.split('\n') : [],
      onPress: openDownloads,
    }),
    [coversKey],
  );
  return <TileView tile={tile} progress={progress} />;
});

const TileView = memo(function TileView({ tile, progress = null }: { tile: Tile; progress?: number | null }) {
  // Тот же массив обложек между сборками — мозаика (memo) не перерисовывается от тиков прогресса.
  const covers = useMemo(() => four(tile.covers), [tile.covers]);
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        tile.onPress();
      }}
      style={({ pressed }) => [styles.tile, pressed && styles.tileDown]}
    >
      <View style={styles.cover}>
        <Mosaic uris={covers} size={TILE_H} icon={tile.icon} />
        {covers.length > 0 ? (
          // Значок поверх обложки — чтобы плитка со снимком всё равно говорила, ЧТО это за список.
          <View style={styles.badge}>
            <SymbolView name={tile.icon} size={11} tintColor="#fff" />
          </View>
        ) : null}
      </View>
      <Text style={styles.tileText} numberOfLines={2}>
        {tile.title}
      </Text>
      {progress != null ? (
        <View style={styles.tileBar}>
          <View style={[styles.tileBarFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
      ) : null}
    </Pressable>
  );
});

/*
  «ПРОДОЛЖИТЬ ПРОСМОТР» С ПЕРЕСТАНОВКОЙ — как значки на экране «Домой» iPhone.

  «Переместить» в меню карточки включает режим правки: все карточки ряда мелко дрожат, у каждой
  в углу крестик (убрать из ряда), а карточку можно взять (подержать и повести) и перетащить на
  новое место — соседи расступаются под ней. «Готово» сохраняет порядок (watchProgress:
  setContinueOrder); то, что посмотрят после, всё равно встанет первым.
*/
const CARD_W = 220;
/*
  В режиме правки карточки уменьшаются на 30% (так удобнее брать и переносить) — плавно, и так же
  плавно возвращаются по «Готово». Шаг перестановки — по уменьшенной карточке.
*/
const SMALL = 0.7;
/** Отступ ряда по краям (contentContainerStyle) и зазор между карточками. */
const ROW_PAD = 16;
const ROW_GAP = 10;
const STEP = CARD_W * SMALL + ROW_GAP;

/*
  УДАЛЕНИЕ КРЕСТИКОМ — как значок на экране «Домой»: карточка сжимается к своему центру до пятой
  части и растворяется, а соседи справа в это же время плавно съезжают на освободившееся место.
  Съезжают они не «прыжком после удаления», а потому что сама уходящая карточка постепенно отдаёт
  своё место в ряду (её поля сходятся до нуля) — раскладка ряда меняется кадр за кадром в потоке
  интерфейса. Из данных карточка убирается только когда она уже невидима и места не занимает, —
  поэтому в момент удаления на экране ничего не дёргается.

  Кривая — bezier(0.2, 0, 0, 1): уверенный, но мягкий старт и долгий доезд без перелёта, как у
  системных переходов iOS. 320 мс — достаточно, чтобы глаз прочитал «ушла и сомкнулись», и не так
  долго, чтобы ждать.
*/
const RM_MS = 320;
const RM_EASE = Easing.bezier(0.2, 0, 0, 1);

/*
  АВТОПРОКРУТКА У КРАЯ — как перенос значка на соседний экран «Домой»: поднёс карточку к краю —
  ряд сам поехал в ту сторону. Зона — 60 точек у кромки; скорость растёт к самой кромке плавно
  (по квадрату близости), поэтому прокрутка начинается мягко, без рывка на входе в зону.
*/
const EDGE = 60;
/** Скорость у самой кромки, точек в секунду. */
const EDGE_SPEED = 900;

/** Куда встанет перетаскиваемая карточка: путь пальца (вместе с прокруткой ряда) в шагах ряда. */
function hoverOf(from: number, dx: number, count: number): number {
  'worklet';
  return Math.max(0, Math.min(count - 1, from + Math.round(dx / STEP)));
}

/** Общие для ряда значения, которые читают карточки в потоке интерфейса. Один объект на ряд — memo карточек не ломается. */
type RowShared = {
  dragIdx: SharedValue<number>;
  hoverIdx: SharedValue<number>;
  /** Сдвиг пальца от начала перетаскивания. */
  dragX: SharedValue<number>;
  /** Насколько ряд прокрутился сам за время перетаскивания — его карточка добирает, чтобы остаться под пальцем. */
  scrollDelta: SharedValue<number>;
  shrink: SharedValue<number>;
  dragging: SharedValue<boolean>;
  fingerX: SharedValue<number>;
  startOff: SharedValue<number>;
  autoOff: SharedValue<number>;
  offX: SharedValue<number>;
  /** Пока кто-то удаляется, брать карточки нельзя — см. JiggleCard. */
  blockDrag: SharedValue<boolean>;
};

function ContinueRow({ list }: { list: TitleProgress[] }) {
  const [editing, setEditing] = useState(false);
  const [order, setOrder] = useState<TitleProgress[]>(list);
  const { width: screenW } = usePortraitWindow();
  const dragIdx = useSharedValue(-1);
  const hoverIdx = useSharedValue(-1);
  const dragX = useSharedValue(0);
  const scrollDelta = useSharedValue(0);
  const shrink = useSharedValue(1);
  const dragging = useSharedValue(false);
  const fingerX = useSharedValue(0);
  const startOff = useSharedValue(0);
  const autoOff = useSharedValue(0);
  const offX = useSharedValue(0);
  const blockDrag = useSharedValue(false);
  const viewW = useSharedValue(0);
  const contentW = useSharedValue(0);
  const countSv = useSharedValue(list.length);
  /** Доводка прокрутки при удалении у правого края (см. removeStart). */
  const fixing = useSharedValue(false);
  const fixOff = useSharedValue(0);
  const pending = useRef(0);
  const lenRef = useRef(order.length);
  lenRef.current = order.length;
  const listRef = useAnimatedRef<Reanimated.ScrollView>();

  const rs = useMemo<RowShared>(
    () => ({ dragIdx, hoverIdx, dragX, scrollDelta, shrink, dragging, fingerX, startOff, autoOff, offX, blockDrag }),
    [dragIdx, hoverIdx, dragX, scrollDelta, shrink, dragging, fingerX, startOff, autoOff, offX, blockDrag],
  );

  useEffect(() => {
    shrink.value = withTiming(editing ? SMALL : 1, { duration: 280, easing: Easing.inOut(Easing.cubic) });
  }, [editing, shrink]);

  // Пока не правим — ряд следует за журналом.
  const sig = list.map((t) => `${t.type}-${t.id}`).join('|');
  useEffect(() => {
    if (!editing) setOrder(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, editing]);

  // Число карточек нужно перестановке в потоке интерфейса (автопрокрутка пересчитывает цель сама).
  useEffect(() => {
    countSv.value = order.length;
  }, [order.length, countSv]);

  const drop = useCallback(
    (from: number, to: number) => {
      setOrder((o) => {
        const a = [...o];
        const [m] = a.splice(from, 1);
        a.splice(to, 0, m);
        return a;
      });
      void Haptics.selectionAsync();
    },
    [],
  );
  // Новый порядок уже нарисован — сдвиги можно снять без скачка.
  useEffect(() => {
    dragIdx.value = -1;
    hoverIdx.value = -1;
    dragX.value = 0;
    scrollDelta.value = 0;
  }, [order, dragIdx, hoverIdx, dragX, scrollDelta]);

  // Прокрутка ряда — в потоке интерфейса: с неё начинается отсчёт автопрокрутки.
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      offX.value = e.contentOffset.x;
    },
  });

  /*
    АВТОПРОКРУТКА — КАЖДЫЙ КАДР В ПОТОКЕ ИНТЕРФЕЙСА, без JS. Пока карточку держат у края, ряд
    прокручивается на скорость × время кадра (120 Гц на Pro — шаг вдвое мельче, движение ровнее), до
    границ содержимого. Сдвиг прокрутки тут же добавляется карточке (scrollDelta) — она остаётся под
    пальцем, — и тут же пересчитывается место, куда она встанет: палец может стоять, а ряд ехать.
  */
  const autoScroll = useCallback(
    (f: FrameInfo) => {
      'worklet';
      if (!dragging.value) return;
      const x = fingerX.value;
      let c = 0;
      if (x < EDGE) c = -(EDGE - x) / EDGE;
      else if (x > screenW - EDGE) c = (x - (screenW - EDGE)) / EDGE;
      if (c === 0) return;
      c = Math.max(-1, Math.min(1, c));
      // Кадр после подвисания не должен швырнуть ряд: шаг ограничен двумя кадрами 60 Гц.
      const dt = Math.min(f.timeSincePreviousFrame ?? 16, 34);
      const max = Math.max(0, contentW.value - viewW.value);
      const next = Math.max(0, Math.min(max, autoOff.value + (EDGE_SPEED * c * Math.abs(c) * dt) / 1000));
      if (next === autoOff.value) return;
      autoOff.value = next;
      scrollTo(listRef, next, 0, false);
      scrollDelta.value = next - startOff.value;
      hoverIdx.value = hoverOf(dragIdx.value, dragX.value + scrollDelta.value, countSv.value);
    },
    [screenW, dragging, fingerX, contentW, viewW, autoOff, listRef, scrollDelta, startOff, hoverIdx, dragIdx, dragX, countSv],
  );
  const auto = useFrameCallback(autoScroll, false);
  /*
    Пока карточку несут, ряд не прокручивается пальцем: прокрутку ведёт только автопрокрутка.
    Иначе системная прокрутка списка и наша (scrollTo) тянули бы ряд в разные стороны, и карточка
    уезжала бы из-под пальца. Переключается в потоке интерфейса — в тот же кадр, когда карточку взяли.
  */
  const scrollProps = useAnimatedProps(() => ({ scrollEnabled: !dragging.value }));
  // Обработчик кадра живёт только в режиме правки: вне его ряд не тратит ни такта.
  useEffect(() => {
    auto.setActive(editing);
  }, [editing, auto]);

  // Доводка прокрутки при удалении — те же кадры, что у сжатия ряда (см. removeStart).
  useAnimatedReaction(
    () => fixOff.value,
    (v) => {
      if (fixing.value) scrollTo(listRef, v, 0, false);
    },
  );

  /*
    КРЕСТИК НАЖАТ — карточка начала уходить. Пока она уходит, перетаскивание закрыто: шаги
    перестановки считаются по полным местам в ряду, а уходящая карточка своё место как раз отдаёт.

    Если ряд прокручен к самому концу, то вместе с сжатием ряда уменьшается и его длина; чтобы у
    правого края не открылась пустота (и не было щелчка, когда система сама подрежет прокрутку),
    прокрутка съезжает к новому концу по той же кривой и за то же время — синхронно с соседями.
  */
  const removeStart = useCallback(() => {
    pending.current += 1;
    blockDrag.value = true;
    const left = lenRef.current - pending.current;
    const finalW = ROW_PAD * 2 + Math.max(0, left * STEP - ROW_GAP);
    const max = Math.max(0, finalW - viewW.value);
    if (offX.value > max + 0.5) {
      if (!fixing.value) fixOff.value = offX.value;
      fixing.value = true;
      fixOff.value = withTiming(max, { duration: RM_MS, easing: RM_EASE }, (done) => {
        if (done) fixing.value = false;
      });
    }
  }, [blockDrag, viewW, offX, fixing, fixOff]);

  /** Карточка доиграла уход и уже не видна — теперь её можно убрать из данных. */
  const removed = useCallback(
    (type: TitleProgress['type'], id: number) => {
      pending.current = Math.max(0, pending.current - 1);
      if (pending.current === 0) blockDrag.value = false;
      hideFromContinue(type, id);
      setOrder((o) => o.filter((x) => !(x.type === type && x.id === id)));
    },
    [blockDrag],
  );

  const startEdit = useCallback(() => setEditing(true), []);

  const finish = () => {
    setContinueOrder(order.map((t) => titleKey(t.type, t.id)));
    setEditing(false);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <Text style={styles.rowTitle}>Продолжить просмотр</Text>
        {editing ? (
          <Pressable onPress={finish} hitSlop={10} style={({ pressed }) => [styles.done, pressed && { opacity: 0.7 }]}>
            <Text style={styles.doneText}>Готово</Text>
          </Pressable>
        ) : null}
      </View>
      <Reanimated.ScrollView
        ref={listRef}
        horizontal
        scrollsToTop={false}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rowList}
        onScroll={onScroll}
        scrollEventThrottle={16}
        animatedProps={scrollProps}
        // Размеры окна и содержимого — границы автопрокрутки.
        onLayout={(ev) => {
          viewW.value = ev.nativeEvent.layout.width;
        }}
        onContentSizeChange={(w) => {
          contentW.value = w;
        }}
      >
        {order.map((t, i) => (
          <JiggleCard
            key={`${t.type}-${t.id}`}
            t={t}
            index={i}
            count={order.length}
            editing={editing}
            rs={rs}
            onDrop={drop}
            onRemoveStart={removeStart}
            onRemoved={removed}
            onMove={startEdit}
          />
        ))}
      </Reanimated.ScrollView>
    </View>
  );
}

const JiggleCard = memo(function JiggleCard({
  t,
  index,
  count,
  editing,
  rs,
  onDrop,
  onRemoveStart,
  onRemoved,
  onMove,
}: {
  t: TitleProgress;
  index: number;
  count: number;
  editing: boolean;
  rs: RowShared;
  onDrop: (from: number, to: number) => void;
  onRemoveStart: () => void;
  onRemoved: (type: TitleProgress['type'], id: number) => void;
  onMove: () => void;
}) {
  const wob = useSharedValue(0);
  /** Уход карточки по крестику: 0 — на месте, 1 — сжалась, растворилась и отдала своё место. */
  const gone = useSharedValue(0);
  const removing = useRef(false);
  /*
    Фаза дрожи берётся из номера на ВХОДЕ в режим правки. Если бы эффект зависел от номера, то
    после удаления соседа у всех правее номер сменился бы, дрожь перезапустилась с задержкой — и
    карточки на мгновение замирали бы.
  */
  const phase = useRef(index % 3);
  useEffect(() => {
    if (!editing) {
      cancelAnimation(wob);
      wob.value = withTiming(0, { duration: 120 });
      return;
    }
    phase.current = index % 3;
    // Дрожь — как у значков iOS: мелкий поворот туда-обратно, у соседей в разной фазе.
    wob.value = withDelay(phase.current * 60, withRepeat(withSequence(withTiming(1, { duration: 110 }), withTiming(-1, { duration: 110 })), -1, true));
    return () => cancelAnimation(wob);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, wob]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(editing)
        .activateAfterLongPress(160)
        .onStart((e) => {
          // Пока кто-то уходит, ряд «плывёт» — брать карточку нельзя, шаги посчитались бы неверно.
          if (rs.blockDrag.value || gone.value > 0) return;
          rs.dragIdx.value = index;
          rs.hoverIdx.value = index;
          rs.dragX.value = 0;
          rs.scrollDelta.value = 0;
          // Отсчёт автопрокрутки — от того места, где ряд стоял в момент, когда карточку взяли.
          rs.startOff.value = rs.offX.value;
          rs.autoOff.value = rs.offX.value;
          rs.fingerX.value = e.absoluteX;
          rs.dragging.value = true;
        })
        .onUpdate((e) => {
          if (!rs.dragging.value || rs.dragIdx.value !== index) return;
          rs.dragX.value = e.translationX;
          rs.fingerX.value = e.absoluteX;
          // Цель — по пути пальца ПЛЮС то, что ряд успел прокрутиться сам.
          rs.hoverIdx.value = hoverOf(index, e.translationX + rs.scrollDelta.value, count);
        })
        .onEnd(() => {
          if (!rs.dragging.value || rs.dragIdx.value !== index) return;
          // Палец отпущен — автопрокрутка встаёт в этом же кадре.
          rs.dragging.value = false;
          const to = rs.hoverIdx.value;
          if (to !== index) runOnJS(onDrop)(index, to);
          else {
            // Сдвиг прокрутки вливается в сдвиг карточки, и она одним движением едет на своё место.
            rs.dragX.value = rs.dragX.value + rs.scrollDelta.value;
            rs.scrollDelta.value = 0;
            rs.dragX.value = withTiming(0, { duration: 160 });
            rs.dragIdx.value = -1;
            rs.hoverIdx.value = -1;
          }
        })
        .onFinalize(() => {
          // Жест оборвался (система забрала касание) — автопрокрутка не должна ехать дальше сама.
          if (rs.dragIdx.value === index) rs.dragging.value = false;
        }),
    [editing, index, count, rs, gone, onDrop],
  );

  const remove = useCallback(() => {
    // Повторное касание уходящей карточки и касание во время перетаскивания — мимо.
    if (removing.current || rs.dragIdx.value >= 0) return;
    removing.current = true;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onRemoveStart();
    // В поток интерфейса уходят только тип и номер: сам объект тайтла туда копировать незачем
    // (в отладке Reanimated ещё и замораживает всё, что передано в worklet).
    const type = t.type;
    const id = t.id;
    gone.value = withTiming(1, { duration: RM_MS, easing: RM_EASE }, (done) => {
      if (done) runOnJS(onRemoved)(type, id);
    });
  }, [rs, onRemoveStart, onRemoved, gone, t.type, t.id]);

  const st = useAnimatedStyle(() => {
    const d = rs.dragIdx.value;
    const h = rs.hoverIdx.value;
    let shift = 0;
    if (d >= 0 && d !== index) {
      // Соседи расступаются: карточка «уезжает» в сторону, освобождая место под перетаскиваемой.
      if (d < index && h >= index) shift = -STEP;
      if (d > index && h <= index) shift = STEP;
    }
    const me = d === index;
    const k = rs.shrink.value;
    const g = gone.value;
    // Уходящая сжимается до 0.2 и гаснет вместе со сжатием.
    const q = 1 - 0.8 * g;
    return {
      zIndex: me ? 10 : 0,
      opacity: 1 - g,
      /*
        Уменьшенная карточка забирает и место: соседи подъезжают, ряд становится плотнее.
        Уходящая отдаёт место целиком: ширина сходится к нулю справа, а зазор перед ней — слева.
        Когда g = 1, она не занимает в ряду ничего, и удаление из данных ничего не сдвигает.
      */
      marginLeft: -ROW_GAP * g,
      marginRight: -CARD_W * (1 - k) - CARD_W * k * g,
      transformOrigin: 'left center',
      transform: [
        { translateX: me ? rs.dragX.value + rs.scrollDelta.value : withTiming(shift, { duration: 180 }) },
        // Сжатие идёт к ЦЕНТРУ карточки: компенсируем и левый край (точка масштаба), и съехавший зазор.
        { translateX: ROW_GAP * g + (CARD_W * k * (1 - q)) / 2 },
        { rotate: `${wob.value * (me ? 0 : 1.3)}deg` },
        { scale: k * (me ? 1.06 : 1) * q },
      ],
    };
  });

  return (
    <GestureDetector gesture={pan}>
      <Reanimated.View style={st}>
        <ContinueCard t={t} editing={editing} onMove={onMove} />
        {editing ? (
          <Pressable onPress={remove} hitSlop={8} style={styles.xBadge}>
            <SymbolView name="xmark" size={11} weight="bold" tintColor="#000" />
          </Pressable>
        ) : null}
      </Reanimated.View>
    </GestureDetector>
  );
});

/** Карточка «Продолжить»: кадр, полоса просмотренного и где остановились. */
export const ContinueCard = memo(function ContinueCard({
  t,
  wide = false,
  editing = false,
  onMove,
}: {
  t: TitleProgress;
  wide?: boolean;
  editing?: boolean;
  onMove?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  /*
    РАМКА ОЖИДАНИЯ МОНТИРУЕТСЯ ПРИ ПЕРВОМ НАЖАТИИ, а не заранее. В покое она ничего не рисует, но
    каждая из двенадцати карточек держала свой SVG и четыре анимируемых значения. Однажды
    появившись, рамка остаётся — ей нужно доиграть «замыкание» после ожидания.
    Размер кадра держим в ref: лишняя сборка на каждое измерение карточке не нужна, пока рамки нет.
  */
  const armed = useRef(false);
  const box = useRef<{ w: number; h: number } | null>(null);
  const [, remeasured] = useState(0);
  const e = t.last;
  const frac = e.durationMs > 0 ? Math.min(1, e.positionMs / e.durationMs) : 0;
  const where =
    t.type === 'tv' && e.season
      ? t.finished
        ? `Досмотрена серия ${e.episode} — дальше следующая`
        : `Сезон ${e.season} · Серия ${e.episode}`
      : `Осталось ${Math.max(1, Math.round((e.durationMs - e.positionMs) / 60000))} мин`;
  const raw = e.backdropUrl ?? e.posterUrl;
  /*
    Кадр карточки — w780, а не w1280: карточка в ряду 220 точек (660 px @3x), w780 покрывает её с
    запасом, а весит и декодируется в разы легче — на каждой из двенадцати карточек. Широкая
    карточка (список «Продолжить» во всю ширину) остаётся на исходном размере, чтобы не размылась.
  */
  const img = raw && !wide ? raw.replace('/t/p/w1280/', '/t/p/w780/') : raw;
  return (
    <Pressable
      onPress={async () => {
        if (busy || editing) return;
        armed.current = true;
        setBusy(true);
        void Haptics.selectionAsync();
        try {
          await resumeTitle(t);
        } finally {
          setBusy(false);
        }
      }}
      onLongPress={
        editing
          ? undefined
          : () =>
              openTitleMenu({
                item: itemOfEntry(t, e),
                episode: t.type === 'tv' && e.season && e.episode ? { season: Number(e.season), episode: Number(e.episode) } : null,
                inContinue: true,
                onMove,
              })
      }
      delayLongPress={380}
      style={({ pressed }) => [wide ? styles.cardWide : styles.card, pressed && styles.tileDown]}
    >
      <View
        style={styles.frame}
        onLayout={(ev) => {
          const { width: w, height: h } = ev.nativeEvent.layout;
          box.current = { w, h };
          // Рамка уже есть — ей нужен новый размер; нет — молчим.
          if (armed.current) remeasured((n) => n + 1);
        }}
      >
        {img ? <FadeInImage source={{ uri: img }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${Math.round((t.finished ? 1 : frac) * 100)}%` }]} />
        </View>
        {armed.current && box.current ? <BusyOutline w={box.current.w} h={box.current.h} on={busy} /> : null}
      </View>
      <Text style={styles.cardTitle} numberOfLines={1}>
        {e.title}
      </Text>
      <Text style={styles.cardSub} numberOfLines={1}>
        {where}
      </Text>
    </Pressable>
  );
});

const TILE_H = 56;

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, gap: 8, marginBottom: 22 },
  tile: {
    // Две колонки: половина ширины за вычетом половины зазора.
    width: '48.6%',
    flexGrow: 1,
    height: TILE_H,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.09)',
  },
  tileDown: { opacity: 0.7, transform: [{ scale: 0.98 }] },
  cover: {
    width: TILE_H,
    height: TILE_H,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceHi,
  },
  mosaic: { ...StyleSheet.absoluteFill, flexDirection: 'row', flexWrap: 'wrap' },
  mosaicCell: { width: TILE_H / 2, height: TILE_H / 2 },
  badge: {
    position: 'absolute',
    right: 3,
    bottom: 3,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  tileText: { flex: 1, fontFamily: font.bold, fontSize: 13, lineHeight: 16, color: colors.onBg, paddingHorizontal: 10 },
  tileBar: { position: 'absolute', left: TILE_H, right: 0, bottom: 0, height: 2, backgroundColor: 'rgba(255,255,255,0.12)' },
  tileBarFill: { height: '100%', backgroundColor: colors.focusFill },
  row: { marginBottom: 22 },
  rowTitle: { ...typo.headlineLarge, color: colors.onBg, marginBottom: 9, marginLeft: 16 },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: 16 },
  done: { height: 30, paddingHorizontal: 14, borderRadius: 15, justifyContent: 'center', backgroundColor: colors.focusFill, marginBottom: 9 },
  doneText: { fontFamily: font.bold, fontSize: 14, color: '#000' },
  xBadge: { position: 'absolute', left: -6, top: -6, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E6E6E6', zIndex: 20 },
  rowList: { paddingHorizontal: ROW_PAD, gap: ROW_GAP },
  card: { width: CARD_W },
  cardWide: { width: '100%' },
  frame: { width: '100%', aspectRatio: 16 / 9, borderRadius: 0, overflow: 'hidden', backgroundColor: colors.surfaceHi },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  barFill: { height: '100%', backgroundColor: colors.focusFill },
  cardTitle: { ...typo.titleMedium, color: colors.onBg, marginTop: 6 },
  cardSub: { ...typo.labelMedium, color: colors.mutedWarm, marginTop: 2 },
});
