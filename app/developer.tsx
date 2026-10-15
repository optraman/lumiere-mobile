import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import Reanimated, { FadeIn } from 'react-native-reanimated';
import { SymbolView } from 'expo-symbols';
import { TopGlow } from '../src/components/TopGlow';
import { ZoomPage, useZoomClose } from '../src/nav/ZoomPage';
import { diagnose } from '../src/api/sources/playback';
import { verdict, type SourceCheck, type TitleCheck } from '../src/api/sources/check';
import type { Step } from '../src/api/sources/http';
import { clearJournal, useJournal } from '../src/data/journal';
import { setDevPrefs, useDevPrefs } from '../src/data/devPrefs';
import type { MediaItem } from '../src/types/media';
import { colors } from '../src/theme/colors';
import { type as typo } from '../src/theme/fonts';
import { usePortraitInsets } from '../src/nav/portrait';
import { GlassBack, BACK_GAP } from '../src/components/GlassBack';

/**
 * ДЛЯ РАЗРАБОТЧИКОВ — отдельная страница из настроек (решение Марка): проверка источников, журнал
 * выбора и переключатель «Показывать источник в плеере». Человеку, который просто смотрит кино,
 * это не нужно, поэтому в основных настройках остался только вход сюда.
 */

/**
 * НА ЧЁМ ПРОВЕРЯЕМ: один длинный сериал и один старый фильм.
 *
 * Сериал — потому что у части источников есть только сериалы и наоборот; фильм — по той же причине.
 * Оба широко известны: если источник не знает «Теорию большого взрыва» и «Матрицу», он не знает
 * ничего, и это честный ответ о его состоянии.
 */
const PROBES: MediaItem[] = [
  {
    id: 1418, type: 'tv', title: 'Теория большого взрыва', originalTitle: 'The Big Bang Theory', overview: '',
    posterUrl: null, backdropUrl: null, year: '2007', rating: 0, releaseDate: null, originalLanguage: 'en', genreIds: [], voteCount: 0,
  },
  {
    id: 603, type: 'movie', title: 'Матрица', originalTitle: 'The Matrix', overview: '',
    posterUrl: null, backdropUrl: null, year: '1999', rating: 0, releaseDate: null, originalLanguage: 'en', genreIds: [], voteCount: 0,
  },
];

type Line = { name: string; serial: SourceCheck | null; movie: SourceCheck | null };
type Report = { lines: Line[]; kp: string; details: string };

const stepText = (x: Step) => `   ${x.at} → ${x.status} · ${x.ms} мс${x.hint ? ` · ${x.hint}` : ''}`;

/** Подробный разбор — все запросы по каждому источнику. Его можно выделить и скопировать. */
function detailsOf(name: string, c: (TitleCheck & { imdb: string | null }) | null): string {
  if (!c) return `${name}: проверка сорвалась`;
  const out = [`■ ${name} · imdb ${c.imdb ?? '—'} · КП ${c.kp ?? '—'}`];
  c.kpSteps.forEach((x) => out.push(`  КП${stepText(x)}`));
  for (const r of c.sources) {
    out.push(`  ${r.name}: ${verdict(r)}`);
    r.steps.forEach((x) => out.push(stepText(x)));
    r.linkSteps?.forEach((x) => out.push(`  ссылка${stepText(x)}`));
    r.stream?.steps.forEach((x) => out.push(`  поток${stepText(x)}`));
  }
  return out.join('\n');
}

export default function DeveloperScreen() {
  return (
    <ZoomPage>
      <DeveloperBody />
    </ZoomPage>
  );
}

