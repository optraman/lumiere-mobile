import { createContext, memo, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, View, type ViewStyle } from 'react-native';
import Reanimated, { runOnJS, useAnimatedReaction, useAnimatedStyle, useSharedValue, withDelay, withTiming, type SharedValue } from 'react-native-reanimated';
import Svg, { Circle, ClipPath, Defs, G, LinearGradient, Path, Polygon, RadialGradient, Rect, Stop } from 'react-native-svg';

import { FilmGrain } from './film/FilmGrain';
import { MoodMorph } from './MoodMorph';
import { FRAME_X, FRAME_Y, filmEase, flash, flight, sceneLive, spin, wave } from './film/clock';

/*
  СЦЕНЫ «НАСТРОЕНИЯ» — абстракции из жанровых картинок APK (assets/genres/genre_*.png), только
  живые: красные полосы боевика скользят по своей диагонали, круги романтики дышат и плывут,
  у комедии катится штриховка и вертится звёздочка, в арке ужасов дрожит лиловый свет, у
  фантастики луна ходит по орбите и пролетают метеоры.

  ПОЧЕМУ ВЕКТОР, А НЕ ВИДЕО ИЛИ PNG. Картинки и видео в Expo Go едут с сервера разработки и
  появлялись позже экрана; вектор есть с первого кадра. Каждая фигура — своё SVG-полотно: оно
  рисуется ОДИН раз в собственную картинку слоя, а дальше система двигает эту готовую картинку
  сдвигом/масштабом/прозрачностью на нативном драйвере. Ни JS, ни перерисовки SVG по кадрам.

  БЕРЕЖЁМ ВИДЕОКАРТУ (телефон грелся):
  • ДВИЖЕТСЯ только сцена, на которой стоит карусель (RunCtx). Остальные смонтированы заранее
    (по одной, пока карточка подъезжает), но неподвижны и невидимы — их анимации не подключены,
    система их не считает, а листание не перерисовывает ни одного полотна.
  • Часы шагают 24 раза в секунду (clock.ts): между шагами экран не перерисовывается.
  • Полотна — в 0,6 разрешения (RES), морфинг — в 0,5: процессору и видеокарте в разы меньше точек.
  • Без shouldRasterizeIOS: SVG-полотно и так уже готовая картинка, а «растеризация» добавляла
    вторую копию каждого полотна и лишний проход вне экрана — двойная память видеокарты.

  ВСЕ ДВИЖЕНИЯ — ОТ ОДНИХ ЧАСОВ (T: 0→1 за 30 с, по кругу). Каждое движение делает целое число
  оборотов за круг, поэтому петля бесшовная; часы общие для карточки и страницы и стоят, когда
  ни одной сцены не видно (sceneLive), — на Главной это не греет телефон зря.

  Рисунок — в координатах 400×300 и «накрывает» любой прямоугольник (как resizeMode cover):
  на карточке и в шапке страницы композиция одна и та же.
*/

type Frame = { s: number; ox: number; oy: number };
const frameFor = (w: number, h: number): Frame => {
  const s = Math.max(w / 400, h / 300);
  return { s, ox: (w - 400 * s) / 2, oy: (h - 300 * s) / 2 };
};

/*
  Движется ли сцена. Двигается только та, на которой стоит карусель; остальные смонтированы,
  но неподвижны и невидимы — их анимации даже не подключены, и системе нечего считать.
*/
const RunCtx = createContext(true);

/*
  Полотна рисуются в 0,6 от размера экрана и растягиваются обратно. SVG рисует процессор,
  и полотна во весь экран на 3x-экране — это миллионы точек градиентов на каждое: при появлении
  сцены это были заметные подтормаживания, и вся эта память лежала в видеокарте. Абстракции из
  мягких градиентов под зерном плёнки в 0,6 выглядят так же — разница в чёткости не видна.
*/
const RES = 0.6;

/**
 * Фигура сцены: кусок рисунка 400×300 в своей коробке [x, y, ш, в]. Рисуется один раз и дальше
 * двигается как готовая картинка; трансформация — вокруг центра коробки.
 */
