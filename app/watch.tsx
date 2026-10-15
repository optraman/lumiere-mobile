import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useEvent } from 'expo';
import { VideoView, isPictureInPictureSupported, useVideoPlayer, type VideoPlayer } from 'expo-video';
import { useKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  Keyframe,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {
  takePendingPlayback,
  type EpisodeRef,
  type PlaybackRequest,
  type SubtitleTrack,
} from '../src/player/request';
import { changeEpisode, movieRequest, nextFallback, pickChoice, rememberTrack, voiceKey, watchChoices, watchOffline } from '../src/api/sources/playback';
import { File as ExpoFile } from 'expo-file-system';
import { useDevPrefs } from '../src/data/devPrefs';
import { mapItems } from '../src/api/mapper';
import type { MediaItem } from '../src/types/media';
import { say } from '../src/data/journal';
import { flushWatchProgress, saveProgress } from '../src/data/watchProgress';
import { cueAt, loadCues, parseCues, type Cue } from '../src/player/vtt';
import { findOnlineSubtitles, loadOpenSubtitle, OPENSUBS } from '../src/player/opensubs';
import { fontFamilyOf, PLAQUE, PLAYER_SIZE, POSITION_LIFT, useSubtitlePrefs } from '../src/data/subtitlePrefs';
import { HIDE_AFTER_MS, shouldShowChrome } from '../src/player/chrome';
import { Glass } from '../src/player/ui/Glass';
import { GlassButton } from '../src/player/ui/GlassButton';
import { Scrubber, clock } from '../src/player/ui/Scrubber';
import { ArrowRightGlyph, SkipGlyph, SpeedGlyph, SubsGlyph, VoiceGlyph } from '../src/player/ui/Glyphs';
import { introSegments, type Segments } from '../src/player/introdb';
import { PlayPauseGlyph } from '../src/player/ui/PlayPauseGlyph';
import { SeekRipple, type Nudge } from '../src/player/ui/SeekRipple';
import { setPlayerBusy } from '../src/downloads/engine';
import { setGlowPaused } from '../src/components/AmbientGlow';
import { LandscapeStage, orientPan, stageMotion, usePlayerInsets, usePlayerWindow, useStageSide } from '../src/player/landscape';
import { SeasonChip, SeasonSwap, StillImage } from '../src/components/EpisodeMotion';
import { BusyOutline } from '../src/components/BusyOutline';
import { logoUrl, TmdbApi, TmdbImages } from '../src/api/tmdb';
import { colors } from '../src/theme/colors';
import { font, type as typo } from '../src/theme/fonts';

/**
 * ПЛЕЕР.
 *
 * Собран заново по плееру Влада (PlayerScreen/PlayerControls/PlayerChrome/SeekRamp), но под палец и
 * под то, что умеет эта система. Из его плеера взято ВСЁ, что составляет поведение: правило
 * трёх секунд бездействия, разгон перемотки, сохранение качества при смене озвучки, возобновление с
 * места, переход по сериям, набор вкладок в меню. Эти две вещи — правило панели и разгон — вынесены
 * в src/player/chrome.ts и портированы дословно, вместе с проверкой на них.
 *
 * Своё здесь одно — материал и плавность, и оба взяты у системы, а не нарисованы:
 *  — панели сделаны настоящим Liquid Glass (expo-glass-effect), тем самым материалом, что Apple
 *    использует в своих плеерах: он преломляет кадр под собой, а не просто затемняет его;
 *  — ведение полосы времени живёт целиком на нативной стороне (reanimated), поэтому ползунок не
 *    отстаёт от пальца — раньше каждое движение проходило через сборку дерева и мост;
 *  — появление и уход панели — затухание, а не вставка и удаление узлов: дерево строится один раз.
 */

type Menu = null | 'quality' | 'voice' | 'episodes' | 'subs' | 'audio' | 'speed';

/** Как часто пишется позиция. Чаще незачем: журнал всё равно откладывает запись на диск. */
const SAVE_MS = 5000;
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * Плеер живёт в «лежачей сцене» внутри стоячего экрана (src/player/landscape.tsx): окно не
 * поворачивается никогда, кадр ложится за телефоном сам.
 */
/** Умеет ли система «картинку в картинке» (на старых iPad и в симуляторе — нет). Не меняется. */
const PIP = (() => {
  try {
    return isPictureInPictureSupported();
  } catch {
    return false;
  }
})();

/** Карточка на экране блокировки и в «Пункте управления»: название, серия, кадр. */
function nowPlaying(r: PlaybackRequest) {
  return {
    title: r.title,
    artist: r.subtitle ?? undefined,
    artwork: r.backdropUrl ?? r.posterUrl ?? undefined,
  };
}

export default function WatchScreen() {
  return (
    <LandscapeStage>
      <WatchScreenBody />
    </LandscapeStage>
  );
}

function WatchScreenBody() {
  useKeepAwake();
  // Пока открыт плеер, склейка загрузок ждёт (engine.ts, setPlayerBusy): память — кино.
  useEffect(() => {
    setPlayerBusy(true);
    setGlowPaused(true);
    return () => {
      setPlayerBusy(false);
      setGlowPaused(false);
    };
  }, []);
  // Поля лежачей сцены: с обеих сторон под «остров», снизу под полосу «домой».
  const insets = usePlayerInsets();
  /** Куда повёрнут кадр — для перевода жестов в его оси. */
  const side = useStageSide();
  const [{ item: first }] = useState(() => ({ item: takePendingPlayback() }));
  const [req, setReq] = useState<PlaybackRequest | null>(first);
  const [menu, setMenu] = useState<Menu>(null);
  const menuRef = useRef<Menu>(null);
  menuRef.current = menu;
  /** Куда мы попросили перемотать кнопкой. Новый объект на каждое нажатие — см. Scrubber. */
  const [seekTarget, setSeekTarget] = useState<{ ms: number } | null>(null);
  /** «contain» — кадр целиком с полями, «cover» — во весь экран с обрезкой. Переключается щипком. */
  const [fit, setFitRaw] = useState<'contain' | 'cover'>('contain');
  const setFit = useCallback((next: 'contain' | 'cover') => {
    setFitRaw((cur) => {
      if (cur !== next) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
      return next;
    });
  }, []);
  const [shown, setShown] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const [ownSubs, setOwnSubs] = useState<{ url: string; cues: Cue[] } | null>(null);

  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);

  /**
   * ПОСЛЕДНЯЯ ИЗВЕСТНАЯ ПОЗИЦИЯ.
   *
   * Спрашивать её у плеера при уходе с экрана нельзя: к моменту разбора дерева нативный объект уже
   * освобождён, и обращение падает. А записать позицию надо именно тогда — иначе «продолжить» будет
   * отставать на последние секунды. Поэтому она копится по ходу и на выходе берётся отсюда.
   */
  const posMs = useRef(first?.startPositionMs ?? 0);
  const durMs = useRef(0);
  const touchedAt = useRef(Date.now());
  const seekTo = useRef<number | null>(null);
  /** Играло ли кино до того, как взялись за ползунок. */
  const wasPlaying = useRef(false);

  const source = req
    ? {
        uri: req.url,
        headers: req.headers,
        contentType: req.isHls ? ('hls' as const) : ('progressive' as const),
        metadata: nowPlaying(req),
      }
    : null;

  const [initial] = useState(() =>
    first
      ? {
          uri: first.url,
          headers: first.headers,
          contentType: first.isHls ? ('hls' as const) : ('progressive' as const),
          metadata: nowPlaying(first),
        }
      : null,
  );

  /*
    ПЛЕЕР СОЗДАЁТСЯ ОДИН РАЗ. useVideoPlayer пересоздаёт его при смене источника, а пересозданный
    плеер заново проигрывает начальную настройку поверх уже идущей замены — два плеера на один
    экран. Поэтому сюда отдаётся ПЕРВЫЙ источник и больше не меняется никогда; всё остальное —
    качество, озвучка, серия — идёт через replaceAsync у того же плеера, как и задумано.
  */
  const videoView = useRef<VideoView>(null);
  /*
    «КАРТИНКА В КАРТИНКЕ» ПО КНОПКЕ. Если система отказала — не молчим: причина идёт в журнал и
    на экран. Молчаливая кнопка, которая «ничего не делает», — худшее, что может быть: не понять,
    сломана она или телефон не умеет. Самая частая причина — запуск в Expo Go: там нет фонового
    режима «аудио», без которого iOS окно не открывает; в собранном .ipa он есть (app.json).
  */
  /*
    СИСТЕМНЫЕ КНОПКИ — ТОЛЬКО НА МИГ ПЕРЕХОДА В ОКНО. У плеера свои кнопки, системные выключены
    (nativeControls={false}), а без них AVKit на части версий iOS отказывается открывать окно —
    ни по просьбе, ни сам при сворачивании. Поэтому на время перехода они включаются: при
    сворачивании это под анимацией ухода на домашний экран, а по кнопке — на долю секунды до
    того, как кадр улетит в окно. Вернулся в приложение — снова только свои.
  */
  const [pipPrep, setPipPrep] = useState(false);
  const inPip = useRef(false);
  const startPip = useCallback(() => {
    setPipPrep(true);
    // Кадр, чтобы системные кнопки успели встать, — потом просим окно.
    setTimeout(() => {
      const v = videoView.current;
      if (!v) return;
      v.startPictureInPicture().catch((e: unknown) => {
        setPipPrep(false);
        const why = e instanceof Error ? e.message : String(e);
        say(`Картинка в картинке не открылась: ${why}`);
        Alert.alert('Картинка в картинке недоступна', why);
      });
    }, 120);
  }, []);
  const player = useVideoPlayer(initial, (p) => {
    p.timeUpdateEventInterval = 0.25;
    /*
      ФОН И ЭКРАН БЛОКИРОВКИ. Свернул приложение или погасил экран — звук идёт дальше, а на экране
      блокировки и в «Пункте управления» карточка с названием и кнопками (данные — nowPlaying).
      Если свернуть во время показа, кадр уходит в «картинку в картинке» (см. VideoView).
    */
    p.staysActiveInBackground = true;
    p.showNowPlayingNotification = true;
    if (first?.startPositionMs) p.currentTime = first.startPositionMs / 1000;
    p.play();
  });

  // Сворачивание: «неактивно» наступает раньше «в фоне» — как раз успеть подготовить окно.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'inactive' && player.playing) setPipPrep(true);
      if (st === 'active' && !inPip.current) setPipPrep(false);
    });
    return () => sub.remove();
  }, [player]);

  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing, oldIsPlaying: false });
  /** Пропорции кадра — по ним рамка подгоняется к самому видео (см. «Улетает сам кадр»). */
  const { videoTrack } = useEvent(player, 'videoTrackChange', { videoTrack: player.videoTrack ?? null });
  const { status, error: playerError } = useEvent(player, 'statusChange', {
    status: player.status,
    oldStatus: undefined,
    error: undefined,
  });

  /*
    ПРОПУСК ЗАСТАВКИ — как у Влада: разметку серии берём у TheIntroDB (src/player/introdb.ts),
    когда поток открылся и стала известна его длительность.
  */
  /*
    ЧАСТИ ФИЛЬМА — как серии у сериала: если фильм входит в коллекцию TMDB («Назад в будущее»,
    «Матрица»), внизу появляется лента частей (свайп вверх), а у правого края — «к предыдущей» и
    «к следующей части». Только вышедшие части, по дате выхода.
  */
  const [parts, setParts] = useState<MediaItem[] | null>(null);
  useEffect(() => {
    setParts(null);
    if (!req || req.mediaType !== 'movie') return;
    let dead = false;
    void (async () => {
      try {
        const d = (await TmdbApi.detailsLite('movie', req.mediaId)) as { belongs_to_collection?: { id?: number } | null };
        const cid = d.belongs_to_collection?.id;
        if (!cid) return;
        const c = await TmdbApi.collection(cid);
        const today = new Date().toISOString().slice(0, 10);
        const list = (c.parts ?? [])
          .filter((x) => (x as { release_date?: string }).release_date && ((x as { release_date?: string }).release_date as string) <= today)
          .sort((a, b) => (((a as { release_date?: string }).release_date ?? '') < ((b as { release_date?: string }).release_date ?? '') ? -1 : 1));
        const items = mapItems(list, 'movie');
        if (!dead && items.length > 1) setParts(items);
      } catch {
        // коллекции нет — и списка нет
      }
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.mediaKey]);
  /** Что выбрано в ленте серий/частей и сейчас ищется (обводка по кадру). */
  const [picking, setPicking] = useState<string | null>(null);
  const partIndex = parts && req ? parts.findIndex((m) => m.id === req.mediaId) : -1;

  const [intro, setIntro] = useState<Segments | null>(null);
  useEffect(() => {
    setIntro(null);
  }, [req?.mediaKey]);
  useEffect(() => {
    if (!req || status !== 'readyToPlay') return;
    let dead = false;
    void introSegments(
      req.mediaId,
      req.mediaType === 'movie',
      req.season != null ? Number(req.season) : null,
      req.episode != null ? Number(req.episode) : null,
      player.duration > 0 ? player.duration * 1000 : null,
    ).then((seg) => {
      if (!dead) setIntro(seg && seg.introEndMs > seg.introStartMs ? seg : null);
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.mediaKey, status]);

  /*
    ОКНО НЕ ПОВОРАЧИВАЕТСЯ. Раньше здесь снимался портретный замок, и система крутила всё окно.
    Теперь замок стоит всегда, а лежит только сцена плеера (LandscapeStage).
  */

  /**
   * ЗНАК ТАЙТЛА ВМЕСТО НАЗВАНИЯ.
   *
   * У фильма есть собственное начертание имени, и ТМДБ его хранит. Набранное системным шрифтом
   * название поверх кадра выглядит как подпись к файлу; знак — как заставка. Пока ответа нет,
   * показываем текст: ждать картинку, которой может не оказаться, значит оставить верх пустым.
   */
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    if (!req) return;
    let dead = false;
    logoUrl(req.mediaType, req.mediaId)
      .then((u) => {
        if (!dead) setLogo(u);
      })
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [req?.mediaId, req?.mediaType]);

  /** Дорожки снимаются тогда, когда могут измениться, — а не на каждой сборке экрана. */
  const [tracks, setTracks] = useState<{
    subs: VideoPlayer['availableSubtitleTracks'];
    audio: VideoPlayer['availableAudioTracks'];
  }>({ subs: [], audio: [] });
  /*
    КАКАЯ ДОРОЖКА ВЫБРАНА — помним сами, по номеру. На iPhone у дорожек нет id (он только у
    Android), и сравнение «id === id» было undefined === undefined — в меню «Аудио» отмеченными
    горели ВСЕ дорожки разом. Теперь отмечена одна: та, что выбрана.
  */
  const devShowSource = useDevPrefs().showSource;
  const [audioPick, setAudioPick] = useState<number | null>(null);
  /*
    ДОРОЖКИ — ПО СОБЫТИЮ ПЛЕЕРА «появились дорожки нового файла», а не по статусу «готов».

    Здесь и была причина «озвучка иногда не меняется, особенно при смене источника». Список
    дорожек снимался, когда менялся адрес запроса или статус. Но при подмене файла запрос
    обновляется РАНЬШЕ, чем плеер загрузит новый файл, — и снимались дорожки СТАРОГО файла; а
    статус «готов» у быстрой подмены не меняется вовсе (это отмечено и в startSwap). В итоге меню
    показывало дорожки прошлого источника, нужный голос (preferTrack) включался в старом файле и
    пропадал, а выбор из меню указывал на дорожку, которой в новом файле нет.
    Теперь: при подмене список сразу очищается, а заполняется, когда плеер сам сообщит о дорожках
    нового файла (availableAudioTracksChange); и только тогда включается нужный голос.

    Сравнение дорожек — по подписи и языку: на iPhone у дорожки нет id (он только у Android), и
    прежнее «id === id» было undefined === undefined — истина для любой пары. Из-за этого, в
    частности, у VixSrc английская дорожка никогда не включалась принудительно.
  */
  const reqRef = useRef(req);
  reqRef.current = req;
  /** Для какого файла голос из запроса уже включён (см. applyTracks). */
  const preferDone = useRef<string | null>(null);
  const sameTrack = (a?: { label?: string; language?: string } | null, b?: { label?: string; language?: string } | null) =>
    !!a && !!b && a.label === b.label && a.language === b.language;
  const applyTracks = useCallback(
    (audio: VideoPlayer['availableAudioTracks']) => {
      const r = reqRef.current;
      setTracks({ subs: player.availableSubtitleTracks, audio });
      // «Одна озвучка» (VixSrc): в файле рядом с оригиналом итальянская — играть английскую.
      if (r?.hideFileTracks) {
        const eng = audio.find((t) => /^en/i.test(t.language ?? '') || /english|eng/i.test(t.label ?? ''));
        if (eng && !sameTrack(player.audioTrack, eng)) player.audioTrack = eng;
        setAudioPick(null);
        return;
      }
      if (audio.length <= 1) {
        setAudioPick(null);
        return;
      }
      const rows = audioRowsOf(audio, r?.voices ?? []);
      // Голос, выбранный раньше (или только что в меню), — если он есть среди дорожек этого файла.
      // ОДИН раз на файл: иначе после каждой подгрузки (статус снова «готов») голос из запроса
      // перебивал бы тот, что человек выбрал в меню сам, — «озвучка не меняется».
      const want = r?.preferTrack && preferDone.current !== r.url ? rows.find((x) => x.name === r.preferTrack) : undefined;
      if (want) {
        preferDone.current = r!.url;
        player.audioTrack = audio[want.i];
        setAudioPick(want.i);
        return;
      }
      const cur = player.audioTrack;
      const at = cur ? audio.findIndex((t) => sameTrack(t, cur)) : -1;
      const def = audio.findIndex((t) => t.isDefault);
      setAudioPick(at >= 0 ? at : def >= 0 ? def : 0);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [player],
  );
  useEffect(() => {
    const sub = player.addListener('availableAudioTracksChange', (e) => applyTracks(e.availableAudioTracks));
    return () => sub.remove();
  }, [player, applyTracks]);
  // Первый файл и страховка: если событие пришло раньше, чем мы подписались, — снимаем по готовности.
  useEffect(() => {
    if (status === 'readyToPlay' && !swapping.current) applyTracks(player.availableAudioTracks);
  }, [status, player, applyTracks]);
  /*
    Сменилась играющая дорожка (в т.ч. не по нашему выбору) — подсветка в меню идёт за плеером. Если
    одинаково подписанных дорожек несколько, оставляем выбранную нами, когда она среди них.
  */
  useEffect(() => {
    const sub = player.addListener('audioTrackChange', (e) => {
      const list = player.availableAudioTracks;
      if (!e.audioTrack || list.length <= 1) return;
      setAudioPick((pick) => {
        if (pick != null && sameTrack(list[pick], e.audioTrack)) return pick;
        const at = list.findIndex((t) => sameTrack(t, e.audioTrack));
        return at >= 0 ? at : pick;
      });
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);

  /** Дорожки файла, которые показываются в меню: у варианта «одна озвучка» — никаких. */
  const fileAudio = req?.hideFileTracks ? [] : tracks.audio;

  /*
    ПОДМЕНА ПОТОКА: ДРУГАЯ СЕРИЯ, ДРУГАЯ ОЗВУЧКА, ЗАПАСНОЙ ИСТОЧНИК.

    Раньше место выставлялось, как только статус был «готов» при новом адресе. Но в тот момент,
    когда адрес уже новый, статус ещё СТАРЫЙ — готов был прошлый поток. Место ставилось ему,
    метка «дождаться» сбрасывалась, и новая серия начиналась там, где кончилась прежняя. А пока
    новый поток грузился, ползунок показывал время прошлой серии, и журнал успевал записать его
    как позицию новой.

    Теперь подмена ждёт ИМЕННО новый поток: либо плеер сам сказал, что он загрузился
    (replaceAsync завершился), либо после подмены статус уходил в загрузку и вернулся в «готов».
    До этого ползунок показывает место, куда встанем (`hold`), а журнал позицию не пишет.
  */
  const swapping = useRef(false);
  const sawLoading = useRef(false);
  const [hold, setHold] = useState<number | null>(null);

  const finishSwap = useCallback(() => {
    if (!swapping.current) return;
    swapping.current = false;
    const to = seekTo.current;
    seekTo.current = null;
    if (to !== null) {
      player.currentTime = to / 1000;
      posMs.current = to;
    }
    durMs.current = (player.duration || 0) * 1000;
    setHold(null);
    player.play();
    setSwitching(false);
    // Страховка к событию дорожек: новый файл точно загружен — снять его дорожки сейчас.
    if (player.availableAudioTracks.length) applyTracks(player.availableAudioTracks);
  }, [player, applyTracks]);

  const startSwap = useCallback(
    (src: { uri: string; headers?: Record<string, string>; contentType: 'hls' | 'progressive'; metadata?: ReturnType<typeof nowPlaying> }, positionMs: number) => {
      seekTo.current = positionMs;
      swapping.current = true;
      sawLoading.current = false;
      setHold(positionMs);
      void player
        .replaceAsync(src)
        .then(() => {
          // Новый поток уже на месте: место ставим сразу — плеер встанет туда, как догрузит.
          if (!swapping.current) return;
          sawLoading.current = true;
          player.currentTime = positionMs / 1000;
          /*
            Если статус так и остался «готов», событие о готовности может не прийти вовсе: поток
            загрузился быстрее, чем статус успел смениться. Чуть подождём и закончим подмену сами.
          */
          setTimeout(() => {
            if (alive.current && swapping.current && player.status === 'readyToPlay') finishSwap();
          }, 400);
        })
        .catch(() => undefined);
    },
    [player, finishSwap],
  );

  useEffect(() => {
    if (!swapping.current) return;
    if (status !== 'readyToPlay') {
      sawLoading.current = true;
      return;
    }
    if (sawLoading.current) finishSwap();
  }, [status, finishSwap]);

  /** Страховка от вечного кружка при переключении. */
  useEffect(() => {
    if (!switching) return;
    const t = setTimeout(() => setSwitching(false), 15_000);
    return () => clearTimeout(t);
  }, [switching]);

  // --------------------------------------------------------------- панель

  const touch = useCallback(() => {
    touchedAt.current = Date.now();
    setShown(true);
  }, []);
  /** Ведут ползунок — панель не гаснет, сколько бы это ни длилось (точная перемотка бывает долгой). */
  const scrubbing = useRef(false);

  /*
    ОБРАБОТЧИКИ ПОЛЗУНКА — ПОСТОЯННЫЕ. Раньше они создавались прямо в разметке, на каждой сборке
    новые, и memo у Ticker из-за них не срабатывал никогда: полоса пересобиралась вместе со всем
    плеером. Всё, что им нужно, — плеер и ссылки, а они не меняются.
  */
  const onScrub = useCallback(
    (ms: number) => {
      // Кино едет ВМЕСТЕ с пальцем: кадр меняется прямо под ним (предпросмотр убран).
      player.currentTime = ms / 1000;
    },
    [player],
  );
  const onScrubStart = useCallback(() => {
    /*
      НА ВРЕМЯ ВЕДЕНИЯ ХОД ОСТАНОВЛЕН.

      Иначе кино продолжает уезжать вперёд, пока его ищут, и цель уплывает из-под
      пальца. Помним, играло ли оно: отпустят — вернём как было, а не включим у того,
      кто сам поставил на паузу.
    */
    wasPlaying.current = player.playing;
    if (player.playing) player.pause();
    scrubbing.current = true;
    touch();
  }, [player, touch]);
  const onScrubEnd = useCallback(
    (ms: number) => {
      player.currentTime = ms / 1000;
      if (wasPlaying.current) player.play();
      scrubbing.current = false;
      touch();
    },
    [player, touch],
  );

  /*
    СПИСОК СЕРИЙ — СНИЗУ, СВАЙПОМ ВВЕРХ, КАК РЕКОМЕНДАЦИИ В ЮТУБЕ.

    Полоса времени и кнопки поднимаются, а из-под них выезжает лента серий. `drawer` — от 0
    (закрыто) до 1 (открыто): за ним идёт палец, к нему пружиной приходит отпускание. Пока список
    открыт, панель не гаснет, а смахивание вниз закрывает список, а не кино.
  */
  // Карточки серий и частей стали крупнее (EP_W × EP_H) — шторка выше на ту же разницу.
  const DRAWER_H = 196 + (EP_H - 84);
  /*
    ПРУЖИНА СПИСКА — БЕЗ ПЕРЕЛЁТА (overshootClamping). Недодемпфированная пружина проскакивала
    единицу и возвращалась: на обратном ходе «1 − drawer» снова становилось больше нуля, и кнопки
    панели на мгновение проступали — то самое мерцание оверлея при открытии списка частей.
  */
  const drawer = useSharedValue(0);
  /*
    «ТИХИЙ» СПИСОК. Список вытянули, когда панель была спрятана: панель ради списка включается
    (лента живёт в ней), но её кнопки и полоса НЕ показываются — ни пока тянут, ни пока список
    закрывается. Раньше на эти доли секунды проступала вся панель — «на секунду виден оверлей».
    Снимается, как только панель спрячется или человек сам её позовёт касанием.
  */
  const quiet = useSharedValue(0);
  const quietRef = useRef(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerOpenRef = useRef(false);
  const openDrawer = useCallback(() => {
    setMenu(null);
    drawerOpenRef.current = true;
    setDrawerOpen(true);
    drawer.value = withSpring(1, { damping: 22, stiffness: 240, mass: 0.8, overshootClamping: true });
    touch();
  }, [drawer, touch]);
  const closeDrawer = useCallback(() => {
    drawerOpenRef.current = false;
    setDrawerOpen(false);
    if (quietRef.current) {
      // Список доедет вниз — и панель гаснет целиком, кнопок по дороге не показывая.
      drawer.value = withSpring(0, { damping: 22, stiffness: 240, mass: 0.8, overshootClamping: true }, (fin) => {
        if (fin) runOnJS(endQuiet)('hide');
      });
      return;
    }
    drawer.value = withSpring(0, { damping: 22, stiffness: 240, mass: 0.8, overshootClamping: true });
    touch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer, touch]);
  /** Список берут пальцем: если панель была спрятана — список «тихий». */
  const grabDrawer = useCallback(() => {
    if (!drawerOpenRef.current && !shownRef.current) {
      quietRef.current = true;
      quiet.value = 1;
    }
    touchedAt.current = Date.now();
    setShown(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** hide — спрятать панель и снять режим, когда она погаснет; show — показать кнопки сейчас. */
  function endQuiet(mode: 'hide' | 'show' | 'gone') {
    if (!quietRef.current) return;
    quietRef.current = false;
    if (mode === 'hide') setShown(false);
    quiet.value = mode === 'show' ? withTiming(0, { duration: 160 }) : withDelay(420, withTiming(0, { duration: 0 }));
  }

  /*
    ОДИН ЧАСОВОЙ НА ВСЮ ПАНЕЛЬ, и решение он не принимает — он спрашивает (см. chrome.ts).
    Раньше те же правила были размазаны по таймеру, четырём переменным и условиям в разметке, и
    отвечали на один вопрос по-разному.
  */
  /*
    ОДИН ТАЙМЕР НА ОСТАВШЕЕСЯ ВРЕМЯ, А НЕ ОПРОС ТРИ РАЗА В СЕКУНДУ. Раньше проверка шла каждые
    300 мс всё время просмотра — и при спрятанной панели снова и снова звала setShown(false).
    Теперь таймер взводится, только когда панели вообще есть от чего гаснуть (видна, кино идёт,
    ничто её не держит), и срабатывает к сроку. Касание сдвигает срок без перерисовки (touchedAt),
    поэтому сработавший таймер сверяется с ним и, если рано, ждёт остаток. Ползунок ведут —
    проверяет снова через те же 300 мс, что и прежде.
  */
  useEffect(() => {
    // Пока грузится, панель не прячется: именно на ней теперь видно, что загрузка идёт.
    const pinned = menu !== null || switching || status === 'loading' || drawerOpen;
    if (!shown || !isPlaying || pinned || failed !== null) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      const since = Date.now() - touchedAt.current;
      const keep = shouldShowChrome({
        shown: true,
        playing: isPlaying,
        pinned: scrubbing.current,
        hasError: false,
        msSinceInteraction: since,
      });
      if (!keep) {
        setShown(false);
        return;
      }
      t = setTimeout(check, since <= HIDE_AFTER_MS ? HIDE_AFTER_MS - since + 20 : 300);
    };
    t = setTimeout(check, Math.max(0, HIDE_AFTER_MS - (Date.now() - touchedAt.current)) + 20);
    return () => {
      if (t) clearTimeout(t);
    };
  }, [shown, isPlaying, menu, switching, failed, status, drawerOpen]);

  /*
    ЭТИ ЗНАЧЕНИЯ ОБЪЯВЛЕНЫ ЗДЕСЬ, А НЕ РЯДОМ С ЖЕСТОМ ЗАКРЫТИЯ, И ЭТО ВАЖНО.

    Их читает стиль панели (чтобы гаснуть по мере смахивания), а стиль собирается ВЫШЕ по
    файлу — в момент сборки экрана. Объявленные ниже, они на этот момент ещё не существуют, и
    плеер падал на первом же кадре: «Cannot read property value of undefined». Порядок строк
    здесь не вкусовщина, а условие работы.
  */
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  /** Точка, за которую тянут: к ней и стягивается кадр при закрытии. */
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);
  /** Куда кадр улетает при закрытии — задаётся по направлению последнего движения. */
  const flyX = useSharedValue(0);
  const flyY = useSharedValue(200);
  const gone = useSharedValue(0);
  /** Закрытие уже решено: возврат на место после этого не нужен. */
  const closing = useSharedValue(0);
  /** Жест закрытия разрешён: не с краю под панелью и одним пальцем. */
  const armed = useSharedValue(1);
  /** Видна ли панель — жесту нужно знать это в своём потоке. */
  const chromeOn = useSharedValue(1);

  /*
    ПОВОРОТ ЭКРАНА.

    При смене ориентации система мгновенно пересчитывает ширину, безопасные поля и раскладку, и
    панель на один кадр оказывается собранной по старым числам: кнопки разъезжаются, полоса
    прыгает, знак дёргается. Починить «чтобы не пересчитывалось» нельзя — пересчёт и есть поворот.
    Зато можно не показывать его: панель гаснет на время поворота и возвращается уже собранной.
    Кадр при этом виден всё время, прячется только оправа.
  */
  const { width: winW, height: winH } = usePlayerWindow();
  const landscape = winW > winH;
  /*
    ПОЛЯ ПО БОКАМ — ДО ОСТРОВА, С ОБЕИХ СТОРОН.

    Лёжа «остров» (Dynamic Island) занимает одну боковую кромку. Раньше полоса и кнопки шли почти
    до краёв экрана и с той стороны подлезали к нему, а с другой — прилипали к рамке. Теперь
    поле с обеих сторон одинаковое и равно полю острова: панель стоит симметрично и вся — в
    спокойной зоне экрана. Стоя — обычные двенадцать точек.
  */
  const sidePad = landscape ? Math.max(insets.left, insets.right) + 8 : 12;
  /** Лежит ли экран — для фона при закрытии (см. «Лёжа — фон не тает»). */
  const wideSV = useSharedValue(landscape ? 1 : 0);
  /** Чёрный поверх страницы на миг закрытия лёжа (см. finish и backdrop). */
  const cover = useSharedValue(0);
  const wideRef = useRef(landscape);
  wideRef.current = landscape;
  useEffect(() => {
    wideSV.value = landscape ? 1 : 0;
  }, [landscape, wideSV]);
  const turn = useSharedValue(1);


  /*
    ГАСИТЬ НАДО ДО ПЕРЕСЧЁТА, А НЕ ПОСЛЕ.

    Первая попытка слушала размеры окна — и опаздывала: к моменту, когда они меняются, панель УЖЕ
    пересобрана по новым числам, и скачок произошёл. Система сообщает о повороте раньше, чем
    пересчитывает раскладку, поэтому слушаем именно её: панель успевает погаснуть до перестройки
    и возвращается уже собранной.
  */
  /*
    ПОВОРОТ — ЗАНОВО ОТСЧИТЫВАТЬ ВРЕМЯ ДО СКРЫТИЯ ПАНЕЛИ (просьба Марка).

    Повернул телефон на другой бок — значит, сейчас смотрит на экран и, скорее всего, ищет кнопку:
    панель, если она видна, не должна погаснуть через миг после поворота. Скрытую панель поворот
    не показывает — только сбрасывает счёт.
  */
  const firstSide = useRef(true);
  useEffect(() => {
    if (firstSide.current) {
      firstSide.current = false;
      return;
    }
    touchedAt.current = Date.now();
    turn.value = withTiming(1, { duration: 120 });
  }, [side, turn]);

  /*
    ВОЗВРАЩАТЬ — КОГДА УСТОЯЛИСЬ И РАЗМЕРЫ, И БЕЗОПАСНЫЕ ПОЛЯ.

    Размеры окна приходят первыми, а поля (вырез, остров) — чуть позже. Панель показывалась по
    размерам — и успевала один кадр постоять растянутой до самых краёв, без полей, а потом резко
    сжаться. Теперь она возвращается через 180 мс после ПОСЛЕДНЕГО изменения любого из них.
  */
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      turn.value = withTiming(1, { duration: 240 });
    }, 180);
    return () => {
      if (settle.current) clearTimeout(settle.current);
    };
  }, [landscape, winW, winH, insets.left, insets.right, insets.top, insets.bottom, turn]);

  const fade = useSharedValue(1);
  useEffect(() => {
    chromeOn.value = shown ? 1 : 0;
  }, [shown, chromeOn]);
  useEffect(() => {
    // Затухание, а не вставка узлов: дерево панели строится один раз и живёт всё время.
    // Появление — быстро: касание должно ощущаться мгновенным. Уход — мягче, он никого не ждёт.
    const fast = fastFade.current;
    fastFade.current = false;
    fade.value = withTiming(shown ? 1 : 0, { duration: fast ? 70 : shown ? 120 : 260 });
  }, [shown, fade]);
  /*
    ПАНЕЛЬ ГАСНЕТ ПО МЕРЕ СМАХИВАНИЯ.

    Уезжающий кадр с живой панелью поверх выглядит как два разных экрана, уехавших вместе. Стоит
    панели пропасть в первые же точки движения — и в руке остаётся просто картинка, которую
    убирают. Гаснет быстрее, чем едет кадр (втрое), поэтому исчезает практически сразу.
  */
  /** Верх и середина уходят, когда открыт список серий: остаются полоса, кнопки и лента. */
  const drawerAside = useAnimatedStyle(() => ({ opacity: (1 - drawer.value) * (1 - quiet.value) }));
  /*
    СО СПИСКОМ СЕРИЙ ОСТАЁТСЯ ТОЛЬКО СПИСОК.

    Полоса и кнопки больше не поднимаются над лентой, а уходят: смотреть серии через частокол
    кнопок было тесно. Время остаётся — маленькой строкой у верхнего края экрана.
  */
  const drawerLift = useAnimatedStyle(() => ({
    opacity: (1 - Math.min(1, drawer.value * 1.4)) * (1 - quiet.value),
  }));
  const drawerClock = useAnimatedStyle(() => ({ opacity: drawer.value }));
  /*
    Часы сверху проступают вместе со списком (их прозрачность — сам drawer), поэтому идти им нужно
    ровно тогда, когда список хоть немного выдвинут, — и пальцем, и пружиной (см. TopClock).
  */
  const [clockLive, setClockLive] = useState(false);
  useAnimatedReaction(
    () => drawer.value > 0,
    (on, was) => {
      if (on !== was) runOnJS(setClockLive)(on);
    },
  );
  /*
    Стрелка покачивается ОДИН раз — когда панель появляется: заметить, но не мельтешить всё время.
  */
  const bob = useSharedValue(0);
  useEffect(() => {
    if (!shown || drawerOpen) return;
    bob.value = withSequence(
      withDelay(250, withTiming(-4, { duration: 220, easing: Easing.out(Easing.quad) })),
      withTiming(0, { duration: 240, easing: Easing.in(Easing.quad) }),
      withTiming(-2, { duration: 170 }),
      withTiming(0, { duration: 190 }),
    );
  }, [shown, drawerOpen, bob]);
  const pullBob = useAnimatedStyle(() => ({ transform: [{ translateY: bob.value }] }));
  const drawerSheet = useAnimatedStyle(() => ({
    opacity: Math.min(1, drawer.value * 1.6),
    transform: [{ translateY: (1 - drawer.value) * (DRAWER_H * 0.6) }],
  }));
  const subsAway = useAnimatedStyle(() => {
    const far = Math.sqrt(dragX.value * dragX.value + dragY.value * dragY.value);
    return { opacity: (1 - Math.min(1, far / 90)) * (1 - gone.value) };
  });
  /*
    ПОВОРОТ — ПАНЕЛЬ ТЯНЕТСЯ ЦЕЛИКОМ, ОДНИМ ДВИЖЕНИЕМ.

    Пробовали гасить панель на повороте (мигала), пробовали плавно двигать каждую часть к новому
    месту (части ехали вразнобой, кнопка плей «ускакивала»). Теперь панель сразу собирается по
    новым размерам, но показывается сжатой/растянутой до СТАРЫХ пропорций — и за 0,38 с
    вытягивается (в альбомную) или сжимается (в портрет) к настоящим. Всё движется вместе, как
    одно полотно, синхронно с поворотом самого экрана.
  */
  const stretchX = useSharedValue(1);
  const stretchY = useSharedValue(1);
  const lastDims = useRef({ w: winW, h: winH });
  useLayoutEffect(() => {
    const prev = lastDims.current;
    lastDims.current = { w: winW, h: winH };
    if (prev.w === winW && prev.h === winH) return;
    stretchX.value = prev.w / winW;
    stretchY.value = prev.h / winH;
    const ease = { duration: 380, easing: Easing.out(Easing.cubic) };
    stretchX.value = withTiming(1, ease);
    stretchY.value = withTiming(1, ease);
  }, [winW, winH, stretchX, stretchY]);

  const chrome = useAnimatedStyle(() => {
    const far = Math.sqrt(dragX.value * dragX.value + dragY.value * dragY.value);
    const away = Math.min(1, far / 90);
    return {
      opacity: fade.value * turn.value * (1 - away) * (1 - gone.value),
      transform: [{ scaleX: stretchX.value }, { scaleY: stretchY.value }],
    };
  });

  // --------------------------------------------------------------- журнал просмотра

  const store = useCallback(
    (ms: number) => {
      // Во время подмены время в плеере ещё от прошлого потока — записать его значит испортить новую серию.
      if (!req || durMs.current <= 0 || swapping.current) return;
      saveProgress({
        key: req.mediaKey,
        positionMs: ms,
        durationMs: durMs.current,
        title: req.title,
        episodeLabel: req.subtitle ?? undefined,
        posterUrl: req.posterUrl,
        backdropUrl: req.backdropUrl,
        mediaId: req.mediaId,
        mediaType: req.mediaType,
        season: req.season ?? undefined,
        episode: req.episode ?? undefined,
      });
    },
    [req],
  );

  useEffect(() => {
    const t = setInterval(() => store(posMs.current), SAVE_MS);
    return () => {
      clearInterval(t);
      store(posMs.current);
    };
  }, [store]);

  /*
    Журнал во время кино пишется на диск раз в полминуты и экранов не будит (watchProgress.ts).
    Уход из плеера — сразу на диск и сразу на главную: «Продолжить просмотр» должен стоять на новом
    месте, когда плеер уехал. Стоит ПОСЛЕ эффекта выше нарочно: при разборе экрана React снимает
    эффекты по порядку, и последняя позиция (store в его уборке) успевает лечь в журнал до записи.
  */
  useEffect(() => () => flushWatchProgress(true), []);

  // Пауза — тоже повод записать на диск сразу: с паузы чаще всего и уходят из приложения.
  // Пауза на время ведения ползунка — не пауза: место ещё едет под пальцем.
  useEffect(() => {
    if (isPlaying || scrubbing.current) return;
    store(posMs.current);
    flushWatchProgress();
  }, [isPlaying, store]);

  // --------------------------------------------------------------- переключения

  const swap = useCallback(
    (next: PlaybackRequest, positionMs: number) => {
      setSwitching(true);
      setReq(next);
      setMenu(null);
      // Дорожки прошлого файла — долой: новые придут событием плеера (см. applyTracks).
      setTracks({ subs: [], audio: [] });
      setAudioPick(null);
      startSwap(
        { uri: next.url, headers: next.headers, contentType: next.isHls ? ('hls' as const) : ('progressive' as const), metadata: nowPlaying(next) },
        positionMs,
      );
    },
    [startSwap],
  );

  /*
    ЗАПАСНОЙ ИСТОЧНИК — САМ, БЕЗ ВОПРОСОВ.

    Ссылка, которую дал источник, может не открыться: раздача отказала, узел мёртв, срок истёк.
    Раньше это означало вечную загрузку или ошибку. Теперь плеер сам просит следующий вариант —
    другую озвучку того же источника или следующий источник по порядку — и встаёт на то же место.
    Человек видит короткую заминку, а не экран с ошибкой.

    Признаков отказа два: явная ошибка плеера и загрузка, которая тянется дольше разумного.
    Предел числа подмен — чтобы при полном отказе всех источников не крутиться по кругу.
  */
  const fallbacks = useRef(0);
  const MAX_FALLBACKS = 12;
  const STUCK_MS = 20_000;

  const tryNext = useCallback(async (why: string) => {
    if (!req) return;
    // В журнал (настройки → «Журнал выбора»): какой источник не поднялся и почему.
    say(`ЛЮМЬЕР · плеер · ${req.sourceName} «${req.choices.find((c) => c.index === req.choice)?.voice ?? '—'}» не поднялся: ${why}`);
    if (fallbacks.current >= MAX_FALLBACKS) {
      setFailed('Не открылось ни в одном источнике.');
      return;
    }
    fallbacks.current += 1;
    const pos = posMs.current || req.startPositionMs;
    const next = await nextFallback(req).catch(() => null);
    if (!alive.current) return;
    if (next) swap(next, pos);
    else setFailed('Не открылось ни в одном источнике.');
  }, [req, swap]);

  // Явная ошибка.
  useEffect(() => {
    if (status === 'error') void tryNext(playerError?.message ?? 'ошибка плеера');
  }, [status, tryNext, playerError]);

  // Загрузка, которая не кончается.
  useEffect(() => {
    if (status !== 'loading') return;
    const t = setTimeout(() => void tryNext(`загрузка дольше ${STUCK_MS / 1000} с`), STUCK_MS);
    return () => clearTimeout(t);
  }, [status, req?.url, tryNext]);

  // Поток пошёл — счётчик подмен обнуляется: следующая беда начнётся с чистого листа.
  useEffect(() => {
    if (status === 'readyToPlay') fallbacks.current = 0;
  }, [status]);

  /*
    МЕНЮ ОЗВУЧЕК ДОПОЛНЯЕТСЯ НА ХОДУ.

    Кино включается с первого годного источника, а остальные ещё отвечают в фоне. Их голоса
    приходят сюда отдельно от запроса: подменять сам запрос нельзя — от него зависят таймеры
    запасного источника и запись позиции, и каждое пополнение сбрасывало бы их.
  */
  const [more, setMore] = useState<{ key: string; choices: PlaybackRequest['choices'] } | null>(null);
  useEffect(() => {
    const key = req?.mediaKey;
    if (!key) return;
    return watchChoices(key, (choices) => setMore({ key, choices }));
  }, [req?.mediaKey]);

  /*
    СКАЧАННОЕ + СЕТЬ. Играет файл с телефона; если интернет есть, источники дописывают остальные
    серии сериала и номер IMDb (по нему найдутся субтитры онлайн). Озвучки приходят обычным путём
    (watchChoices выше). Сети нет — сюда ничего не придёт, и останется только скачанное.
  */
  useEffect(() => {
    const key = req?.mediaKey;
    if (!key || req?.sourceId !== 'offline') return;
    return watchOffline(key, (x) =>
      setReq((cur) => {
        if (!cur || cur.mediaKey !== key) return cur;
        const episodes = x.episodes.length > cur.episodes.length ? x.episodes : cur.episodes;
        const currentEpisode = cur.season
          ? episodes.findIndex((e) => e.season === cur.season && e.episode === cur.episode)
          : cur.currentEpisode;
        return { ...cur, imdb: cur.imdb ?? x.imdb, episodes, currentEpisode };
      }),
    );
  }, [req?.mediaKey, req?.sourceId]);

  /** Другая озвучка того же источника — это другая ссылка, а не дорожка внутри файла. */
  const pickVoiceChoice = async (index: number, track?: string) => {
    if (!req || (index === req.choice && !track)) {
      setMenu(null);
      return;
    }
    const pos = posMs.current;
    setSwitching(true);
    const next = await pickChoice(req, index, track).catch(() => null);
    if (!alive.current) return;
    if (next) swap(next, pos);
    else {
      setSwitching(false);
      setMenu(null);
    }
  };

  /*
    ЗДЕСЬ БЫЛИ ВЫБОР КАЧЕСТВА И ВЫБОР ОЗВУЧКИ — ОБА ИСЧЕЗЛИ, И ПО РАЗНЫМ ПРИЧИНАМ.

    Качество: источник отдаёт master-плейлист, внутри которого все качества сразу, и плеер
    переключает их сам по ширине канала. Ручной выбор здесь был бы выбором «хуже, чем авто».

    Озвучка: дорожки лежат ВНУТРИ того же файла. Сменить озвучку — это player.audioTrack, то есть
    меню «Аудио» ниже. Ни запроса, ни пересборки ссылки, ни запасного «Оригинала» на случай, если
    серии в выбранном дубляже не окажется, — всего того, из-за чего прошлый источник не работал.
  */

  const goEpisode = async (season: string, episode: string) => {
    if (!req) return;
    store(posMs.current);
    setSwitching(true);
    const next = await changeEpisode(req, Number(season), Number(episode));
    if (!next) {
      setSwitching(false);
      setMenu(null);
      return;
    }
    swap(next, next.startPositionMs);
  };

  /** Другая часть фильма: свой запрос к источнику, с места, где эту часть остановили. */
  const goPart = async (m: MediaItem) => {
    if (!req || m.id === req.mediaId) return;
    store(posMs.current);
    setSwitching(true);
    const next = await movieRequest(m).catch(() => null);
    if (!alive.current) return;
    if (!next) {
      setSwitching(false);
      return;
    }
    swap(next, next.startPositionMs);
  };

  const step = (delta: number) => {
    if (!req) return;
    if (parts) {
      const m = parts[partIndex + delta];
      if (m) void goPart(m);
      return;
    }
    const i = req.currentEpisode + delta;
    const e = req.episodes[i];
    if (e) void goEpisode(e.season, e.episode);
  };

  /*
    ПЕРЕМОТКА ДВОЙНЫМ КАСАНИЕМ У КРАЁВ — КАК В ЮТУБЕ (кнопки ±10 убраны).

    Двойное касание справа — вперёд на десять секунд, слева — назад. Пока подсказка у края не
    погасла, каждое следующее ОДИНОЧНОЕ касание той же стороны добавляет ещё десять: так листают
    «10, 20, 30», не стуча дважды каждый раз. Время считается от последней цели, а не от того, что
    сообщает плеер: он узнаёт новое место только догрузив его, и быстрые касания иначе терялись бы.
  */
  const NUDGE_MS = 10_000;
  const NUDGE_HOLD_MS = 650;
  const [nudge, setNudge] = useState<Nudge | null>(null);
  const nudgeRef = useRef<{ side: -1 | 1; total: number; tick: number; target: number } | null>(null);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
  }, []);

  const sideOf = (x: number): -1 | 0 | 1 => (x < winW * 0.36 ? -1 : x > winW * 0.64 ? 1 : 0);

  const doNudge = (side: -1 | 1, x: number, y: number) => {
    const prev = nudgeRef.current;
    const same = prev && prev.side === side;
    const from = same ? prev.target : posMs.current;
    const target = Math.max(0, Math.min(durMs.current || Infinity, from + side * NUDGE_MS));
    const next = { side, total: same ? prev.total + 10 : 10, tick: (prev?.tick ?? 0) + 1, target };
    nudgeRef.current = next;
    setNudge({ side, total: next.total, tick: next.tick, x, y });
    setSeekTarget({ ms: target });
    player.currentTime = target / 1000;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
    nudgeTimer.current = setTimeout(() => {
      nudgeRef.current = null;
      setNudge(null);
    }, NUDGE_HOLD_MS);
  };

  /*
    Меню открывается и всё. Раньше здесь же догружались субтитры «Оригинала»: у прошлого источника
    они лежали в другой озвучке, и за ними надо было сходить отдельным запросом в момент открытия
    вкладки. Теперь субтитры приезжают вместе с серией, и догружать нечего.
  */
  /**
   * ГДЕ ОТКРЫВАТЬ МЕНЮ.
   *
   * Посреди экрана оно открывалось «ниоткуда»: связь между нажатой кнопкой и всплывшим списком
   * приходилось достраивать в уме. Меню должно вырастать из своей кнопки — тогда и возврат взгляда
   * к ней после выбора происходит сам собой.
   *
   * Координата кнопки известна ВНУТРИ ряда, а ряд ещё и мотается. Поэтому из неё вычитается
   * текущая прокрутка и прибавляется левое поле ряда — получается место на экране.
   */
  const chipsScrollX = useRef(0);
  const chipsDragging = useRef(false);
  const [anchorX, setAnchorX] = useState<number | null>(null);

  /*
    ВКЛАДКИ — ОДНИМ КАСАНИЕМ.

    Раньше открытое меню закрывало собой весь экран: чтобы из «Озвучки» попасть в «Скорость»,
    надо было сначала коснуться мимо (закрыть) и только потом нажать нужную кнопку. Теперь кнопки
    под меню остаются живыми: касание другой кнопки сразу открывает её меню, касание той же —
    закрывает, касание по кадру — тоже закрывает.
  */
  const openMenu = (which: Menu, x?: number) => {
    if (menuRef.current === which) {
      setMenu(null);
      touch();
      return;
    }
    const pad = sidePad;
    setAnchorX(typeof x === 'number' ? x - chipsScrollX.current + pad : null);
    if (drawerOpenRef.current) closeDrawer();
    setMenu(which);
    touch();
  };

  /*
    СУБТИТРЫ ПОМНЯТ ЯЗЫК, А НЕ ФАЙЛ.

    Файл субтитров — это одна серия. Раньше при переходе к следующей на экране оставались строки
    прошлой (или исчезали насовсем), и включать их приходилось заново. Теперь запоминается выбор —
    «русские» — и у новой серии сам включается файл того же языка, как только он найдётся.
  */
  const subLang = useRef<string | null>(null);
  const [subsNote, setSubsNote] = useState<'ищем' | 'готово'>('ищем');

  const pickOwnSub = (track: SubtitleTrack) => {
    setMenu(null);
    subLang.current = track.lang ?? track.label;
    if (ownSubs?.url === track.url) return;
    setOwnSubs(null);
    player.subtitleTrack = null;
    // Субтитры OpenSubtitles — архивом с их сервера; остальные — файлом с раздачи источника.
    // Скачанные вместе с видео — файлом с телефона; OpenSubtitles — архивом с их сервера;
    // остальные — файлом с раздачи источника.
    const load = track.url.startsWith('file://')
      ? new ExpoFile(track.url).text().then(parseCues)
      : track.url.startsWith(OPENSUBS)
        ? loadOpenSubtitle(track.url).then((t) => (t ? parseCues(t) : []))
        : loadCues(track.url, req?.headers);
    void load
      .then((cues) => {
        if (alive.current && cues.length > 0) setOwnSubs({ url: track.url, cues });
      })
      .catch(() => undefined);
  };

  /*
    СУБТИТРЫ ДЛЯ ЛЮБОГО ФИЛЬМА.

    Балансеры дают субтитры не всегда: у одних они есть, у других нет вовсе. Поэтому, как у Влада,
    к каждой серии и фильму с номером IMDB отдельно ищутся русские, английские и немецкие на
    OpenSubtitles. Ищется сразу при открытии — к моменту, когда человек откроет меню, список уже
    готов; скачивается только выбранный.
  */
  useEffect(() => {
    const imdb = req?.imdb;
    setSubsNote('ищем');
    if (!imdb) {
      setSubsNote('готово');
      return;
    }
    let dead = false;
    const s = req?.season ? Number(req.season) : null;
    const e = req?.episode ? Number(req.episode) : null;
    void findOnlineSubtitles(imdb, s, e).then(({ tracks: found, note }) => {
      if (dead) return;
      setSubsNote('готово');
      say(`ЛЮМЬЕР · субтитры · ${found.map((t) => t.label).join(', ') || 'не нашлись'} (${note})`);
      if (found.length === 0) return;
      setReq((cur) => {
        if (!cur) return cur;
        const have = new Set(cur.subtitleTracks.map((t) => t.url));
        // Язык, уже скачанный вместе с видео, второй раз (онлайн) не показываем.
        const local = new Set(cur.subtitleTracks.filter((t) => t.url.startsWith('file://')).map((t) => t.lang ?? ''));
        const extra = found.filter((t) => !have.has(t.url) && !(t.lang && local.has(t.lang)));
        return extra.length ? { ...cur, subtitleTracks: [...cur.subtitleTracks, ...extra] } : cur;
      });
    });
    return () => {
      dead = true;
    };
    // И при подмене на запасной источник: у нового запроса свой список, найденное надо вернуть.
  }, [req?.imdb, req?.season, req?.episode, req?.url]);

  // Другая серия — строки прошлой с экрана долой.
  useEffect(() => {
    setOwnSubs(null);
  }, [req?.mediaKey]);

  // У новой серии нашёлся файл выбранного языка — включаем его сами.
  useEffect(() => {
    const want = subLang.current;
    if (!req || !want || ownSubs) return;
    const t = req.subtitleTracks.find((x) => (x.lang ?? x.label) === want);
    if (t) pickOwnSub(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.subtitleTracks, req?.mediaKey, ownSubs]);

  const pickSpeed = (v: number) => {
    setSpeed(v);
    player.playbackRate = v;
    setMenu(null);
  };

  /*
    ЗАКРЫТИЕ ПЛЕЕРА.

    Было: нажал «назад» — экран мгновенно исчезает, и ПРЯМО В ЭТОТ МОМЕНТ система возвращает
    портретный замок. Поворот происходит на глазах, под ним страница тайтла пересобирает раскладку,
    и всё вместе читается как сбой.

    Стало: сначала кадр уезжает вниз, уменьшаясь и округляя углы, — как системный плеер у Apple, —
    и только когда он уже чёрный, под ним тихо происходит поворот. Видно ровно то, что должно:
    кино ушло.

    Смахиванием — тем же путём, но под пальцем. Жест висит на кадре, а не на всём экране: панель
    лежит выше и забирает свои касания себе, поэтому ни ползунок, ни кнопки случайно его не
    запускают. Он просыпается только от движения ВНИЗ (вверх — ничего) и срывается при заметном
    уходе вбок: горизонталь принадлежит строке кнопок и точной перемотке.
  */
  /*
    КАСАНИЕ ПО КАДРУ — МГНОВЕННО В ОБЕ СТОРОНЫ.

    Панель появляется И прячется в момент касания — без ожидания «а вдруг будет второе». Двойное
    касание у края распознаётся по времени, и второе касание срабатывает уже в момент ПРИКОСНОВЕНИЯ
    пальца, а не когда его подняли: перемотка отвечает так же быстро, как сама панель.

    При двойном касании у края панель, переключённая первым касанием, сразу возвращается как была
    (см. onTapDown) — перемотка идёт без висящей панели.
  */
  // Окно двойного касания короче (220 мс): два спокойных касания «показать — спрятать» панель
  // больше не читаются как перемотка.
  const TAP_GAP_MS = 220;
  const lastTap = useRef<{ at: number; side: -1 | 0 | 1 } | null>(null);
  /** Касание уже отработало как перемотка в момент прикосновения — отпускание ничего не делает. */
  const tapConsumed = useRef(false);
  /** Какой была панель до одиночного касания у края — чтобы вернуть её при двойном (onTapDown). */
  const tapToggled = useRef<{ at: number; was: boolean } | null>(null);
  /** Следующее скрытие панели — быстрым (возврат после двойного касания). */
  const fastFade = useRef(false);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  // Панель погасла — «тихий» режим больше не нужен.
  useEffect(() => {
    if (!shown && quietRef.current) endQuiet('gone');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const onTapDown = useCallback(
    (x: number, y: number) => {
      tapConsumed.current = false;
      const side = sideOf(x);
      if (side === 0) return;
      const prev = lastTap.current;
      // Перемотка — только двойным касанием, и следующая тоже двойным (не каждым тапом).
      if (prev && prev.side === side && Date.now() - prev.at < TAP_GAP_MS) {
        tapConsumed.current = true;
        lastTap.current = null;
        /*
          Это двойное касание: панель, которую первое касание успело переключить, — вернуть как
          было, быстро. Панель появляется мгновенно (без ожидания второго касания), а при двойном
          тут же уходит — перемотка идёт без висящей панели.
        */
        const undo = tapToggled.current;
        tapToggled.current = null;
        if (undo && Date.now() - undo.at < TAP_GAP_MS + 80 && shownRef.current !== undo.was) {
          fastFade.current = true;
          // Была видна — вернуть через touch(): заодно заново пойдут часы автоскрытия.
          if (undo.was) touch();
          else setShown(false);
        }
        doNudge(side, x, y);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [winW, player],
  );

  const onCatcherTap = useCallback(
    (x: number) => {
      if (tapConsumed.current) {
        tapConsumed.current = false;
        return;
      }
      // Открыто меню — касание по кадру его закрывает (и только).
      if (menuRef.current) {
        setMenu(null);
        touch();
        return;
      }
      // Открыт список серий — касание по кадру его закрывает.
      if (drawerOpenRef.current) {
        closeDrawer();
        return;
      }
      lastTap.current = { at: Date.now(), side: sideOf(x) };
      // Пока висит «+10» у этого края, одиночное касание — первая половина следующего двойного:
      // панель не дёргается.
      if (nudgeRef.current && nudgeRef.current.side === sideOf(x)) return;
      const toggle = () => {
        // Панель включена ради «тихого» списка, но её не видно — касание её показывает, а не прячет.
        if (quietRef.current) {
          endQuiet('show');
          touch();
          return;
        }
        if (shownRef.current) setShown(false);
        else touch();
      };
      /*
        ДВОЙНОЕ КАСАНИЕ — БЕЗ ПАНЕЛИ (решение Марка), но и без ожидания: панель переключается в
        момент касания, как раньше. Если следом пришло второе касание (перемотка у края), панель
        тут же возвращается как была (см. onTapDown) — короткой вспышкой, а не висящей панелью.
      */
      if (sideOf(x) !== 0) tapToggled.current = { at: Date.now(), was: shownRef.current };
      toggle();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [touch, winW],
  );


  /*
    ЗАКРЫТИЕ — СРАЗУ, БЕЗ ЧЁРНОЙ ПАУЗЫ.

    Плеер теперь прозрачное окно поверх страницы тайтла: пока кадр улетает, под ним уже видна
    страница, а не чёрный экран. Ждать «пока погаснет», чтобы спрятать поворот, больше незачем —
    как только кадр улетел, окно закрывается; портретный замок вернёт сам уход с экрана.
  */
  const finish = useCallback(() => {
    store(posMs.current);
    // Окно и так стоит: кадр улетел — под ним стоящая страница, закрываемся сразу.
    router.back();
  }, [store]);

  /*
    УЛЁТ — С ТОЙ СКОРОСТЬЮ, С КОТОРОЙ ОТПУСТИЛИ. Раньше кадр после отпускания на миг замирал и
    разгонялся заново (кривая «с разгона»), и это читалось как прыжок. Теперь ход равномерный, а
    длительность подобрана под скорость пальца: быстро смахнул — быстро улетел.
  */
  const leave = useCallback(
    (ms = 190) => {
      if (gone.value > 0) return;
      gone.value = withTiming(1, { duration: ms, easing: Easing.linear }, (done) => {
        if (done) runOnJS(finish)();
      });
    },
    [finish, gone],
  );

  /** Насколько далеко надо утянуть, чтобы отпускание закрывало, а не возвращало. */
  const CLOSE_AT = 90;
  /** Полосы у краёв, откуда смахивание не начинается, пока видна панель. */
  const EDGE_TOP = insets.top + 90;
  const EDGE_BOTTOM = insets.bottom + 150;

  /*
    Пороги — в осях лежачего кадра (orientPan): «вниз» — это вниз по кадру, как бы он ни лежал
    в стоячем окне. Смещение и скорость переводятся так же (stageMotion).
  */
  /*
    ЖЕСТЫ КАДРА СОБИРАЮТСЯ ЗАНОВО, ТОЛЬКО КОГДА МЕНЯЕТСЯ ТО, ОТ ЧЕГО ОНИ ЗАВИСЯТ (сторона, размеры,
    открыт ли список). Раньше каждая перерисовка плеера строила четыре новых жеста, и обработчик
    жестов заново получал их настройку и функции для потока отрисовки. Общие значения постоянны.
  */
  const dismiss = useMemo(() => orientPan(Gesture.Pan(), side, { activeY: 10, activeX: [-14, 14], failY: -8 })
    // Любая сторона: вниз, вбок, по диагонали вверх. Порог общий — 18 точек в любом направлении.
    /*
      ЗАЩИТА ОТ ДУРАКА: ВВЕРХ — НИКОГДА НЕ ЗАКРЫВАЕТ.

      Свайп вверх теперь открывает список серий. Чтобы, промахнувшись, не смахнуть кино, этот жест
      просыпается только от движения вниз или вбок и тут же сдаётся, если палец сначала пошёл вверх.
      И даже начавшись, он не закроет плеер, если в итоге палец ушёл вверх.

      Порог проснуться — десять точек, а не восемнадцать: кадр отзывается сразу, как его тронули.
    */
    .enabled(!drawerOpen)
    /*
      ОДИН ПАЛЕЦ — И ЭТО ГЛАВНОЕ ЗДЕСЬ.

      Щипок — это два пальца, которые расходятся, и их общий центр почти всегда уезжает: для
      «смахивания» это выглядело как уверенное движение в сторону, поэтому масштабирование то и
      дело закрывало фильм. Жест закрытия теперь просыпается только от ОДНОГО пальца, а появление
      второго его отменяет.
    */
    .maxPointers(1)
    /*
      ВТОРОЙ ПАЛЕЦ — ЖЕСТ СНЯТ СРАЗУ, А НЕ КОГДА-НИБУДЬ.

      maxPointers не спасал: первый палец щипка ложится раньше второго, успевает пройти свои
      восемнадцать точек — и смахивание уже началось. Теперь появление второго пальца в любой
      момент жеста отменяет его на месте.
    */
    .onTouchesDown((e, manager) => {
      if (e.numberOfTouches > 1) {
        armed.value = 0;
        manager.fail();
      }
    })
    .onBegin((e) => {
      focalX.value = e.x;
      focalY.value = e.y;
      /*
        НЕ ИЗ-ПОД ПАНЕЛИ.

        Пока панель видна, смахивание не начинается у её краёв — сверху, где «назад» и знак, и
        снизу, где полоса и кнопки. Палец, промахнувшийся мимо кнопки на пару точек, листает или
        нажимает, а не закрывает фильм. Когда панели нет, весь кадр — зона закрытия.
      */
      const nearEdge = e.y < EDGE_TOP || e.y > winH - EDGE_BOTTOM;
      armed.value = chromeOn.value && nearEdge ? 0 : 1;
    })
    .onUpdate((e) => {
      if (!armed.value || e.numberOfPointers > 1) {
        armed.value = 0;
        return;
      }
      const m = stageMotion(e, side);
      dragX.value = m.tx;
      // Вверх кадр почти не идёт — немного, чтобы было видно, что он живой, но не уезжает.
      dragY.value = m.ty < 0 ? m.ty * 0.25 : m.ty;
    })
    .onEnd((e) => {
      if (!armed.value) return;
      const m = stageMotion(e, side);
      // Путь в итоге вверх — не закрываем ни при какой скорости.
      if (m.ty < -16 || m.vy < -350) return;
      const far = Math.hypot(m.tx, Math.max(0, m.ty));
      /*
        ПЕРЕДУМАЛ — НЕ ЗАКРЫВАЕТ. Скорость учитывается только ПО НАПРАВЛЕНИЮ ухода: палец, который
        вернул кадр обратно (даже быстро), закрытием больше не считается. И близко к месту старта
        кадр закрыть нельзя никакой скоростью.
      */
      const along = far > 1 ? (m.vx * m.tx + Math.max(0, m.vy) * Math.max(0, m.ty)) / far : 0;
      const fast = Math.hypot(m.vx, Math.max(0, m.vy));
      // Палец уже возвращает кадр назад — это «передумал», даже если увёл далеко.
      if (along < -250) return;
      if (far > CLOSE_AT || (along > 900 && far > 36)) {
        /*
          УХОД — РОВНО ПО ТОЙ ЛИНИИ, ПО КОТОРОЙ ВЕЛИ. Раньше направление округлялось до «вбок и
          вниз по диагонали» (знаки смещения), и кадр, отпущенный почти вертикально, на лету
          сворачивал на 45°. Теперь берётся сам вектор: быстрое смахивание — по скорости пальца,
          медленное — по тому, куда кадр уже утянули.
        */
        const useV = fast > 600;
        let dx = useV ? m.vx : dragX.value;
        let dy = useV ? Math.max(0, m.vy) : Math.max(0, dragY.value);
        const len = Math.hypot(dx, dy);
        if (len < 1) {
          dx = 0;
          dy = 1;
        } else {
          dx /= len;
          dy /= len;
        }
        const DIST = 480;
        flyX.value = dx * DIST;
        flyY.value = dy * DIST;
        const speed = Math.max(fast, 1400);
        const ms = Math.min(300, Math.max(140, (DIST / speed) * 1000));
        closing.value = 1;
        runOnJS(leave)(ms);
      }
    })
    /*
      ВОЗВРАТ — В onFinalize, А НЕ В onEnd.

      onEnd зовётся только при обычном отпускании. Если жест сорвался — лёг второй палец, вмешался
      щипок, система забрала касание, — onEnd не наступает, и кадр оставался сдвинутым, а панель
      (её прозрачность зависит от сдвига) — невидимой. Именно так её и «невозможно было вызвать».
      onFinalize наступает всегда.
    */
    .onFinalize(() => {
      if (closing.value) return;
      dragX.value = withSpring(0, { damping: 18, stiffness: 220, mass: 0.7 });
      dragY.value = withSpring(0, { damping: 18, stiffness: 220, mass: 0.7 });
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [side, drawerOpen, EDGE_TOP, EDGE_BOTTOM, winH, leave],
  );

  /*
    ЩИПОК — КАК В ЮТУБЕ, А НЕ ПРОИЗВОЛЬНЫЙ МАСШТАБ.

    Произвольное увеличение в плеере бесполезно: кадр и так во всю ширину, а увеличенный вручную
    он уезжает за край и его приходится возить пальцем. Полезно ровно одно переключение — вписать
    кадр целиком или заполнить им экран, обрезав поля. Поэтому щипок не меняет масштаб плавно, а
    перещёлкивает между этими двумя состояниями, и щелчок подтверждается откликом.
  */
  const pinch = useMemo(() => Gesture.Pinch()
    .onBegin(() => {
      // Если закрытие уже успело начаться — отматываем его назад: человек масштабирует, а не уходит.
      dragX.value = withSpring(0, { damping: 18, stiffness: 240 });
      dragY.value = withSpring(0, { damping: 18, stiffness: 240 });
    })
    .onEnd((e) => {
    if (e.scale > 1.15) runOnJS(setFit)('cover');
    else if (e.scale < 0.88) runOnJS(setFit)('contain');
  }), [dragX, dragY, setFit]);

  /*
    СВАЙП ВВЕРХ — СПИСОК СЕРИЙ (только у сериалов).

    Палец ведёт ленту: полоса с кнопками поднимается ровно настолько, насколько подняли палец.
    Отпустили выше середины или быстро вверх — открыто; иначе — назад. Открытый список закрывается
    тем же движением вниз.
  */
  const drawerFrom = useSharedValue(0);
  const hasEpisodes = (req?.episodes.length ?? 0) > 1 || (parts?.length ?? 0) > 1;
  const drawerPan = useMemo(() => orientPan(Gesture.Pan(), side, { activeY: drawerOpen ? [-12, 12] : -12, failX: [-40, 40] })
    .enabled(hasEpisodes)
    .maxPointers(1)
    .onStart(() => {
      drawerFrom.value = drawer.value;
      runOnJS(grabDrawer)();
    })
    .onUpdate((e) => {
      drawer.value = Math.min(1, Math.max(0, drawerFrom.value - stageMotion(e, side).ty / DRAWER_H));
    })
    .onEnd((e) => {
      const vy = stageMotion(e, side).vy;
      const open = vy < -300 || (vy < 300 && drawer.value > 0.4);
      runOnJS(open ? openDrawer : closeDrawer)();
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [side, drawerOpen, hasEpisodes, grabDrawer, openDrawer, closeDrawer],
  );

  // Одно касание — один вызов; двойное распознаётся по времени между касаниями (onTapDown).
  const toggleChrome = useMemo(() => Gesture.Tap()
    .maxDistance(12)
    .onBegin((e) => {
      runOnJS(onTapDown)(e.x, e.y);
    })
    .onEnd((e, ok) => {
      if (ok) runOnJS(onCatcherTap)(e.x);
    }), [onTapDown, onCatcherTap]);
  const frameGestures = useMemo(
    () => Gesture.Simultaneous(dismiss, drawerPan, pinch, toggleChrome),
    [dismiss, drawerPan, pinch, toggleChrome],
  );

  /*
    УЛЕТАЕТ САМ КАДР, А НЕ ЧЁРНЫЙ ПРЯМОУГОЛЬНИК ЭКРАНА.

    Раньше при смахивании уезжал весь экран вместе с чёрными полями вокруг кино — летела рамка,
    в которой где-то было видео. Теперь двигается только кадр, ровно по своим краям (рамка
    подогнана под пропорции видео), а чёрный фон под ним растворяется с первых же точек движения:
    за улетающим кадром видна страница фильма или список серий — то, куда возвращаемся.
  */
  /*
    РАМКА КАДРА — НА ВЕСЬ ЭКРАН, НО ПРОЗРАЧНАЯ.

    Прошлый раз рамка подгонялась под видео расчётом в JS — и при повороте экрана один кадр стояла
    по старым размерам: видео мелькало сбоку и прыгало на место. Теперь рамка — весь экран, её
    раскладывает сама система (поворот без запаздывания), а поля вокруг видео у плеера прозрачные.
    Улетает при смахивании ровно картинка, а не чёрный прямоугольник.

    Пока видео не загрузилось, картинки нет вовсе — и улетать было бы нечему. Поэтому до первого
    кадра на её месте чёрная заглушка в пропорциях видео (16:9, пока настоящие не известны).
  */
  const vs = videoTrack?.size;
  const aspect = vs && vs.width > 0 && vs.height > 0 ? vs.width / vs.height : 16 / 9;
  const hasPicture = !!vs && status === 'readyToPlay';

  /*
    ФОН ТАЕТ ПО МЕРЕ СМАХИВАНИЯ: под плеером стоящая страница (окно не поворачивается никогда —
    см. landscape.tsx), и за улетающим кадром видна она. `cover` остался от времён, когда окно
    поворачивалось и на закрытии его приходилось прятать за чёрным, — сейчас он всегда 0.
  */
  const backdrop = useAnimatedStyle(() => {
    const far = Math.sqrt(dragX.value * dragX.value + dragY.value * dragY.value);
    // Фон тает плавно и не до конца, пока ведут (за кадром видна страница, но без рывка);
    // до нуля — только когда кадр улетает.
    const k = Math.min(1, far / 380);
    const soft = 1 - 0.75 * k * k * (3 - 2 * k);
    return { opacity: Math.max(cover.value, soft * (1 - gone.value)) };
  });
  const page = useAnimatedStyle(() => {
    const far = Math.sqrt(dragX.value * dragX.value + dragY.value * dragY.value);
    const p = Math.min(1, far / 280);
    const k = Math.max(p, gone.value);
    // Уменьшается ощутимо: кадр читается как предмет, который убирают, а не как экран, который
    // чуть сдвинули.
    const sc = 1 - 0.34 * k;
    /*
      СТЯГИВАЕТСЯ К ПАЛЬЦУ, А НЕ К ЦЕНТРУ.

      Масштаб у слоя всегда считается от его середины, поэтому кадр, уменьшаясь, уползал от пальца
      к центру экрана — движение и уменьшение шли в разные стороны. Сдвиг на смещение точки касания,
      умноженное на «сколько ушло масштаба», возвращает её на место: палец остаётся на том же месте
      картинки, а всё остальное сходится к нему.
    */
    const ox = focalX.value - winW / 2;
    const oy = focalY.value - winH / 2;
    // Подтяжка к пальцу — только пока ведут: в полёте она бы уводила кадр вбок от линии ухода.
    const pull = 1 - (1 - 0.34 * p);
    return {
      transform: [
        { translateX: dragX.value + gone.value * flyX.value + ox * pull },
        { translateY: dragY.value + gone.value * flyY.value + oy * pull },
        { scale: sc },
      ],
      opacity: 1 - gone.value * 0.9,
    };
  });

  /*
    ВЫБОР В ЛЕНТЕ — ПОСТОЯННЫМИ ФУНКЦИЯМИ. Созданные прямо в разметке, они были новыми на каждой
    перерисовке, и memo у лент серий и частей не срабатывал: ленты с кадрами пересобирались вместе
    с плеером. Переход берётся из ссылки — всегда свежий, хотя сама функция одна.
  */
  const goEpisodeRef = useRef(goEpisode);
  goEpisodeRef.current = goEpisode;
  const goPartRef = useRef(goPart);
  goPartRef.current = goPart;
  const pickPart = useCallback(
    (m: MediaItem) => {
      setPicking(`p${m.id}`);
      void goPartRef.current(m).finally(() => {
        setPicking(null);
        closeDrawer();
      });
    },
    [closeDrawer],
  );
  const pickEpisode = useCallback(
    (e: EpisodeRef) => {
      setPicking(`${e.season}-${e.episode}`);
      void goEpisodeRef.current(e.season, e.episode).finally(() => {
        setPicking(null);
        closeDrawer();
      });
    },
    [closeDrawer],
  );

  if (!req) {
    return (
      <View style={styles.screen}>
        <View style={styles.center}>
          <Text style={styles.hint}>Нечего смотреть.</Text>
        </View>
      </View>
    );
  }

  /**
   * ОЗВУЧКИ ИЗО ВСЕХ ИСТОЧНИКОВ.
   *
   * Список собран каскадом: для этой серии каждый балансер, который её знает, кладёт сюда свои
   * голоса. Порядок — по качеству источника (больше озвучек и выше качество — выше в списке).
   * Источник подписан у каждого пункта: «Дубляж» у двух балансеров — это два разных файла.
   */
  /*
    Источник человеку не показывается — это неважно. Поэтому одинаковые голоса разных балансеров
    сливаются в одну строку: остаётся первая, то есть от лучшего источника (список уже упорядочен
    по числу озвучек и качеству). И голоса, уже лежащие дорожками в текущем файле, второй раз не
    показываются.
  */
  const voiceChoices = (() => {
    // Голоса, уже лежащие дорожками в играющем файле (Collaps), — второй раз ссылкой не показываем:
    // дорожка переключается мгновенно, ссылка — новой загрузкой. Сравнение по смыслу (voiceKey).
    const seen = new Set(fileAudio.length > 1 ? req.voices.map(voiceKey) : []);
    const out: { voice: string; index: number; track?: string }[] = [];
    const all = more && more.key === req.mediaKey && more.choices.length > req.choices.length ? more.choices : req.choices;
    all.forEach(({ index, ...c }) => {
      const key = voiceKey(c.voice);
      // Текущий файл с дорожками уже представлен самими дорожками выше.
      if (fileAudio.length > 1 && index === req.choice) return;
      if (seen.has(key) && index !== req.choice) return;
      seen.add(key);
      out.push({ voice: c.voice, index, track: c.track });
    });
    return out;
  })();

  const hasPrev = parts ? partIndex > 0 : req.currentEpisode > 0;
  const hasNext = parts ? partIndex >= 0 && partIndex < parts.length - 1 : req.currentEpisode >= 0 && req.currentEpisode < req.episodes.length - 1;
  const loading = status === 'loading' || switching;

  return (
    <View style={styles.stage}>
      <StatusBar hidden />
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdrop]} pointerEvents="none" />
      <Animated.View style={[StyleSheet.absoluteFill, styles.frame, page]} pointerEvents="none">
        {!hasPicture ? (
          <View style={styles.placeholderWrap}>
            <View style={[styles.placeholder, landscape ? { height: '100%' } : { width: '100%' }, { aspectRatio: aspect }]} />
          </View>
        ) : null}
        <VideoView
          ref={videoView}
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit={fit}
          nativeControls={pipPrep}
          allowsPictureInPicture
          // Свернул приложение во время показа — кадр сам уходит в маленькое окно поверх всего.
          startsPictureInPictureAutomatically
          onPictureInPictureStart={() => {
            inPip.current = true;
          }}
          onPictureInPictureStop={() => {
            inPip.current = false;
            setPipPrep(false);
          }}
        />
      </Animated.View>

      {/*
        Касание кадра показывает или прячет панель; смахивание вниз или вбок — закрывает плеер;
        свайп вверх — список серий.
      */}
      <GestureDetector gesture={frameGestures}>
        <Animated.View style={StyleSheet.absoluteFill} />
      </GestureDetector>

      {ownSubs ? (
        <Animated.View style={[StyleSheet.absoluteFill, subsAway]} pointerEvents="none">
          <Subs player={player} cues={ownSubs.cues} />
        </Animated.View>
      ) : null}

      <SeekRipple nudge={nudge} width={winW} height={winH} />

      {intro ? (
        <SkipIntro
          player={player}
          seg={intro}
          bottom={insets.bottom + 96}
          right={sidePad}
          onSkip={(ms) => {
            player.currentTime = ms / 1000;
            setSeekTarget({ ms });
            touch();
          }}
        />
      ) : null}

      <Animated.View style={[StyleSheet.absoluteFill, styles.chrome, chrome]} pointerEvents={shown ? 'box-none' : 'none'}>
        {/*
          ЗАТЕМНЕНИЕ И ВИНЬЕТКА — ЧАСТЬ ПАНЕЛИ, А НЕ КАДРА.

          Белая надпись на светлом кадре не читается, поэтому под знаком сверху и под полосой снизу
          нужна тень. Но держать её постоянно нельзя: во время просмотра любое затемнение — это
          порча картинки, за которую человек и платил. Всё это лежит ВНУТРИ панели и гаснет вместе
          с ней, поэтому в кино не остаётся ни единой тёмной полосы.

          По краям — едва заметное сгущение: оно собирает взгляд к центру и прячет границу, на
          которой затемнение иначе обрывалось бы линией.
        */}
        <LinearGradient
          colors={['rgba(0,0,0,0.62)', 'rgba(0,0,0,0.26)', 'transparent']}
          style={styles.scrimTop}
          pointerEvents="none"
        />
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.34)', 'rgba(0,0,0,0.72)']}
          style={styles.scrimBottom}
          pointerEvents="none"
        />
        <LinearGradient
          colors={['rgba(0,0,0,0.26)', 'transparent']}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={styles.scrimLeft}
          pointerEvents="none"
        />
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.26)']}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={styles.scrimRight}
          pointerEvents="none"
        />
        {/* Верх: выход и подпись того, что идёт. */}
        {/*
          ОТСТУПЫ ПО БОКАМ — ТОЖЕ БЕЗОПАСНЫЕ.

          Это видно только глазами, и я это увидел: в ЛЕЖАЧЕМ положении вырез у телефона сбоку, а
          не сверху. Я считался лишь с верхом и низом, поэтому кнопка «назад» и крайние кнопки
          уезжали под вырез и под полосу home. На бумаге отступы были, на экране — нет.
        */}
        <Animated.View style={[styles.top, { paddingTop: insets.top + 8, paddingLeft: sidePad + 4, paddingRight: sidePad + 4 }, drawerAside]}>
          <GlassButton icon="chevron.backward" size={19} diameter={40} onPress={leave} />
          <Animated.View style={styles.titles} pointerEvents="none">
            {logo ? (
              <Image source={{ uri: logo }} style={styles.logo} resizeMode="contain" />
            ) : (
              <Text style={styles.title} numberOfLines={1}>
                {req.title}
              </Text>
            )}
            {/*
              Балансер — мелко, в той же строке, что номер серии. У фильма строка состоит из него
              одного. Меняется сам, когда плеер уходит на запасной источник.
            */}
            {/* Источник («с устройства», «Collaps») — только если включено в «Для разработчиков». */}
            <Text style={styles.sub}>{[req.subtitle, devShowSource ? req.sourceName : null].filter(Boolean).join(' · ')}</Text>
          </Animated.View>
          {/*
            «КАРТИНКА В КАРТИНКЕ» — справа, напротив «назад», заодно уравновешивает ряд, и
            название остаётся по центру. Где системой не поддерживается — пустышка той же ширины.
          */}
          {PIP ? (
            <GlassButton icon="pip.enter" size={18} diameter={40} onPress={startPip} />
          ) : (
            <View style={styles.topBalance} />
          )}
        </Animated.View>

        {/*
          СЕРЕДИНА — ПО ЦЕНТРУ ЭКРАНА, А НЕ МЕЖДУ ВЕРХОМ И НИЗОМ.

          Панель раскладывает три ряда «по краям и посередине», но верхний ряд низкий, а нижний —
          с полосой времени и кнопками. Середина между ними оказывалась заметно выше центра кадра,
          и это было видно глазом. Теперь ряд вынут из потока и стоит ровно в центре.
        */}
        <Animated.View style={[styles.middleWrap, drawerAside]} pointerEvents={drawerOpen ? 'none' : 'box-none'}>
        {/*
            Кнопка плей — БЕЗ плавного перехода раскладки: она стоит ровно в центре экрана, и
            центр система пересчитывает сама вместе с поворотом. Переход раскладки вёл её от
            старых координат к новым — и при повороте она «ускакивала» в сторону.
          */}
          <Animated.View style={styles.middle}>
          {/*
            ТРИ ЖИВЫЕ КНОПКИ.

            Кнопка «плей» была прямоугольником с треугольником внутри — ни отклика на касание, ни
            смены состояния, кроме подмены значка. У Apple она ведёт себя как вещь: стекло подаётся
            под пальцем, значок уходит вглубь, возврат идёт пружиной, а сама пара «плей/пауза» —
            один системный значок, который сам знает, как перетечь из одного в другое.
          */}
          <GlassButton
            glyph={(c) => <PlayPauseGlyph playing={isPlaying} color={c} size={34} />}
            diameter={79}
            onPress={() => {
              if (player.playing) player.pause();
              else player.play();
              touch();
            }}
          />
        </Animated.View>
        </Animated.View>

        {/* Низ: время и кнопки. Со списком серий поднимается над ним. */}
        <Animated.View
         
          pointerEvents={drawerOpen ? 'none' : 'box-none'}
          style={[
            styles.bottom,
            drawerLift,
            /*
              В ЛЕЖАЧЕМ ПОЛОЖЕНИИ ПОЛОСА ШИРЕ.

              Поля в двенадцать точек верны для портрета, где экран узкий. В альбомной ориентации
              они оставляли шкале середину экрана, хотя места по бокам полно: полоса времени тем
              точнее, чем она длиннее, и именно в этом положении её и крутят.
            */
            /*
              Безопасное поле сбоку в лежачем положении — это про вырез, а он занимает середину
              кромки и до самого низа не доходит. Нижняя панель под ним не проходит, поэтому брать
              все шестьдесят точек незачем: берём не больше двенадцати.
            */
            {
              paddingBottom: insets.bottom + 10,
              paddingLeft: sidePad,
              paddingRight: sidePad,
            },
          ]}
        >
          {/*
            ПОЛЗУНОК — В СВОЁМ СТЕКЛЕ, КНОПКИ — КАЖДАЯ В СВОЁМ.

            Раньше всё это лежало на одной широкой плашке, и она читалась как единый прямоугольник
            поверх кадра: чем больше кнопок, тем больше картины он закрывал, и терялось главное —
            что это отдельные действия, а не одна панель.

            Стекло у Apple работает иначе: оно обтекает то, что на нём лежит. Поэтому каждая кнопка
            получает своё стекло по своему размеру, а между ними остаётся кадр. Видно и кино, и
            кнопки, и то, что они друг другу не родня.
          */}
          {/*
            ПОЛЗУНОК БЕЗ СТЕКЛА.

            Оправа вокруг полосы времени казалась логичной — «каждому своё стекло», — а на экране
            читалась как ореол: светлая плашка во всю ширину под кадром, которая спорит с картинкой
            и ничего не добавляет. Сама полоса и цифры видны поверх кино и без подложки.
          */}
          <Animated.View style={styles.bar}>
            <Ticker
              player={player}
              posMs={posMs}
              durMs={durMs}
              hold={hold}
              seekTarget={seekTarget}
              speed={speed}
              loading={loading}
              active={shown}
              onScrub={onScrub}
              onScrubStart={onScrubStart}
              onScrubEnd={onScrubEnd}
            />
          </Animated.View>
          {/*
            ОДНА СТРОКА, КОТОРУЮ МОЖНО МОТАТЬ, А НЕ ДВА РЯДА.

            В портрете ширины не хватает, и перенос по второму ряду раздувал панель вдвое — она
            съедала кадр и выглядела как попытка впихнуть сюда всё сразу. Строка остаётся одной
            всегда, а то, что не поместилось, домотается пальцем: так же ведут себя системные
            панели инструментов.

            У «пред./след.» подписей нет намеренно: восемь подписанных кнопок выстраиваются во всю
            ширину и снова читаются сплошной полосой, ради ухода от которой их и разносили.
          */}
          <Animated.View style={styles.chipsLine} pointerEvents="box-none">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chipsScroll}
            contentContainerStyle={styles.chips}
            // Полоса кнопок не должна отбирать жест у того, что под ней, пока её не трогают.
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={16}
            onScrollEndDrag={() => {
              chipsDragging.current = false;
            }}
            onMomentumScrollEnd={() => {
              chipsDragging.current = false;
            }}
            onScroll={(e) => {
              chipsScrollX.current = e.nativeEvent.contentOffset.x;
              /*
                ...но только прокрутка ПАЛЬЦЕМ. При повороте экрана ряд сам сдвигается под новую
                ширину и тоже присылает «прокрутку» — и таймер скрытия панели обнулялся на каждом
                повороте, будто её трогали.
              */
              if (!chipsDragging.current) return;
              /*
                Прокрутка — это тоже касание. Раньше панель считала её бездействием и через три
                секунды гасла прямо под пальцем; погасшая, она пропускает касания к кадру, а на
                кадре висит смахивание — и продолжение прокрутки закрывало фильм.
              */
              touch();
            }}
            onScrollBeginDrag={() => {
              chipsDragging.current = true;
              touch();
            }}
          >
            {/*
              ПОРЯДОК: озвучка, субтитры, скорость, серии (решение Марка) — от того, что меняют чаще,
              к тому, что реже. Серии к тому же открываются свайпом вверх.
            */}
            {/*
              ОЗВУЧКА — ЭТО И ЕСТЬ ЗВУКОВАЯ ДОРОЖКА.

              Подпись «Аудио» была бы честной только для технаря: в списке лежат «Paramount comedy»,
              «TVShows», «Eng.Original» — то, что человек называет озвучкой. Значок — тот же, что у
              Влада на этой кнопке (RecordVoiceOver).
            */}
            {(fileAudio.length > 1 || voiceChoices.length > 1) && (
              <Chip glyph={(c) => <VoiceGlyph color={c} size={18} />} label="Озвучка" active={menu === 'audio'} onPress={(x) => openMenu('audio', x)} />
            )}
            {/*
              СУБТИТРЫ — КНОПКА ЕСТЬ ВСЕГДА.

              Раньше она появлялась, только когда что-то нашлось, — и пока поиск шёл или когда он
              ничего не дал, казалось, что субтитров в плеере нет вовсе. Теперь кнопка на месте, а в
              меню честно сказано: ищем, нашли или не нашлось.
            */}
            <Chip
              glyph={(c) => <SubsGlyph color={c} size={18} />}
              label="Субтитры"
              active={menu === 'subs' || ownSubs !== null || player.subtitleTrack != null}
              onPress={(x) => openMenu('subs', x)}
            />
            <Chip
              glyph={(c) => <SpeedGlyph color={c} size={18} />}
              label={speed === 1 ? 'Скорость' : `${speed}×`}
              active={menu === 'speed'}
              onPress={(x) => openMenu('speed', x)}
            />
            {(req.episodes.length > 0 || parts) && (
              <Chip icon="list.bullet" label={parts ? 'Части' : 'Серии'} onPress={() => (drawerOpen ? closeDrawer() : openDrawer())} />
            )}
          </ScrollView>
            {hasPrev || hasNext ? (
              <Animated.View style={styles.epPinned}>
              {/*
                ПЕРЕХОД ПО СЕРИЯМ — ЗНАЧКИ У ПРАВОГО КРАЯ.

                Только значки, без «Серия 5» (решение Марка): номер серии и так видно в подписи сверху
                и в ленте серий. Кнопки ниже остальных: это переход, а не настройка.

                Они стоят у ПРАВОГО края и не уезжают вместе с прокруткой ряда: «дальше» — это вправо,
                туда же, куда растёт время на полосе, и большой палец правой руки лежит именно там.
              */}
              {hasPrev && (
                <Chip
                  glyph={(c) => <SkipGlyph forward={false} color={c} size={15} />}
                  thin
                  onPress={() => step(-1)}
                />
              )}
              {hasNext && (
                <Chip
                  glyph={(c) => <SkipGlyph forward color={c} size={15} />}
                  thin
                  onPress={() => step(1)}
                />
              )}
              </Animated.View>
            ) : null}
          </Animated.View>
        </Animated.View>

        {/*
          ЛЕНТА СЕРИЙ — под поднятой полосой. Выезжает снизу ровно на ту высоту, на которую
          поднялась панель; касание серии — переход к ней, касание по кадру — закрыть.
        */}
        {/*
          ЯЗЫЧОК СНИЗУ — ПОДСКАЗКА, ЧТО ОТТУДА МОЖНО ТЯНУТЬ.

          Свайп вверх ничем не выдавал себя: о списке серий можно было узнать только случайно.
          Маленькая стрелка у самой нижней кромки, чуть покачивающаяся, говорит «тяни вверх» без
          слов. Её же можно просто нажать.
        */}
        {hasEpisodes ? (
          <Animated.View
            style={[styles.pullHint, { bottom: insets.bottom > 0 ? Math.max(4, insets.bottom - 20) : 2 }, drawerAside]}
            pointerEvents={drawerOpen ? 'none' : 'box-none'}
          >
            <Pressable onPress={openDrawer} hitSlop={{ top: 6, bottom: 10, left: 24, right: 24 }}>
              <Animated.View style={pullBob}>
                <SymbolView name="chevron.compact.up" size={22} tintColor="rgba(255,255,255,0.8)" />
              </Animated.View>
            </Pressable>
          </Animated.View>
        ) : null}
        {hasEpisodes ? (
          <Animated.View style={[styles.topClock, { top: insets.top + 10 }, drawerClock]} pointerEvents="none">
            <TopClock player={player} live={clockLive} />
          </Animated.View>
        ) : null}
        {hasEpisodes ? (
          <Animated.View
            style={[styles.drawer, { height: DRAWER_H + insets.bottom, paddingBottom: insets.bottom, paddingLeft: sidePad - 12, paddingRight: sidePad - 12 }, drawerSheet]}
            pointerEvents={drawerOpen ? 'box-none' : 'none'}
          >
            {/*
              ВЕРХНИЙ КРАЙ ЛЕНТЫ — НЕ ЛИНИЕЙ, А ТЕНЬЮ.

              Сплошная подложка обрывалась резкой границей поперёк кадра. Теперь затемнение
              начинается выше ленты и нарастает плавно — как виньетка, без края.
            */}
            <LinearGradient
              colors={['transparent', 'rgba(0,0,0,0.55)', 'rgba(0,0,0,0.78)']}
              locations={[0, 0.3, 1]}
              style={styles.drawerShade}
              pointerEvents="none"
            />
            {/*
              ВЫБОР В ЛЕНТЕ — С ОБВОДКОЙ, КАК В «ПРОДОЛЖИТЬ ПРОСМОТР». Пока ищется источник, по краю
              выбранного кадра бежит линия, и лента не закрывается; нашлось — закрывается.
            */}
            {parts ? (
              <PartsPane
                parts={parts}
                current={partIndex}
                picking={picking}
                onPick={pickPart}
              />
            ) : (
              <EpisodesPane
                episodes={req.episodes}
                current={req.currentEpisode}
                tvId={req.mediaType === 'tv' ? req.mediaId : null}
                picking={picking}
                onPick={pickEpisode}
              />
            )}
          </Animated.View>
        ) : null}
      </Animated.View>

      {failed && (
        <View style={styles.center}>
          <Glass radius={24} style={styles.failBox}>
            <Text style={styles.hint}>{failed}</Text>
            <Pressable
              onPress={() => {
                setFailed(null);
                if (source) startSwap(source, posMs.current);
              }}
              style={styles.retry}
            >
              <Text style={styles.retryText}>Повторить</Text>
            </Pressable>
          </Glass>
        </View>
      )}

      {menu && (
        <Sheet key={menu} onClose={() => setMenu(null)} anchorX={anchorX} wide={menu === 'episodes'} insets={insets}>
          {menu === 'episodes' && (
            <EpisodesPane
              episodes={req.episodes}
              current={req.currentEpisode}
              tvId={req.mediaType === 'tv' ? req.mediaId : null}
              onPick={(e) => void goEpisode(e.season, e.episode)}
            />
          )}

          {/*
            ДВА РОДА ОЗВУЧЕК — И МЕНЮ ОДНО.

            У одних источников озвучки лежат дорожками внутри файла (переключаются мгновенно), у
            других это разные ссылки (переключение — новая загрузка с того же места). Человеку эта
            разница не нужна: он выбирает голос. Если источник дал несколько ссылок — показываем их;
            если одну, но с дорожками внутри — показываем дорожки.
          */}
          {/* Сначала голоса внутри этого файла — они переключаются мгновенно. */}

          {menu === 'audio' &&
            fileAudio.length > 1 &&
            audioRowsOf(fileAudio, req.voices).map((r) => (
              <Row
                key={`track-${r.i}`}
                text={r.label}
                mark={false}
                active={audioPick === r.i}
                onPress={() => {
                  player.audioTrack = fileAudio[r.i];
                  setAudioPick(r.i);
                  if (r.name) rememberTrack(req, r.name);
                  setMenu(null);
                }}
              />
            ))}


          {menu === 'audio' &&
            voiceChoices.length > 1 &&
            voiceChoices.map((c) => (
              <Row
                key={`choice-${c.index}-${c.voice}`}
                text={voiceName(c.voice, null, null, c.index)}
                mark={false}
                active={c.index === req.choice && !(fileAudio.length > 1)}
                onPress={() => void pickVoiceChoice(c.index, c.track)}
              />
            ))}

          {menu === 'speed' &&
            SPEEDS.map((v) => (
              <Row key={v} text={v === 1 ? 'Обычная' : `${v}×`} active={v === speed} onPress={() => pickSpeed(v)} />
            ))}

          {menu === 'subs' && (
            <>
              <Row
                text="Выключены"
                active={player.subtitleTrack === null && ownSubs === null}
                onPress={() => {
                  player.subtitleTrack = null;
                  subLang.current = null;
                  setOwnSubs(null);
                  setMenu(null);
                }}
              />
              {tracks.subs.length === 0 && req.subtitleTracks.length === 0 ? (
                <Text style={styles.subsNote}>
                  {subsNote === 'ищем'
                    ? 'Ищем субтитры…'
                    : req.imdb
                      ? 'Не нашлось ни у источника, ни в сети.'
                      : 'Не нашлось: у тайтла нет номера IMDB.'}
                </Text>
              ) : null}
              {tracks.subs.map((t, i) => (
                <Row
                  key={`${i}-${t.id ?? ''}`}
                  text={t.label ?? t.language ?? 'Дорожка'}
                  active={player.subtitleTrack?.id === t.id}
                  onPress={() => {
                    setOwnSubs(null);
                    player.subtitleTrack = t;
                    setMenu(null);
                  }}
                />
              ))}
              {/* Дорожки резки: их файлы мы скачиваем и рисуем сами — плеер внешние не умеет. */}
              {req.subtitleTracks.map((t, i) => (
                <Row key={`own-${i}-${t.url}`} text={t.label} active={ownSubs?.url === t.url} onPress={() => pickOwnSub(t)} />
              ))}
            </>
          )}
        </Sheet>
      )}
    </View>
  );
}


/**
 * ЕДИНСТВЕННЫЙ ПОДПИСЧИК НА ВРЕМЯ.
 *
 * Всё, что обновляется по нескольку раз в секунду, живёт здесь и только здесь. Пересобирается при
 * этом один маленький узел вместо всего плеера — ради этого он и выделен.
 */
const Ticker = memo(function Ticker({
  player,
  posMs,
  durMs,
  hold,
  seekTarget,
  speed,
  loading,
  active,
  onScrub,
  onScrubStart,
  onScrubEnd,
}: {
  player: VideoPlayer;
  posMs: React.MutableRefObject<number>;
  durMs: React.MutableRefObject<number>;
  /** Идёт подмена потока: показывать это место, а не время прошлого потока. */
  hold: number | null;
  seekTarget: { ms: number } | null;
  speed: number;
  loading: boolean;
  /** Панель видна: только тогда полосе есть смысл перерисовываться за временем. */
  active: boolean;
  onScrub: (ms: number) => void;
  onScrubStart: () => void;
  onScrubEnd: (ms: number) => void;
}) {
  /*
    ВРЕМЯ — В ССЫЛКУ ВСЕГДА, В ПЕРЕРИСОВКУ — ТОЛЬКО ПРИ ВИДИМОЙ ПАНЕЛИ.

    Панель большую часть фильма спрятана, а полоса с цифрами пересобиралась четыре раза в секунду
    ради того, чего не видно. Теперь событие времени всегда обновляет позицию для журнала и
    перемотки (posMs/durMs — их ждут сохранение и двойное касание), а перерисовку просит, только
    пока панель на экране. Показалась панель — `active` меняется, и полоса в ту же сборку встаёт
    на последнее известное время: ровно то, что показала бы и прежде.
  */
  const now = useRef(player.currentTime);
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const sub = player.addListener('timeUpdate', (e) => {
      now.current = e.currentTime;
      if (holdRef.current === null) {
        posMs.current = e.currentTime * 1000;
        durMs.current = (player.duration || 0) * 1000;
      }
      if (activeRef.current) redraw();
    });
    return () => sub.remove();
  }, [player, posMs, durMs]);
  /*
    ТАЙМКОД — ТОЧНО ПО СЕКУНДАМ. Событие времени приходит 4 раза в секунду, и цифра у ползунка
    менялась невпопад: то с запозданием до четверти секунды, то через «длинную» секунду. Пока
    панель видна и фильм идёт, полоса перерисовывается ровно в момент смены секунды: время берётся
    у плеера напрямую, а следующий срок считается от доли секунды и скорости воспроизведения.
  */
  useEffect(() => {
    if (!active) return;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      now.current = player.currentTime;
      redraw();
      const rate = player.playing ? player.playbackRate || 1 : 0;
      const cur = now.current;
      const wait = rate > 0 ? ((Math.floor(cur) + 1 - cur) / rate) * 1000 + 8 : 250;
      t = setTimeout(tick, Math.max(16, wait));
    };
    tick();
    return () => clearTimeout(t);
  }, [active, player]);
  const currentTime = now.current;
  const holding = hold !== null;
  const duration = holding ? 0 : player.duration || 0;
  const at = holding ? hold : currentTime * 1000;
  if (!holding) {
    posMs.current = at;
    durMs.current = duration * 1000;
  }
  return (
    <Scrubber
      positionMs={at}
      durationMs={duration * 1000}
      seekTarget={seekTarget}
      speed={speed}
      loading={loading}
      onScrub={onScrub}
      onScrubStart={onScrubStart}
      onScrubEnd={onScrubEnd}
    />
  );
});

/** Время у верхнего края — пока открыт список серий и остальная панель убрана. */
const TopClock = memo(function TopClock({ player, live }: { player: VideoPlayer; live: boolean }) {
  /*
    ЧАСЫ ИДУТ, ТОЛЬКО ПОКА ИХ ВИДНО. Они видны лишь со списком серий, а подписка на время
    пересобирала их четыре раза в секунду весь фильм. Теперь подписка есть, только пока список хоть
    немного выдвинут (`live`), а время берётся у плеера в момент сборки — поэтому, проступив, часы
    сразу показывают настоящее время, а не то, на котором остановились.
  */
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!live) return;
    const sub = player.addListener('timeUpdate', () => redraw());
    return () => sub.remove();
  }, [player, live]);
  return (
    <Text style={styles.topClockText}>
      {clock(player.currentTime)} <Text style={styles.topClockDim}>/ {clock(player.duration || 0)}</Text>
    </Text>
  );
});

/**
 * СУБТИТРЫ ПОВЕРХ КАДРА.
 *
 * Отдельный узел и отдельная подписка на время — по той же причине, что и Ticker. Поднимаются, когда
 * панель показана, чтобы не оказаться под ней.
 */
const Subs = memo(function Subs({ player, cues }: { player: VideoPlayer; cues: Cue[] }) {
  const { currentTime } = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });
  const hint = useRef(0);
  const { index, cue } = cueAt(cues, currentTime, hint.current);
  hint.current = index;

  /*
    ВНЕШНИЙ ВИД — ИЗ НАСТРОЕК, КАК У ВЛАДА.

    Размер считается долей высоты КАДРА, а не экрана: в портрете кадр — узкая полоса посередине,
    и подпись, посчитанная от высоты экрана, была бы вдвое крупнее самой картинки.

    Положение — подъём над нижним краем кадра (низко / выше / по центру) — и БОЛЬШЕ НИЧЕГО.
    Раньше лёжа, при показанной панели, подпись подпрыгивала над ней, и прыгала снова при каждом
    касании, при списке серий и частей. Марк попросил: субтитры стоят на месте всегда, что бы ни
    открывалось поверх. Подпись не зависит ни от панели, ни от списков.
  */
  const prefs = useSubtitlePrefs();
  const { width, height } = usePlayerWindow();
  const frameH = Math.min(height, (width * 9) / 16);
  const frameBottom = (height - frameH) / 2;
  const bottom = frameBottom + frameH * 0.04 + frameH * (POSITION_LIFT[prefs.position] ?? 0);
  const box = { bottom };

  if (!cue) return null;
  const bg = prefs.background;
  return (
    <Animated.View pointerEvents="none" style={[styles.subsBox, box]}>
      <Text
        style={[
          styles.subsText,
          {
            fontSize: Math.max(13, frameH * (PLAYER_SIZE[prefs.size] ?? 0.0468)),
            fontFamily: fontFamilyOf(prefs.font),
            backgroundColor: PLAQUE[bg] ?? PLAQUE[1],
          },
          // «Без фона» — обводка: плотная тень вокруг каждой буквы.
          bg === 0 ? styles.subsOutline : styles.subsPlain,
        ]}
      >
        {cue.text}
      </Text>
    </Animated.View>
  );
});

