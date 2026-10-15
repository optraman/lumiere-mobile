import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dimensions, Image, Keyboard, StyleSheet, Text, View } from 'react-native';
import { LOGO_LETTERS_ART } from './film/letters';
import { titlesByRecent } from '../data/watchProgress';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { ZoomIn, Easing, runOnJS, useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { LINE, outlineMetrics } from './BusyOutline';
import * as Haptics from 'expo-haptics';
import { colors } from '../theme/colors';
import { font, type as typo } from '../theme/fonts';

/*
  ПАСХАЛКА ПОИСКА — ЗМЕЙКА.

  Тридцать быстрых касаний по лупе — и линия поиска, бегавшая по краю поля, отрывается от рамки,
  летит к середине экрана, по пути сжимаясь до самой маленькой змейки (три клетки), а вокруг неё
  разворачивается поле игры. Управление — свайпами: вверх, вниз, влево, вправо.

  Устроено просто и дёшево: «полёт» — одна полоса на Reanimated (по кривой Безье, с поворотом по
  касательной); сама игра — шаг раз в ~120 мс в JS и клетки обычными View (перерисовка ~8 раз в
  секунду — это ничто). Уход с вкладки сбрасывает всё обратно в поиск (search.tsx).
*/

const CELL = 18;
const GAP = 2;
const START_LEN = 3;
/** Постер-бонус — 4×6 клеток (вшестеро выше буквы, пропорции постера 2:3). */
const BONUS_W = 4;
const BONUS_H = 6;

/** Правый край поля — от правого края экрана (для строки «ЛЮМЬЕР» над полем). */
function winRight(board: { x: number; w: number }) {
  return Dimensions.get('window').width - (board.x + board.w);
}

type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

const APath = Reanimated.createAnimatedComponent(Path);

export const SnakeEgg = memo(function SnakeEgg({ field, area, tailAt, tailTime }: { field: Rect; area: Rect; tailAt: number; tailTime: number }) {
  // Поле игры: целое число клеток, по центру отведённой области.
  const cols = Math.max(8, Math.floor((area.w - 8) / CELL));
  const rows = Math.max(10, Math.floor((area.h - 40) / CELL));
  const board = useMemo(() => {
    const w = cols * CELL;
    const h = rows * CELL;
    return { x: area.x + (area.w - w) / 2, y: area.y + 34 + (area.h - 34 - h) / 2, w, h };
  }, [cols, rows, area]);
  const mid = { x: Math.floor(cols / 2), y: Math.floor(rows / 2) };

  const [phase, setPhase] = useState<'fly' | 'ready' | 'play' | 'over'>('fly');

  /* ——— ПОЛЁТ ЛИНИИ ——— */
  /*
    Летит ТА САМАЯ линия поиска: штрих продолжает бежать по рамке поля с того места, где он был
    в момент 30-го касания и с той же скоростью, на нижней кромке сходит с рамки и ползёт к
    середине экрана ходами змейки (прямо и под прямым углом), по пути укорачиваясь до трёх
    клеток и утолщаясь до змейки.
    Это один штрих (пунктир с одним отрезком) вдоль заранее построенного пути — как и на рамке.
  */
  const to = { x: board.x + (mid.x - 1) * CELL + 1.5 * CELL, y: board.y + mid.y * CELL + CELL / 2 };
  const endW = CELL - GAP;
  const endLen = START_LEN * CELL - GAP;
  const route = useMemo(() => {
    const { per, seg } = outlineMetrics(field.w, field.h);
    const x0 = field.x + LINE / 2;
    const y0 = field.y + LINE / 2;
    const x1 = field.x + field.w - LINE / 2;
    const y1 = field.y + field.h - LINE / 2;
    const cx = field.x + field.w / 2;
    // Рамка как у BusyOutline: от середины верхней кромки по часовой стрелке.
    const corners = [
      { d: 0, x: cx, y: y0 },
      { d: x1 - cx, x: x1, y: y0 },
      { d: x1 - cx + (y1 - y0), x: x1, y: y1 },
      { d: x1 - cx + (y1 - y0) + (x1 - x0), x: x0, y: y1 },
      { d: x1 - cx + 2 * (y1 - y0) + (x1 - x0), x: x0, y: y0 },
      { d: per, x: cx, y: y0 },
    ];
    const at = (dist: number) => {
      const q = ((dist % per) + per) % per;
      for (let i = 1; i < corners.length; i++) {
        const A = corners[i - 1];
        const B = corners[i];
        if (q <= B.d) {
          const f = (q - A.d) / Math.max(1e-6, B.d - A.d);
          return { x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f };
        }
      }
      return { x: cx, y: y0 };
    };
    // Хвост штриха — там, где он сейчас; голова — на seg дальше.
    const ran = tailTime ? Math.max(0, Date.now() - tailTime) * (per / 1150) : 0;
    const tail = (((tailAt + ran) % per) + per) % per;
    const head = tail + seg;
    // Сход с рамки — на нижней кромке: сразу, если голова уже на ней, иначе — когда дойдёт.
    const b0 = corners[2].d;
    const b1 = corners[3].d;
    let exit = head;
    const hq = head % per;
    if (!(hq >= b0 && hq <= b1)) exit = head + ((b0 - hq + per) % per);
    const pts: { x: number; y: number }[] = [at(tail)];
    for (const k of [0, 1]) {
      for (const c of corners) {
        const d = c.d + k * per;
        if (d > tail && d < exit) pts.push({ x: c.x, y: c.y });
      }
    }
    const E = at(exit);
    pts.push(E);
    const perLen = exit - tail;
    /*
      Дальше — КАК ХОДИТ ЗМЕЙКА: только прямые отрезки и повороты под прямым углом. С нижней
      кромки — вниз, потом вбок, ещё вниз до ряда змейки и последним ходом вправо — в клетки, где
      она начнёт игру (она стартует, двигаясь вправо).
    */
    const S0 = { x: to.x - endLen / 2 + endW / 2, y: to.y };
    const S1 = { x: to.x + endLen / 2 - endW / 2, y: to.y };
    const yA = Math.min(E.y + 3 * CELL, to.y - 2 * CELL);
    const xB = S0.x - 3 * CELL;
    pts.push({ x: E.x, y: yA }, { x: xB, y: yA }, { x: xB, y: to.y });
    pts.push(S1);
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const d = 'M' + pts.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' L');
    return { d, seg, perLen, total, speed: per / 1150 };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, tailAt, tailTime]);

  const hd = useSharedValue(route.seg);
  const frame = useSharedValue(0);
  useEffect(() => {
    // По рамке — с той же скоростью, что бежал штрих; дальше — плавно к середине.
    const t1 = Math.max(0, (route.perLen - route.seg) / route.speed);
    // По «змеиному» пути — ровным ходом, как ползёт змейка (без разгона и торможения).
    const t2 = Math.max(700, Math.min(1400, (route.total - route.perLen) / 0.55));
    hd.value = withSequence(
      withTiming(route.perLen, { duration: t1, easing: Easing.linear }),
      withTiming(route.total, { duration: t2, easing: Easing.linear }, (done) => {
        if (done) runOnJS(setPhase)('ready');
      }),
    );
    frame.value = withDelay(t1 + t2 - 120, withTiming(1, { duration: 420, easing: Easing.bezier(0.2, 0, 0, 1) }));
  }, [route, hd, frame]);
  const lineProps = useAnimatedProps(() => {
    const h = hd.value;
    const f = Math.max(0, Math.min(1, (h - route.perLen) / Math.max(1, route.total - route.perLen)));
    // Длина штриха без круглых концов: к концу — две клетки (+ толщина концов = три клетки).
    const L = route.seg + (endLen - endW - route.seg) * f;
    const wdt = LINE + (endW - LINE) * f * f;
    return { strokeDasharray: [Math.max(0.1, L), 100000], strokeDashoffset: -(h - L), strokeWidth: wdt };
  });
  // Рамка поля: разворачивается из габарита змейки на всё поле.
  const frameSt = useAnimatedStyle(() => {
    const f = frame.value;
    const sx = to.x - endLen / 2 - 4;
    const sy = to.y - endW / 2 - 4;
    const sw = endLen + 8;
    const sh = endW + 8;
    return {
      opacity: Math.min(1, f * 2),
      left: sx + (board.x - sx) * f,
      top: sy + (board.y - sy) * f,
      width: sw + (board.w - sw) * f,
      height: sh + (board.h - sh) * f,
    };
  });

  /* ——— ИГРА ——— */
  const snake = useRef<Pt[]>([]);
  const dir = useRef<Pt>({ x: 1, y: 0 });
  const queue = useRef<Pt[]>([]);
  const food = useRef<Pt>({ x: 0, y: 0 });
  const [score, setScore] = useState(0);
  const scoreRef = useRef(0);
  /*
    ПОСТЕР-БОНУС. После каждой третьей съеденной буквы на поле появляется постер из истории
    просмотров — блок 4×6 клеток. Съел (въехал головой в любую его клетку) — +3 очка и змейка
    подрастает на три клетки. Пока постер на поле, новый не появляется.
  */
  const bonus = useRef<{ x: number; y: number; uri: string } | null>(null);
  const grow = useRef(0);
  // Буквы считаются отдельно от очков: постер даёт очки, но букву в слове не пропускает.
  const [letters, setLetters] = useState(0);
  const lettersRef = useRef(0);
  const lastPoster = useRef<string | null>(null);
  const inBonus = (q: Pt) => {
    const b = bonus.current;
    return !!b && q.x >= b.x && q.x < b.x + BONUS_W && q.y >= b.y && q.y < b.y + BONUS_H;
  };
  const best = useRef(0);
  const [, redraw] = useState(0);

  const placeFood = useCallback(() => {
    const taken = new Set(snake.current.map((s) => `${s.x},${s.y}`));
    for (let i = 0; i < 500; i++) {
      // Не у самого края: буква шире клетки и не должна вылезать за рамку поля.
      const f = { x: 1 + Math.floor(Math.random() * (cols - 2)), y: Math.floor(Math.random() * rows) };
      if (!taken.has(`${f.x},${f.y}`) && !inBonus(f)) {
        food.current = f;
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, rows]);

  const placeBonus = useCallback(() => {
    // Постеры — из истории просмотров (что смотрел — то и ешь); мелкий размер файла — под блок 36 точек.
    const uris = titlesByRecent()
      .map((t) => t.last.posterUrl)
      .filter((u): u is string => !!u)
      .map((u) => u.replace(/\/t\/p\/w\d+\//, '/t/p/w185/'));
    if (!uris.length) return;
    const pool = uris.length > 1 ? uris.filter((u) => u !== lastPoster.current) : uris;
    const uri = pool[Math.floor(Math.random() * pool.length)];
    const taken = new Set(snake.current.map((q) => `${q.x},${q.y}`));
    const head = snake.current[0];
    for (let i = 0; i < 300; i++) {
      const b = { x: Math.floor(Math.random() * (cols - BONUS_W + 1)), y: Math.floor(Math.random() * (rows - BONUS_H + 1)) };
      let ok = true;
      for (let dx = 0; dx < BONUS_W && ok; dx++)
        for (let dy = 0; dy < BONUS_H && ok; dy++) {
          const q = { x: b.x + dx, y: b.y + dy };
          if (taken.has(`${q.x},${q.y}`) || (q.x === food.current.x && q.y === food.current.y)) ok = false;
        }
      // Не прямо под носом у змейки — чтобы появление не было «съел, не заметив».
      if (ok && head && Math.abs(b.x - head.x) + Math.abs(b.y - head.y) < 4) ok = false;
      if (ok) {
        bonus.current = { ...b, uri };
        lastPoster.current = uri;
        return;
      }
    }
  }, [cols, rows]);

  const reset = useCallback(() => {
    snake.current = [
      { x: mid.x + 1, y: mid.y },
      { x: mid.x, y: mid.y },
      { x: mid.x - 1, y: mid.y },
    ];
    dir.current = { x: 1, y: 0 };
    queue.current = [];
    setScore(0);
    scoreRef.current = 0;
    bonus.current = null;
    grow.current = 0;
    lettersRef.current = 0;
    setLetters(0);
    placeFood();
    redraw((n) => n + 1);
  }, [mid.x, mid.y, placeFood]);

  useEffect(() => {
    if (phase === 'ready') reset();
  }, [phase, reset]);

  useEffect(() => {
    if (phase !== 'play') return;
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const step = () => {
      if (!alive) return;
      const next = queue.current.shift();
      if (next) dir.current = next;
      const head = snake.current[0];
      const nh = { x: head.x + dir.current.x, y: head.y + dir.current.y };
      const hitWall = nh.x < 0 || nh.y < 0 || nh.x >= cols || nh.y >= rows;
      const eats = nh.x === food.current.x && nh.y === food.current.y;
      const eatsBonus = inBonus(nh);
      // Хвост уходит из клетки в этом же шаге — в неё можно въехать (если змейка не растёт).
      const keep = eats || eatsBonus || grow.current > 0;
      if (!eats && !eatsBonus && grow.current > 0) grow.current -= 1;
      const body = keep ? snake.current : snake.current.slice(0, -1);
      const hitSelf = body.some((s) => s.x === nh.x && s.y === nh.y);
      if (hitWall || hitSelf) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setPhase('over');
        return;
      }
      snake.current = [nh, ...body];
      const before = scoreRef.current;
      if (eats) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        scoreRef.current += 1;
        lettersRef.current += 1;
        setLetters(lettersRef.current);
        placeFood();
      }
      if (eatsBonus) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        scoreRef.current += 3;
        // Этот шаг уже оставил хвост (+1), ещё две клетки — на следующих шагах: итого +3.
        grow.current += 2;
        bonus.current = null;
      }
      if (scoreRef.current !== before) {
        best.current = Math.max(best.current, scoreRef.current);
        setScore(scoreRef.current);
        // Постер — после каждой третьей СЪЕДЕННОЙ БУКВЫ, а не по очкам: иначе сам постер (+3)
        // переводил счёт через тройку, и следующий появлялся тут же — постеры шли без перерыва.
        if (eats && lettersRef.current % 3 === 0 && !bonus.current) placeBonus();
      }
      redraw((n) => n + 1);
      // Чем длиннее змейка, тем быстрее шаг: 130 мс → не быстрее 70.
      t = setTimeout(step, Math.max(70, 130 - snake.current.length * 2));
    };
    t = setTimeout(step, 130);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, cols, rows, placeFood, placeBonus]);

  const turn = useCallback(
    (dx: number, dy: number) => {
      const d = Math.abs(dx) > Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) };
      if (phase === 'over') {
        reset();
        setPhase('play');
        return;
      }
      if (phase === 'ready') setPhase('play');
      // Разворот «в себя» запрещён; очередь — чтобы два быстрых свайпа за один шаг оба сработали.
      const last = queue.current[queue.current.length - 1] ?? dir.current;
      if (d.x === -last.x && d.y === -last.y) return;
      if (d.x === last.x && d.y === last.y) return;
      if (queue.current.length < 2) queue.current.push(d);
    },
    [phase, reset],
  );

  // Свайп срабатывает, как только палец ушёл на 16 точек, — не дожидаясь, пока его отпустят.
  const fired = useRef(false);
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .onBegin(() => {
          fired.current = false;
          // Клавиатура, открытая случайно, закрывается от любого касания игры.
          Keyboard.dismiss();
        })
        .onUpdate((e) => {
          if (fired.current) return;
          if (Math.abs(e.translationX) > 16 || Math.abs(e.translationY) > 16) {
            fired.current = true;
            turn(e.translationX, e.translationY);
          }
        }),
    [turn],
  );
  const tap = useMemo(
    () =>
      Gesture.Tap()
        .runOnJS(true)
        .onEnd(() => {
          Keyboard.dismiss();
          if (phase === 'over') {
            reset();
            setPhase('ready');
          }
        }),
    [phase, reset],
  );

  // Один и тот же жест между шагами игры: пересоздавать его на каждый шаг — рвать свайп на ходу.
  const gesture = useMemo(() => Gesture.Exclusive(pan, tap), [pan, tap]);
  const showGame = phase !== 'fly';
  return (
    <GestureDetector gesture={gesture}>
      <View style={StyleSheet.absoluteFill}>
        <Reanimated.View pointerEvents="none" style={[styles.frame, frameSt]} />
        {showGame ? (
          <>
            <Text style={[styles.score, { left: board.x, top: board.y - 30 }]}>
              {score}
              {best.current > 0 ? <Text style={styles.best}>{`   лучший ${best.current}`}</Text> : null}
            </Text>
            {/*
              ЕДА — БУКВЫ ЛОГОТИПА по порядку: Л, Ю, М, Ь, Е, Р — и снова. Вырезаны из самой надписи
              «ЛЮМЬЕР» (film/letters.ts): та же форма и толщина, что в логотипе. Буква стоит по
              центру своей клетки, высотой в клетку.
            */}
            {(() => {
              const art = LOGO_LETTERS_ART[letters % LOGO_LETTERS_ART.length];
              const lh = CELL;
              const lw = (art.w / art.h) * lh;
              return (
                <Image
                  source={{ uri: art.uri }}
                  style={[
                    styles.letter,
                    { width: lw, height: lh, left: board.x + food.current.x * CELL + CELL / 2 - lw / 2, top: board.y + food.current.y * CELL + CELL / 2 - lh / 2 },
                  ]}
                />
              );
            })()}
            {bonus.current ? (
              <Reanimated.View
                key={bonus.current.uri + bonus.current.x + ',' + bonus.current.y}
                entering={ZoomIn.duration(260)}
                style={[styles.poster, { left: board.x + bonus.current.x * CELL + GAP / 2, top: board.y + bonus.current.y * CELL + GAP / 2 }]}
              >
                <Image source={{ uri: bonus.current.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              </Reanimated.View>
            ) : null}
            {/* Слово собирается по мере еды: съеденные буквы этого круга — яркие, остальные — тенью;
                собранное целиком «ЛЮМЬЕР» горит, пока не съедена следующая «Л». */}
            <View style={[styles.word, { right: winRight(board), top: board.y - 27 }]} pointerEvents="none">
              {LOGO_LETTERS_ART.map((l, i) => (
                <Image
                  key={l.ch}
                  source={{ uri: l.uri }}
                  style={{ width: (l.w / l.h) * 14, height: 14, opacity: i < (letters > 0 && letters % LOGO_LETTERS_ART.length === 0 ? LOGO_LETTERS_ART.length : letters % LOGO_LETTERS_ART.length) ? 1 : 0.22, tintColor: '#F2EADB' }}
                />
              ))}
            </View>
            {snake.current.map((s, i) => (
              <View
                key={i}
                style={[
                  styles.cell,
                  i === 0 && styles.head,
                  { left: board.x + s.x * CELL + GAP / 2, top: board.y + s.y * CELL + GAP / 2 },
                ]}
              />
            ))}
            {phase === 'ready' ? <Text style={[styles.hint, { top: board.y + board.h / 2 + CELL * 2 }]}>Свайпни, чтобы начать</Text> : null}
            {phase === 'over' ? (
              <View style={[styles.over, { top: board.y + board.h / 2 - 50 }]} pointerEvents="none">
                <Text style={styles.overTitle}>Игра окончена</Text>
                <Text style={styles.overText}>Счёт {score} · коснись или свайпни, чтобы сыграть ещё</Text>
              </View>
            ) : null}
          </>
        ) : null}
        {phase === 'fly' ? (
          <Svg pointerEvents="none" style={StyleSheet.absoluteFill}>
            <APath d={route.d} fill="none" stroke={colors.focusFill} strokeLinecap="round" strokeLinejoin="miter" animatedProps={lineProps} />
          </Svg>
        ) : null}
      </View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  frame: { position: 'absolute', borderWidth: 1, borderColor: 'rgba(204,204,153,0.35)' },
  cell: { position: 'absolute', width: CELL - GAP, height: CELL - GAP, borderRadius: 3, backgroundColor: colors.focusFill },
  head: { backgroundColor: '#F2EADB' },
  // Буква-еда: тёплая белая, с лёгким свечением, как логотип на заставке.
  letter: { position: 'absolute', tintColor: '#F2EADB', shadowColor: '#F2EADB', shadowOpacity: 0.7, shadowRadius: 5, shadowOffset: { width: 0, height: 0 } },
  word: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 2 },
  // Постер-бонус: блок 2×3 клетки, тонкая пергаментная рамка и свечение — чтобы читался как «приз».
  poster: {
    position: 'absolute',
    width: BONUS_W * CELL - GAP,
    height: BONUS_H * CELL - GAP,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(242,234,219,0.6)',
    backgroundColor: colors.surfaceHi,
  },
  score: { position: 'absolute', fontFamily: font.display, fontSize: 20, color: colors.onBg },
  best: { fontFamily: font.regular, fontSize: 13, color: colors.mutedWarm },
  hint: { position: 'absolute', left: 0, right: 0, textAlign: 'center', ...typo.labelMedium, color: colors.mutedWarm },
  over: { position: 'absolute', left: 24, right: 24, alignItems: 'center', gap: 6 },
  overTitle: { fontFamily: font.display, fontSize: 24, color: colors.onBg },
  overText: { ...typo.bodyMedium, color: colors.mutedWarm, textAlign: 'center' },
});