function Piece({ f, box, style, children }: { f: Frame; box: [number, number, number, number]; style?: Animated.WithAnimatedValue<ViewStyle>; children: ReactNode }) {
  const run = useContext(RunCtx);
  const [x, y, bw, bh] = box;
  const W = bw * f.s;
  const H = bh * f.s;
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: 'absolute', left: f.ox + x * f.s, top: f.oy + y * f.s, width: W, height: H }, run ? style : null]}
    >
      <View style={{ width: W * RES, height: H * RES, transformOrigin: 'top left', transform: [{ scale: 1 / RES }] }}>
        <Svg width={W * RES} height={H * RES} viewBox={`${x} ${y} ${bw} ${bh}`}>
          {children}
        </Svg>
      </View>
    </Animated.View>
  );
}
const FULL: [number, number, number, number] = [0, 0, 400, 300];
/** Сдвиг в единицах рисунка → точки экрана. */
const px = (f: Frame, v: Animated.AnimatedInterpolation<number>) => Animated.multiply(v, f.s);

// ——— мелкие украшения, как в APK: сетка точек, черта, крестик ———
function Dots({ x, y, cols, rows, step, color, o, r = 0.9 }: { x: number; y: number; cols: number; rows: number; step: number; color: string; o: number; r?: number }) {
  const out: ReactNode[] = [];
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) out.push(<Circle key={`${i}-${j}`} cx={x + i * step} cy={y + j * step} r={r} fill={color} opacity={o} />);
  return <>{out}</>;
}
const Dash = ({ x1, y, x2, c, o }: { x1: number; y: number; x2: number; c: string; o: number }) => (
  <Path d={`M${x1},${y} H${x2}`} stroke={c} strokeWidth={1.4} opacity={o} />
);
const Cross = ({ x, y, s, c, o }: { x: number; y: number; s: number; c: string; o: number }) => (
  <Path d={`M${x - s},${y} H${x + s} M${x},${y - s} V${y + s}`} stroke={c} strokeWidth={1.2} opacity={o} />
);
const star4 = (cx: number, cy: number, s: number) => {
  const k = s * 0.14;
  return `M${cx},${cy - s} Q${cx + k},${cy - k} ${cx + s},${cy} Q${cx + k},${cy + k} ${cx},${cy + s} Q${cx - k},${cy + k} ${cx - s},${cy} Q${cx - k},${cy - k} ${cx},${cy - s} Z`;
};

/* ——— БОЕВИКИ: красные полосы по диагонали на чёрном ——— */
function Action({ f }: { f: Frame }) {
  // Полосы ходят вдоль своей диагонали навстречу друг другу — как клинки.
  const along = (amp: number, ph: number) => {
    const v = wave(2, -amp, amp, ph);
    return [{ translateX: px(f, Animated.multiply(v, 0.6)) }, { translateY: px(f, Animated.multiply(v, -0.8)) }];
  };
  return (
    <>
      <Piece f={f} box={FULL}>
        <Defs>
          <RadialGradient id="a3" cx="0.62" cy="0.35" r="0.6">
            <Stop offset="0" stopColor="#FF2010" stopOpacity={0.22} />
            <Stop offset="1" stopColor="#FF2010" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width={400} height={300} fill="#070404" />
        <Rect width={400} height={300} fill="url(#a3)" />
        <Polygon points="40,300 140,300 330,0 230,0" fill="#170808" />
        <Dots x={22} y={22} cols={11} rows={6} step={9} color="#C42318" o={0.45} />
        <Dash x1={22} y={150} x2={58} c="#E0201A" o={0.9} />
        <Dots x={22} y={228} cols={6} rows={5} step={9} color="#C42318" o={0.35} />
        <Cross x={356} y={62} s={6} c="#E0201A" o={0.85} />
      </Piece>
      <Piece f={f} box={[40, -40, 440, 380]} style={{ transform: along(9, 0.5) }}>
        <Defs>
          <LinearGradient id="a2" x1="1" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#F01408" />
            <Stop offset="0.45" stopColor="#B00804" stopOpacity={0.85} />
            <Stop offset="1" stopColor="#3A0000" stopOpacity={0.15} />
          </LinearGradient>
        </Defs>
        <Polygon points="60,330 360,-20 470,-20 170,330" fill="url(#a2)" />
      </Piece>
      <Piece f={f} box={[170, -40, 260, 270]} style={{ transform: along(12, 0), opacity: wave(3, 0.82, 1) }}>
        <Defs>
          <LinearGradient id="a1" x1="1" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#FF2A12" />
            <Stop offset="0.6" stopColor="#E00A04" />
            <Stop offset="1" stopColor="#9A0000" />
          </LinearGradient>
        </Defs>
        <Polygon points="190,140 300,-20 400,-20 238,210" fill="url(#a1)" />
      </Piece>
    </>
  );
}