/** Кнопка под ползунком: своё стекло, системный значок, живой отклик (см. ui/GlassButton). */
function Chip({
  icon,
  glyph,
  label,
  onPress,
  active = false,
  thin = false,
}: {
  icon?: SFSymbol;
  glyph?: (color: string) => React.ReactNode;
  label?: string;
  /** Отдаёт свою левую координату внутри ряда: по ней меню встаёт рядом с кнопкой, а не по центру. */
  onPress: (x: number) => void;
  active?: boolean;
  thin?: boolean;
}) {
  const x = useRef(0);
  /*
    ВЫСОТА ЗАДАНА ЯВНО, И ЭТО НЕ ПРИДИРКА К ВЁРСТКЕ.

    Скругление у кнопки одно число, а высота до сих пор зависела от значка и подписи: у кнопки со
    значком она выходила одна, у кнопки с длинным словом — другая. Скругление в 19 точек при высоте
    44 даёт не пилюлю, а прямоугольник со слегка сглаженными углами — ровно то, что и было видно.
    Фиксируем высоту и берём ровно её половину.
  */
  const h = thin ? CHIP_THIN : CHIP_H;
  return (
    <GlassButton
      icon={icon}
      glyph={glyph}
      label={label}
      size={thin ? 13 : 16}
      radius={h / 2}
      active={active}
      style={{ height: h }}
      // Без подписи — круглая: ширина равна высоте.
      diameter={label ? undefined : h}
      onLayout={(e) => {
        x.current = e.nativeEvent.layout.x;
      }}
      // Строка мотается пальцем — боковое движение принадлежит ей, кнопке остаётся вертикаль.
      axis="y"
      /*
        ПОД ПОЛЗУНКОМ ЖЕЛЕ НЕ ПОЛОЖЕНО. Их шесть в ряд, и шевеление каждой превращает панель в
        кисель. Отклик здесь только в нажатии — подсветка материала и уход значка вглубь.
      */
      pullable={false}
      onPress={() => onPress(x.current)}
    />
  );
}

