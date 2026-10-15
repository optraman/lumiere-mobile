import { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { NavigationContext } from './navigationContext';
import * as Haptics from 'expo-haptics';
import { useScreenFocus } from './useScreenFocus';

/**
 * Какая вкладка была активна в последний раз. МОДУЛЬНАЯ, а не внутри хука: хуки на разных вкладках
 * не видят друг друга, и без общей памяти каждый считал бы себя первым.
 */
let lastTab: string | null = null;

/**
 * Возвращение на вкладку — и ОТКУДА оно случилось.
 *
 * Фокус приходит и при переключении вкладки, и при закрытии страницы фильма: вкладка ведь снова
 * становится видимой. Для двух вещей эта разница принципиальна.
 *
 * ОТКЛИК звучит только на смене вкладки — иначе телефон щёлкал бы после каждого возврата с
 * карточки, «на пустом месте».
 *
 * ПОЛОЖЕНИЕ ЛЕНТЫ: переключая вкладку, человек начинает новый просмотр и хочет её начало; закрывая
 * страницу фильма — возвращается ровно туда, где стоял.
 *
 * СБРОС ДЕЛАЕТСЯ ПРИ УХОДЕ СО ВКЛАДКИ, а не при возвращении на неё, и это единственный способ не
 * показать прыжок. На возвращении любой наш код выполняется уже после того, как система показала
 * экран: он успевает мелькнуть прежним местом и только потом дёрнуться наверх. Уходящую же вкладку
 * никто не видит — её можно перематывать сколько угодно.
 *
 * Отличить уход по вкладкам от ухода на страницу фильма просто: в первом случае активной стала
 * ДРУГАЯ вкладка, во втором активной осталась эта же, просто поверх неё легла страница. Это видно
 * прямо в состоянии навигации.
 */
export function useTabFocus(tab: string, onLeftTab?: () => void) {
  const focused = useScreenFocus();
  const nav = useContext(NavigationContext);
  const first = useRef(true);
  /** Колбэк в ref: он меняется каждую сборку, а подписка не должна из-за этого пересоздаваться. */
  const leave = useRef(onLeftTab);
  leave.current = onLeftTab;
  /** Была ли это смена вкладки. Ref, а не состояние: знание нужно другим эффектам, а лишняя
   * пересборка экрана в момент возвращения — как раз то, от чего мы уходим. */
  const switched = useRef(false);

  useLayoutEffect(() => {
    if (!focused) return;
    switched.current = lastTab !== null && lastTab !== tab;
    lastTab = tab;

    if (first.current) {
      // Первое появление не считается сменой: телефон не должен щёлкать на запуске, а лента и так
      // стоит в начале.
      first.current = false;
      switched.current = false;
      return;
    }

    if (switched.current) {
      // Light, а не Medium: нужен едва заметный тап.
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
  }, [focused, tab]);

  useEffect(() => {
    if (!nav) return;
    return nav.addListener('blur', () => {
      // Активная вкладка осталась прежней — значит, ушли не на соседнюю вкладку, а на страницу
      // поверх этой. Оттуда человек вернётся туда же, где стоял.
      const state = nav.getState?.();
      const active = state?.routes?.[state.index]?.name;
      if (active === tab) return;
      // Экран уже не виден: перематываем следующим тиком, чтобы не задеть кадр самой смены.
      setTimeout(() => leave.current?.(), 0);
    });
  }, [nav, tab]);

  return { focused, switched };
}
