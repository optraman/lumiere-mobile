import { useContext, useEffect, useState } from 'react';
import { NavigationContext } from './navigationContext';

/**
 * Виден ли сейчас экран, на котором стоит компонент.
 *
 * То же, что useIsFocused, но БЕЗ ПАДЕНИЯ вне навигации: useIsFocused требует контекст экрана и
 * бросает исключение, если его нет, а свечение показывается ещё и на заставке — там никакой
 * навигации нет вовсе. Здесь контекст берётся напрямую, и его отсутствие означает «показывается
 * всегда», что для заставки ровно верно.
 */
export function useScreenFocus(): boolean {
  const nav = useContext(NavigationContext);
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    if (!nav) return;
    setFocused(nav.isFocused());
    const offFocus = nav.addListener('focus', () => setFocused(true));
    const offBlur = nav.addListener('blur', () => setFocused(false));
    return () => {
      offFocus();
      offBlur();
    };
  }, [nav]);

  return focused;
}