/** Высота кнопки под ползунком. Скругление — ровно половина от неё. */
const CHIP_H = 38;
/** Переходы по сериям — ниже прочих: это другой род действия, и в ряду это должно быть видно. */
const CHIP_THIN = 30;

/**
 * ИМЯ ОЗВУЧКИ.
 *
 * Сам поток называет дорожки как придётся: «russian», «eng», иногда вовсе никак. Источник же
 * присылает человеческие имена — «Paramount comedy», «TVShows», «Eng.Original» — и ровно в том
 * порядке, в каком дорожки лежат в плейлисте. Поэтому имя берётся оттуда, а из потока — только
 * запасной вариант.
 *
 * Оригинал — особый случай: называть его «Eng.Original» незачем, это калька. Пишем «Оригинал», а
 * язык ставим в скобки сокращением: так видно и что это оригинал, и на каком он языке.
 */
/**
 * СТРОКИ МЕНЮ «АУДИО» ДЛЯ ДОРОЖЕК ВНУТРИ ФАЙЛА (Collaps).
 *
 * Имя — от источника (студия: «Paramount Comedy», «TVShows», «Eng.Original»), а не системное
 * «Русский», которое у всех русских дорожек одинаковое. Если плеер перечислил одну и ту же дорожку
 * несколько раз (по разу на каждую группу качества) — список повторяется блоками по числу имён:
 * тогда показывается один блок. Оставшиеся одинаковые подписи нумеруются, чтобы их можно было
 * различить.
 */