/* ——— РОМАНТИКА: розовые круги, искорка ——— */
function Romance({ f }: { f: Frame }) {
  return (
    <>
      <Piece f={f} box={FULL}>
        <Defs>
          <LinearGradient id="r0" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#DC2454" />
            <Stop offset="1" stopColor="#C8163F" />
          </LinearGradient>
        </Defs>
        <Rect width={400} height={300} fill="url(#r0)" />
        <Dots x={20} y={20} cols={10} rows={8} step={8} color="#FFFFFF" o={0.28} r={0.8} />
        <Dash x1={24} y={282} x2={60} c="#FFFFFF" o={0.55} />
      </Piece>
      {/* Большой круг дышит, малый плывёт по кругу внутри него — «сердце бьётся». */}
      <Piece f={f} box={[100, 30, 340, 340]} style={{ transform: [{ scale: wave(2, 1, 1.035) }, { translateY: px(f, wave(1, -4, 4, 0.25)) }] }}>
        <Defs>
          <RadialGradient id="r1" cx="0.3" cy="0.25" r="0.85">
            <Stop offset="0" stopColor="#F8709A" />
            <Stop offset="0.55" stopColor="#E83A6C" />
            <Stop offset="1" stopColor="#DA2A5A" />
          </RadialGradient>
        </Defs>
        <Circle cx={270} cy={200} r={165} fill="url(#r1)" />
      </Piece>
      <Piece f={f} box={[206, 146, 224, 224]} style={{ transform: [{ translateX: px(f, wave(1, -10, 10)) }, { translateY: px(f, wave(1, -7, 7, 0.25)) }] }}>
        <Defs>
          <RadialGradient id="r2" cx="0.35" cy="0.3" r="0.8">
            <Stop offset="0" stopColor="#D82050" />
            <Stop offset="1" stopColor="#C9173F" />
          </RadialGradient>
        </Defs>
        <Circle cx={318} cy={258} r={108} fill="url(#r2)" />
      </Piece>
      <Piece f={f} box={[346, 22, 32, 32]} style={{ opacity: wave(4, 0.45, 1), transform: [{ scale: wave(4, 0.7, 1.15) }] }}>
        <Path d={star4(362, 38, 11)} fill="#FFFFFF" />
      </Piece>
    </>
  );
}

