import { router } from 'expo-router';
import { go } from './navGuard';
import type { MediaItem } from '../types/media';

/**
 * Переход к просмотру. Тайтл передаётся через модуль, а не через адрес: в параметрах маршрута
 * ездят только строки, а здесь нужен весь объект — название, оригинальное название, год, постер,
 * жанры. Кодировать это в адрес значит городить JSON в ссылке ради экрана, который всё равно
 * открывается только изнутри приложения.
 */
let pending: MediaItem | null = null;
/** Серия, с которой сразу начать (если её выбрали заранее). */
let pendingEpisode: { season: string; episode: string } | null = null;

export function watchOnline(item: MediaItem, episode?: { season: string; episode: string }) {
  pending = item;
  pendingEpisode = episode ?? null;
  go('/online');
}

export function takeOnlineItem(): { item: MediaItem | null; episode: { season: string; episode: string } | null } {
  return { item: pending, episode: pendingEpisode };
}
