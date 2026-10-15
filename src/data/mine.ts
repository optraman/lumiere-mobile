import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import type { MediaItem } from '../types/media';

/**
 * «МОЁ» — свой список, как WatchlistStore у Влада и favorites у планшетного Люмьера.
 *
 * «Добавить в Моё» на странице фильма кладёт сюда снимок тайтла (обложка, год, оценка, описание) —
 * достаточно, чтобы показать карточку без сети. Новое — сверху.
 */
export type MineEntry = {
  id: number;
  type: MediaItem['type'];
  title: string;
  originalTitle: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  year: string | null;
  rating: number;
  addedAt: number;
};

const KEY = 'lumiere_mine_v1';
let list: MineEntry[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((cb) => cb());

export async function loadMine(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    list = raw ? (JSON.parse(raw) as MineEntry[]) : [];
  } catch {
    list = [];
  }
  emit();
}
void loadMine();

function save() {
  AsyncStorage.setItem(KEY, JSON.stringify(list)).catch(() => undefined);
}

export function isMine(type: MediaItem['type'], id: number): boolean {
  return list.some((e) => e.type === type && e.id === id);
}

/** Добавить, если нет; убрать, если есть. Возвращает НОВОЕ состояние: true — теперь в «Моё». */
export function toggleMine(item: MediaItem): boolean {
  if (isMine(item.type, item.id)) {
    list = list.filter((e) => !(e.type === item.type && e.id === item.id));
    save();
    emit();
    return false;
  }
  list = [
    {
      id: item.id,
      type: item.type,
      title: item.title,
      originalTitle: item.originalTitle,
      overview: item.overview,
      posterUrl: item.posterUrl,
      backdropUrl: item.backdropUrl,
      year: item.year,
      rating: item.rating,
      addedAt: Date.now(),
    },
    ...list,
  ];
  save();
  emit();
  return true;
}

export function mineItems(): MediaItem[] {
  return list.map(toItem);
}

export function toItem(e: MineEntry): MediaItem {
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    originalTitle: e.originalTitle,
    overview: e.overview,
    posterUrl: e.posterUrl,
    backdropUrl: e.backdropUrl,
    year: e.year,
    rating: e.rating,
    releaseDate: null,
    originalLanguage: null,
    genreIds: [],
    voteCount: 0,
  };
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useMine(): MineEntry[] {
  return useSyncExternalStore(subscribe, () => list);
}

export function useIsMine(type: MediaItem['type'] | undefined, id: number | undefined): boolean {
  return useSyncExternalStore(subscribe, () => (type && id ? isMine(type, id) : false));
}
