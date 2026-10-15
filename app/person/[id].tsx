import { useCallback, useEffect, useMemo, useState } from 'react';
import { TitleMenuHost } from '../../src/components/TitleMenu';
import { useOwnBack } from '../../src/nav/useOwnBack';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Animated, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { MaterialIcons } from '@expo/vector-icons';
import { TmdbApi, TmdbImages } from '../../src/api/tmdb';
import { mapItems } from '../../src/api/mapper';
import type { MediaItem } from '../../src/types/media';
import { PosterCard } from '../../src/components/PosterCard';
import { FadeInImage } from '../../src/components/FadeInImage';
import { ScreenBackdrop } from '../../src/components/ScreenBackdrop';
import { useScreenZoom } from '../../src/nav/useScreenZoom';
import { useZoomBack } from '../../src/nav/zoomBack';
import { colors } from '../../src/theme/colors';
import { font, type as typo } from '../../src/theme/fonts';
import { LinearGradient } from 'expo-linear-gradient';
import { usePortraitInsets } from '../../src/nav/portrait';

/**
 * Страница человека: кто это и в чём участвовал. Открывается по нажатию на режиссёра или актёра, а
 * любая работа отсюда открывается обычной страницей фильма — по людям можно ходить сколько угодно
 * вглубь.
 *
 * Список — FlatList, а не сетка внутри ScrollView. Раньше все работы (до тридцати постеров)
 * создавались за один кадр, и от этого дёргалось и открытие, и особенно закрытие экрана: система
 * пыталась анимировать уход экрана, одновременно удерживая три десятка картинок.
 */
