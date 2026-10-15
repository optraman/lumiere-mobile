import { useEffect, useRef, useState } from 'react';
import { go } from '../src/nav/navGuard';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TopGlow } from '../src/components/TopGlow';
import Reanimated, { FadeIn } from 'react-native-reanimated';
import { SymbolView } from 'expo-symbols';
import { ZoomPage, useZoomClose } from '../src/nav/ZoomPage';
import { askClearHistory } from '../src/data/clearHistory';
import { SubtitlePreview } from '../src/components/SubtitlePreview';
import {
  BACKGROUND_LABELS,
  FONT_LABELS,
  POSITION_LABELS,
  SIZE_LABELS,
  setSubtitlePrefs,
  useSubtitlePrefs,
} from '../src/data/subtitlePrefs';
import { colors } from '../src/theme/colors';
import { type as typo } from '../src/theme/fonts';
import { usePortraitInsets } from '../src/nav/portrait';
import { router } from 'expo-router';
import { useDownloads } from '../src/downloads/store';
import { fmtSize, freeSpace, parallelDownloads, setParallelDownloads } from '../src/downloads/engine';

/**
 * НАСТРОЙКИ.
 *
 * Их почти не осталось, и это не упущение, а следствие смены источника. Раньше здесь жили логин,
 * пароль, зеркало, качество по умолчанию и кнопка «обновить сессию» — всё это были рычаги, чтобы
 * уговорить резку отдать файл. Collaps не спрашивает ни того, ни другого: тайтл открывается по
 * номеру IMDB, качество выбирает сам плеер из плейлиста, сессии нет вовсе.
 *
 * Проверка источников и журнал выбора переехали на страницу «Для разработчиков» (app/developer.tsx):
 * человеку, который просто смотрит кино, они не нужны.
 */

/**
 * НАСТРОЙКИ — больше не вкладка: шестерёнка справа от «ЛЮМЬЕР» на Главной, Фильмах и Сериалах
 * открывает их отдельной страницей (тем же разворотом, что и списки с главной). Логотипа здесь
 * нет — он живёт только в шапке лент.
 */
export default function SettingsScreen() {
  return (
    <ZoomPage>
      <SettingsBody />
    </ZoomPage>
  );
}

