import { memo, useEffect, useMemo, useState } from 'react';
import { markPush } from '../src/nav/navGuard';
import { TopGlow } from '../src/components/TopGlow';
import { ActionSheetIOS, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import Reanimated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { colors } from '../src/theme/colors';
import { type as typo } from '../src/theme/fonts';
import { usePortraitInsets } from '../src/nav/portrait';
import { FadeInImage } from '../src/components/FadeInImage';
import { speeds, useDownloads, type DlTask } from '../src/downloads/store';
import {
  fmtSize,
  fmtSpeed,
  freeSpace,
  pauseAll,
  pauseDownload,
  removeDownload,
  remuxAgain,
  resumeAll,
  resumeDownload,
} from '../src/downloads/engine';
import { localRequest } from '../src/downloads/offline';
import { setPendingPlayback } from '../src/player/request';
import { ZoomPage, useZoomClose } from '../src/nav/ZoomPage';
import { openTitleMenu } from '../src/components/TitleMenu';
import { openTitle } from '../src/nav/openTitle';
import type { DlItem } from '../src/downloads/store';
import type { MediaItem } from '../src/types/media';

/** Загрузка хранит урезанную карточку тайтла — меню и страница фильма ждут полную: дополняем пустым. */
function asMedia(d: DlItem): MediaItem {
  return {
    id: d.id, type: d.type, title: d.title, originalTitle: d.originalTitle, overview: '',
    posterUrl: d.posterUrl, backdropUrl: d.backdropUrl, year: d.year ?? '', rating: 0, releaseDate: null,
    originalLanguage: '', genreIds: [], voteCount: 0,
  } as MediaItem;
}

/*
  ПОСТЕР В ЗАГРУЗКАХ — как на главной: зажал — то же контекстное меню тайтла (TitleMenu), оттуда
  и страница фильма/сериала, и «Моё», и оценки.
*/
function Thumb({ item }: { item: DlItem }) {
  return (
    <Pressable onLongPress={() => openTitleMenu({ item: asMedia(item) })} delayLongPress={350} style={styles.thumb}>
      {item.posterUrl ? <FadeInImage source={{ uri: item.posterUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
    </Pressable>
  );
}

/**
 * ЗАГРУЗКИ — как вкладка «Загрузки» у планшетного Люмьера (lumiere.tab.DownloadsPage):
 *   — «Скачиваются»: что идёт, сколько скачано, скорость и сколько осталось; пауза и продолжение;
 *   — «Готовые загрузки»: можно смотреть без интернета; сериалы — одной карточкой со списком серий;
 *   — внизу — сколько занимают загрузки и сколько свободно на телефоне.
 */
export default function DownloadsScreen() {
  return (
    <ZoomPage>
      <DownloadsScreenBody />
    </ZoomPage>
  );
}

function DownloadsScreenBody() {
  const close = useZoomClose();
  const insets = usePortraitInsets();
  const tasks = useDownloads();
  // Скорость живёт вне списка (в памяти) — освежаем экран раз в секунду, пока что-то качается.
  const [tickN, tick] = useState(0);
  const anyRunning = tasks.some((t) => t.state === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [anyRunning]);

  const active = tasks.filter((t) => t.state !== 'done');
  const ready = tasks.filter((t) => t.state === 'done');
  const hasActive = tasks.some((t) => t.state === 'running' || t.state === 'queued');
  const canResume = tasks.some((t) => t.state === 'paused' || t.state === 'failed');

  // Готовые — по тайтлам: сериал одной карточкой, серии под ней по порядку.
  // Группы пересобираются только при смене списка (useMemo), а не на каждый секундный тик:
  // тогда те же массивы доходят до memo(ReadyGroup), и готовые карточки не перерисовываются.
  const groups = useMemo(() => {
    const m = new Map<string, DlTask[]>();
    for (const t of tasks) {
      if (t.state !== 'done') continue;
      const k = `${t.item.type}:${t.item.id}`;
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return m;
  }, [tasks]);
  const used = tasks.reduce((n, t) => n + (t.bytes || 0), 0);
  /*
    СВОБОДНОЕ МЕСТО — НЕ НА КАЖДУЮ ПЕРЕРИСОВКУ. Это синхронный вызов в нативный код, а экран во
    время загрузки перерисовывается до четырёх раз в секунду (тик скорости + обновления хранилища).
    Теперь: при открытии, когда меняется состав списка, и раз в 5 секунд, пока что-то качается.
  */
  const [free, setFree] = useState(freeSpace);
  useEffect(() => {
    setFree(freeSpace());
  }, [tasks.length, ready.length]);
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => setFree(freeSpace()), 5000);
    return () => clearInterval(id);
  }, [anyRunning]);

  return (
    <View style={styles.screen}>
      <TopGlow />
      <View style={[styles.head, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={close} hitSlop={12} style={styles.back}>
          <SymbolView name="chevron.backward" size={20} tintColor={colors.onBg} />
        </Pressable>
        <Text style={styles.title}>Загрузки</Text>
        {hasActive || canResume ? (
          <Pressable
            onPress={() => (hasActive ? pauseAll() : resumeAll())}
            style={({ pressed }) => [styles.pill, pressed && { opacity: 0.6 }]}
          >
            <SymbolView name={hasActive ? 'pause.fill' : 'play.fill'} size={12} tintColor={colors.onBg} />
            <Text style={styles.pillText}>{hasActive ? 'Пауза всех' : 'Продолжить все'}</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 40 }}>
        {tasks.length === 0 ? (
          <View style={styles.empty}>
            <SymbolView name="arrow.down.circle" size={44} tintColor={colors.faint} />
            <Text style={styles.emptyTitle}>Пока ничего не скачано</Text>
            <Text style={styles.emptyText}>
              Откройте фильм или сериал и нажмите «Скачать» — он появится здесь и будет доступен без интернета,
              например в дороге.
            </Text>
          </View>
        ) : null}

        {active.length > 0 ? <Text style={styles.section}>Скачиваются</Text> : null}
        {active.map((t) => (
          // tick — только идущим строкам: их скорость живёт вне списка и обновляется раз в секунду,
          // остальные строки (memo) при тике не перерисовываются.
          <ActiveRow key={t.id} t={t} tick={t.state === 'running' ? tickN : 0} />
        ))}

        {groups.size > 0 ? <Text style={styles.section}>Готовые загрузки</Text> : null}
        {[...groups.values()].map((list) => (
          <ReadyGroup key={`${list[0].item.type}:${list[0].item.id}`} list={list} />
        ))}

        {tasks.length > 0 ? (
          <Text style={styles.storage}>
            Загрузки занимают {fmtSize(used)}
            {free >= 0 ? ` · свободно ${fmtSize(free)}` : ''}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function play(t: DlTask) {
  // Ещё не собрано в один файл — плееру отдавать нечего: собрать заново, дальше приложение само.
  if (t.playlist !== 'video.mp4') {
    remuxAgain(t.id);
    return;
  }
  const target = t.season != null && t.episode != null ? { season: t.season, episode: t.episode } : null;
  const req = localRequest(
    { id: t.item.id, type: t.item.type, title: t.item.title, posterUrl: t.item.posterUrl, backdropUrl: t.item.backdropUrl },
    target,
  );
  if (!req) {
    Alert.alert('Файл не найден', 'Загрузка повреждена или удалена. Поставьте её заново.');
    return;
  }
  setPendingPlayback(req);
  (markPush(), router.push('/watch'));
}

function confirmRemove(t: DlTask, list?: DlTask[]) {
  const many = list && list.length > 1;
  const size = (list ?? [t]).reduce((n, x) => n + (x.bytes || 0), 0);
  Alert.alert(
    t.state === 'done' ? 'Удалить с устройства?' : 'Отменить загрузку?',
    `${t.item.title}${many ? ` — ${list!.length} серий` : t.label ? ` · ${t.label}` : ''}\nОсвободит ${fmtSize(size)}.`,
    [
      { text: 'Отмена', style: 'cancel' },
      { text: t.state === 'done' ? 'Удалить' : 'Отменить и удалить', style: 'destructive', onPress: () => (list ?? [t]).forEach((x) => removeDownload(x.id)) },
    ],
  );
}

function statusOf(t: DlTask): string {
  const pct = t.piecesTotal ? Math.round((t.piecesDone / t.piecesTotal) * 100) : 0;
  const amount = t.bytesTotal > 0 ? `${fmtSize(t.bytes)} из ~${fmtSize(t.bytesTotal)} · ${pct}%` : t.bytes > 0 ? fmtSize(t.bytes) : '';
  switch (t.state) {
    case 'running': {
      // Последний шаг: куски перекладываются в один файл, который iPhone играет с диска.
      if (t.mux != null) return `Готовлю к просмотру · ${Math.round(t.mux * 100)}%`;
      const sp = speeds.get(t.id) ?? 0;
      if (!t.piecesTotal) return 'Подключение…';
      const left = sp > 0 && t.bytesTotal > t.bytes ? Math.round((t.bytesTotal - t.bytes) / sp / 60) : null;
      return [amount, sp > 0 ? fmtSpeed(sp) : null, left != null ? `осталось ${left < 1 ? 'меньше минуты' : `${left} мин`}` : null]
        .filter(Boolean)
        .join(' · ');
    }
    case 'paused':
      return `Пауза${amount ? ` · ${amount}` : ''}`;
    case 'failed':
      return `Не скачалось: ${t.error ?? 'ошибка'}`;
    default:
      return `В очереди${amount ? ` · ${amount}` : ''}`;
  }
}

/**
 * Пульс идущей загрузки — та же волна, что бежит по шкале плеера, пока грузится видео (Scrubber):
 * светлая полоса набегает слева направо и гаснет, 1.5 с на проход. Стоит на паузе — волны нет.
 */
function BarWave({ on }: { on: boolean }) {
  const sweep = useSharedValue(0);
  const W = useSharedValue(0);
  useEffect(() => {
    cancelAnimation(sweep);
    sweep.value = 0;
    if (on) sweep.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.cubic) }), -1, false);
  }, [on, sweep]);
  /*
    ВОЛНА — СДВИГОМ, А НЕ ШИРИНОЙ. Раньше width в процентах менялась каждый кадр, бесконечно, на
    каждой идущей строке — это раскладка на каждом кадре. Теперь полоса всегда во всю шкалу и
    выезжает слева: видна та же часть [0 … sweep] со скруглённым правым концом, а левый конец
    обрезает скругление самой шкалы — ровно как было.
  */
  const wave = useAnimatedStyle(() => ({
    transform: [{ translateX: -(1 - sweep.value) * W.value }],
    opacity: on && W.value > 0 ? Math.sin(Math.PI * sweep.value) * 0.85 : 0,
  }));
  return (
    <Reanimated.View
      pointerEvents="none"
      onLayout={(e) => {
        W.value = e.nativeEvent.layout.width;
      }}
      style={[styles.wave, wave]}
    />
  );
}

// memo: строка перерисовывается, только когда поменялась её задача (хранилище отдаёт новые
// объекты при изменениях) или — для идущей — тикнула секунда скорости.
const ActiveRow = memo(function ActiveRow({ t }: { t: DlTask; tick: number }) {
  const frac = t.mux != null ? t.mux : t.piecesTotal ? t.piecesDone / t.piecesTotal : 0;
  const toggle = () => {
    void Haptics.selectionAsync();
    if (t.state === 'running' || t.state === 'queued') pauseDownload(t.id);
    else resumeDownload(t.id);
  };
  return (
    <Pressable onPress={toggle} onLongPress={() => confirmRemove(t)} style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
      <Thumb item={t.item} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {t.item.title}
        </Text>
        {t.label ? <Text style={styles.rowLabel}>{t.label}{t.voice ? ` · ${t.voice}` : ''}</Text> : t.voice ? <Text style={styles.rowLabel}>{t.voice}</Text> : null}
        <View style={styles.bar}>
          <View style={[styles.barFill, t.state === 'failed' && styles.barFail, { width: `${Math.round(frac * 100)}%` }]} />
          <BarWave on={t.state === 'running'} />
        </View>
        <Text style={[styles.rowSub, t.state === 'failed' && { color: colors.error }]} numberOfLines={2}>
          {statusOf(t)}
        </Text>
      </View>
      <Pressable onPress={toggle} hitSlop={10} style={styles.action}>
        <SymbolView
          name={t.state === 'running' || t.state === 'queued' ? 'pause.circle' : t.state === 'failed' ? 'arrow.clockwise.circle' : 'play.circle'}
          size={28}
          tintColor={colors.onBg}
        />
      </Pressable>
      <Pressable onPress={() => confirmRemove(t)} hitSlop={10} style={styles.action}>
        <SymbolView name="xmark.circle" size={24} tintColor={colors.faint} />
      </Pressable>
    </Pressable>
  );
});

// memo: готовые карточки не меняются от тика скорости идущих загрузок.
const ReadyGroup = memo(function ReadyGroup({ list }: { list: DlTask[] }) {
  const first = list[0];
  const series = first.item.type === 'tv';
  const sorted = [...list].sort((a, b) => ((a.season ?? 0) - (b.season ?? 0)) * 10000 + ((a.episode ?? 0) - (b.episode ?? 0)));
  const size = list.reduce((n, x) => n + (x.bytes || 0), 0);
  const menu = (t: DlTask) => {
    // Порядок пунктов строится списком действий — номера кнопок не надо считать руками.
    const many = series && list.length > 1;
    const acts: { text: string; run: () => void; danger?: boolean }[] = [
      { text: 'Смотреть', run: () => play(t) },
      // Отсюда же — на страницу тайтла (раньше из загрузок туда было не попасть).
      { text: series ? 'Открыть страницу сериала' : 'Открыть страницу фильма', run: () => openTitle(asMedia(t.item)) },
      { text: many ? 'Удалить серию' : 'Удалить', run: () => confirmRemove(t), danger: true },
      ...(many ? [{ text: 'Удалить все серии', run: () => confirmRemove(t, list), danger: true }] : []),
    ];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        userInterfaceStyle: 'dark',
        title: `${t.item.title}${t.label ? ` · ${t.label}` : ''}`,
        options: [...acts.map((a) => a.text), 'Отмена'],
        destructiveButtonIndex: acts.map((a, i) => (a.danger ? i : -1)).filter((i) => i >= 0),
        cancelButtonIndex: acts.length,
      },
      (i) => acts[i]?.run(),
    );
  };
  return (
    <View style={styles.group}>
      <Pressable
        onPress={() => (series ? undefined : play(first))}
        onLongPress={() => menu(first)}
        style={({ pressed }) => [styles.row, pressed && !series && { opacity: 0.7 }]}
      >
        <Thumb item={first.item} />
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle} numberOfLines={2}>
            {first.item.title}
          </Text>
          <Text style={styles.rowSub}>
            {series ? `${list.length} ${plural(list.length, 'серия', 'серии', 'серий')} · ` : ''}
            {fmtSize(size)}
            {list.every((x) => x.playlist === 'video.mp4') ? ' · можно смотреть без интернета' : ''}
          </Text>

        </View>
        {!series ? (
          <Pressable onPress={() => play(first)} hitSlop={10} style={styles.action}>
            <SymbolView name="play.circle.fill" size={30} tintColor={colors.focusFill} />
          </Pressable>
        ) : null}
        <Pressable onPress={() => menu(first)} hitSlop={10} style={styles.action}>
          <SymbolView name="ellipsis.circle" size={24} tintColor={colors.faint} />
        </Pressable>
      </Pressable>
      {series
        ? sorted.map((t) => (
            // Серия — с той же кнопкой «смотреть», что у фильма, и своим крестиком: удалить именно её.
            <Pressable key={t.id} onPress={() => play(t)} onLongPress={() => menu(t)} style={({ pressed }) => [styles.ep, pressed && { opacity: 0.6 }]}>
              <Text style={styles.epText}>{t.label}</Text>
              <Text style={styles.epSize}>{fmtSize(t.bytes)}</Text>
              <Pressable onPress={() => play(t)} hitSlop={8} style={styles.action}>
                <SymbolView name="play.circle.fill" size={30} tintColor={colors.focusFill} />
              </Pressable>
              <Pressable onPress={() => confirmRemove(t)} hitSlop={8} style={styles.action}>
                <SymbolView name="xmark.circle" size={24} tintColor={colors.faint} />
              </Pressable>
            </Pressable>
          ))
        : null}
    </View>
  );
});

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 12, gap: 6 },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title: { ...typo.pageTitle, color: colors.onBg, flex: 1 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  pillText: { ...typo.labelMedium, color: colors.onBg },
  section: { ...typo.titleMedium, color: colors.mutedWarm, marginTop: 14, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  thumb: { width: 52, height: 78, borderRadius: 0, overflow: 'hidden', backgroundColor: colors.surfaceHi },
  rowTitle: { ...typo.titleMedium, color: colors.onBg },
  rowLabel: { ...typo.labelMedium, color: colors.onBg, marginTop: 2 },
  rowSub: { ...typo.labelMedium, color: colors.mutedWarm, marginTop: 4 },
  bar: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.14)', marginTop: 8, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: colors.focusFill },
  // Во всю ширину шкалы: видимую долю задаёт сдвиг (см. BarWave), а не ширина.
  wave: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.75)' },
  barFail: { backgroundColor: colors.error },
  action: { width: 34, alignItems: 'center' },
  group: { marginBottom: 6 },
  ep: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6, paddingLeft: 64, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.stroke },
  epText: { ...typo.bodyMedium, color: colors.onBg, flex: 1 },
  epSize: { ...typo.labelMedium, color: colors.faint },
  storage: { ...typo.labelMedium, color: colors.muted, marginTop: 18, textAlign: 'center' },
  empty: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 30, gap: 10 },
  emptyTitle: { ...typo.titleMedium, color: colors.onBg },
  emptyText: { ...typo.bodyMedium, color: colors.muted, textAlign: 'center', lineHeight: 21 },
});
