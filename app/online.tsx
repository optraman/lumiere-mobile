import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { markPush } from '../src/nav/navGuard';
import { go } from '../src/nav/navGuard';
import { useOwnBack } from '../src/nav/useOwnBack';
import {
  ActivityIndicator,
  Image,
  Alert,
  Animated,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { useAnimatedScrollHandler, useAnimatedStyle, useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { takeOnlineItem } from '../src/nav/openOnline';
import { movieRequest, episodeRequest, openFor, type ListSeason } from '../src/api/sources/playback';
import { setPendingPlayback, type PlaybackRequest } from '../src/player/request';
import { logoUrl, TmdbApi, TmdbImages } from '../src/api/tmdb';
import { SeasonChip, StillImage } from '../src/components/EpisodeMotion';
import { TitleMark } from '../src/components/TitleMark';
import { BusyOutline } from '../src/components/BusyOutline';
import { episodeKey, furthestEpisode, watchEntry } from '../src/data/watchProgress';
import { TopGlow } from '../src/components/TopGlow';
import { ScreenBackdrop } from '../src/components/ScreenBackdrop';
import { useScreenZoom } from '../src/nav/useScreenZoom';
import { useZoomBack } from '../src/nav/zoomBack';
import { colors } from '../src/theme/colors';
import { PAGE_RADIUS } from '../src/theme/radii';
import { font, type as typo } from '../src/theme/fonts';
import { device } from '../src/perf/device';
import { GlassSheet } from '../src/components/GlassSheet';
import type { MediaItem } from '../src/types/media';
import { usePortraitInsets, usePortraitWindow } from '../src/nav/portrait';
import { SymbolView } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { voicesFor } from '../src/api/sources/playback';
import { allDownloads, useDownloadFor, type DlTask } from '../src/downloads/store';
import { enqueueDownload, freeSpace, fmtSize } from '../src/downloads/engine';
import { voiceForAsync } from '../src/data/voicePrefs';
import { titleKey } from '../src/data/watchProgress';
import { useVoicePicker } from '../src/components/VoicePicker';

/**
 * «Смотреть».
 *
 * У Влада это два разных экрана: невидимый загрузчик для фильма (крутилка — и сразу плеер) и
 * «Смотреть онлайн» с сезонами и сериями для сериала. Здесь они сведены в один, но ведут себя
 * ровно так же.
 *
 * СПИСОК СЕРИЙ БЕРЁТСЯ ИЗ TMDB, а не со страницы резки — и это главное, что я в прошлый раз сделал
 * не так. У Влада резку вообще не спрашивают, пока человек выбирает: она знает про серии ровно
 * столько, сколько выложила, а TMDB знает их все, с названиями, кадрами и датами. Резку спрашивают
 * ПОТОМ и только про выбранную серию — и там уже работает лестница запасных озвучек.
 *
 * ПОИСК НАЧИНАЕТСЯ СРАЗУ, пока человек выбирает. Открыть этот экран значит «я собираюсь смотреть»,
 * и единственный оставшийся вопрос — какую серию. Поиск по резке — медленная половина запуска, и
 * она ничего не стоит, если идёт в те секунды, которые человек и так тратит на выбор.
 */

/** Сколько ждём резку, прежде чем признать, что она молчит. */

type TmdbEpisode = {
  episode_number: number;
  name?: string;
  still_path?: string | null;
  air_date?: string | null;
};

type State =
  | { kind: 'loading' }
  | { kind: 'resolving' }
  | { kind: 'series' }
  | { kind: 'error'; message: string; reason?: string };

export default function OnlineScreen() {
  const insets = usePortraitInsets();
  /*
    ЗАКРЫВАЕТСЯ ТЕМ ЖЕ ЖЕСТОМ, ЧТО СТРАНИЦА ФИЛЬМА И СТРАНИЦА АКТЁРА.

    Экран всплывает поверх страницы тайтла, и уходить должен так же, как она: потянул от левого
    края — страница уезжает вслед за пальцем, отпустил — либо закрылась, либо вернулась на место.
    Системного жеста здесь нет намеренно (в раскладке он выключен): системный либо тянет вбок
    целую карточку, либо смахивает вниз, а у нас под пальцем вертикальная прокрутка серий, и
    смахивание вниз ловило бы её каждый раз.
  */
  const goBack = useOwnBack();
  const zoom = useScreenZoom(goBack);
  const back = useZoomBack({
    setProgress: zoom.setProgress,
    settleOpen: zoom.settleOpen,
    close: zoom.close,
    // Пока страницу тянут — и сразу после — нажатия по сериям не засчитываются (см. steady).
    onMove: () => {
      scrolledAt.current = Date.now();
    },
  });
  const [{ item, episode: target }] = useState(takeOnlineItem);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [seasons, setSeasons] = useState<{ number: number; name: string }[]>([]);
  const [season, setSeason] = useState<number | null>(null);
  const [episodes, setEpisodes] = useState<TmdbEpisode[]>([]);
  /**
   * СЕЗОНЫ И СЕРИИ — СО СТРАНИЦЫ РЕЗКИ, а не из TMDB.
   *
   * Это было моей ошибкой: список я строил по TMDB, потому что там есть названия серий, кадры и
   * даты. Но играть-то мы просим у резки, и просим НОМЕРАМИ — а её номера живут в её же вкладках,
   * в разметке страницы сериала. У сериалов, где нумерация расходится (а расходится она постоянно:
   * сдвоенные серии, спецвыпуски, свой порядок у озвучки), мы просили несуществующее и получали
   * отказ.
   *
   * Теперь наоборот: список ведёт резка, а TMDB только украшает — подставляет название и кадр,
   * если номер совпал. Не совпал — покажем то, что написано у резки.
   */
  const [sourceSeasons, setSourceSeasons] = useState<ListSeason[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  /** Номер последнего нажатия на серию: ответ на прежнее нажатие плеер не открывает. */
  const tapTicket = useRef(0);
  /*
    ФАНТОМНЫЕ НАЖАТИЯ. Листая список, палец то и дело касался серии в момент, когда список ещё
    ехал (или останавливал его касанием), — и система засчитывала это как нажатие: открывалась
    серия, которую никто не выбирал. Теперь нажатие засчитывается, только если список стоял:
    последние 350 мс не прокручивался.
  */
  /*
    КОГДА НАЖАТИЕ — НАЖАТИЕ. Прежний флаг «что-то едет» снимался только концом инерции, а её у
    iOS бывает и не бывает: отпустил список ровно на месте — конца инерции не приходит, флаг висел,
    и серии переставали открываться вовсе. Теперь считаются ПАРЫ событий, которые приходят всегда:
    «палец лёг — палец отпустил» и «инерция началась — инерция кончилась». Нажатие засчитывается,
    когда ни одна пара не открыта и после последнего движения прошло 120 мс. На случай, если
    система всё-таки потеряет конец пары, счётчики сами обнуляются через полторы секунды тишины.
  */
  const motion = useRef({ drags: 0, glides: 0, quietAt: 0, lastAt: 0 }).current;
  const touch = () => {
    const now = Date.now();
    if (now - motion.lastAt > 1500) {
      motion.drags = 0;
      motion.glides = 0;
    }
    motion.lastAt = now;
  };
  const onDragStart = useCallback(() => {
    touch();
    motion.drags += 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onDragEnd = useCallback(() => {
    touch();
    motion.drags = Math.max(0, motion.drags - 1);
    motion.quietAt = Date.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onGlideStart = useCallback(() => {
    touch();
    motion.glides += 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onGlideEnd = useCallback(() => {
    touch();
    motion.glides = Math.max(0, motion.glides - 1);
    motion.quietAt = Date.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const steady = () => {
    if (Date.now() - motion.lastAt > 1500) {
      motion.drags = 0;
      motion.glides = 0;
    }
    return motion.drags === 0 && motion.glides === 0 && Date.now() - motion.quietAt > 120;
  };
  /** Жест «назад» от края тоже считается движением: отпущенная страница не открывает серию. */
  const scrolledAt = { set current(v: number) { motion.quietAt = v; } };

  /*
    СЕЗОНЫ ЛИСТАЮТСЯ ПАЛЬЦЕМ — как страницы. Страниц на руках всегда не больше трёх: текущая и
    соседние. Раньше пройденные страницы оставались жить («держи кадры»), и через пару сезонов на
    экране висели сотни строк с картинками — отсюда тормоза и нагрев. Кадры теперь держит сама
    рамка (StillImage помнит показанные), поэтому снятая страница возвращается без перезагрузки.

    Номер «ближней» страницы меняется, только когда листалка ОСТАНОВИЛАСЬ: пересобирать дерево
    посреди движения пальца и есть тот рывок, который был виден.
  */
  const pagerRef = useRef<ScrollView | null>(null);
  const { width: pageW } = usePortraitWindow();
  const [nearPage, setNearPage] = useState(0);
  const playRef = useRef<(s: number, e: number) => void>(() => undefined);
  const dlRef = useRef<(s: number, e: number) => void>(() => undefined);
  const onPlayRow = useCallback((s: number, e: number) => {
    if (steady()) playRef.current(s, e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onDownloadRow = useCallback((s: number, e: number) => {
    if (steady()) dlRef.current(s, e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** Где листалка сезонов сейчас — дробный номер страницы, прямо из потока отрисовки. */
  const pagePos = useSharedValue(0);
  const pagerScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      pagePos.value = e.contentOffset.x / Math.max(1, e.layoutMeasurement.width);
    },
  });
  /**
   * Начальное положение листалки — ОДИН РАЗ. Здесь стояло contentOffset, пересчитываемое из
   * выбранного сезона на каждой перерисовке, — а iOS применяет новое значение этого свойства
   * сразу. Любая перерисовка посреди свайпа отбрасывала листалку на прежний сезон: те самые
   * «прыжки» и «возврат к старому сезону без причины».
   */
  const startOffset = useRef<{ x: number; y: number } | null>(null);
  const [pagerReady, setPagerReady] = useState(false);
  const [seasonSheet, setSeasonSheet] = useState(false);

  /*
    СПИСОК ОТКРЫВАЕТСЯ НЕ НА ПЕРВОЙ СЕРИИ.

    Правило Влада (глава 10 схемы): начальный сезон и начальная позиция определяются САМОЙ ДАЛЬНЕЙ
    записью просмотра этого сериала — самой большой по номеру (S×E), а не самой свежей по времени.
    Пересмотр ранней серии не должен утаскивать страницу назад: человек, который вчера дошёл до
    восьмой, а сегодня переглянул вторую, всё ещё смотрит восьмую.

    Прокрутка к этой строке делается ИЗ ЕЁ СОБСТВЕННОГО onLayout — единственного момента, когда её
    высота уже известна. Любой расчёт по «строка примерно такой высоты» промахивается ровно на тех
    сериалах, где названия занимают две строки.
  */
  const landing = useRef(furthestEpisode(item?.type ?? 'tv', item?.id ?? 0));
  const listRef = useRef<ScrollView | null>(null);
  const landed = useRef(false);

  /**
   * ТАЙТЛ У ИСТОЧНИКА — открывается в фоне, пока человек выбирает серию.
   *
   * Это ОДИН запрос на весь сериал: сезоны, серии, ссылки, озвучки и субтитры приезжают вместе.
   * Поэтому обещание здесь ровно одно и переиспользуется всеми нажатиями: второго похода в сеть
   * не будет ни при выборе серии, ни при переключении внутри плеера.
   */
  const pageRef = useRef<ReturnType<typeof openFor> | null>(null);

  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const fail = useCallback((message: string, reason?: unknown) => {
    if (!alive.current) return;
    const text = reason instanceof Error ? reason.message : reason ? String(reason) : undefined;
    setState({ kind: 'error', message, reason: text });
  }, []);

  /**
   * ПЕРЕХОД В ПЛЕЕР — РАЗНЫЙ ДЛЯ ФИЛЬМА И ДЛЯ СЕРИАЛА.
   *
   * У фильма этот экран — просто крутилка на пути к плееру: оставлять его в стопке нельзя, иначе
   * выход из плеера приводит обратно на загрузку, которая тут же отправляет в плеер снова.
   * Поэтому замена.
   *
   * У сериала это СПИСОК СЕРИЙ, то самое место, куда человек хочет вернуться: досмотрел — выбрал
   * следующую. Прежде он тоже заменялся, и выход из плеера выбрасывал на главную. Поэтому добавление.
   */
  const toPlayer = useCallback(
    (req: Parameters<typeof setPendingPlayback>[0], keepList: boolean) => {
      setPendingPlayback(req);
      if (keepList) go('/watch');
      else (markPush(), router.replace('/watch'));
    },
    [],
  );

  /** Запустить серию. Страница уже разобрана — здесь обычно не происходит ни одного запроса. */
  const playEpisode = useCallback(
    async (s: number, e: number) => {
      if (!item) return;

      /*
        ЗДЕСЬ СТОЯЛА ПАМЯТЬ НА УЖЕ ОТКРЫТЫЕ СЕРИИ — И ОНА СКРЫВАЛА ВСЁ ОСТАЛЬНОЕ.

        Один раз источник отдал заставку про подписку — её адрес лёг в память, и дальше КАЖДОЕ
        нажатие этой серии отдавало заставку МГНОВЕННО, вообще не обращаясь к сети. Три исправления
        подряд выглядели как «ничего не изменилось», потому что проверялась память, а не код.
        Памяти здесь больше нет и не будет: серия всегда берётся из разобранного тайтла.
      */
      setBusy(`${s}-${e}`);
      const ticket = ++tapTicket.current;
      try {
        const req = await episodeRequest(item, s, e);
        /*
          УШЛИ — НИЧЕГО НЕ ВКЛЮЧАЕТСЯ. Ссылка на серию ищется секунду-другую; если за это время
          список закрыли (или нажали другую серию), запоздавший ответ раньше всё равно открывал
          плеер — «серия включилась сама». Теперь он открывает его, только если экран жив и это
          последнее нажатие.
        */
        if (!alive.current || ticket !== tapTicket.current) return;
        if (!req) {
          fail('Этой серии у источника нет.');
          return;
        }
        /*
          Список серий виден — значит в него и возвращаемся. Но если серия была выбрана заранее
          (пришли «продолжить смотреть»), списка на экране нет: там крутилка, и вернуться на неё
          значит снова уехать в плеер. Тогда этот экран заменяется, как у фильма.
        */
        toPlayer(req, !target);
      } catch (err) {
        fail('Не удалось открыть серию.', err);
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [item, target, fail, toPlayer],
  );

  // Тайтл у источника — сразу и в фоне, независимо от того, что показывает экран.
  useEffect(() => {
    if (!item) {
      fail('Нечего смотреть.');
      return;
    }
    /*
      Источник открывается не в первый миг, а через 0.7 с: разбор страниц источников — тяжёлая
      работа JS, и в момент открытия экрана она отнимала кадры у анимации и прокрутки. Сезоны к
      этому времени уже на экране (из TMDB).
    */
    /*
      И НЕ ВО ВРЕМЯ ПРОКРУТКИ. Ждём 2.5 с и затем момент, когда список полторы секунды никто не
      трогал: тяжёлый разбор идёт, пока человек читает названия, а не пока листает. (Нажатие на
      серию запускает поиск само и не ждёт этого.)
    */
    /*
      ОПРОС ТИШИНЫ ОСТАНАВЛИВАЕТСЯ ВМЕСТЕ С ЭКРАНОМ. Раньше он тикал каждые полсекунды и после ухода
      со страницы, а дождавшись тишины, запускал тяжёлый разбор источника для экрана, которого уже
      нет (часто — прямо поверх играющего кино). Теперь уход снимает таймер, и разбора не будет;
      обещание при этом всё равно завершается (null), чтобы его никто не ждал вечно.
    */
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let release: (() => void) | null = null;
    const quietNow = () =>
      new Promise<void>((done) => {
        release = done;
        const tick = () => {
          if (dead) done();
          else if (motion.drags === 0 && motion.glides === 0 && Date.now() - motion.lastAt > 1500) done();
          else timer = setTimeout(tick, 500);
        };
        timer = setTimeout(tick, 2500);
      });
    pageRef.current = quietNow()
      .then(() => (dead || !alive.current ? null : openFor(item)))
      .catch(() => null);
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
      (release as (() => void) | null)?.();
    };
  }, [item, fail]);

  // Фильм уезжает в плеер сам; сериал показывает выбор серии.
  useEffect(() => {
    if (!item) return;
    let cancelled = false;

    (async () => {
      if (item.type === 'movie') {
        setState({ kind: 'resolving' });
        try {
          const req = await movieRequest(item);
          if (cancelled || !alive.current) return;
          if (!req) {
            fail('В онлайне этого пока нет. Скорее всего, релиз ещё не вышел в хорошем качестве — возможно, стоит немного подождать.');
            return;
          }
          toPlayer(req, false);
        } catch (e) {
          if (!cancelled) fail('Не удалось открыть онлайн.', e);
        }
        return;
      }

      // Серия выбрана заранее — сразу к ней, без списка.
      if (target) {
        setState({ kind: 'resolving' });
        await playEpisode(Number(target.season), Number(target.episode));
        return;
      }

      /*
        СЕЗОНЫ ПОКАЗЫВАЮТСЯ СРАЗУ — из справочника TMDB (его ответ обычно уже в памяти: страница
        сериала спрашивала то же самое). Раньше экран ждал, пока источник откроет тайтл целиком, —
        это секунды на пустом экране. Источник доезжает в фоне: когда он ответил, список серий
        переходит на ЕГО номера (именно ими потом просим серию), а если у него другой набор
        сезонов — список сезонов заменяется его списком, выбранный сезон сохраняется.
      */
      let shown = false;
      try {
        const d = await TmdbApi.details('tv', item.id);
        if (cancelled) return;
        const list = (d.seasons ?? [])
          .filter((s) => (s.season_number ?? 0) > 0)
          .map((s) => ({ number: s.season_number ?? 0, name: `Сезон ${s.season_number}` }));
        if (list.length) {
          setSeasons(list);
          setSeason(startSeason(list, landing.current));
          setState({ kind: 'series' });
          shown = true;
        }
      } catch {
        /* справочник молчит — ждём источник */
      }
      try {
        const page = await pageRef.current;
        if (cancelled) return;
        const own = page && page.kind === 'serial' ? page.seasons : [];
        if (own.length > 0) {
          setSourceSeasons(own);
          const list = own.map((x) => ({ number: x.season, name: `Сезон ${x.season}` }));
          setSeasons((prev) => (sameSeasons(prev, list) ? prev : list));
          setSeason((cur) => (cur != null && list.some((x) => x.number === cur) ? cur : startSeason(list, landing.current)));
          setState({ kind: 'series' });
          return;
        }
        if (!shown) fail('Не удалось получить список серий.');
      } catch (e) {
        if (!cancelled && !shown) fail('Не удалось получить список серий.', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [item, target, fail, toPlayer, playEpisode]);

  /** Знак сериала для шапки (вместо набранного названия). */
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    if (!item) return;
    let dead = false;
    logoUrl(item.type, item.id)
      .then((u) => !dead && setLogo(u))
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [item]);

  /*
    Список сезонов пришёл (или сменился, когда ответил источник): листалка встаёт на выбранный
    сезон без анимации, капсулы — вместе с ней.
  */
  const seasonRef = useRef<number | null>(null);
  seasonRef.current = season;
  useEffect(() => {
    if (!seasons.length) return;
    const i = Math.max(0, seasons.findIndex((x) => x.number === seasonRef.current));
    pagePos.value = i;
    setNearPage(i);
    if (!startOffset.current) {
      startOffset.current = { x: i * pageW, y: 0 };
      setPagerReady(true);
    }
    else pagerRef.current?.scrollTo({ x: i * pageW, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasons]);

  /** Серии сезона: номера от источника, если он ответил, иначе из TMDB. */
  const seasonRows = useCallback(
    async (n: number): Promise<{ season: number; episode: number }[]> => {
      const own = sourceSeasons.find((x) => x.season === n);
      if (own) return own.episodes.map((e) => ({ season: n, episode: Number(e.episode) || 0 }));
      if (!item) return [];
      const raw = (await TmdbApi.tvSeason(item.id, n).catch(() => null)) as { episodes?: TmdbEpisode[] } | null;
      return (raw?.episodes ?? [])
        .filter((e) => !e.air_date || new Date(e.air_date).getTime() <= Date.now())
        .map((e) => ({ season: n, episode: e.episode_number }));
    },
    [sourceSeasons, item],
  );

  // Кадры и названия соседних сезонов — заранее, в фоне (ответы помнятся, см. tmdb.ts): переход
  // на другой сезон не ждёт сети.
  useEffect(() => {
    if (!item || seasons.length < 2) return;
    const timers = seasons.map((x, i) =>
      setTimeout(() => {
        TmdbApi.tvSeason(item.id, x.number).catch(() => undefined);
      }, 600 + i * 300),
    );
    return () => timers.forEach(clearTimeout);
  }, [item, seasons]);

  /*
    ЗАГРУЗКА СЕРИЙ — как у планшетного Люмьера: значок у каждой серии и «Скачать сезон».
    Голос — выбранный для сериала (если выбирали), иначе спрашиваем, если их несколько.
  */
  /*
    СПИСОК ЗАГРУЗОК ЗДЕСЬ НЕ ПОДПИСАН. Он нужен только в момент нажатия («уже качается?») — и
    берётся тогда же, свежим. Подписка будила весь экран тайтла на каждое обновление хода загрузки
    (три раза в секунду), хотя видно его только в строках серий, а они следят каждая за своей
    (useDownloadFor в EpisodeRowLive).
  */
  const taskOf = (s: number, e: number): DlTask | undefined =>
    item ? allDownloads().find((t) => t.key === episodeKey(item.type, item.id, String(s), String(e))) : undefined;

  const { picker, askVoice } = useVoicePicker();
  /*
    ОЗВУЧКА ДЛЯ ЗАГРУЗКИ — СПРАШИВАЕМ ВСЕГДА (просьба Марка). Раньше, если серию уже смотрели в
    какой-то озвучке (или озвучка одна), выбор делался молча — за человека. Теперь окно
    открывается всегда и сразу по касанию; список доезжает в него сам. Озвучка, в которой
    смотрели, отмечена — выбрать её можно одним касанием.
  */
  const pickVoice = async (s: number, e: number, label?: string): Promise<string | null | undefined> => {
    if (!item) return null;
    const saved = await voiceForAsync(titleKey(item.type, item.id));
    return askVoice({
      voices: voicesFor(item, { season: s, episode: e }).catch(() => [] as string[]),
      subtitle: label ?? `Сезон ${s} · Серия ${e}`,
      current: saved,
    });
  };

  const downloadEpisode = async (s: number, e: number) => {
    if (!item) return;
    const have = taskOf(s, e);
    if (have) {
      go('/downloads');
      return;
    }
    const voice = await pickVoice(s, e);
    if (!voice) return;
    enqueueDownload(item, { season: s, episode: e }, voice);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  /*
    СЕЗОН ЦЕЛИКОМ. Озвучки собираются по каждой серии; в окне — все, что есть хоть где-то
    (чаще встречающиеся — выше). Выбрали озвучку, а в части серий её нет — второе окно так и
    говорит: «Серии 3 и 5 не содержат озвучку X» — и предлагает, чем их заменить (из того, что у
    этих серий есть). Отказались от замены — эти серии просто не качаются.
  */
  const downloadSeason = async (n: number) => {
    if (!item) return;
    const rows = await seasonRows(n);
    if (rows.length === 0) return;
    const todo = rows.filter((r) => !taskOf(r.season, r.episode));
    if (todo.length === 0) {
      Alert.alert('Все серии сезона уже в загрузках');
      return;
    }
    const perEp = Promise.all(
      todo.map((r) => voicesFor(item, { season: r.season, episode: r.episode }).catch(() => [] as string[])),
    );
    const union = perEp.then((all) => {
      const count = new Map<string, number>();
      all.forEach((vs) => vs.forEach((v) => count.set(v, (count.get(v) ?? 0) + 1)));
      return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
    });
    const saved = await voiceForAsync(titleKey(item.type, item.id));
    const voice = await askVoice({ voices: union, subtitle: `весь ${n} сезон`, current: saved });
    if (!voice) return;
    const all = await perEp;
    const missing = todo.filter((_, i) => !all[i].includes(voice));
    let swapTo: string | null = null;
    if (missing.length) {
      const nums = missing.map((r) => r.episode);
      const others = new Map<string, number>();
      missing.forEach((r) => {
        const i = todo.indexOf(r);
        all[i].forEach((v) => others.set(v, (others.get(v) ?? 0) + 1));
      });
      const list = [...others.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
      swapTo = await askVoice({
        voices: list,
        title: 'Замена озвучки',
        subtitle: `сезон ${n}`,
        note: `${nums.length === 1 ? 'Серия' : 'Серии'} ${nums.join(', ')} не ${nums.length === 1 ? 'содержит' : 'содержат'} озвучку «${voice}». Чем заменить?`,
      });
    }
    let queued = 0;
    todo.forEach((r) => {
      const i = todo.indexOf(r);
      const has = all[i];
      const v = has.includes(voice) ? voice : swapTo && has.includes(swapTo) ? swapTo : swapTo ? has[0] : null;
      if (!v) return;
      enqueueDownload(item, { season: r.season, episode: r.episode }, v);
      queued += 1;
    });
    if (queued) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  /*
    ВЫБОР СЕЗОНА — одна дорога для касания и для свайпа. Капсулы горят не от состояния, а от
    положения листалки (pagePos), поэтому две сразу загореться не могут: подсветка — это просто то,
    где сейчас листалка. Состояние сезона меняется один раз, когда листалка встала.
  */
  const tabsRef = useRef<ScrollView | null>(null);
  const chipX = useRef<number[]>([]);
  const showChip = useCallback(
    (i: number) => {
      const x = chipX.current[i];
      if (x != null) tabsRef.current?.scrollTo({ x: Math.max(0, x - 60), animated: true });
    },
    [],
  );
  const settlePage = useCallback(
    (i: number) => {
      const n = seasons[i]?.number;
      if (n == null) return;
      setNearPage(i);
      showChip(i);
      if (n !== seasonRef.current) {
        void Haptics.selectionAsync();
        setSeason(n);
      }
    },
    [seasons, showChip],
  );
  const goSeason = useCallback(
    (i: number) => {
      void Haptics.selectionAsync();
      // Страницы вокруг цели — сразу, чтобы листалка приехала на готовый список.
      setNearPage(i);
      pagerRef.current?.scrollTo({ x: i * pageW, animated: true });
      // Конец программной прокрутки iOS обычно сообщает сам; это — на случай, если промолчит.
      setTimeout(() => settlePage(i), 480);
    },
    [pageW, settlePage],
  );

  // Строки серий зовут запуск и загрузку через ссылки: сами строки не пересобираются, когда эти
  // функции меняются. (Раньше ссылки так и не были подключены — серии не открывались вовсе.)
  playRef.current = (s, e) => void playEpisode(s, e);
  dlRef.current = (s, e) => void downloadEpisode(s, e);

  return (
    <View style={styles.root} pointerEvents={zoom.interactive ? 'auto' : 'none'}>
      <ScreenBackdrop style={zoom.backdropStyle} />
        <Animated.View style={[styles.screen, zoom.pageStyle]}>
          {/*
            СВЕЧЕНИЕ — ТОЛЬКО ВВЕРХУ, У ЗНАКА СЕРИАЛА, а ниже очень плавно уходит в чёрное (чуть
            ниже знака, без обрыва). Под списком серий свет не нужен, а рисовать его там — лишняя
            работа телефону.
          */}
          <TopGlow />

          <Pressable onPress={() => zoom.close()} style={[styles.back, { top: insets.top + 6 }]} hitSlop={12}>
            <View style={styles.backCircle}>
              <MaterialIcons name="arrow-back-ios-new" size={17} color={colors.onBg} />
            </View>
          </Pressable>

          {(state.kind === 'loading' || state.kind === 'resolving') && (
            <View style={styles.center}>
              <ActivityIndicator color={colors.accent} size="large" />
            </View>
          )}

          {state.kind === 'error' && (
            <View style={styles.center}>
              <Text style={styles.error}>{state.message}</Text>
              {state.reason ? <Text style={styles.reason}>{state.reason}</Text> : null}
            </View>
          )}

          {state.kind === 'series' && (
            <View style={{ flex: 1, paddingTop: insets.top + 2 }}>
              {/*
                ЗНАК СЕРИАЛА ПО ЦЕНТРУ, А НЕ НАБРАННОЕ НАЗВАНИЕ СЛЕВА (просьба Марка).

                Шапка — та же, что у плеера и страницы фильма: начертание из афиши посередине, на
                одной высоте со стрелкой «назад». Пока знака нет (или у сериала его нет вовсе) —
                название тем же местом, по центру, и потом оно перетекает в знак (TitleMark).
              */}
              <View style={styles.markRow}>
                <TitleMark logoUrl={logo} title={item?.title ?? ''} textStyle={styles.markText} height={46} />
              </View>

              {/*
                РЯД СЕЗОНОВ ДЕРЖИТ СВОЮ ВЫСОТУ САМ — из-за этого текст в чипах и обрезало.

                Здесь два прокручиваемых списка друг под другом в колонке, и высоту никто не объявлял.
                Список серий длинный, он просит всю колонку и получает её, а ряду сезонов остаётся то,
                что не забрали, — меньше, чем нужно его же кнопкам. Подписи «Сезон 1» при этом никуда
                не деваются, их просто подрезает по краю.

                Лечится объявлением, а не подгонкой размеров: ряд сезонов не растягивается и не
                сжимается (растёт ровно по своему содержимому), а всё оставшееся место забирает список
                серий.
              */}
              {seasons.length > 5 ? (
                /*
                  СЕЗОНОВ МНОГО (больше пяти) — не лента капсул, а одна капсула текущего сезона со
                  стрелкой: касание открывает список всех сезонов листом снизу. Листать сезоны
                  пальцем по сериям можно по-прежнему — капсула показывает, где вы.
                */
                <View style={[styles.tabs, styles.tabsOne]}>
                  <Pressable
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setSeasonSheet(true);
                    }}
                    style={({ pressed }) => [styles.tab, styles.tabActive, styles.tabPick, pressed && { opacity: 0.7 }]}
                  >
                    <Text style={[styles.tabText, styles.tabTextActive]}>{seasons.find((x) => x.number === season)?.name ?? 'Сезон'}</Text>
                    <SymbolView name="chevron.down" size={12} weight="bold" tintColor="#000" />
                  </Pressable>
                  <Pressable onPress={() => season != null && void downloadSeason(season)} hitSlop={6} style={({ pressed }) => [styles.dlRound, { marginLeft: 6 }, pressed && { opacity: 0.6, transform: [{ scale: 0.94 }] }]}>
                    <SymbolView name="arrow.down.circle" size={20} tintColor="#000" />
                  </Pressable>
                </View>
              ) : (
                <ScrollView
                ref={tabsRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.tabsRow}
                contentContainerStyle={styles.tabs}
              >
                {seasons.map((s, i) => (
                  <View
                    key={s.number}
                    style={styles.tabPair}
                    onLayout={(e) => {
                      chipX.current[i] = e.nativeEvent.layout.x;
                    }}
                  >
                    <SeasonChip
                      label={s.name}
                      on={s.number === season}
                      pos={pagePos}
                      index={i}
                      onPress={() => goSeason(i)}
                      style={styles.tab}
                      textStyle={styles.tabText}
                    />
                    <SeasonDownload pos={pagePos} index={i} onPress={() => void downloadSeason(s.number)} />
                  </View>
                ))}
              </ScrollView>
              )}

              {seasons.length > 0 && pagerReady && startOffset.current ? (
                <Reanimated.ScrollView
                  ref={pagerRef as never}
                  horizontal
                  pagingEnabled
                  directionalLockEnabled
                  showsHorizontalScrollIndicator={false}
                  style={styles.list}
                  contentOffset={startOffset.current}
                  scrollEventThrottle={16}
                  onScroll={pagerScroll}
                  onScrollBeginDrag={onDragStart}
                  onScrollEndDrag={onDragEnd}
                  onMomentumScrollBegin={onGlideStart}
                  onMomentumScrollEnd={(e) => {
                    onGlideEnd();
                    settlePage(Math.round(e.nativeEvent.contentOffset.x / pageW));
                  }}
                >
                  {seasons.map((x, i) => (
                    <View key={x.number} style={{ width: pageW }}>
                      {Math.abs(i - nearPage) <= 1 && item ? (
                        <SeasonPage
                          item={item}
                          season={x.number}
                          own={sourceSeasons.find((o) => o.season === x.number)}
                          width={pageW}
                          bottom={insets.bottom + 24}
                          busy={busy}
                          onPlay={onPlayRow}
                          onDownload={onDownloadRow}
                          onDragStart={onDragStart}
                          onDragEnd={onDragEnd}
                          onGlideStart={onGlideStart}
                          onGlideEnd={onGlideEnd}
                          landing={landing.current}
                        />
                      ) : null}
                    </View>
                  ))}
                </Reanimated.ScrollView>
              ) : (
                <ActivityIndicator color={colors.accent} style={{ marginTop: 30 }} />
              )}
            </View>
          )}
          {/*
            ЗАКРЫТЬ — ТОЛЬКО ОТ САМОГО ЛЕВОГО КРАЯ. Полоска шириной в палец поверх страницы: свайп
            по сезонам её не касается и закрыть страницу случайно не может, а от края закрытие
            работает всегда — листалка сезонов это касание не перехватывает.
          */}
          <GestureDetector gesture={back}>
            <View style={styles.edge} />
          </GestureDetector>
        </Animated.View>
      {picker}
      <GlassSheet open={seasonSheet} onClose={() => setSeasonSheet(false)}>
        <Text style={styles.sheetTitle}>Сезоны</Text>
        <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 6, paddingBottom: 8 }} showsVerticalScrollIndicator={false}>
          {seasons.map((x, i) => {
            const on = x.number === season;
            return (
              <Pressable
                key={x.number}
                onPress={() => {
                  setSeasonSheet(false);
                  goSeason(i);
                }}
                style={({ pressed }) => [styles.sheetRow, on && styles.sheetRowOn, pressed && { opacity: 0.6 }]}
              >
                <Text style={[styles.sheetRowText, on && { color: '#000' }]}>{x.name}</Text>
                {on ? <SymbolView name="checkmark" size={14} tintColor="#000" /> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </GlassSheet>
    </View>
  );
}

function sameSeasons(a: { number: number }[], b: { number: number }[]): boolean {
  return a.length === b.length && a.every((x, i) => x.number === b[i].number);
}

/**
 * Сезон, на котором открывается список: тот, где лежит самая дальняя просмотренная серия.
 *
 * Если такого сезона в списке нет (запись из другого источника, сезон убрали) — первый: правило
 * должно уметь промахнуться молча, а не оставить экран без выбранного сезона.
 */
function startSeason(
  list: { number: number; name: string }[],
  landing: { season: number; episode: number } | null,
): number | null {
  if (landing && list.some((s) => s.number === landing.season)) return landing.season;
  return list[0]?.number ?? null;
}

/** Одна серия: кадр, номер с названием и полоса того, сколько от неё просмотрено. */
/**
 * СТРАНИЦА ОДНОГО СЕЗОНА в листалке сезонов: свой список серий, свои кадры и названия из TMDB
 * (ответ помнится — см. tmdb.ts), своя прокрутка.
 */
/** Высота строки серии — постоянная: так список знает положение любой строки, не измеряя её. */
const ROW_H = 98;

const SeasonPage = memo(function SeasonPage({
  item,
  season,
  own,
  width,
  bottom,
  busy,
  onPlay,
  onDownload,
  onDragStart,
  onDragEnd,
  onGlideStart,
  onGlideEnd,
  landing,
}: {
  item: MediaItem;
  season: number;
  own: ListSeason | undefined;
  width: number;
  bottom: number;
  busy: string | null;
  onPlay: (s: number, e: number) => void;
  onDownload: (s: number, e: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onGlideStart: () => void;
  onGlideEnd: () => void;
  landing: { season: number; episode: number } | null;
}) {
  const [eps, setEps] = useState<TmdbEpisode[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let dead = false;
    TmdbApi.tvSeason(item.id, season)
      .then((raw) => {
        const list = (raw as { episodes?: TmdbEpisode[] }).episodes ?? [];
        // Кадры — сразу в кэш картинок: строки, собранные позже, берут их из памяти.
        for (const e of list) {
          const u = TmdbImages.still(e.still_path ?? null);
          if (u) Image.prefetch(u).catch(() => undefined);
        }
        if (!dead) setEps(list);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!dead) setReady(true);
      });
    return () => {
      dead = true;
    };
  }, [item.id, season]);

  const rows = useMemo(() => {
    if (own) {
      return own.episodes.map((e) => {
        const n = Number(e.episode) || 0;
        const tmdb = eps.find((x) => x.episode_number === n);
        return { season, episode: n, title: tmdb?.name || e.title || `Серия ${n}`, tmdb };
      });
    }
    return eps.map((e) => ({ season, episode: e.episode_number, title: e.name || `Серия ${e.episode_number}`, tmdb: e as TmdbEpisode | undefined }));
  }, [own, eps, season]);

  /*
    Открываемся на самой дальней просмотренной серии (правило Влада) — сразу нужной строкой:
    высота строк постоянная, поэтому список знает, где она, ещё до того, как её нарисовал.
  */
  const startAt = useMemo(() => {
    if (!landing || landing.season !== season) return 0;
    return Math.max(0, rows.findIndex((r) => r.episode === landing.episode));
  }, [landing, season, rows]);

  type Row = (typeof rows)[number];
  const render = useCallback(
    ({ item: r }: { item: Row }) => (
      <EpisodeRowLive
        dlKey={episodeKey(item.type, item.id, String(r.season), String(r.episode))}
        seenFrac={seenFrac(item, r.season, r.episode)}
        item={item}
        season={r.season}
        episode={r.episode}
        title={r.title}
        tmdb={r.tmdb}
        stillsReady={ready}
        busy={busy === `${r.season}-${r.episode}`}
        onPlay={onPlay}
        onDownload={onDownload}
      />
    ),
    // Загрузок здесь нет: каждая строка следит за своей сама (EpisodeRowLive).
    [item, ready, busy, onPlay, onDownload],
  );

  if (rows.length === 0) {
    return <View style={{ width }}>{!ready ? <ActivityIndicator color={colors.accent} style={{ marginTop: 30 }} /> : null}</View>;
  }

  return (
    /*
      СПИСОК ВИРТУАЛИЗОВАН: на руках только строки у экрана и немного запаса. Раньше сезон
      рисовал все серии разом (а пройденные сезоны оставались жить) — сотни картинок и рамок в
      памяти, отсюда тормоза, нагрев и долгий выход со страницы.
    */
    <FlatList
      style={{ width }}
      data={rows}
      keyExtractor={(r) => `${r.season}-${r.episode}`}
      renderItem={render}
      getItemLayout={(_, i) => ({ length: ROW_H, offset: ROW_H * i, index: i })}
      initialScrollIndex={startAt > 2 ? startAt : undefined}
      // Сколько строк держать — по экрану этой модели (src/perf/device), с запасом в полэкрана.
      initialNumToRender={Math.min(9, device().rowsOnScreen)}
      maxToRenderPerBatch={4}
      windowSize={5}
      removeClippedSubviews
      onScrollBeginDrag={onDragStart}
      onScrollEndDrag={onDragEnd}
      onMomentumScrollBegin={onGlideStart}
      onMomentumScrollEnd={onGlideEnd}
      contentContainerStyle={{ paddingBottom: bottom }}
      showsVerticalScrollIndicator={false}
    />
  );
});

/**
 * «СКАЧАТЬ СЕЗОН» — круглая пергаментная кнопка правее капсулы сезона. Она есть у каждого сезона,
 * но видна только у того, где стоит листалка: её ширина, прозрачность и размер следуют за пальцем
 * (pagePos). Уходящий сезон кнопку плавно втягивает — капсулы сходятся, приходящий выпускает —
 * капсулы расходятся. Всё в потоке отрисовки, без пересборки списка.
 */
const SeasonDownload = memo(function SeasonDownload({
  pos,
  index,
  onPress,
}: {
  pos: SharedValue<number>;
  index: number;
  onPress: () => void;
}) {
  /*
    Место под кнопку (ширина) и сама кнопка (размер, прозрачность) — РАЗНЫЕ слои. Раньше кнопка
    сидела в коробке с обрезкой по краю, и пока коробка росла, круг резало её квадратной маской.
    Теперь коробка ничего не режет: она только раздвигает капсулы, а круг растёт из своей
    середины и целиком.
  */
  /*
    БЛИЗОСТЬ ЛИСТАЛКИ К ЭТОМУ СЕЗОНУ — ОТДЕЛЬНЫМ ЗНАЧЕНИЕМ. Стили ниже зависят от него, а не от
    самой листалки: у далёких сезонов оно так и стоит нулём, а неизменное значение никого не будит.
    Раньше каждый кадр прокрутки пересчитывал и заново отправлял на экран сдвиг кнопки у КАЖДОГО
    сезона (новый массив сдвига всегда «изменился»), хотя видна она только у одного-двух.
  */
  const near = useDerivedValue(() => Math.max(0, 1 - Math.abs(pos.value - index)));
  const slot = useAnimatedStyle(() => {
    const v = near.value;
    return { width: 40 * v };
  });
  const btn = useAnimatedStyle(() => {
    const v = near.value;
    // Центр круга — посередине освобождённого места (с отступом 6 от капсулы).
    return { opacity: v, transform: [{ translateX: 20 * v - 14 }, { scale: v }] };
  });
  return (
    <Reanimated.View style={[styles.dlSlot, slot]}>
      <Reanimated.View style={[styles.dlBtnWrap, btn]}>
      <Pressable
        onPress={onPress}
        hitSlop={6}
        style={({ pressed }) => [styles.dlRound, pressed && { opacity: 0.6, transform: [{ scale: 0.94 }] }]}
      >
        <SymbolView name="arrow.down.circle" size={20} tintColor="#000" />
      </Pressable>
      </Reanimated.View>
    </Reanimated.View>
  );
});

/** Сколько серии уже просмотрено — считается в списке и передаётся строке числом. */
function seenFrac(item: MediaItem, s: number, e: number): number {
  const seen = watchEntry(episodeKey(item.type, item.id, String(s), String(e)));
  return seen && seen.durationMs > 0 ? seen.positionMs / seen.durationMs : 0;
}

/*
  СТРОКА ПЕРЕРИСОВЫВАЕТСЯ, ТОЛЬКО КОГДА МЕНЯЕТСЯ ОНА САМА.

  Пока что-то качается, список загрузок меняется на каждом скачанном куске — и раньше от этого
  пересобирались ВСЕ строки всех серий, несколько раз в секунду: отсюда «список лагает». Теперь
  строка сравнивает то, что в ней видно (номер, название, кадр, просмотр, состояние своей
  загрузки), и без нужды не пересобирается. Обработчики нажатий на сравнение не влияют: они
  всегда делают одно и то же для той же серии.
*/
const EpisodeRowFast = memo(
  function EpisodeRowFast(p: Parameters<typeof EpisodeRow>[0] & { seenFrac: number }) {
    return <EpisodeRow {...p} />;
  },
  (a, b) =>
    a.season === b.season &&
    a.episode === b.episode &&
    a.title === b.title &&
    a.tmdb === b.tmdb &&
    a.stillsReady === b.stillsReady &&
    a.busy === b.busy &&
    a.seenFrac === b.seenFrac &&
    a.download?.state === b.download?.state &&
    (a.download ? Math.floor((a.download.piecesDone / Math.max(1, a.download.piecesTotal)) * 100) : -1) ===
      (b.download ? Math.floor((b.download.piecesDone / Math.max(1, b.download.piecesTotal)) * 100) : -1),
);

/** Строка серии, сама подписанная на СВОЮ загрузку (см. useDownloadFor). */
function EpisodeRowLive({ dlKey, ...p }: Omit<Parameters<typeof EpisodeRow>[0], 'download'> & { seenFrac: number; dlKey: string }) {
  const download = useDownloadFor(dlKey);
  return <EpisodeRowFast {...p} download={download} />;
}

function EpisodeRow({
  item,
  season,
  episode,
  title,
  tmdb,
  stillsReady,
  busy,
  onPlay,
  download,
  onDownload,
}: {
  item: MediaItem;
  season: number;
  /** Номер серии — тот, которым её знает источник. */
  episode: number;
  title: string;
  /** То же в TMDB, если нашлось: только ради кадра и даты выхода. */
  tmdb?: TmdbEpisode;
  /** Ответ справочника по сезону уже пришёл. */
  stillsReady: boolean;
  busy: boolean;
  onPlay: (s: number, e: number) => void;
  /** Загрузка этой серии, если её ставили. */
  download?: DlTask;
  onDownload?: (s: number, e: number) => void;
}) {
  /*
    РАМКА ОЖИДАНИЯ — ТОЛЬКО У НАЖАТОЙ СЕРИИ. Раньше она стояла в каждой строке (два SVG-полотна
    на строку, пусть и невидимых) — лишняя работа на всём списке. Теперь появляется на нажатие и
    уходит, когда доиграла «замыкание».
  */
  const [ring, setRing] = useState(busy);
  useEffect(() => {
    if (busy) {
      setRing(true);
      return;
    }
    const t = setTimeout(() => setRing(false), 900);
    return () => clearTimeout(t);
  }, [busy]);
  const seen = watchEntry(episodeKey(item.type, item.id, String(season), String(episode)));
  const progress = seen && seen.durationMs > 0 ? seen.positionMs / seen.durationMs : 0;
  /*
    Приглушаем только те серии, которые ЕЩЁ НЕ ВЫШЛИ ПО TMDB и которых нет у источника. Если
    источник серию показывает, значит она у него есть, и гасить её нельзя, что бы ни говорила дата
    выхода: список ведёт источник, а не справочник.
  */
  const future = useMemo(() => {
    if (!tmdb?.air_date) return false;
    return new Date(tmdb.air_date).getTime() > Date.now();
  }, [tmdb?.air_date]);
  const still = TmdbImages.still(tmdb?.still_path ?? null);

  return (
    <Pressable
      onPress={future ? undefined : () => onPlay(season, episode)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, future && styles.rowFuture]}
    >
      <StillImage uri={still} waiting={!stillsReady} style={styles.stillBox}>
        {/* Серия открывается — по краю кадра бежит линия, как в «Продолжить просмотр». */}
        {ring ? <BusyOutline w={132} h={74} on={busy} /> : null}
        {progress > 0.01 && (
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${Math.min(100, progress * 100)}%` }]} />
          </View>
        )}
      </StillImage>
      <View style={styles.rowBody}>
        <Text style={styles.rowNum}>Серия {episode}</Text>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {title || `Серия ${episode}`}
        </Text>
        {future ? <Text style={styles.rowSoon}>ещё не вышла</Text> : null}
        {download ? (
          <Text style={styles.rowDl}>
            {download.state === 'done'
              ? 'Скачано · можно смотреть без интернета'
              : download.state === 'failed'
                ? 'Не скачалось'
                : download.state === 'paused'
                  ? 'Загрузка на паузе'
                  : `Скачивается${download.piecesTotal ? ` · ${Math.round((download.piecesDone / download.piecesTotal) * 100)}%` : '…'}`}
          </Text>
        ) : null}
      </View>
      {!future && onDownload ? (
        <Pressable onPress={() => onDownload(season, episode)} hitSlop={10} style={styles.dlBtn}>
          <SymbolView
            name={download?.state === 'done' ? 'checkmark.circle.fill' : download ? 'arrow.down.circle.dotted' : 'arrow.down.circle'}
            size={24}
            tintColor={download?.state === 'done' ? colors.focusFill : colors.muted}
          />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  // Скругление верхних углов — как у страницы фильма: тот же жест, та же оправа.
  screen: { flex: 1, backgroundColor: colors.bg, borderTopLeftRadius: PAGE_RADIUS, borderTopRightRadius: PAGE_RADIUS, overflow: 'hidden' },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', padding: 32 },
  error: { ...typo.bodyMedium, color: colors.muted, textAlign: 'center', lineHeight: 22 },
  reason: { ...typo.labelMedium, color: colors.faint, textAlign: 'center', marginTop: 14 },
  title: { ...typo.headlineLarge, color: colors.onBg, marginHorizontal: 20, marginBottom: 14 },
  // Ряд знака: по высоте и центру — вровень со стрелкой «назад», поля по бокам под неё.
  markRow: { height: 46, marginHorizontal: 58, marginTop: 0, marginBottom: 14, justifyContent: 'center' },
  markText: { ...typo.headlineLarge, color: colors.onBg, textAlign: 'center' },
  // Ряд сезонов: своя высота, ни растяжения, ни сжатия (см. пояснение у самого ряда).
  tabsRow: { flexGrow: 0, flexShrink: 0 },
  tabsOne: { flexDirection: 'row' },
  tabPick: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sheetTitle: { fontFamily: font.display, fontSize: 20, color: colors.onBg, paddingHorizontal: 20, paddingBottom: 12 },
  sheetRow: { height: 48, borderRadius: 24, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: 'rgba(255,255,255,0.08)' },
  sheetRowOn: { backgroundColor: colors.focusFill },
  sheetRowText: { fontFamily: font.bold, fontSize: 15, color: colors.onBg },
  list: { flex: 1 },
  tabs: { paddingHorizontal: 20, gap: 8, paddingBottom: 14, alignItems: 'center' },
  tab: {
    paddingHorizontal: 14,
    // Высота задана явно, а не набрана из отступов: у Manrope свои внутренние поля, и на них
    // строка «Сезон 1» вставала впритык к краю чипа.
    minHeight: 34,
    justifyContent: 'center',
    // Чип не сжимается под соседей: сжатый, он переносит подпись на вторую строку и режет её.
    flexShrink: 0,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.stroke,
  },
  tabActive: { backgroundColor: colors.focusFill, borderColor: colors.focusFill },
  // Междустрочие задано явно — без него шрифт сам решает, сколько ему надо, и подрезает хвосты букв.
  tabText: { ...typo.labelMedium, color: colors.onBg, lineHeight: 16 },
  tabTextActive: { color: '#000000' },
  row: { flexDirection: 'row', gap: 14, paddingHorizontal: 20, height: ROW_H, alignItems: 'center', overflow: 'hidden' },
  rowPressed: { backgroundColor: colors.surface },
  rowFuture: { opacity: 0.45 },
  // Кадр серии в пропорции 16:9 — как у Влада: по нему серию узнают быстрее, чем по номеру.
  stillBox: {
    width: 132,
    height: 74,
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: colors.surfaceHi,
    justifyContent: 'flex-end',
  },
  still: { ...StyleSheet.absoluteFill },
  stillBusy: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(8,8,10,0.55)' },
  bar: { height: 4, backgroundColor: 'rgba(246,246,248,0.25)' },
  barFill: { height: '100%', backgroundColor: colors.focusFill },
  rowBody: { flex: 1, gap: 3 },
  rowNum: { ...typo.labelMedium, color: colors.mutedWarm },
  rowTitle: { ...typo.bodyMedium, color: colors.onBg },
  rowSoon: { ...typo.labelMedium, color: colors.faint },
  rowDl: { ...typo.labelMedium, color: colors.focusFill },
  dlBtn: { width: 36, alignItems: 'center', justifyContent: 'center' },
  glowTop: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' },
  edge: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 22, zIndex: 10 },
  tabPair: { flexDirection: 'row', alignItems: 'center' },
  dlSlot: { height: 34, overflow: 'visible' },
  dlBtnWrap: { position: 'absolute', left: 0, top: 0, width: 34, height: 34 },
  dlRound: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.focusFill },
  back: { position: 'absolute', left: 14, zIndex: 2 },
  backCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(8,8,10,0.5)',
  },
});