/* ——— КОМЕДИЯ: оранжевый круг, штриховка, звёздочка ——— */
function Comedy({ f }: { f: Frame }) {
  const hatch: ReactNode[] = [];
  for (let x = 220; x < 440; x += 7) hatch.push(<Path key={x} d={`M${x},300 L${x + 130},170`} stroke="#D24E00" strokeWidth={1.3} opacity={0.9} />);
  return (
    <>
      <Piece f={f} box={FULL}>
        <Defs>
          <LinearGradient id="c0" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#F57E06" />
            <Stop offset="1" stopColor="#EC6600" />
          </LinearGradient>
        </Defs>
        <Rect width={400} height={300} fill="url(#c0)" />
        <Dots x={20} y={20} cols={9} rows={6} step={8} color="#D85A00" o={0.55} r={0.8} />
        <Dash x1={330} y={22} x2={372} c="#FFC24A" o={0.9} />
      </Piece>
      {/* Круг подпрыгивает — мягко, как мяч в замедленной съёмке. */}
      <Piece f={f} box={[90, 5, 310, 310]} style={{ transform: [{ translateY: px(f, wave(2, -7, 5)) }, { scale: wave(2, 1.015, 0.995) }] }}>
        <Defs>
          <LinearGradient id="c1" x1="0.15" y1="0.1" x2="0.85" y2="0.95">
            <Stop offset="0" stopColor="#D84E00" />
            <Stop offset="1" stopColor="#F27A0C" />
          </LinearGradient>
        </Defs>
        <Circle cx={245} cy={160} r={150} fill="url(#c1)" />
        <Circle cx={245} cy={160} r={150} fill="none" stroke="#F79A3A" strokeWidth={1} opacity={0.55} />
      </Piece>
      {/* Штриховка «бежит»: два набора светлых штрихов через один загораются по очереди. */}
      <Piece f={f} box={FULL}>
        <Defs>
          <ClipPath id="ct">
            <Polygon points="268,300 400,168 400,300" />
          </ClipPath>
        </Defs>
        <G clipPath="url(#ct)">{hatch}</G>
      </Piece>
      <HatchGlint f={f} start={220} ph={0} />
      <HatchGlint f={f} start={227} ph={0.5} />
      <Piece f={f} box={[26, 246, 28, 34]} style={{ transform: [{ rotate: spin() }] }}>
        <Path d="M40,248 L43,258 L52,256 L45,263 L52,270 L43,268 L40,278 L37,268 L28,270 L35,263 L28,256 L37,258 Z" fill="#C63E00" />
      </Piece>
    </>
  );
}
/*
  Блик на штриховке: каждый второй штрих светлее, и два таких набора (со сдвигом на шаг) гаснут и
  загораются навстречу — глаз видит линии, бегущие по диагонали. Сдвигать сами линии нельзя:
  вместе с ними уехала бы и граница треугольника.
*/
function HatchGlint({ f, start, ph }: { f: Frame; start: number; ph: number }) {
  const lines: ReactNode[] = [];
  for (let x = start; x < 440; x += 14) lines.push(<Path key={x} d={`M${x},300 L${x + 130},170`} stroke="#FF9A3A" strokeWidth={1.3} />);
  return (
    <Piece f={f} box={[260, 160, 140, 140]} style={{ opacity: wave(6, 0, 0.75, ph) }}>
      <Defs>
        <ClipPath id={`cg${start}`}>
          <Polygon points="268,300 400,168 400,300" />
        </ClipPath>
      </Defs>
      <G clipPath={`url(#cg${start})`}>{lines}</G>
    </Piece>
  );
}