function audioRowsOf(audio: { label: string; language: string }[], voices: string[]): { i: number; name: string | null; label: string }[] {
  const n = voices.length;
  const blocks = n > 0 && audio.length > n && audio.length % n === 0;
  const list = (blocks ? audio.slice(0, n) : audio).map((t, i) => {
    const name = (blocks ? voices[i % n] : voices[i]) ?? null;
    return { i, name, label: voiceName(name ?? undefined, t.label, t.language, i) };
  });
  const seen = new Map<string, number>();
  for (const r of list) {
    const k = r.label.toLowerCase();
    const c = (seen.get(k) ?? 0) + 1;
    seen.set(k, c);
    if (c > 1) r.label = `${r.label} · ${c}`;
  }
  return list;
}

function voiceName(fromSource: string | undefined, label?: string | null, lang?: string | null, index = 0): string {
  const raw = (fromSource ?? label ?? lang ?? '').trim();
  if (!raw) return `Дорожка ${index + 1}`;

  if (/ориг|origin/i.test(raw)) {
    // «Eng.Original» → eng; если в имени языка нет, берём его у самой дорожки.
    const code = (/^([a-zа-я]{2,3})[.\s]/i.exec(raw)?.[1] ?? lang ?? '').trim();
    return code ? `Оригинал (${code.toUpperCase()})` : 'Оригинал';
  }

  // «russian» / «english» без студии — это не имя озвучки, а язык; так и подписываем.
  const plain: Record<string, string> = {
    russian: 'Русская',
    ru: 'Русская',
    english: 'Английская',
    en: 'Английская',
    ukrainian: 'Украинская',
    uk: 'Украинская',
  };
  const known = plain[raw.toLowerCase()];
  if (known) return known;

  return raw;
}