function SettingsBody() {
  const close = useZoomClose();
  const insets = usePortraitInsets();

  const [parallel, setParallel] = useState(parallelDownloads());
  const scrollRef = useRef<ScrollView>(null);
  /*
    ТЕЛО НАСТРОЕК — ЧУТЬ ПОЗЖЕ ШАПКИ. Страница открывается разворотом за 170 мс; раньше в эти же
    миллисекунды собиралось всё её тело (источники, загрузки, журнал), и анимация не успевала
    показать ни кадра — страница «открывалась без анимации», да ещё с задержкой. Теперь сперва
    разворачивается лёгкая страница с заголовком, а тело проявляется следом.
  */
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 120);
    return () => clearTimeout(t);
  }, []);
  const [cleared, setCleared] = useState(false);
  const subs = useSubtitlePrefs();

  /*
    ОКНО ПРЕДПРОСМОТРА СУБТИТРОВ АНИМИРУЕТСЯ, ТОЛЬКО КОГДА ОНО РЯДОМ С ЭКРАНОМ. Его часы шли каждый
    кадр, даже если раздел «Субтитры» давно уехал за край. Запас — целый экран сверху и снизу:
    часы запускаются задолго до того, как окно покажется, и знак встаёт на своё место (время в окне
    абсолютное) ещё за кадром — глаз никакой паузы не застаёт.
  */
  const [previewNear, setPreviewNear] = useState(true);
  const subsBox = useRef({ y: 0, h: 0 });
  const scrollBox = useRef({ y: 0, h: 0 });
  const checkPreview = () => {
    const { y, h } = subsBox.current;
    const v = scrollBox.current;
    if (h === 0 || v.h === 0) return;
    const near = y + h > v.y - v.h && y < v.y + v.h * 2;
    setPreviewNear((prev) => (prev === near ? prev : near));
  };

  /*
    ОЧИСТКА ИСТОРИИ — С ВОПРОСОМ.

    Это необратимо: пропадут места, где остановился в каждом фильме и сериале, и ряд «Продолжить
    просмотр». Одно случайное касание не должно этого делать, поэтому сначала системный вопрос,
    и кнопка в нём красная — так система сама помечает действия, которые нельзя отменить.
  */
  const askClear = () => askClearHistory(() => setCleared(true));

  return (
    <View style={styles.screen}>
      <TopGlow />
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={close} hitSlop={12} style={styles.back}>
          <SymbolView name="chevron.backward" size={20} tintColor={colors.onBg} />
        </Pressable>
        <Text style={styles.headTitle}>Настройки</Text>
      </View>

      {ready ? (
      <Reanimated.View entering={FadeIn.duration(140)} style={{ flex: 1 }}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 120 }]}
        showsVerticalScrollIndicator={false}
        // Положение прокрутки — только чтобы решить, крутить ли окно предпросмотра (см. previewNear).
        scrollEventThrottle={50}
        onScroll={(e) => {
          scrollBox.current.y = e.nativeEvent.contentOffset.y;
          checkPreview();
        }}
        onLayout={(e) => {
          scrollBox.current.h = e.nativeEvent.layout.height;
          checkPreview();
        }}
      >
        {/*
          СУБТИТРЫ — как у Влада: живое окно предпросмотра и четыре ряда выбора под ним. Любое
          касание выбора сразу видно в окне и сразу применяется в плеере — без кнопки «сохранить».
        */}
        <View
          style={styles.section}
          onLayout={(e) => {
            subsBox.current = { y: e.nativeEvent.layout.y, h: e.nativeEvent.layout.height };
            checkPreview();
          }}
        >
          <Text style={styles.sectionTitle}>Субтитры</Text>
          <Text style={styles.sectionHint}>Размер, оттенение, положение и шрифт.</Text>
          <View style={styles.card}>
            <SubtitlePreview prefs={subs} active={previewNear} />
            <OptionRow labels={SIZE_LABELS} value={subs.size} onPick={(v) => setSubtitlePrefs({ size: v })} />
            <OptionRow labels={BACKGROUND_LABELS} value={subs.background} onPick={(v) => setSubtitlePrefs({ background: v })} />
            <OptionRow labels={POSITION_LABELS} value={subs.position} onPick={(v) => setSubtitlePrefs({ position: v })} />
            <OptionRow labels={FONT_LABELS} value={subs.font} onPick={(v) => setSubtitlePrefs({ font: v })} />
          </View>
        </View>

        {/*
          ЗАГРУЗКИ — как раздел «Загрузки» в настройках планшетного Люмьера: сколько качать
          одновременно и сколько это занимает.
        */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Загрузки</Text>
          <Text style={styles.sectionHint}>
            Скачанные фильмы и серии хранятся в памяти телефона и открываются без интернета. Качается, пока
            приложение открыто.
          </Text>
          <View style={styles.card}>
            <Text style={styles.note}>Скачивать одновременно</Text>
            <OptionRow
              labels={['1', '2', '3']}
              value={parallel - 1}
              onPick={(v) => {
                setParallelDownloads(v + 1);
                setParallel(v + 1);
              }}
            />
            <StorageNote />
            <Pressable onPress={() => go('/downloads')} style={({ pressed }) => [styles.probe, pressed && { opacity: 0.6 }]}>
              <Text style={styles.probeText}>Открыть загрузки</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>История просмотра</Text>
          <Text style={styles.sectionHint}>
            Где остановился в каждом фильме и сериале. Отсюда же берётся, с какой серии открывать
            список и откуда продолжать.
          </Text>
          <View style={styles.card}>
            <Pressable onPress={askClear} style={({ pressed }) => [styles.probe, pressed && { opacity: 0.6 }]}>
              <Text style={[styles.probeText, styles.danger]}>Очистить историю просмотра</Text>
            </Pressable>
            {cleared ? <Text style={styles.note}>История очищена.</Text> : null}
          </View>
        </View>

        {/* Проверка источников, журнал выбора и подпись источника в плеере — отдельной страницей. */}
        <View style={styles.section}>
          <Pressable onPress={() => go('/developer')} style={({ pressed }) => [styles.card, styles.devRow, pressed && { opacity: 0.6 }]}>
            <Text style={styles.devText}>Для разработчиков</Text>
            <SymbolView name="chevron.right" size={14} tintColor={colors.faint} />
          </Pressable>
        </View>
      </ScrollView>
      </Reanimated.View>
      ) : null}
    </View>
  );
}

