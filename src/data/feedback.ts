import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import type { MediaItem } from '../types/media';

/*
  НРАВИТСЯ / НЕ НРАВИТСЯ — как у Влада (Q3/AbstractC0596n0, «thumbs»): оценка тайтла пальцем
  из меню по долгому нажатию.

  Что она делает:
    • «не нравится» — тайтл пропадает из всех рядов лент (и из «Потому что вам нравится»);
    • «нравится» — тайтл становится «семенем» персональных подборок (вес ×1.2 против просто
      досмотренного) и поднимает в рядах тайтлы тех же жанров: каждый лайк даёт его жанрам +1,
      дизлайк −1, ряды постеров пересортировываются по сумме (от −3 до 3), как у Влада.
*/
export type Thumb = 'like' | 'dislike';
export type FeedbackEntry = {
  v: Thumb;
  at: number;
  type: MediaItem['type'];
  id: number;
  title: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  genreIds: number[];
};

const KEY = 'lumiere_feedback_v1';
let map: Record<string, FeedbackEntry> = {};
let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version += 1;
  listeners.forEach((cb) => cb());
};

const keyOf = (type: string, id: number) => `${type}:${id}`;

/*
  Читается ОДИН раз: загрузку зовут и при импорте, и из прогрева заставки — раньше это было два
  чтения с диска и два оповещения, и каждое заново пересобирало ленты всех трёх вкладок.
*/
let loading: Promise<void> | null = null;
export function loadFeedback(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      map = raw ? (JSON.parse(raw) as Record<string, FeedbackEntry>) : {};
    } catch {
      map = {};
    }
    emit();
  })();
  return loading;
}
void loadFeedback();

export function thumbOf(type: string, id: number): Thumb | null {
  return map[keyOf(type, id)]?.v ?? null;
}

/** Поставить оценку; та же ещё раз — снять. */
export function setThumb(item: MediaItem, v: Thumb): Thumb | null {
  const k = keyOf(item.type, item.id);
  if (map[k]?.v === v) {
    delete map[k];
  } else {
    map[k] = {
      v,
      at: Date.now(),
      type: item.type,
      id: item.id,
      title: item.title,
      posterUrl: item.posterUrl,
      backdropUrl: item.backdropUrl,
      genreIds: item.genreIds ?? [],
    };
  }
  AsyncStorage.setItem(KEY, JSON.stringify(map)).catch(() => undefined);
  emit();
  return map[k]?.v ?? null;
}

export function liked(): FeedbackEntry[] {
  return Object.values(map)
    .filter((e) => e.v === 'like')
    .sort((a, b) => b.at - a.at);
}

export function isDisliked(type: string, id: number): boolean {
  return map[keyOf(type, id)]?.v === 'dislike';
}

/** Сумма оценок по жанрам: +1 за лайк, −1 за дизлайк каждому жанру тайтла. */
export function genreAffinity(): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of Object.values(map)) {
    for (const g of e.genreIds) out.set(g, (out.get(g) ?? 0) + (e.v === 'like' ? 1 : -1));
  }
  return out;
}

export function subscribeFeedback(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useFeedbackVersion(): number {
  return useSyncExternalStore(subscribeFeedback, () => version);
}