/**
 * СЕРИИ ВНУТРИ ПЛЕЕРА.
 *
 * Простым списком это не работает: у сериала бывает три сотни серий, и выбор превращается в
 * прокрутку длинного перечня одинаковых строк поверх кино. Поэтому сезон выбирается кнопкой, а
 * серии идут кадрами вбок — так их видно сразу несколько и узнаются они по картинке.
 *
 * Кадры берутся у TMDB и только для открытого сезона: качать все триста заранее незачем, а
 * открытый сезон человек и так рассматривает несколько секунд. Нет кадра — остаётся номер, и это
 * нормально: карточка не разваливается.
 */
const EpisodesPane = memo(function EpisodesPane({
  episodes,
  current,
  tvId,
  picking,
  onPick,
}: {
  episodes: EpisodeRef[];
  current: number;
  tvId: number | null;
  picking?: string | null;
  onPick: (e: EpisodeRef) => void;
}) {
  const seasons = useMemo(() => {
    const out: string[] = [];
    for (const e of episodes) if (!out.includes(e.season)) out.push(e.season);
    return out;
  }, [episodes]);

  const currentSeason = episodes[current]?.season ?? seasons[0] ?? '1';
  const [season, setSeason] = useState(currentSeason);
  const [stills, setStills] = useState<Record<string, string | null>>({});
  /** Для какого сезона справочник уже ответил: пока нет — по пустым кадрам идёт блик. */
  const [stillsFor, setStillsFor] = useState<string | null>(null);
  /** Когда лента серий последний раз двигалась — для защиты от фантомных нажатий. */
  const scrolledAt = useRef(0);

  const rows = useMemo(() => episodes.filter((e) => e.season === season), [episodes, season]);

  useEffect(() => {
    if (!tvId) return;
    let dead = false;
    setStills({});
    setStillsFor(null);
    TmdbApi.tvSeason(tvId, Number(season))
      .then((raw) => {
        if (dead) return;
        const list = (raw as { episodes?: { episode_number: number; still_path?: string | null }[] }).episodes ?? [];
        const map: Record<string, string | null> = {};
        for (const e of list) map[String(e.episode_number)] = TmdbImages.still(e.still_path ?? null);
        setStills(map);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!dead) setStillsFor(season);
      });
    return () => {
      dead = true;
    };
  }, [tvId, season]);

  return (
    <View style={styles.pane}>
      {/*
        СЕЗОНЫ — НАД СЕРИЯМИ, РЯДОМ КНОПОК «1 СЕЗОН», «2 СЕЗОН».

        Раньше сезон выбирался через раскрывающийся заголовок: лишнее касание и мелкие цифры.
        Теперь все сезоны видны сразу, каждый — кнопка в палец высотой (34 точки), выбранный залит.
      */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.paneSeasons}>
        {seasons.map((sn) => (
          <SeasonChip
            key={sn}
            label={`${sn} сезон`}
            on={sn === season}
            onPress={() => {
              void Haptics.selectionAsync();
              setSeason(sn);
            }}
            style={styles.paneSeason}
            textStyle={styles.paneSeasonText}
          />
        ))}
      </ScrollView>
        <SeasonSwap season={season} order={seasons}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.paneStrip}
          // Нажатие на серию — только когда лента стоит: касание, остановившее прокрутку, не открывает серию.
          onScroll={() => {
            scrolledAt.current = Date.now();
          }}
          onScrollBeginDrag={() => {
            scrolledAt.current = Date.now();
          }}
          onMomentumScrollEnd={() => {
            scrolledAt.current = Date.now();
          }}
          scrollEventThrottle={32}
        >
          {rows.map((e) => {
            const here = episodes.indexOf(e) === current;
            const still = stills[e.episode];
            return (
              <Pressable
                key={`${e.season}-${e.episode}`}
                onPress={() => {
                  if (Date.now() - scrolledAt.current > 350) onPick(e);
                }}
                style={styles.epCard}
              >
                <StillImage uri={still} waiting={stillsFor !== season} style={[styles.epStill, here && styles.epStillOn]}>
                  <BusyOutline w={EP_W} h={EP_H} on={picking === `${e.season}-${e.episode}`} />
                </StillImage>
                <Text style={[styles.epNum, here && styles.epNumOn]} numberOfLines={1}>
                  Серия {e.episode}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        </SeasonSwap>
    </View>
  );
});

/**
 * ВСПЛЫВАЮЩЕЕ МЕНЮ.
 *
 * Открывается НАД СВОЕЙ КНОПКОЙ, а не посреди экрана: карточка узкая, её левый край ставится так,
 * чтобы середина пришлась на кнопку, и прижимается к краю экрана, если у края места не хватило.
 *
 * Список серий — исключение: ему нужна ширина, внутри лента кадров. Он занимает всё, что есть,
 * минус безопасные поля. В лежачем положении это важно вдвойне: там вырез с «островом» съедает
 * край, и карточка, растянутая во всю ширину, уезжала бы под него.
 */
/*
  ПОЯВЛЕНИЕ МЕНЮ — БЫСТРО, НО НЕ ВДРУГ.

  Простое проявление за 160 мс читалось как «моргнуло». Меню должно вырастать из своей кнопки:
  чуть снизу и чуть меньше своего размера — к месту и в полный рост, с плавным торможением в конце.
  Двести с небольшим миллисекунд: глаз успевает увидеть движение, а палец не успевает заскучать.
  Уходит быстрее, чем приходит, — закрытие не должно задерживать.
*/
const MENU_IN = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 14 }, { scale: 0.94 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }], easing: Easing.out(Easing.cubic) },
}).duration(220);

