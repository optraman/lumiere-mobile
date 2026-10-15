import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { colors } from '../../theme/colors';
import { font, type as typo } from '../../theme/fonts';

/**
 * ПОЛОСА ВРЕМЕНИ — КАК В СИСТЕМНОМ ПЛЕЕРЕ.
 *
 * Три правила, и все три взяты из того, как ведёт себя ползунок у Apple:
 *
 *  1. КИНО ЕДЕТ ВМЕСТЕ С ПАЛЬЦЕМ, а не после того, как палец убрали. Перемотка «вслепую, а потом
 *     посмотрим, куда попал» — это угадывание; когда кадр меняется под пальцем, попасть можно
 *     точно и с первого раза;
 *  2. ВО ВРЕМЯ ВЕДЕНИЯ ЗВУК И ХОД ОСТАНОВЛЕНЫ. Иначе кино продолжает уезжать вперёд, пока его
 *     ищут, и цель уплывает из-под пальца. Отпустили — пошло дальше, ровно с того места, где
 *     остановились;
 *  3а. ПОЛОЖЕНИЕ НЕ ОТКАТЫВАЕТСЯ НАЗАД. Отпустили — ползунок остаётся там, куда его привели, и
 *     ждёт, пока плеер туда доедет. Прежде он на долю секунды прыгал обратно на старое место и
 *     только потом на новое: шкала показывала не намерение, а то, что успел догрузить поток. Этот
 *     откат читается как сбой, хотя перемотка идёт правильно;
 *  3. ПАЛЕЦ ВВЕРХ — ШКАЛА ТОЧНЕЕ. Это то самое «scrubbing speed» из системного плеера: чем дальше
 *     палец от полосы, тем меньший отрезок времени она охватывает. У земли — весь фильм на ширину
 *     экрана; поднял на ладонь — минута; поднял выше — секунды, и можно ловить кадр. Отпустил —
 *     шкала возвращается к обычной.
 *
 * Всё ведение живёт на НАТИВНОЙ стороне (reanimated): жест, ширина заливки и положение ползунка —
 * общие значения, они меняются в своём потоке и до JS не доходят. Наверх уходят только две вещи:
 * «перемотай сюда» по ходу движения и «продолжай» в конце.
 */

/**
 * Ступени точности: во сколько раз сужается охват шкалы по мере подъёма пальца.
 * `mark` — короткая подпись ступени в пузыре, `dots` — сколько делений из трёх горит.
 */
const RATES = [
  { lift: 0, factor: 1, name: 'обычная', mark: '' },
  { lift: 60, factor: 0.25, name: 'точная', mark: '×4' },
  { lift: 130, factor: 0.06, name: 'очень точная', mark: '×16' },
  { lift: 210, factor: 0.012, name: 'посекундная', mark: '×80' },
];

/** Шаги делений линейки, секунды: берётся самый мелкий, при котором деления не слипаются. */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
const TICK_MIN_PX = 11;

/** Сколько ждём, пока плеер доедет до заданного места, прежде чем перестать его ждать. */
const LATCH_GIVE_UP_MS = 8_000;
/** Ближе этого к цели считаем, что доехал. */
const LATCH_NEAR_MS = 1_200;

/** Пузырь над ползунком: время и ступень точности. Предпросмотр — в самом кадре (watch.tsx). */
const BUBBLE_W = 150;