function DeveloperBody() {
  const close = useZoomClose();
  const insets = usePortraitInsets();
  const dev = useDevPrefs();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  // Тело — чуть позже шапки: страница разворачивается лёгкой (как настройки).
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 120);
    return () => clearTimeout(t);
  }, []);

  /*
    ПРОВЕРКА ВСЕХ ИСТОЧНИКОВ СРАЗУ.

    Тот же каскад, что и при просмотре, только вместо «первого ответившего» показывается ответ
    каждого: кто нашёл, кто промолчал и за сколько. Это единственный способ узнать, что работает
    именно с этого телефона и из этой страны, — облако и компьютер видят сеть иначе.
  */
  const probe = async () => {
    if (busy) return;
    setBusy(true);
    setReport(null);
    setFailed(false);
    try {
      const [serial, movie] = await Promise.all([
        diagnose(PROBES[0], { season: 1, episode: 1 }).catch(() => null),
        diagnose(PROBES[1], null).catch(() => null),
      ]);
      if (!serial && !movie) throw new Error('сорвалось');
      const names = new Map<string, Line>();
      for (const r of serial?.sources ?? []) names.set(r.id, { name: r.name, serial: r, movie: null });
      for (const r of movie?.sources ?? []) {
        const l = names.get(r.id) ?? { name: r.name, serial: null, movie: null };
        l.movie = r;
        names.set(r.id, l);
      }
      const kp = (c: typeof serial) => (c ? (c.kp ? `найден (${c.kp})` : 'не найден') : 'сорвалось');
      setReport({
        lines: [...names.values()],
        kp: `Номер Кинопоиска: сериал — ${kp(serial)}, фильм — ${kp(movie)}`,
        details: [detailsOf(PROBES[0].title, serial), detailsOf(PROBES[1].title, movie)].join('\n\n'),
      });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <TopGlow />
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <GlassBack onPress={close} />
        <Text style={styles.headTitle}>Для разработчиков</Text>
      </View>

      {ready ? (
      <Reanimated.View entering={FadeIn.duration(140)} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 120 }]} showsVerticalScrollIndicator={false}>
        {/* Подпись источника в плеере («· Collaps») — по умолчанию выключена. */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Плеер</Text>
          <View style={[styles.card, styles.switchRow]}>
            <Text style={styles.switchText}>Показывать источник в плеере</Text>
            <Switch
              value={dev.showSource}
              onValueChange={(v) => setDevPrefs({ showSource: v })}
              trackColor={{ true: colors.focusFill, false: colors.stroke }}
              thumbColor="#FFFFFF"
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Источники</Text>
          <Text style={styles.sectionHint}>
            Все источники опрашиваются разом; играет первый, у кого есть оригинал, 1080p и несколько
            озвучек. Проверка проходит каждый до первого куска видео — так видно, где рвётся.
          </Text>
          <View style={styles.card}>
            <Pressable
              onPress={probe}
              style={({ pressed }) => [styles.probe, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.probeText}>{busy ? 'Проверяем… до полуминуты' : 'Проверить источники'}</Text>
            </Pressable>
            {failed ? <Text style={styles.note}>Проверка сорвалась — нет связи?</Text> : null}
            {report ? (
              <View style={styles.table}>
                <Text style={styles.note}>{report.kp}</Text>
                {/*
                  Каждый источник проходится до первого куска видео, как его пройдёт плеер. «Нашёл»
                  без «работает» — значит, цепочка рвётся дальше: на ссылке или на потоке.
                */}
                {report.lines.map((l) => (
                  <View key={l.name} style={styles.srcRow}>
                    <Text style={[styles.td, styles.tdName, styles.cell]}>{l.name}</Text>
                    {(['serial', 'movie'] as const).map((k) => {
                      const c = l[k];
                      const text = c ? verdict(c) : '—';
                      return (
                        <Text key={k} style={[styles.td, styles.cell, text.startsWith('работает') && styles.ok]} selectable>
                          {k === 'serial' ? 'Сериал: ' : 'Фильм: '}
                          {text}
                        </Text>
                      );
                    })}
                  </View>
                ))}
                <Pressable onPress={() => setMore((v) => !v)} style={({ pressed }) => [styles.probe, pressed && { opacity: 0.6 }]}>
                  <Text style={styles.probeText}>{more ? 'Скрыть подробности' : 'Все запросы подробно'}</Text>
                </Pressable>
                {more ? (
                  <Text style={styles.mono} selectable>
                    {report.details}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>

        {/*
          ЖУРНАЛ ВЫБОРА — что происходило при последних запусках видео: кто ответил, кто выбран,
          чья ссылка не открылась и с какой ошибкой плеер перешёл к следующему источнику.
        */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Журнал выбора</Text>
          <Text style={styles.sectionHint}>
            Последние запуски видео: кто из источников ответил, кто выбран и почему плеер переходил к запасным.
          </Text>
          <View style={styles.card}>
            <JournalCard />
          </View>
        </View>

      </ScrollView>
      </Reanimated.View>
      ) : null}
    </View>
  );
}

function JournalCard() {
  const journal = useJournal();
  if (journal.length === 0) return <Text style={styles.note}>Пока пусто — включите что-нибудь и вернитесь сюда.</Text>;
  return (
    <>
      <Text style={styles.mono} selectable>
        {journal.slice(-30).join('\n')}
      </Text>
      <Pressable onPress={clearJournal} style={({ pressed }) => [styles.probe, pressed && { opacity: 0.6 }]}>
        <Text style={styles.probeText}>Очистить журнал</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  switchText: { ...typo.bodyLarge, color: colors.onBg, flex: 1 },
  screen: { flex: 1, backgroundColor: colors.bg },
  // Заголовок — на BACK_GAP от стеклянной стрелки, а не впритык к ней.
  header: { flexDirection: 'row', alignItems: 'center', gap: BACK_GAP, paddingHorizontal: 14, paddingBottom: 12 },
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
