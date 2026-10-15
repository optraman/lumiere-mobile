import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { MediaItem } from '../types/media';
import { toItem, type MineEntry } from './mine';

/**
 * ПЛЕЙЛИСТЫ — свои подборки: «на выходные», «с Аней», «пересмотреть». У каждого — имя и обложка
 * (своё фото или, пока его нет, мозаика из постеров внутри). Тайтлы хранятся снимком, как в «Моё»:
 * карточка показывается без сети.
 */
export type Playlist = {
  id: string;
  name: string;
  /** Своё фото обложки — файл в папке приложения; null — мозаика из постеров. */
  cover: string | null;
  items: MineEntry[];
  createdAt: number;
};

const KEY = 'lumiere_playlists_v1';
let list: Playlist[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((cb) => cb());

export async function loadPlaylists(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    list = raw ? (JSON.parse(raw) as Playlist[]) : [];
  } catch {
    list = [];
  }
  emit();
}
void loadPlaylists();

function save() {
  AsyncStorage.setItem(KEY, JSON.stringify(list)).catch(() => undefined);
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function usePlaylists(): Playlist[] {
  return useSyncExternalStore(subscribe, () => list);
}

export function usePlaylist(id: string | undefined): Playlist | undefined {
  return useSyncExternalStore(subscribe, () => list.find((p) => p.id === id));
}

const snap = (item: MediaItem): MineEntry => ({
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
});

export function createPlaylist(name: string, cover: string | null, first?: MediaItem): Playlist {
  const p: Playlist = {
    id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: name.trim() || 'Новый кинофест',
    cover,
    items: first ? [snap(first)] : [],
    createdAt: Date.now(),
  };
  list = [p, ...list];
  save();
  return p;
}

export function updatePlaylist(id: string, patch: Partial<Pick<Playlist, 'name' | 'cover'>>): void {
  list = list.map((p) => (p.id === id ? { ...p, ...patch, name: (patch.name ?? p.name).trim() || p.name } : p));
  save();
}

export function deletePlaylist(id: string): void {
  const p = list.find((x) => x.id === id);
  if (p?.cover) dropCover(p.cover);
  list = list.filter((x) => x.id !== id);
  save();
}

export function inPlaylist(p: Playlist, item: Pick<MediaItem, 'type' | 'id'>): boolean {
  return p.items.some((e) => e.type === item.type && e.id === item.id);
}

/** Добавить, если нет; убрать, если есть. Возвращает новое состояние. */
export function togglePlaylistItem(id: string, item: MediaItem): boolean {
  let now = false;
  list = list.map((p) => {
    if (p.id !== id) return p;
    if (inPlaylist(p, item)) return { ...p, items: p.items.filter((e) => !(e.type === item.type && e.id === item.id)) };
    now = true;
    return { ...p, items: [snap(item), ...p.items] };
  });
  save();
  return now;
}

export function playlistItems(p: Playlist): MediaItem[] {
  return p.items.map(toItem);
}

// ─────────────────────────────── обложка

function coversDir(): Directory {
  const d = new Directory(Paths.document, 'playlists');
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

function dropCover(uri: string) {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // нечего удалять
  }
}

type PickerResult = { canceled?: boolean; assets?: { uri: string }[] | null };
type PickerModule = { launchImageLibraryAsync?: (o: Record<string, unknown>) => Promise<PickerResult> };

/**
 * ФОТО ДЛЯ ОБЛОЖКИ — из галереи телефона.
 *
 * Системный выбор фото (тот же, что у expo-image-picker) зовётся напрямую: модуль уже есть внутри
 * приложения, отдельную библиотеку ставить не нужно. Выбранное копируется в папку приложения —
 * временный файл галереи система может стереть в любой момент. Квадрат: обложка показывается
 * квадратом, и обрезать её человек выбирает сам.
 */
export async function pickCover(): Promise<string | null> {
  let uri: string | null = null;
  const picker = requireOptionalNativeModule<PickerModule>('ExponentImagePicker');
  if (picker?.launchImageLibraryAsync) {
    const res = await picker
      .launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.85 })
      .catch(() => null);
    if (!res || res.canceled || !res.assets?.length) return null;
    uri = res.assets[0].uri;
  } else {
    // Запасной путь — выбор файла (картинки из «Файлов»).
    const res = await (File as unknown as { pickFileAsync: (o: Record<string, unknown>) => Promise<unknown> })
      .pickFileAsync({ mimeTypes: ['image/*'] })
      .catch(() => null);
    const f = (res as { result?: File; uri?: string } | null) ?? null;
    uri = (f as { uri?: string } | null)?.uri ?? (f?.result as File | undefined)?.uri ?? null;
  }
  if (!uri) return null;
  try {
    const src = new File(uri);
    const dest = new File(coversDir(), `${Date.now().toString(36)}.jpg`);
    await src.copy(dest);
    return dest.uri;
  } catch {
    return uri;
  }
}

/** Сменить обложку: старый файл удаляется, чтобы не копились. */
export function setPlaylistCover(id: string, uri: string | null): void {
  const p = list.find((x) => x.id === id);
  if (p?.cover && p.cover !== uri) dropCover(p.cover);
  updatePlaylist(id, { cover: uri });
}