/* ——— УЖАСЫ: тёмная арка, лиловый свет из-за неё, ступени ——— */
function Horror({ f }: { f: Frame }) {
  const steps: [number, number][] = [
    [236, 180],
    [254, 230],
    [272, 290],
    [290, 360],
  ];
  // Свет дрожит неровно: две волны разной частоты — как свеча за дверью.
  const flick = Animated.add(wave(3, 0, 0.22), wave(7, 0, 0.12, 0.3));
  return (
    <>
      <Piece f={f} box={FULL}>
        <Defs>
          <RadialGradient id="h0" cx="0.5" cy="0.45" r="0.75">
            <Stop offset="0" stopColor="#1A1026" />
            <Stop offset="1" stopColor="#08060C" />
          </RadialGradient>
        </Defs>
        <Rect width={400} height={300} fill="url(#h0)" />
        <Dash x1={24} y={34} x2={72} c="#8A4AEA" o={0.8} />
        <Cross x={364} y={34} s={7} c="#8A4AEA" o={0.8} />
        <Dots x={22} y={200} cols={6} rows={5} step={9} color="#8A4AEA" o={0.4} />
        <Dots x={340} y={210} cols={6} rows={5} step={9} color="#8A4AEA" o={0.3} />
      </Piece>
      <Piece f={f} box={FULL} style={{ opacity: Animated.add(0.66, flick), transform: [{ scale: wave(3, 0.98, 1.05) }] }}>
        <Defs>
          <RadialGradient id="h1" cx={200} cy={140} r={150} gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#9050F5" stopOpacity={0.85} />
            <Stop offset="0.5" stopColor="#7A3CE0" stopOpacity={0.35} />
            <Stop offset="1" stopColor="#7A3CE0" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width={400} height={300} fill="url(#h1)" />
      </Piece>
      <Piece f={f} box={[0, 230, 400, 70]} style={{ opacity: wave(3, 0.55, 1, 0.15) }}>
        <Defs>
          <LinearGradient id="h3" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#7A3CE0" stopOpacity={0} />
            <Stop offset="0.5" stopColor="#8A4AEA" stopOpacity={0.9} />
            <Stop offset="1" stopColor="#7A3CE0" stopOpacity={0} />
          </LinearGradient>
        </Defs>
        {steps.map(([y, w]) => (
          <Rect key={y} x={200 - w / 2} y={y} width={w} height={4} fill="url(#h3)" />
        ))}
      </Piece>
      <Piece f={f} box={[130, 30, 140, 210]}>
        <Defs>
          <LinearGradient id="h2" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#140B1C" />
            <Stop offset="1" stopColor="#07040B" />
          </LinearGradient>
        </Defs>
        <Path d="M142,232 V100 A58,58 0 0 1 258,100 V232 Z" fill="url(#h2)" stroke="#9A5CF2" strokeOpacity={0.35} strokeWidth={1.5} />
      </Piece>
    </>
  );
}

