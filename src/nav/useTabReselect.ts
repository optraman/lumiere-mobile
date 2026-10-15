import { useContext, useEffect, useRef } from 'react';
import { NavigationContext } from './navigationContext';

/**
 * ПОВТОРНОЕ НАЖАТИЕ НА ВКЛАДКУ, НА КОТОРОЙ УЖЕ СТОИШЬ.
 *
 * Системная панель вкладок сообщает о каждом нажатии (tabPress). Если вкладка в этот момент уже
 * была на экране — это «ещё раз»: на ленте — наверх, на поиске — к клавиатуре. С другой вкладки то
 * же нажатие просто открывает эту.
 */
export function useTabReselect(onReselect: () => void): void {
  const navigation = useContext(NavigationContext);
  /*
    Была ли вкладка на экране — спрашиваем у навигации В МОМЕНТ нажатия, а не держим в состоянии:
    состояние фокуса перерисовывало всю ленту при каждой смене вкладки и открытии страницы.
  */
  const cb = useRef(onReselect);
  cb.current = onReselect;
  useEffect(() => {
    const nav = navigation as unknown as { addListener?: (e: string, f: () => void) => () => void; isFocused?: () => boolean } | null;
    if (!nav?.addListener) return;
    return nav.addListener('tabPress', () => {
      if (nav.isFocused?.()) cb.current();
    });
  }, [navigation]);
}