/** Ряд вариантов — те же «чипы», что у Влада: выбранный залит, остальные контуром. */
/*
  ЖУРНАЛ И МЕСТО НА ДИСКЕ — СВОИМИ КУСОЧКАМИ. Журнал пополняется на каждом шаге поиска источника
  (а поиск идёт в фоне почти всегда), загрузки шлют прогресс трижды в секунду — и раньше от
  каждого такого события перерисовывались ВСЕ настройки, в том числе в момент открытия. Теперь
  перерисовывается только строка, которой это касается. Свободное место спрашивается у системы
  один раз, а не на каждую перерисовку.
*/
function StorageNote() {
  const dlTasks = useDownloads();
  const [free] = useState(() => freeSpace());
  return (
    <Text style={styles.note}>
      Загрузки занимают {fmtSize(dlTasks.reduce((n, t) => n + (t.bytes || 0), 0))}
      {free >= 0 ? ` · свободно ${fmtSize(free)}` : ''}
    </Text>
  );
}

function OptionRow({ labels, value, onPick }: { labels: string[]; value: number; onPick: (v: number) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.options}>
      {labels.map((l, i) => (
        <Pressable
          key={l}
          onPress={() => onPick(i)}
          style={({ pressed }) => [styles.option, i === value && styles.optionOn, pressed && { opacity: 0.7 }]}
        >
          <Text style={[styles.optionText, i === value && styles.optionTextOn]}>{l}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  devRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  devText: { ...typo.bodyLarge, color: colors.onBg },
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingBottom: 12 },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headTitle: { ...typo.pageTitle, color: colors.onBg, flex: 1 },
  body: { paddingHorizontal: 20, paddingTop: 8 },
  section: { marginBottom: 28 },
  sectionTitle: { ...typo.titleLarge, color: colors.onBg, marginBottom: 6 },
  sectionHint: { ...typo.bodyMedium, color: colors.faint, marginBottom: 12, lineHeight: 18 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  probe: { paddingVertical: 10, alignItems: 'center' },
  probeText: { ...typo.bodyLarge, color: colors.accent },
  note: { ...typo.bodyMedium, color: colors.faint, marginTop: 10, lineHeight: 18 },
  table: { marginTop: 12, gap: 6 },
  td: { ...typo.labelMedium, color: colors.faint, flex: 1 },
  tdName: { color: colors.onBg, flex: 1.2 },
  srcRow: { gap: 2, paddingVertical: 4 },
  cell: { flex: 0 },
  mono: { fontFamily: 'Menlo', fontSize: 10.5, lineHeight: 15, color: colors.faint, marginTop: 8 },
  ok: { color: colors.focusFill },
  danger: { color: colors.error },
  options: { gap: 8, paddingTop: 12 },
  option: {
    paddingHorizontal: 14,
    height: 34,
    borderRadius: 17,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.stroke,
  },
  optionOn: { backgroundColor: colors.focusFill, borderColor: colors.focusFill },
  optionText: { ...typo.labelMedium, color: colors.onBg },
  optionTextOn: { color: '#000000' },
});