/* ——— ФАНТАСТИКА: синяя планета, луна на орбите, метеоры ——— */
const STARS: [number, number, number][] = [
  [30, 40, 0.6], [90, 110, 0.4], [150, 30, 0.7], [60, 180, 0.35], [205, 80, 0.5], [250, 25, 0.4],
  [120, 250, 0.3], [180, 150, 0.25], [20, 250, 0.4], [230, 190, 0.3], [355, 150, 0.5], [390, 60, 0.35],
];
function SciFi({ f, active }: { f: Frame; active?: boolean }) {
  /*
    ЛУНА И ПЛАНЕТА — ОТ СВОИХ ЧАСОВ, КОТОРЫЕ СТАРТУЮТ С НУЛЯ при каждом приходе на Фантастику.
    Раньше они ходили по общим часам, и в момент, когда морфинг передавал сцену, луна могла стоять
    далеко от того места, где её нарисовал морфинг, — и прыгала. Теперь орбита начинается ровно
    из той точки, где луна у морфинга (300, 70), и уже оттуда плывёт по эллипсу; пока сцена не
    «идёт», луна стоит в этой же точке.
  */
  const run = useContext(RunCtx);
  const orbit = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    orbit.stopAnimation();
    orbit.setValue(0);
    if (!run) return;
    const a = Animated.loop(Animated.timing(orbit, { toValue: 1, duration: 30000, easing: filmEase(Easing.linear, 30000), useNativeDriver: true }));
    a.start();
    return () => a.stop();
  }, [run, orbit]);
  const ring = useMemo(() => {
    // Эллипс, начинающийся в нуле: x = A·sin, y = B·(1 − cos) — в начале сдвиг (0, 0).
    const N = 48;
    const inputRange: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    const py: number[] = [];
    const ps: number[] = [];
    for (let i = 0; i <= N; i++) {
      const a = (2 * Math.PI * i) / N;
      inputRange.push(i / N);
      xs.push(-36 * Math.sin(a));
      ys.push(12 * (1 - Math.cos(a)));
      py.push(-4 * Math.sin(a));
      ps.push(1 + 0.006 * (1 - Math.cos(a)));
    }
    return {
      mx: px(f, orbit.interpolate({ inputRange, outputRange: xs })),
      my: px(f, orbit.interpolate({ inputRange, outputRange: ys })),
      py: px(f, orbit.interpolate({ inputRange, outputRange: py })),
      ps: orbit.interpolate({ inputRange, outputRange: ps }),
    };
  }, [f, orbit]);
  /*
    ПАЛКА ИЗ «УЖАСОВ» → ПАДАЮЩАЯ ЗВЕЗДА. При листании ступень из Ужасов перетекает в штрих
    метеора (MoodMorph). Здесь этот же штрих стоит ровно на том месте, где морфинг его оставил,
    — подмена незаметна, — и, как только карусель ДОШЛА до Фантастики (не дожидаясь, пока
    докрутится инерция) или открылась страница, срывается и улетает по своей диагонали, разгоняясь и угасая. Ушли с Фантастики —
    штрих снова на месте и ждёт следующего прихода. Каждый раз, а не по общим часам.
  */
  const fly = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      fly.setValue(0);
      return;
    }
    fly.setValue(0);
    // Без задержки и сразу с разгона: звезда срывается в тот же миг, как морфинг её «собрал».
    // 24 кадра в секунду, как у плёнки: полёт идёт шагами, а не плавно на 120 Гц.
    const a = Animated.timing(fly, { toValue: 1, duration: 1600, easing: filmEase(Easing.out(Easing.quad), 1600), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [active, fly]);
  const arrive = fly.interpolate({ inputRange: [0, 1], outputRange: [0, 320] });
  // Метеор: короткий штрих летит по своей диагонали и гаснет.
  const meteor = (t0: number, t1: number) => {
    const d = flight(t0, t1, -70, 110);
    return { opacity: flash(t0, t1), transform: [{ translateX: px(f, d) }, { translateY: px(f, Animated.multiply(d, -0.8)) }] };
  };
  return (
    <>
      <Piece f={f} box={FULL}>
        <Defs>
          <LinearGradient id="s0" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#030820" />
            <Stop offset="1" stopColor="#0A1A55" />
          </LinearGradient>
        </Defs>
        <Rect width={400} height={300} fill="url(#s0)" />
        {STARS.map(([x, y, o]) => (
          <Circle key={`${x}-${y}`} cx={x} cy={y} r={1} fill="#C8D6FF" opacity={o} />
        ))}
        <Dots x={22} y={230} cols={7} rows={6} step={8} color="#5A7BE0" o={0.4} />
        <Dash x1={330} y={284} x2={372} c="#4A6BE0" o={0.8} />
      </Piece>
      <Piece f={f} box={[150, 40, 120, 100]} style={meteor(0.56, 0.63)}>
        <Defs>
          <LinearGradient id="s4" x1="0" y1="1" x2="1" y2="0">
            <Stop offset="0" stopColor="#9FB6FF" stopOpacity={0} />
            <Stop offset="1" stopColor="#DCE6FF" stopOpacity={0.9} />
          </LinearGradient>
        </Defs>
        <Path d="M160,130 L260,50" stroke="url(#s4)" strokeWidth={1} />
      </Piece>
      <Piece
        f={f}
        box={[30, 50, 130, 110]}
        style={{
          opacity: fly.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1, 0] }),
          transform: [{ translateX: px(f, arrive) }, { translateY: px(f, Animated.multiply(arrive, -90 / 110)) }],
        }}
      >
        <Defs>
          {/* Хвост не до нуля: в покое штрих почти сплошной — как фигура морфинга, с которой он
              подменяется; в полёте видна яркая голова. */}
          <LinearGradient id="s5" x1="0" y1="1" x2="1" y2="0">
            <Stop offset="0" stopColor="#C8D6FF" stopOpacity={0.35} />
            <Stop offset="0.8" stopColor="#DCE6FF" stopOpacity={0.95} />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity={1} />
          </LinearGradient>
          <RadialGradient id="s6" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.9} />
            <Stop offset="1" stopColor="#BFD0FF" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Path d="M40,150 L150,60" stroke="url(#s5)" strokeWidth={1.6} strokeLinecap="round" />
        <Circle cx={150} cy={60} r={4.5} fill="url(#s6)" />
      </Piece>
      {/* Луна ходит по эллипсу от своей точки у морфинга (см. orbit выше). */}
      <Piece f={f} box={[272, 42, 56, 56]} style={{ transform: [{ translateX: ring.mx }, { translateY: ring.my }] }}>
        <Defs>
          <RadialGradient id="s2" cx="0.35" cy="0.3" r="0.8">
            <Stop offset="0" stopColor="#6A8CFF" />
            <Stop offset="1" stopColor="#1A2E90" />
          </RadialGradient>
        </Defs>
        <Circle cx={300} cy={70} r={26} fill="url(#s2)" />
      </Piece>
      <Piece f={f} box={[110, 140, 480, 480]} style={{ transform: [{ translateY: ring.py }, { scale: ring.ps }] }}>
        <Defs>
          <RadialGradient id="s1" cx="0.25" cy="0.12" r="0.9">
            <Stop offset="0" stopColor="#4772FF" />
            <Stop offset="0.45" stopColor="#1E45CC" />
            <Stop offset="1" stopColor="#0A1A66" />
          </RadialGradient>
        </Defs>
        <Circle cx={350} cy={380} r={235} fill="url(#s1)" />
      </Piece>
    </>
  );
}