const MENU_OUT = new Keyframe({
  0: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] },
  100: { opacity: 0, transform: [{ translateY: 8 }, { scale: 0.97 }], easing: Easing.in(Easing.quad) },
}).duration(140);

function Sheet({
  children,
  onClose,
  anchorX,
  wide,
  insets,
}: {
  children: React.ReactNode;
  onClose: () => void;
  anchorX: number | null;
  wide: boolean;
  insets: { top: number; bottom: number; left: number; right: number };
}) {
  const { width, height } = usePlayerWindow();
  const landscape = width > height;

  /*
    ПОЛЯ — ПО НАСТОЯЩИМ БЕЗОПАСНЫМ ГРАНИЦАМ, А НЕ «ДВЕНАДЦАТЬ ТОЧЕК И ХВАТИТ».

    Для нижней панели урезанное поле было верным: вырез занимает середину кромки и до низа не
    доходит. Но меню поднимается как раз на уровень выреза — и в лежачем положении «остров» сбоку
    закрывал его край. Поэтому здесь берутся полные поля с обеих сторон, каждое своё (вырез бывает
    и слева, и справа), а сверху меню не выше безопасной границы.
  */
  const leftEdge = (landscape ? insets.left : 0) + 12;
  const rightEdge = (landscape ? insets.right : 0) + 12;
  const room = Math.max(200, width - leftEdge - rightEdge);
  const cardW = wide ? room : Math.min(landscape ? 360 : 300, room);
  const bottomPad = insets.bottom + (wide ? 112 : 64);
  const maxH = Math.max(160, height - bottomPad - insets.top - 12);

  // Левый край: середина карточки на кнопке, но не выезжая за поля.
  const left =
    anchorX === null || wide
      ? leftEdge + (room - cardW) / 2
      : Math.max(leftEdge, Math.min(anchorX - cardW / 2, width - rightEdge - cardW));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/*
        Затемнение — только для глаза: касания проходят сквозь него к кнопкам и к кадру, поэтому
        другая вкладка открывается сразу, без отдельного касания «закрыть».
      */}
      <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)} style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={styles.sheetDim} />
      </Animated.View>
      {/*
        НАД ЧЕМ ИМЕННО ВСПЛЫВАТЬ.

        Узкое меню встаёт сразу над своей кнопкой — от неё оно и выросло. А широкое (серии) при
        таком же отступе ложилось ПОВЕРХ полосы времени: на макете это сразу видно, и это плохо —
        выбирая серию, человек не должен терять из виду, где он сейчас. Поэтому оно поднимается
        выше всей нижней панели целиком.
      */}
      <View style={[styles.sheetSlot, { paddingBottom: bottomPad }]} pointerEvents="box-none">
        <Animated.View
          entering={MENU_IN}
          exiting={MENU_OUT}
          style={[styles.sheetCard, { width: cardW, marginLeft: left, maxHeight: maxH }]}
        >
          <Glass radius={26} style={styles.sheet}>
            <ScrollView showsVerticalScrollIndicator={false}>{children}</ScrollView>
          </Glass>
        </Animated.View>
      </View>
    </View>
  );
}

