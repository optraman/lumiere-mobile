import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Настройки доступности, с которыми Liquid Glass обязан считаться.
 *
 * Заметка по дизайну говорит об этом прямо: прозрачность и рефракция по своей природе спорят с
 * читаемостью, поэтому система ограничивает материал набором переключателей, и переопределять их
 * вручную нельзя. Для нативной панели вкладок это делает сама iOS. Но всё, что мы рисуем САМИ —
 * раскрытие карточки, параллакс героя, виньетки — обязано слушать те же настройки, иначе
 * приложение окажется единственным местом в системе, которое их игнорирует.
 *
 * Reduce Motion гасит пружины, свечение и морфинг: переходы должны падать до простого затухания.
 * Reduce Transparency заменяет просвечивание плотной заливкой.
 */
export function useA11ySettings() {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setReduceMotion(v));
    AccessibilityInfo.isReduceTransparencyEnabled?.().then?.((v) => alive && setReduceTransparency(v));

    const m = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    const t = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduceTransparency);
    return () => {
      alive = false;
      m.remove();
      t.remove();
    };
  }, []);

  return { reduceMotion, reduceTransparency };
}
