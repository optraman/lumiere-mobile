import { useMemo, useRef } from 'react';
import { holdNavigation } from './navGuard';
import { Gesture } from 'react-native-gesture-handler';

/**
 * ЖЕСТ «НАЗАД» ОТ ЛЕВОГО КРАЯ — один на все страницы с разворотом (фильм, человек, список серий,
 * списки с главной). Раньше у каждой страницы была своя копия, и у всех одна и та же дыра.
 *
 * ДЫРА. Решение «закрыть или вернуть» принималось только при обычном отпускании (onEnd). Если
 * жест обрывался иначе — палец ушёл за край, систему отвлекло, вмешалась прокрутка, — решения не
 * было вовсе: страница оставалась полупрозрачной и наполовину свёрнутой, а главное — ОНА ОСТАВАЛАСЬ
 * НА ЭКРАНЕ, невидимая, поверх предыдущей, и забирала все касания. Так страница сериала «застревала»
 * после списка серий: ни прокрутить, ни закрыть. Особенно часто — если водить туда-сюда.
 *
 * Теперь решение принимается при ЛЮБОМ окончании жеста (onFinalize), по последнему положению
 * пальца. А если палец увели левее начала — страница честно возвращается в полный размер, а не
 * застывает на последнем значении.
 *
 * onMove — для защиты от фантомных нажатий: пока страницу тянут (и сразу после), строки под пальцем
 * не должны принимать касание за нажатие.
 */
export function useZoomBack(z: {
  setProgress: (p: number) => void;
  settleOpen: () => void;
  close: (velocity: number) => void;
  onMove?: () => void;
  failY?: boolean;
  /** Жест только от самого края (ширина полосы в точках): когда по странице свайпают ещё что-то. */
  edge?: number;
}) {
  const st = useRef({ active: false, decided: false, lastX: 0 }).current;
  // Свежие колбэки страницы — через ref: жест ниже создаётся один раз, а вызывает всегда
  // последние версии (обработчики идут в JS-потоке, runOnJS(true), так что ref читается напрямую).
  const zr = useRef(z);
  zr.current = z;
  const { failY, edge } = z;
  // Жест строится ОДИН РАЗ (пока не поменялись failY/edge): раньше новый Gesture.Pan() на каждой
  // перерисовке заставлял GestureDetector перенастраивать нативный обработчик — а страница
  // при открытии перерисовывается 6–8 раз, ровно во время анимации разворота.
  return useMemo(() => {
    const decide = (tx: number, vx: number) => {
      if (st.decided) return;
      st.decided = true;
      st.active = false;
      const z = zr.current;
      z.onMove?.();
      if (tx > 110 || vx > 800) z.close(Math.min(Math.max(vx, 0) / 1000, 6));
      else z.settleOpen();
    };
    let g = Gesture.Pan()
      .runOnJS(true)
      .activeOffsetX([-1000, 12]);
    if (failY) g = g.failOffsetY([-14, 14]);
    if (edge) g = g.hitSlop({ left: 0, width: edge });
    return g
      .onStart(() => {
        holdNavigation(600);
        st.active = true;
        st.decided = false;
        st.lastX = 0;
        zr.current.onMove?.();
      })
      .onUpdate((e) => {
        if (!st.active) return;
        st.lastX = e.translationX;
        holdNavigation(600);
        zr.current.onMove?.();
        zr.current.setProgress(e.translationX <= 0 ? 1 : 1 - e.translationX / 260);
      })
      .onEnd((e) => {
        if (st.active) decide(e.translationX, e.velocityX);
      })
      .onFinalize(() => {
        if (st.active) decide(st.lastX, 0);
      });
  }, [st, failY, edge]);
}