/**
 * Строка меню плеера. mark — галочка у выбранного; в списке озвучек её нет (решение Марка):
 * галочки читались как «отметь несколько», а выбор там один — текущая просто подсвечена цветом.
 */
function Row({ text, active, onPress, mark = true }: { text: string; active: boolean; onPress: () => void; mark?: boolean }) {
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && styles.chipDown]}
    >
      <Text style={[styles.rowText, active && styles.rowActive]} numberOfLines={1}>
        {text}
      </Text>
      {active && mark ? <SymbolView name="checkmark" size={16} tintColor={colors.focusFill} /> : null}
    </Pressable>
  );
}

/** Лента частей фильма — как лента серий: кадр, «Часть N», год; текущая обведена. */
const PartsPane = memo(function PartsPane({
  parts,
  current,
  picking,
  onPick,
}: {
  parts: MediaItem[];
  current: number;
  picking?: string | null;
  onPick: (m: MediaItem) => void;
}) {
  const scrolledAt = useRef(0);
  return (
    <View style={styles.pane}>
      <Text style={[styles.paneTitle, { paddingHorizontal: 18, paddingTop: 6, paddingBottom: 10 }]}>Части</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.paneStrip}
        onScrollBeginDrag={() => {
          scrolledAt.current = Date.now();
        }}
        onMomentumScrollEnd={() => {
          scrolledAt.current = Date.now();
        }}
      >
        {parts.map((m, i) => (
          <Pressable
            key={m.id}
            onPress={() => {
              if (Date.now() - scrolledAt.current > 300) onPick(m);
            }}
            style={styles.epCard}
          >
            <StillImage uri={m.backdropUrl ?? m.posterUrl} style={[styles.epStill, i === current && styles.epStillOn]}>
              <BusyOutline w={EP_W} h={EP_H} on={picking === `p${m.id}`} />
            </StillImage>
            <Text style={[styles.epNum, i === current && styles.epNumOn]} numberOfLines={1}>
              {m.title}
              {m.year ? ` · ${m.year}` : ''}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
});

/**
 * «ПРОПУСТИТЬ ВСТУПЛЕНИЕ» — белая капсула с чёрной надписью и стрелкой, как у Влада
 * (i5/AbstractC1708q.i: белая заливка, KeyboardArrowRight). Видна, пока идёт вступление, — и
 * при спрятанной панели тоже: за этим её и показывают.
 */
const SkipIntro = memo(function SkipIntro({
  player,
  seg,
  bottom,
  right,
  onSkip,
}: {
  player: VideoPlayer;
  seg: Segments;
  bottom: number;
  right: number;
  onSkip: (ms: number) => void;
}) {
  const { currentTime } = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });
  const at = currentTime * 1000;
  const inIntro = at >= seg.introStartMs && at < seg.introEndMs - 1500;
  if (!inIntro) return null;
  return (
    <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(160)} style={[styles.skipWrap, { bottom, right }]}>
      <Pressable
        onPress={() => {
          void Haptics.selectionAsync();
          onSkip(seg.introEndMs);
        }}
        style={({ pressed }) => [styles.skipBtn, pressed && { transform: [{ scale: 0.96 }], opacity: 0.85 }]}
      >
        <Text style={styles.skipText}>Пропустить вступление</Text>
        <ArrowRightGlyph color="#000" size={22} />
      </Pressable>
    </Animated.View>
  );
});

