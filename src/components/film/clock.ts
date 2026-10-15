import { Animated, Easing } from 'react-native';

/*
  ЧАСЫ СЦЕН «НАСТРОЕНИЯ». Все движения сцен и плёнки — от двух общих значений на нативном драйвере:
  T — медленный круг (30 с), G — быстрый (1 с) для зерна, пыли и мерцания. Каждое движение делает
  целое число оборотов за круг, поэтому петля бесшовная. Пока ни одной сцены не видно, часы стоят.
*/
// 30 с на круг: все движения сцен медленные и тягучие, как дыхание, а не суета.
const LOOP = 30000;
export const T = new Animated.Value(0);
/** Быстрые часы зерна: 0→1 за секунду, по ним прыгают зерно, пыль и мерцание плёнки. */
export const G = new Animated.Value(0);

const live = new Set<string>();
let running: Animated.CompositeAnimation[] = [];
/*
  24 КАДРА В СЕКУНДУ, КАК У ПЛЁНКИ — прямо в самих часах. Часы T идут не плавно, а шагами по
  1/24 с (ступенчатое «смягчение»): все движения сцен меняются 24 раза в секунду, а между
  шагами стоят — и видеокарта между шагами ничего не перерисовывает. Экран iPhone Pro
  обновляется до 120 раз в секунду, и раньше каждое микродвижение заставляло пересобирать весь
  экран (со стеклом панели вкладок и свечением ленты) — отсюда нагрев и лаги. Движения
  медленные (доли точки за шаг) — на глаз они плавные, а ритм совпадает с зерном плёнки.

  Шаг сделан в часах, а не в каждой фигуре: так у каждой фигуры остаётся короткая таблица
  значений (несколько десятков точек). Длинные таблицы система перебирает на каждом кадре —
  это тоже была нагрузка.
*/
const FPS = 24;
const STEPS = Math.round((LOOP / 1000) * FPS);
const stepEase = (x: number) => Math.floor(x * STEPS) / STEPS;

function run() {
  if (running.length) return;
  running = [
    Animated.loop(Animated.timing(T, { toValue: 1, duration: LOOP, easing: stepEase, useNativeDriver: true })),
    Animated.loop(Animated.timing(G, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true })),
  ];
  running.forEach((a) => a.start());
}
function halt() {
  running.forEach((a) => a.stop());
  running = [];
  // Нативная петля крутится от значения, с которого стартовала, — возвращаем в ноль, иначе после
  // паузы она ходила бы по куску круга. Сцену в этот момент никто не видит — скачка не заметно.
  T.setValue(0);
  G.setValue(0);
}
/** Видна ли сцена (карточка в кадре / страница открыта). Пока не видно ни одной — часы стоят. */
export function sceneLive(id: string, on: boolean) {
  if (on) live.add(id);
  else live.delete(id);
  if (live.size) run();
  else halt();
}

/** Плавная волна по часам: cycles оборотов за круг, от a до b. 24 точки на оборот. */
export function wave(cycles: number, a: number, b: number, phase = 0) {
  const N = Math.max(24, Math.round(24 * cycles));
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  for (let i = 0; i <= N; i++) {
    const x = i / N;
    inputRange.push(x);
    outputRange.push(a + (b - a) * (0.5 + 0.5 * Math.sin(2 * Math.PI * (cycles * x + phase))));
  }
  return T.interpolate({ inputRange, outputRange });
}
/** Короткий «пролёт» внутри круга: от from до to на отрезке [t0, t1], вне его — на краях. */
export function flight(t0: number, t1: number, from: number, to: number) {
  return T.interpolate({ inputRange: [0, t0, t1, 1], outputRange: [from, from, to, to] });
}
export function flash(t0: number, t1: number) {
  const e = (t1 - t0) * 0.18;
  return T.interpolate({ inputRange: [0, t0, t0 + e, t1 - e, t1, 1], outputRange: [0, 0, 1, 1, 0, 0] });
}
/** Полный оборот за круг (для rotate). */
export function spin() {
  return T.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
}

/*
  «Лесенка» по быстрым часам G (секунда): на каждом из N шагов — своё значение. Так движение
  меняется ровно 24 раза в секунду, как кадры плёнки, и между шагами экран не перерисовывается.
*/
export function steppedG(values: number[]) {
  const n = values.length;
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  for (let i = 0; i < n; i++) {
    inputRange.push(i / n, (i + 1) / n - 1e-4);
    outputRange.push(values[i], values[i]);
  }
  return G.interpolate({ inputRange, outputRange, extrapolate: 'clamp' });
}

/*
  ДРОЖАНИЕ КАДРА В ПРОЕКТОРЕ (gate weave) для названий настроений: слово чуть «гуляет» —
  по горизонтали на доли точки, по вертикали чуть заметнее, — 24 раза в секунду. Общие узлы на
  все названия: их подключают сколько угодно надписей, считаются они один раз.
*/
// Сила дрожания: по просьбе Марка — втрое тише первого варианта (было до 0,5 / 0,8 точки).
const WEAVE = 0.35;
export const WEAVE_X = steppedG([0, 0.4, -0.3, 0.2, 0.5, -0.2, 0, 0.3, -0.5, 0.1, 0.4, -0.1, 0, -0.3, 0.2, 0.5, -0.4, 0.1, 0.3, -0.2, 0, 0.4, -0.3, 0.1].map((v) => v * WEAVE));
export const WEAVE_Y = steppedG([0, 0.3, 0.7, 0.2, -0.3, 0.5, 0.1, -0.4, 0.6, 0.2, 0, 0.8, 0.3, -0.2, 0.4, 0, -0.5, 0.3, 0.6, 0.1, -0.3, 0.4, 0.7, 0].map((v) => v * WEAVE));

/*
  Дрожание САМОГО КАДРА — абстракции под названием: так же 24 раза в секунду, но свой рисунок
  шагов (кадр и надпись в старом кино гуляют не синхронно) и чуть сильнее — до ~0,6 точки.
*/
// Сила дрожания кадра: Марк подбирал на глаз — 70 % от первого варианта (до ~0,42 точки).
const FRAME = 0.7;
export const FRAME_X = steppedG([0, -0.3, 0.2, 0.5, 0.1, -0.4, 0.3, 0, -0.2, 0.6, 0.1, -0.3, 0.2, -0.1, 0.4, 0, -0.5, 0.2, 0.3, -0.2, 0.1, 0.5, -0.3, 0].map((v) => v * FRAME));
export const FRAME_Y = steppedG([0.2, 0, 0.5, -0.2, 0.3, 0.6, 0, -0.3, 0.4, 0.1, -0.4, 0.3, 0.6, 0, -0.2, 0.5, 0.2, -0.3, 0.1, 0.4, -0.1, 0.3, 0.6, 0.1].map((v) => v * FRAME));

/** Плёночное «смягчение»: та же кривая, но шагами по 1/24 с — для разовых движений (звезда). */
export function filmEase(ease: (t: number) => number, durationMs: number) {
  const n = Math.max(1, Math.round((durationMs / 1000) * 24));
  return (t: number) => ease(Math.min(1, Math.floor(t * n) / n));
}