export default function PersonScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const insets = usePortraitInsets();

  const [person, setPerson] = useState<{
    name: string;
    bio: string;
    photo: string | null;
    role: string;
  } | null>(null);
  /**
   * Работы РАЗБИТЫ ПО ТОМУ, КЕМ человек в них был.
   *
   * Одним списком это враньё: у Иствуда «Гран Торино» стоит рядом с «Мостами округов Мэдисон», и
   * по сетке постеров невозможно понять, где он играл, а где снимал. Тем более у людей, которые
   * почти не снимаются: страница сценариста, собранная из ролей второго плана, показывает кого
   * угодно, кроме сценариста.
   *
   * Один и тот же фильм может стоять в НЕСКОЛЬКИХ разделах — это не дубликат, а ровно то, что
   * разделы и показывают: человек был в нём и тем, и другим.
   */
  const [groups, setGroups] = useState<Group[]>([]);
  /** Развёрнутые разделы. Свёрнутый показывает две строки и верхнюю треть третьей. */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  /* Снятия списка перед уходом больше нет — по той же причине, что и на странице фильма:
     перерисовка в момент нажатия шла поверх собственной анимации и не давала ей доиграть. Сетка и
     так виртуализована. */
  const goBack = useOwnBack();
  const zoom = useScreenZoom(goBack);
  const startClose = useCallback((v = 0) => zoom.close(v), [zoom]);

  /**
   * Жест «назад» от левого края. Системный свайп здесь не работает: экран показан как всплывающий
   * с выключенной системной анимацией, и возвратом управляет наша. Поэтому жест свой, и он тянет ту
   * же величину — страница уменьшается и гаснет прямо под пальцем.
   *
   * activeOffsetX слева −1000: жест берёт только движение ВПРАВО, иначе он перехватывал бы
   * горизонтальные списки внутри страницы.
   */
  /*
    ЖЕСТ РАБОТАЕТ В JS-ПОТОКЕ, И ЭТО НАМЕРЕННО.

    По умолчанию обработчики жеста — ворклеты: они выполняются в потоке отрисовки, а всё, к чему
    прикасаются, должно уметь туда скопироваться. Наши анимации на этой странице построены на
    Animated из React Native, и Animated.Value скопировать туда нельзя — отсюда и «Cannot copy
    value of type AnimatedValue» после обновления: раньше обёртка runOnJS брала функцию по ссылке,
    теперь она копирует и всё её замыкание, а в замыкании как раз лежит эта величина.

    Выход не в том, чтобы переписать страницу на общие величины reanimated — она и не нуждается в
    потоке отрисовки, вся её анимация и так идёт нативным драйвером. Достаточно сказать жесту, где
    ему работать: runOnJS(true) — и обработчики становятся обычными функциями, а обёртки не нужны
    вовсе.
  */
  const back = useZoomBack({
    setProgress: zoom.setProgress,
    settleOpen: zoom.settleOpen,
    close: startClose,
  });
  useEffect(() => {
    let cancelled = false;
    TmdbApi.person(Number(id))
      .then((p) => {
        if (cancelled) return;
        setPerson({
          name: p.name,
          bio: p.biography?.trim() ?? '',
          photo: TmdbImages.profile(p.profile_path),
          // TMDB помнит пол (1 — женский): актрису подписываем актрисой. Остальные должности — как есть.
          role:
            p.known_for_department === 'Acting' && (p as { gender?: number }).gender === 1
              ? 'Актриса'
              : RU_DEPT[p.known_for_department ?? ''] ?? p.known_for_department ?? '',
        });

        const cast = p.combined_credits?.cast ?? [];
        const crew = p.combined_credits?.crew ?? [];
        const withJob = (jobs: string[]) => crew.filter((c) => jobs.includes(c.job ?? ''));

        const built = SECTIONS.map((sec) => ({
          key: sec.key,
          title: sec.title,
          items: prepare(sec.key === 'acting' ? cast : withJob(sec.jobs)),
        })).filter((g) => g.items.length > 0);

        /*
          Раздел по ОСНОВНОМУ занятию человека поднимается наверх. Порядок разделов в остальном
          постоянный, но у актёра первыми должны идти роли, а у режиссёра — постановки: TMDB сам
          говорит, чем человек известен, и спорить с этим значит открывать страницу не с того, за
          чем на неё пришли.
        */
        const lead = LEAD_SECTION[p.known_for_department ?? ''] ?? '';
        built.sort((a, b) => Number(b.key === lead) - Number(a.key === lead));
        setGroups(built);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [id]);

  /**
   * Разделы разложены в ПЛОСКИЙ список строк: заголовок, строка из трёх постеров, строка, заголовок…
   *
   * Так сделано потому, что numColumns у FlatList и заголовки разделов несовместимы: сетка ставит
   * подряд всё, что ей дали, и заголовок занял бы одну ячейку из трёх. SectionList же колонок не
   * умеет вовсе. Собирая строки самостоятельно, мы сохраняем и то, и другое — и виртуализацию,
   * которая на этом экране обязательна (постеров бывает под сотню).
   */
  // Строки собираются только при смене разделов или раскрытия (useMemo): иначе каждая перерисовка
  // страницы (например, смена interactive при закрытии) давала FlatList новый data и новые срезы.
  const rows = useMemo(() => {
  const rows: Row[] = [];
  /*
    РАЗДЕЛ СВЁРНУТ ДО ДВУХ СТРОК (просьба Марка): видны две строки постеров и верхняя треть
    третьей — она тает книзу, а под ней «Показать все». Так видно, что фильмов больше, и раздел
    не растягивает страницу на десятки строк. Развёрнутый раздел можно свернуть обратно.
  */
  for (const g of groups) {
    rows.push({ kind: 'title', key: `t-${g.key}`, text: g.title });
    const full = open.has(g.key);
    const fold = !full && g.items.length > COLS * 2;
    const until = fold ? COLS * 2 : g.items.length;
    for (let i = 0; i < until; i += COLS) {
      rows.push({ kind: 'row', key: `r-${g.key}-${i}`, items: g.items.slice(i, i + COLS) });
    }
    if (fold) rows.push({ kind: 'peek', key: `p-${g.key}`, group: g.key, count: g.items.length, items: g.items.slice(COLS * 2, COLS * 3) });
    else if (full && g.items.length > COLS * 2) rows.push({ kind: 'less', key: `l-${g.key}`, group: g.key });
  }
  return rows;
  }, [groups, open]);
  const toggle = (k: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    /*
      КАСАНИЯ ОТПУСКАЕТ САМЫЙ ВЕРХНИЙ ВИД, и только так это работает.

      Пометки на внутренней странице было мало: обычный View перехватывает касание сам по себе, без
      всяких обработчиков, — попадание в него просто не доходит до того, что лежит ниже, а ниже
      здесь целый экран под всплывающей страницей. Пока корень оставался «живым», главная не
      получала ни нажатий, ни прокрутки, сколько бы мы ни гасили детей.
    */
    <View style={styles.root} pointerEvents={zoom.interactive ? 'auto' : 'none'}>
      <ScreenBackdrop style={zoom.backdropStyle} />
      <GestureDetector gesture={back}>
        {/* Уходящая страница отпускает касания сразу, не дожидаясь конца анимации. */}
        <Animated.View style={[styles.screen, zoom.pageStyle]}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        showsVerticalScrollIndicator={false}
        // Держим на экране только видимое: за кадр создаётся три строки, а не тридцать карточек.
        initialNumToRender={4}
        maxToRenderPerBatch={4}
        windowSize={5}
        removeClippedSubviews
        contentContainerStyle={{
          // Шапки на экране нет, поэтому отступ нужен только под вырез — прежние +52 оставались от
          // времён, когда сверху была шапка со стрелкой.
          paddingTop: insets.top + 52,
          paddingBottom: 96,
          paddingHorizontal: 10,
        }}
        // Иначе iOS добавит свой отступ поверх нашего и содержимое уедет вниз.
        contentInsetAdjustmentBehavior="never"
        renderItem={({ item }) =>
          item.kind === 'title' ? (
            <Text style={styles.sectionTitle}>{item.text}</Text>
          ) : item.kind === 'peek' ? (
            <View>
              <View style={styles.peek} pointerEvents="none">
                <View style={styles.gridRow}>
                  {item.items.map((m) => (
                    <View key={`${m.type}-${m.id}`} style={styles.cell}>
                      <PosterCard item={m} width={100} style={styles.noMargin} />
                    </View>
                  ))}
                </View>
                <LinearGradient colors={['rgba(8,8,10,0)', colors.bg]} style={StyleSheet.absoluteFill} />
              </View>
              <Pressable onPress={() => toggle(item.group)} style={({ pressed }) => [styles.more, pressed && { opacity: 0.6 }]}>
                <Text style={styles.moreText}>Показать все · {item.count}</Text>
              </Pressable>
            </View>
          ) : item.kind === 'less' ? (
            <Pressable onPress={() => toggle(item.group)} style={({ pressed }) => [styles.more, pressed && { opacity: 0.6 }]}>
              <Text style={styles.moreText}>Свернуть</Text>
            </Pressable>
          ) : (
            <View style={styles.gridRow}>
              {item.items.map((m) => (
                <View key={`${m.type}-${m.id}`} style={styles.cell}>
                  <PosterCard item={m} width={100} style={styles.noMargin} />
                </View>
              ))}
            </View>
          )
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.photoBox}>
              {person?.photo ? (
                <FadeInImage source={{ uri: person.photo }} style={styles.photo} />
              ) : (
                <MaterialIcons name="person" size={44} color={colors.faint} />
              )}
            </View>
            <Text style={styles.name}>{person?.name ?? name ?? ''}</Text>
            {person?.role ? <Text style={styles.role}>{person.role}</Text> : null}

            {/* Биографии нет (просьба Марка): страница человека — это его фильмы, а не статья. */}

            {error && <Text style={styles.errorText}>{error}</Text>}
            {!person && !error && <ActivityIndicator color={colors.accent} style={{ marginTop: 24 }} />}

          </View>
        }
      />

        {/* Стрелка «назад» поверх содержимого: системной шапки на этом экране нет (иначе она даёт
            чёрную полосу), а возврат должен быть доступен и без жеста. */}
        <Pressable
          onPress={() => startClose()}
          style={[styles.back, { top: insets.top + 6 }]}
          hitSlop={10}
        >
          <View style={styles.backCircle}>
            <MaterialIcons name="arrow-back-ios-new" size={17} color={colors.onBg} />
          </View>
        </Pressable>
        </Animated.View>
      </GestureDetector>
      {/* Своё меню тайтла поверх страницы (корневое — под модальным окном, см. TitleMenu). */}
      <TitleMenuHost />
    </View>
  );
}

const COLS = 3;

type Group = { key: string; title: string; items: MediaItem[] };
type Row =
  | { kind: 'peek'; key: string; group: string; count: number; items: MediaItem[] }
  | { kind: 'less'; key: string; group: string }
  | { kind: 'title'; key: string; text: string }
  | { kind: 'row'; key: string; items: MediaItem[] };

/**
 * РАЗДЕЛЫ И ДОЛЖНОСТИ, КОТОРЫЕ В НИХ ПОПАДАЮТ.
 *
 * Должности перечислены поимённо, а не по отделу: в отделе Writing лежат ещё и «Story Editor», и
 * «Script Consultant», а в Production — вся администрация площадки вплоть до координаторов. Для
 * страницы человека важны те несколько должностей, по которым его знают; остальное дало бы список
 * из полутора сотен строк, где ни одна ничего не говорит.
 *
 * Порядок здесь — порядок разделов на экране (с поправкой на основное занятие, см. LEAD_SECTION).
 */
const SECTIONS: { key: string; title: string; jobs: string[] }[] = [
  { key: 'acting', title: 'Роли', jobs: [] },
  { key: 'directing', title: 'Режиссёр', jobs: ['Director'] },
  // «Creator» у TMDB — именно создатель сериала, тот, кто у Влада показан на странице сериала
  // вместо режиссёра.
  { key: 'creator', title: 'Создатель', jobs: ['Creator', 'Series Creator'] },
  {
    key: 'writing',
    title: 'Сценарист',
    jobs: ['Writer', 'Screenplay', 'Story', 'Teleplay', 'Author'],
  },
  { key: 'producing', title: 'Продюсер', jobs: ['Producer', 'Executive Producer'] },
];

/** Каким разделом открывается страница — по тому, чем человек известен. */
const LEAD_SECTION: Record<string, string> = {
  Acting: 'acting',
  Directing: 'directing',
  Writing: 'writing',
  Production: 'producing',
};

/** Общая подготовка любого раздела: только с постерами, по убыванию известности, без повторов. */
function prepare(credits: Parameters<typeof mapItems>[0]): MediaItem[] {
  const seen = new Set<string>();
  return mapItems(credits)
    .filter((m) => m.posterUrl !== null)
    .sort((a, b) => b.voteCount - a.voteCount)
    .filter((m) => {
      // Один и тот же фильм приходит дважды, если человек значится в нём двумя должностями одного
      // раздела — например, Writer и Screenplay.
      const key = `${m.type}-${m.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** TMDB отдаёт отдел по-английски даже при language=ru-RU. */
const RU_DEPT: Record<string, string> = {
  Acting: 'Актёр',
  Directing: 'Режиссёр',
  Writing: 'Сценарист',
  Production: 'Продюсер',
  Sound: 'Композитор',
  Camera: 'Оператор',
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 6 },
  photoBox: {
    width: 104,
    height: 104,
    borderRadius: 52,
    overflow: 'hidden',
    backgroundColor: colors.surfaceHi,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  photo: { width: '100%', height: '100%' },
  name: { ...typo.headlineLarge, color: colors.onBg, marginTop: 14, textAlign: 'center' },
  role: { ...typo.labelMedium, color: colors.mutedWarm, marginTop: 4, textAlign: 'center' },
  bioWrap: { marginTop: 18, paddingHorizontal: 8 },
  bio: { ...typo.bodyMedium, color: colors.muted, lineHeight: 21 },
  sectionTitle: { ...typo.headlineLarge, color: colors.onBg, marginTop: 26, marginBottom: 12, marginLeft: 6 },
  gridRow: { flexDirection: 'row' },
  // Постоянный объект вместо {{ marginRight: 0 }} в разметке: новый объект на каждую отрисовку
  // ломал memo у PosterCard, и все постеры перерисовывались вместе со строкой.
  noMargin: { marginRight: 0 },
  // Верхняя треть строки постеров (постер 100×150 — видно ~70 точек).
  peek: { height: 70, overflow: 'hidden' },
  more: { alignSelf: 'center', height: 36, paddingHorizontal: 18, borderRadius: 18, justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.09)', marginTop: 6, marginBottom: 4 },
  moreText: { fontFamily: font.bold, fontSize: 14, color: colors.onBg },
  // Ячейка ровно в треть строки — сетка держится на этом, а не на numColumns, которого здесь нет.
  cell: { width: '33.33%', alignItems: 'center', marginBottom: 16 },
  errorText: { ...typo.bodyMedium, color: colors.muted, textAlign: 'center', marginTop: 24 },
  back: { position: 'absolute', left: 14 },
  backCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(8,8,10,0.5)',
  },
});