/*
  КАРТОЧКИ СЕРИЙ И ЧАСТЕЙ В ПЛЕЕРЕ — крупнее: в 148×84 кадр (а у частей без кадра — постер)
  на большом экране читался как марка. 196×110 — тот же 16:9, на треть больше; шторка
  подросла на ту же разницу по высоте.
*/
const EP_W = 196;
const EP_H = 110;

const styles = StyleSheet.create({
  // overflow: скруглённые углы при закрытии должны обрезать кадр, а не висеть поверх него.
  screen: { flex: 1, backgroundColor: '#000000', overflow: 'hidden' },
  /** Окно плеера прозрачное: чёрный — отдельный слой (backdrop), он тает при смахивании. */
  stage: { flex: 1, backgroundColor: 'transparent', overflow: 'hidden' },
  backdrop: { backgroundColor: '#000000' },
  frame: { backgroundColor: 'transparent' },
  placeholderWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  placeholder: { backgroundColor: '#000000', maxWidth: '100%', maxHeight: '100%' },
  center: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  hint: { ...typo.bodyMedium, color: colors.onBg, textAlign: 'center', paddingHorizontal: 24 },
  chrome: { justifyContent: 'space-between' },

  top: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  titles: { flex: 1, alignItems: 'center' },
  topBalance: { width: 40 },
  /* Знак тайтла: заметный, но не во весь экран. Опущен вниз — впритык к вырезу он выглядел
     приклеенным к краю, а у выреза сбоку верхняя кромка ещё и съедается. */
  logo: { height: 44, width: 260, maxWidth: '100%', marginTop: 6 },
  title: { ...typo.titleMedium, color: colors.onBg, textAlign: 'center' },
  sub: { ...typo.labelMedium, color: colors.mutedWarm, marginTop: 3, textAlign: 'center' },

  middleWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  middle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 34 },
  scrimTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 190 },
  scrimBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 230 },
  scrimLeft: { position: 'absolute', top: 0, bottom: 0, left: 0, width: 90 },
  scrimRight: { position: 'absolute', top: 0, bottom: 0, right: 0, width: 90 },

  bottom: { gap: 10 },
  bar: { paddingHorizontal: 7, paddingVertical: 4 },
  barWide: { paddingHorizontal: 2 },
  /* Полоса не растягивается по вертикали: ей ровно столько места, сколько занимают сами кнопки. */
  chipsScroll: { flexGrow: 0, flexShrink: 1 },
  subsNote: { ...typo.bodyMedium, color: colors.faint, paddingHorizontal: 14, paddingVertical: 10 },
  drawer: { position: 'absolute', left: 0, right: 0, bottom: 0, justifyContent: 'flex-start' },
  pullHint: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  topClock: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  topClockText: {
    fontFamily: font.display,
    fontSize: 13,
    fontWeight: '700',
    color: colors.onBg,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  topClockDim: { color: colors.mutedWarm },
  drawerShade: { position: 'absolute', left: -60, right: -60, top: -70, bottom: 0 },
  chipsLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  epPinned: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
  /* Поля по краям — чтобы крайняя кнопка не прилипала к границе экрана и было видно, что строка
     мотается дальше. Переноса нет: строка одна всегда. */
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 2, paddingVertical: 2 },
  chipDown: { opacity: 0.55 },

  subsBox: { position: 'absolute', left: 24, right: 24, alignItems: 'center' },
  subsText: {
    ...typo.titleMedium,
    color: '#ffffff',
    textAlign: 'center',
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  subsOutline: { textShadowColor: '#000000', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 6 },
  subsPlain: { textShadowColor: 'transparent' },

  sheetDim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.28)' },
  /* Место под меню: вся площадь, прижато к низу и по центру. Ширину задаёт уже сама карточка —
     так в альбомной ориентации её можно сузить, не споря с left/right. */
  sheetSlot: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    // Карточка сама выбирает ширину и отступ слева — выравнивать её нечем, иначе якорь не работает.
    alignItems: 'flex-start',
  },
  sheetCard: { maxHeight: '58%' },
  pane: { paddingVertical: 4 },
  paneHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 18, paddingVertical: 10 },
  paneTitle: { ...typo.titleMedium, color: colors.onBg },
  paneCount: { ...typo.labelMedium, color: colors.faint, marginLeft: 6 },
  paneSeasons: { gap: 8, paddingHorizontal: 18, paddingTop: 6, paddingBottom: 10 },
  paneSeason: {
    height: 34,
    paddingHorizontal: 16,
    borderRadius: 17,
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  paneSeasonOn: { backgroundColor: colors.focusFill },
  paneSeasonText: { ...typo.labelLarge, color: colors.onBg },
  paneSeasonTextOn: { color: '#000000' },
  paneStrip: { paddingHorizontal: 18, paddingBottom: 12, gap: 10 },
  epCard: { width: EP_W },
  epStill: {
    width: EP_W,
    height: EP_H,
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  /** Текущая серия обведена — поверх кадра подпись читается хуже, чем рамка. */
  epStillOn: { borderWidth: 2, borderColor: colors.focusFill },
  epNum: { ...typo.labelMedium, color: colors.mutedWarm, marginTop: 6 },
  epNumOn: { color: colors.focusFill },
  sheetNarrow: { width: 420, maxWidth: '100%' },
  sheet: { maxHeight: '100%', paddingVertical: 6 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 13, gap: 10 },
  menuHead: { ...typo.labelMedium, color: colors.mutedWarm, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 4 },
  rowText: { ...typo.bodyMedium, color: colors.onBg, flex: 1 },
  rowActive: { color: colors.focusFill },

  skipWrap: { position: 'absolute' },
  skipBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 46,
    paddingLeft: 22,
    paddingRight: 14,
    borderRadius: 30,
    backgroundColor: '#F6F6F8',
  },
  skipText: { fontFamily: font.bold, fontSize: 15, color: '#000' },
  failBox: { padding: 20, alignItems: 'center', gap: 14, marginHorizontal: 30 },
  retry: { paddingHorizontal: 22, paddingVertical: 11, borderRadius: 20, backgroundColor: colors.focusFill },
  retryText: { ...typo.labelMedium, color: '#000000' },
});
