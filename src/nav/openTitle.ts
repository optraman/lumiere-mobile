import type { RefObject } from 'react';
import { holdNavigation, markPush, navigationAllowed } from './navGuard';
import type { View } from 'react-native';
import { router } from 'expo-router';
import type { MediaItem } from '../types/media';

/**
 * Открыть страницу фильма МОРФИНГОМ ИЗ КАРТОЧКИ.
 *
 * Родной зум Apple (Link.AppleZoom, iOS 18+) появился только в Expo SDK 55, а проект намеренно
 * держится на SDK 54 — Expo Go в App Store дальше не идёт (см. README). Поэтому морфинг собран
 * вручную и повторяет ту же идею: страница не «прилетает сбоку», а разворачивается из того самого
 * прямоугольника, по которому нажали.
 *
 * Механика: перед переходом карточка меряет своё положение НА ЭКРАНЕ и отдаёт его странице
 * параметрами. Страница стартует сжатой ровно до этого прямоугольника и разворачивается на весь
 * экран. Измерение асинхронное, поэтому переход происходит в колбэке — если измерить не удалось
 * (список пересобрался прямо в этот момент), уходим без параметров и страница просто появляется,
 * без морфинга. Отсутствие анимации лучше, чем застрявший переход.
 */
export function openTitle(item: MediaItem, ref?: RefObject<View | null>) {
  // Во время закрытия страницы (жест «назад») переходы запрещены — см. navGuard.
  if (!navigationAllowed()) return;
  holdNavigation(250);
  markPush();
  const go = (rect?: { x: number; y: number; w: number; h: number }) => {
    router.push({
      pathname: '/title/[type]/[id]',
      params: {
        type: item.type,
        id: String(item.id),
        // Обложка передаётся сразу, чтобы странице было что показать в первом же кадре: ждать
        // ответа TMDB значит морфить в пустой прямоугольник.
        poster: item.posterUrl ?? '',
        backdrop: item.backdropUrl ?? '',
        title: item.title,
        ...(rect
          ? { mx: String(rect.x), my: String(rect.y), mw: String(rect.w), mh: String(rect.h) }
          : {}),
      },
    });
  };

  const node = ref?.current;
  if (!node) {
    go();
    return;
  }
  node.measureInWindow((x, y, w, h) => {
    if (w > 0 && h > 0) go({ x, y, w, h });
    else go();
  });
}