export function Scrubber({
  positionMs,
  durationMs,
  speed,
  loading = false,
  seekTarget,
  onScrub,
  onScrubStart,
  onScrubEnd,
}: {
  positionMs: number;
  durationMs: number;
  /** Скорость воспроизведения — от неё зависит, во сколько всё кончится. */
  speed: number;
  /** Идёт загрузка: вместо крутилки по самой шкале проходит волна. */
  loading?: boolean;
  /**
   * Место, куда перемотали не ползунком (двойным касанием). Ползунок встанет туда сразу же.
   *
   * Обёрнуто в объект нарочно: два касания подряд могут дать одно и то же число миллисекунд, а
   * засечь надо КАЖДОЕ. Новый объект на каждое касание — и ни одно не теряется.
   */
  seekTarget?: { ms: number } | null;
  /** Куда ведут ПРЯМО СЕЙЧАС — зовётся всё время, пока ведут (для предпросмотра). */
  onScrub: (ms: number) => void;
  onScrubStart: () => void;
  /** Отпустили — вот куда встать. */
  onScrubEnd: (ms: number) => void;
}) {
  const width = useSharedValue(1);
  /** Ширина полосы уже измерена: до этого сдвиг заливки и ползунка посчитать не из чего. */
  const laid = useSharedValue(0);
  const dragging = useSharedValue(0);
  /** Доля, которую показываем: во время ведения — своя, иначе — настоящая позиция. */
  const shownFrac = useSharedValue(0);
  const startFrac = useSharedValue(0);
  const rate = useSharedValue(0);
  /** Где палец по горизонтали — в точной перемотке пузырь идёт за ним, а не за ползунком. */
  const fingerX = useSharedValue(0);
  /*
    Где палец лёг — в координатах самой полосы. Смещение считается от него, а не берётся у жеста:
    жест меряет смещение в координатах окна, а плеер лежит внутри стоячего окна (landscape.tsx) —
    «вправо» по полосе там было бы «вниз» по окну. Координаты касания система пересчитывает в
    повёрнутую полосу сама, поэтому разница с местом касания верна при любом повороте.
  */
  const beginX = useSharedValue(0);
  const beginY = useSharedValue(0);
  /** Когда кадру в последний раз сообщили новое место (см. onUpdate). */
  const lastSent = useSharedValue(0);
  /**
   * КУДА МЫ ПОПРОСИЛИ ВСТАТЬ. −1 значит «никуда, показываем настоящее время».
   *
   * Это и есть защёлка против отката. Пока она взведена, шкала показывает ЦЕЛЬ, а не то, что
   * сейчас отдаёт плеер: он в этот момент ещё докачивает кусок в новом месте и честно сообщает
   * старую позицию. Снимается она сама, как только плеер доехал.
   */
  const pending = useSharedValue(-1);

  /*
    ЦИФРЫ ПОКАЗЫВАЮТ НАМЕРЕНИЕ, А НЕ ОТЧЁТ ПОТОКА.

    Пока ведут и пока плеер докачивает новое место, здесь лежит то, куда мы попросили встать;
    как только он доехал, значение снимается и снова идёт настоящее время. Обновляется оно, когда
    сдвинулось хотя бы на десятую секунды: чаще человек всё равно не читает.
  */
  const [overrideMs, setOverrideMs] = useState<number | null>(null);
  const lastShown = useRef(0);
  const showMs = useCallback((ms: number) => {
    if (Math.abs(ms - lastShown.current) < 100) return;
    lastShown.current = ms;
    setOverrideMs(ms);
  }, []);
  /*
    ЦИФРЫ ПРИ ВЕДЕНИИ — КАЖДУЮ СЕКУНДУ. Раньше время в пузыре обновлялось вместе с перемоткой кадра,
    не чаще раза в 120 мс, и при быстром ведении секунды перескакивали пачками. Теперь за ползунком
    следит поток отрисовки и сообщает новую цифру, как только сменилась целая секунда под пальцем;
    сама перемотка кадра по-прежнему не чаще 120 мс (она дорогая).
  */
  const showSec = useCallback((sec: number) => {
    lastShown.current = sec * 1000;
    setOverrideMs(sec * 1000);
  }, []);
  const clearShown = useCallback(() => {
    lastShown.current = 0;
    setOverrideMs(null);
  }, []);

  /** Ступень точности и ширина полосы — для линейки делений (их раскладка считается в JS). */
  const [level, setLevel] = useState(0);
  const [barW, setBarW] = useState(1);
  const [held, setHeld] = useState(false);

  const done = durationMs > 0 ? Math.min(1, Math.max(0, positionMs / durationMs)) : 0;
  const duration = useSharedValue(durationMs);
  duration.value = durationMs;
  const live = useSharedValue(done);
  live.value = done;
  useAnimatedReaction(
    () => (dragging.value > 0 && duration.value > 0 ? Math.floor((shownFrac.value * duration.value) / 1000) : -1),
    (sec, prev) => {
      if (sec >= 0 && sec !== prev) runOnJS(showSec)(sec);
    },
    [showSec],
  );

  const buzz = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
  }, []);
  /*
    ОБРАБОТЧИКИ — ЧЕРЕЗ ССЫЛКИ. Жест ведения собирается один раз (useMemo ниже): пересборка на
    каждой перерисовке заново отправляла его настройку и функции в поток жестов четыре раза в
    секунду. Чтобы собранный однажды жест всегда звал свежие обработчики, он берёт их отсюда.
  */
  const handlers = useRef({ onScrub, onScrubStart, onScrubEnd });
  handlers.current = { onScrub, onScrubStart, onScrubEnd };
  const scrub = useCallback((ms: number) => handlers.current.onScrub(ms), []);
  const begin = useCallback(() => {
    setHeld(true);
    handlers.current.onScrubStart();
  }, []);
  const end = useCallback((ms: number) => {
    setHeld(false);
    setLevel(0);
    handlers.current.onScrubEnd(ms);
  }, []);

  /*
    ЗАЩЁЛКА НЕ ДОЛЖНА ЗАВИСНУТЬ НАВСЕГДА.

    Обычно её снимает сам плеер, доехав до цели. Но доехать он может и не суметь — обрыв связи,
    негодная ссылка, конец файла. Через несколько секунд ожидания сдаёмся и показываем правду.
  */
  const giveUp = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armGiveUp = useCallback(() => {
    if (giveUp.current) clearTimeout(giveUp.current);
    giveUp.current = setTimeout(() => {
      pending.value = -1;
      clearShown();
    }, LATCH_GIVE_UP_MS);
  }, [pending, clearShown]);

  useEffect(
    () => () => {
      if (giveUp.current) clearTimeout(giveUp.current);
    },
    [],
  );

  /** Перемотка не ползунком: ползунок встаёт на новое место сразу, не дожидаясь потока. */
  useEffect(() => {
    if (!seekTarget || durationMs <= 0) return;
    pending.value = Math.min(1, Math.max(0, seekTarget.ms / durationMs));
    showMs(seekTarget.ms);
    armGiveUp();
  }, [seekTarget, durationMs, pending, armGiveUp, showMs]);

  const pan = useMemo(() => Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => {
      /*
        ОПОРА — ТАМ, ГДЕ СЕЙЧАС ПОЛЗУНОК, А НЕ ТАМ, КУДА ПОПАЛ ПАЛЕЦ (снова, по просьбе Марка).

        Касание полосы не швыряет кино туда, куда всего лишь поставили палец. Вести надо от
        текущего места: полоса — ручка, за которую тянут, а не карта. Перемотка тапом убрана.
      */
      dragging.value = withTiming(1, { duration: 110 });
      startFrac.value = pending.value >= 0 ? pending.value : live.value;
      shownFrac.value = startFrac.value;
      fingerX.value = e.x;
      beginX.value = e.x;
      beginY.value = e.y;
      rate.value = 0;
      runOnJS(begin)();
      runOnJS(buzz)();
    })
    .onUpdate((e) => {
      /*
        ТОЧНОСТЬ ОТ ПОДЪЁМА ПАЛЬЦА. translationY отрицателен, когда палец идёт вверх; по нему и
        выбирается ступень. Переход на другую ступень не сдвигает ползунок: опора пересчитывается
        так, чтобы то же смещение пальца давало то же положение.
      */
      const lift = Math.max(0, -(e.y - beginY.value));
      let step = 0;
      for (let i = RATES.length - 1; i >= 0; i--) {
        if (lift >= RATES[i].lift) {
          step = i;
          break;
        }
      }
      const dx = (e.x - beginX.value) / width.value;
      if (step !== rate.value) {
        startFrac.value = shownFrac.value - dx * RATES[step].factor;
        rate.value = step;
        runOnJS(setLevel)(step);
        runOnJS(buzz)();
      }
      fingerX.value = e.x;
      const next = Math.min(1, Math.max(0, startFrac.value + dx * RATES[step].factor));
      shownFrac.value = next;
      /*
        КАДР ПОД ПАЛЬЦЕМ — НЕ ЧАЩЕ ВОСЬМИ РАЗ В СЕКУНДУ. Раньше на каждое движение пальца (шестьдесят
        раз в секунду) плеер получал новую точку и бросался туда — отсюда тормоза ведения. Ползунок
        при этом движется на каждое движение: он живёт в потоке отрисовки и ни от кого не ждёт.
      */
      const now = Date.now();
      if (duration.value > 0 && now - lastSent.value > 120) {
        lastSent.value = now;
        runOnJS(scrub)(next * duration.value);
        runOnJS(showMs)(next * duration.value);
      }
    })
    .onFinalize(() => {
      // Защёлка взводится ДО того, как гаснет признак ведения: иначе между ними успевает
      // проскочить один кадр со старой позицией — тот самый откат.
      pending.value = shownFrac.value;
      dragging.value = withTiming(0, { duration: 160 });
      rate.value = 0;
      runOnJS(end)(shownFrac.value * duration.value);
      runOnJS(armGiveUp)();
    }),
    // Общие значения и обработчики выше постоянны — жест живёт, пока жив ползунок.
    [dragging, startFrac, pending, live, shownFrac, fingerX, beginX, beginY, rate, width, duration, lastSent, begin, buzz, scrub, showMs, end, armGiveUp],
  );

  /*
    СНЯТИЕ ЗАЩЁЛКИ. Плеер доехал — показываем настоящее время снова. Сравниваем в миллисекундах:
    доля в секунду на получасовой серии и на трёхчасовом фильме — разная точность.
  */
  useAnimatedReaction(
    () => live.value,
    (now) => {
      if (pending.value < 0) return;
      if (duration.value <= 0) {
        pending.value = -1;
        return;
      }
      if (Math.abs(now - pending.value) * duration.value < LATCH_NEAR_MS) {
        pending.value = -1;
        runOnJS(clearShown)();
      }
    },
  );

  /*
    ЗАГРУЗКА — ВОЛНОЙ ПО САМОЙ ШКАЛЕ, А НЕ КРУТИЛКОЙ ПОСЕРЕДИНЕ.
  */
  const sweep = useSharedValue(0);
  useEffect(() => {
    cancelAnimation(sweep);
    if (!loading) {
      sweep.value = 0;
      return;
    }
    sweep.value = 0;
    sweep.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.cubic) }), -1, false);
  }, [loading, sweep]);

  const wave = useAnimatedStyle(() => ({
    width: `${sweep.value * 100}%`,
    opacity: loading ? Math.sin(Math.PI * sweep.value) * 0.85 : 0,
  }));

  const frac = useDerivedValue(() => {
    if (dragging.value > 0) return shownFrac.value;
    if (pending.value >= 0) return pending.value;
    return live.value;
  });

  /*
    ЗАЛИВКА И ПОЛЗУНОК ЕДУТ СДВИГОМ, А НЕ ШИРИНОЙ И ОТСТУПОМ.

    Ширина в процентах и «left» — это раскладка: каждое изменение (при ведении — на каждом кадре,
    при просмотре — четыре раза в секунду) заставляло пересчитывать дерево. Сдвиг раскладку не
    трогает. Заливка — полоса во всю ширину дорожки, выдвинутая слева ровно на свою долю: левый
    край обрезает сама дорожка (то же скругление 4), правый — скруглён, как и был. Пока ширина
    полосы не измерена, обе не видны: без неё сдвиг посчитать не из чего, а с шириной-заглушкой
    заливка на миг встала бы во всю полосу (это доли кадра при открытии плеера).
  */
  const fill = useAnimatedStyle(() => ({
    opacity: laid.value,
    transform: [{ translateX: (frac.value - 1) * width.value }],
  }));
  const knob = useAnimatedStyle(() => ({
    opacity: laid.value,
    transform: [{ translateX: frac.value * width.value }, { scale: 1 + dragging.value * 0.9 }],
  }));
  /*
    ПОЛОСА РАСТЁТ ВМЕСТЕ С ТОЧНОСТЬЮ.

    Взялись — толще; поднялись в точную перемотку — ещё толще, и на ней проступает линейка делений.
    Толщина говорит рукой то же, что пузырь словами: сейчас шкала мельче обычной.
  */
  /*
    Толщина — коротким ходом, а не пружиной: пружина после точной перемотки ещё секунду «оседала»
    из толстой полосы в тонкую, и казалось, что полоса застряла.
  */
  const track = useAnimatedStyle(() => ({
    height: withTiming(4 + dragging.value * 5 + (rate.value > 0 ? 9 : 0), { duration: 140 }),
  }));

  /*
    ЛИНЕЙКА ТОЧНОЙ ПЕРЕМОТКИ.

    В точной ступени вся ширина полосы — это уже не весь фильм, а его кусочек (factor от длины).
    Деления нарисованы с постоянным шагом в секундах и едут под ползунком, как лента под визиром:
    видно, что палец двигает не «чуть-чуть», а ровно столько-то секунд. Шаг подбирается так, чтобы
    деления не слипались: на «посекундной» это секунда, на «точной» — десятки секунд.
  */
  const factor = RATES[level].factor;
  const secPerPx = durationMs > 0 ? (factor * durationMs) / 1000 / Math.max(1, barW) : 1;
  const tickSec = TICK_STEPS.find((t) => t / secPerPx >= TICK_MIN_PX) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const spacing = tickSec / secPerPx;
  const tickCount = level > 0 && durationMs > 0 ? Math.min(160, Math.ceil(barW / spacing) + 2) : 0;
  /*
    ПРОЗРАЧНОСТЬ ЛИНЕЙКИ — ОТДЕЛЬНО ОТ ЕЁ СДВИГА. Вместе они пересчитывались от положения, и каждое
    обновление времени (четыре раза в секунду, даже при спрятанной панели) запускало новый
    140-миллисекундный переход прозрачности — поток отрисовки был занят больше половины просмотра.
    Теперь переход запускается только сменой ступени точности, как и задумано.
  */
  const rulerFade = useAnimatedStyle(() => ({
    opacity: withTiming(rate.value > 0 ? 1 : 0, { duration: 140 }),
  }));
  const ruler = useAnimatedStyle(() => {
    const pos = (frac.value * duration.value) / 1000;
    const kx = frac.value * width.value;
    const phase = ((pos % tickSec) / tickSec) * spacing;
    const off = (((kx - phase) % spacing) + spacing) % spacing;
    return {
      transform: [{ translateX: off - spacing }],
    };
  });

  /*
    ПУЗЫРЬ НАД ПОЛЗУНКОМ: ВРЕМЯ И СТУПЕНЬ ТОЧНОСТИ.

    Всегда над ползунком — и в точной ступени тоже (решение Марка): время принадлежит месту на
    шкале, а не пальцу. По краям прижимается, чтобы не вылезать за полосу.
  */
  const bw = BUBBLE_W;
  const bubble = useAnimatedStyle(() => {
    const anchor = frac.value * width.value;
    const x = Math.min(width.value - bw / 2, Math.max(bw / 2, anchor));
    return {
      opacity: dragging.value,
      transform: [{ translateX: x - bw / 2 }, { translateY: (1 - dragging.value) * 8 }, { scale: 0.92 + dragging.value * 0.08 }],
    };
  });

  const leftTime = useAnimatedStyle(() => ({ opacity: 1 - dragging.value }));
  const shownMs = overrideMs ?? positionMs;
  // Считается один раз на перерисовку (раньше — дважды подряд, с двумя разными Date.now()).
  const ends = endsAt(positionMs, durationMs, speed);
  const tickLabel = tickSec >= 60 ? `${tickSec / 60} мин` : `${tickSec} с`;

  return (
    <View>
      {/*
        ВРЕМЯ — НАД ПОЛОСОЙ, ПО ЕЁ КРАЯМ.

        Цифры по бокам отнимали у полосы ширину, а она тем точнее, чем длиннее. Теперь полоса идёт
        от края до края, а время стоит над её концами: слева — где сейчас, справа — во сколько
        кончится и сколько всего. Края цифр совпадают с краями полосы.
      */}
      <Animated.View style={styles.times} pointerEvents="none">
        {/* Пока над ползунком пузырь со временем, левые цифры прячутся — одно и то же дважды не нужно. */}
        <Animated.Text style={[styles.time, leftTime]} numberOfLines={1}>
          {clock(shownMs / 1000)}
        </Animated.Text>
        <Text style={styles.time} numberOfLines={1}>
          {/*
            КОГДА ЭТО КОНЧИТСЯ — самый частый вопрос к плееру: не «сколько осталось», а «во сколько
            я освобожусь». Считается из остатка и скорости.
          */}
          <Text style={styles.endsAt}>{ends}</Text>
          {ends ? '   ' : ''}
          {clock(durationMs / 1000)}
        </Text>
      </Animated.View>

      <GestureDetector gesture={pan}>
        {/* Зона касания нарочно высокая: попасть пальцем в четырёхточечную линию нельзя. */}
        <Animated.View
         
          style={styles.touch}
          onLayout={(e) => {
            const w = Math.max(1, e.nativeEvent.layout.width);
            width.value = w;
            laid.value = 1;
            setBarW(w);
          }}
        >
          <Animated.View style={[styles.track, track]}>
            <Animated.View style={[styles.fill, fill]} />
            <Animated.View style={[styles.wave, wave]} pointerEvents="none" />
            {tickCount > 0 ? (
              <Animated.View style={[styles.ruler, rulerFade, ruler]} pointerEvents="none">
                {Array.from({ length: tickCount }, (_, i) => (
                  <View key={i} style={[styles.tick, { left: i * spacing }]} />
                ))}
              </Animated.View>
            ) : null}
          </Animated.View>
          <Animated.View style={[styles.knob, knob]} />
        </Animated.View>
      </GestureDetector>

      <Animated.View style={[styles.bubble, { width: bw }, bubble]} pointerEvents="none">
        <Text style={styles.bubbleTime} numberOfLines={1}>
          {clock(shownMs / 1000)}
        </Text>
        {/*
          СТЕПЕНЬ ТОЧНОСТИ — ВИДНА.

          Ступеней три, и раньше их можно было только почувствовать по отклику. Теперь в пузыре три
          деления (горит столько, на какой ступени палец), название ступени и цена деления линейки.
        */}
        {level > 0 ? (
          <View style={styles.levelRow}>
            <View style={styles.dots}>
              {[1, 2, 3].map((i) => (
                <View key={i} style={[styles.dot, i <= level && styles.dotOn]} />
              ))}
            </View>
            <Text style={styles.levelText} numberOfLines={1}>
              {RATES[level].name} · {tickLabel}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    </View>
  );
}

/** «22:47» — часы, когда кончится. Пустая строка, если длительность ещё неизвестна. */
function endsAt(positionMs: number, durationMs: number, speed: number): string {
  if (!(durationMs > 0) || !(durationMs > positionMs)) return '';
  const leftMs = (durationMs - positionMs) / (speed > 0 ? speed : 1);
  const at = new Date(Date.now() + leftMs);
  // «до 22:16» — голые цифры рядом с длительностью читались как ещё одна длительность.
  return `до ${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`;
}

export function clock(s: number): string {
  'worklet';
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  /* Строка времени над полосой: края цифр — ровно края полосы. */
  times: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 2 },
  /*
    ВРЕМЯ — ЕДИНСТВЕННОЕ МЕСТО В ПЛЕЕРЕ, ГДЕ СТОИТ ФИРМЕННЫЙ ШРИФТ.

    Bounded в Люмьере отведён заголовкам и ничему больше. Здесь он уместен ровно потому, что цифры
    времени — единственная постоянная величина на экране.
  */
  time: { fontFamily: font.display, fontSize: 12, fontWeight: '700', color: colors.onBg },
  endsAt: { fontFamily: font.display, fontSize: 10, fontWeight: '600', color: colors.mutedWarm },
  // Зона касания — 42 точки при той же раскладке (поля «съедены» отрицательными отступами):
  // в тонкую полосу пальцем попадать было трудно.
  // Отрицательные поля убраны: часть зоны, вылезавшая за родителя, касаний не получала — палец
  // попадал в кадр под полосой, и панель вела себя как при смахивании.
  touch: { height: 40, justifyContent: 'center' },
  track: { borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.22)', overflow: 'hidden' },
  // Во всю ширину дорожки: видимая доля задаётся сдвигом (см. стиль fill выше).
  fill: { height: '100%', width: '100%', borderRadius: 4, backgroundColor: colors.focusFill },
  /** Волна загрузки: та же полоса, но светлее и поверх заливки. */
  wave: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.75)' },
  ruler: { position: 'absolute', left: 0, top: 0, bottom: 0, right: 0 },
  tick: { position: 'absolute', top: '22%', bottom: '22%', width: 1, backgroundColor: 'rgba(255,255,255,0.55)' },
  knob: {
    position: 'absolute',
    // Место по полосе задаётся сдвигом от левого края (см. стиль knob выше).
    left: 0,
    width: 14,
    height: 14,
    borderRadius: 7,
    marginLeft: -7,
    backgroundColor: '#ffffff',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  bubble: { position: 'absolute', left: 0, bottom: 44, alignItems: 'center', gap: 4 },
  bubbleTime: {
    fontFamily: font.display,
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
  levelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dots: { flexDirection: 'row', gap: 3 },
  dot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: 'rgba(255,255,255,0.3)' },
  dotOn: { backgroundColor: colors.focusFill },
  levelText: { ...typo.labelMedium, color: colors.onBg, fontSize: 10, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
});