// memo: сцена собирает свои анимации один раз на размер кадра, а не на каждую перерисовку.
const SCENES: Record<string, (p: { f: Frame; active?: boolean }) => ReactNode> = {
  action: memo(Action),
  romance: memo(Romance),
  comedy: memo(Comedy),
  horror: memo(Horror),
  scifi: memo(SciFi),
};

/*
  Слой одной сцены. С pos (карточка) настоящая сцена видна только у своей остановки (±25 % хода
  карусели); всё, что между, рисует морфинг (MoodMorph) — он проявляется поверх, пока сцена ещё
  стоит, и гаснет над следующей, когда та уже на месте. Поэтому сцена просто включена или
  выключена: момент переключения всегда закрыт морфингом.
*/
function Layer({ k, n, pos, on, children }: { k: number; n: number; pos?: SharedValue<number>; on: boolean; children: ReactNode }) {
  const st = useAnimatedStyle(() => {
    if (!pos) return { opacity: on ? 1 : 0 };
    const p = Math.min(n - 1, Math.max(0, pos.value));
    return { opacity: Math.abs(p - k) < 0.25 ? 1 : 0 };
  });
  return (
    <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, st]}>
      {children}
    </Reanimated.View>
  );
}

export const MoodScene = memo(function MoodScene({
  keys,
  w,
  h,
  pos,
  index = 0,
  live = true,
  wake = false,
  grain = 1,
}: {
  /** Ключи настроений по порядку (как в карусели). */
  keys: string[];
  w: number;
  h: number;
  /** Положение карусели (0…n−1) — сцены перетекают за пальцем. Без него горит keys[index]. */
  pos?: SharedValue<number>;
  index?: number;
  /** Видна ли сцена сейчас: пока не видна — часы анимации стоят. */
  live?: boolean;
  /** Скоро покажется — нарисовать заранее (но ещё не двигать). */
  wake?: boolean;
  /** Сила зерна и потёртостей плёнки (0 — без них). */
  grain?: number;
}) {
  const id = useId();
  useEffect(() => {
    sceneLive(id, live);
    return () => sceneLive(id, false);
  }, [id, live]);
  const f = useMemo(() => frameFor(w, h), [w, h]);
  // Ближайшая к пальцу сцена — она одна движется (см. RunCtx).
  const [near, setNear] = useState(index);
  const n = keys.length;
  useAnimatedReaction(
    () => (pos ? Math.round(Math.min(n - 1, Math.max(0, pos.value))) : -1),
    (v, prev) => {
      if (v >= 0 && v !== prev) runOnJS(setNear)(v);
    },
    [pos, n],
  );
  const shown = pos ? near : index;
  /*
    МОРФИНГ — 30 КАДРОВ В СЕКУНДУ. Фигуры перестраиваются не на каждый кадр экрана (до 120 Гц),
    а 30 раз в секунду: положение для морфинга (fp) догоняет палец шагами по 1/30 с. Если палец
    остановился между шагами — последний шаг дорисуется через ту же 1/30 с. Названия при этом листаются плавно, как прежде (они от pos).
  */
  const fp = useSharedValue(0);
  const fpLast = useSharedValue(0);
  useAnimatedReaction(
    () => (pos ? pos.value : -1),
    (v) => {
      if (v < 0) return;
      const now = Date.now();
      const gap = now - fpLast.value;
      // 30 кадров в секунду (шаг 1/30 с ≈ 33 мс; порог чуть меньше — кадры экрана идут по 8,3 мс).
      if (gap >= 32) {
        fpLast.value = now;
        fp.value = v;
      } else {
        fp.value = withDelay(34 - gap, withTiming(v, { duration: 0 }));
      }
    },
    [pos],
  );
  /*
    «Пришли» на сцену — палец почти довёл карусель до неё (ближе 8 % хода). Раньше ждали конца
    инерции прокрутки, и звезда Фантастики стартовала с заметной задержкой.
  */
  const [arrived, setArrived] = useState(index);
  useAnimatedReaction(
    () => {
      if (!pos) return -2;
      const p = Math.min(n - 1, Math.max(0, pos.value));
      const k = Math.round(p);
      return Math.abs(p - k) < 0.08 ? k : -1;
    },
    (v, prev) => {
      if (v !== -2 && v !== prev) runOnJS(setArrived)(v);
    },
    [pos, n],
  );
  const current = pos ? arrived : index;
  /*
    СЦЕНЫ МОНТИРУЮТСЯ ПО ОДНОЙ. Сначала — текущая, остальные — по одной за раз, с паузой, и
    только когда карточку впервые увидели (live). Иначе при загрузке ленты процессор разом рисовал
    два десятка полотен (а вкладки Фильмы и Сериалы загружаются заранее — ещё по столько же).
    Потом сцены остаются смонтированными: листание не перерисовывает ни одного полотна.
  */
  const [ready, setReady] = useState<Set<number>>(() => new Set([shown]));
  // До первого показа не рисуем ничего: вкладки загружаются заранее, а карточка ниже экрана —
  // её полотна незачем рисовать, пока до неё не долистали.
  const [woke, setWoke] = useState(live || wake);
  useEffect(() => {
    if (live || wake) setWoke(true);
  }, [live, wake]);
  const seen = useRef(false);
  useEffect(() => {
    if (!woke || seen.current || !pos) return;
    seen.current = true;
    const order = keys.map((_, k) => k).sort((a, b) => Math.abs(a - shown) - Math.abs(b - shown));
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      while (i < order.length && ready.has(order[i])) i++;
      if (i >= order.length) return;
      const k = order[i++];
      setReady((r) => new Set(r).add(k));
      timer = setTimeout(next, 250);
    };
    timer = setTimeout(next, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [woke]);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden', backgroundColor: '#08080A' }]}>
      {/*
        Кадр подрагивает в «проекторе»: сцены и морфинг сдвигаются на доли точки 24 раза в
        секунду. Чуть увеличены (1,5 %), чтобы при сдвиге по краям не открывался фон.
      */}
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ scale: 1.015 }, { translateX: FRAME_X }, { translateY: FRAME_Y }] }]}>
        {keys.map((key, k) => {
          const Scene = SCENES[key];
          // Нужная сейчас сцена монтируется сразу, даже если до неё ещё не дошла очередь.
          if (!Scene || !woke || (!ready.has(k) && k !== shown)) return null;
          return (
            <Layer key={key} k={k} n={keys.length} pos={pos ? fp : undefined} on={k === index}>
              <RunCtx.Provider value={live && k === shown}>
                <Scene f={f} active={key === 'scifi' ? live && k === current : undefined} />
              </RunCtx.Provider>
            </Layer>
          );
        })}
        {woke && pos && keys.length > 1 ? <MoodMorph keys={keys} pos={fp} w={w} h={h} /> : null}
      </Animated.View>
      {woke && grain > 0 ? <FilmGrain w={w} h={h} strength={grain} /> : null}
    </View>
  );
});
