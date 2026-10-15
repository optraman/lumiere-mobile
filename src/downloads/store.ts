import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import type { MediaType } from '../types/media';

/**
 * СПИСОК ЗАГРУЗОК — как downloads.json у планшетного Люмьера (lumiere.tab.Dl).
 *
 * Каждая загрузка помнит, ЧТО это (тайтл, серия, голос) и ДОКУДА дошла (сколько кусков на диске).
 * Ссылку на поток она не хранит: ссылки живут недолго, и при продолжении — через час или через
 * неделю — берётся свежая. Куски, уже лежащие на диске, второй раз не качаются.
 */
export type DlState = 'queued' | 'running' | 'paused' | 'done' | 'failed';

/** Тайтл в том виде, который нужен списку загрузок и офлайн-просмотру — без сети. */
export type DlItem = {
  id: number;
  type: MediaType;
  title: string;
  originalTitle: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  year: string | null;
};

/** Субтитры, сохранённые рядом с видео: подпись, язык и путь внутри папки загрузки. */
export type DlSub = { label: string; lang: string | null; file: string };

export type DlTask = {
  id: string;
  /** Ключ просмотра (как у журнала): у фильма тип:номер, у серии — с сезоном и серией. */
  key: string;
  item: DlItem;
  season?: number;
  episode?: number;
  /** «Сезон 1 · Серия 3» или пусто у фильма. */
  label: string;
  /** Голос: выбранный при постановке; пусто — тот, что выбран для тайтла, или лучший. */
  voice?: string;
  quality?: string | null;
  state: DlState;
  error?: string;
  piecesDone: number;
  piecesTotal: number;
  bytes: number;
  /** Ожидаемый размер — по полосе потока и длительности; уточняется по ходу. */
  bytesTotal: number;
  /** Что открыть плееру: путь внутри папки загрузки (video.mp4; у старых — master.m3u8 или v/index.m3u8). */
  playlist?: string;
  /** Идёт склейка кусков в один файл (remux.ts): доля 0…1. Пока её нет — качается. */
  mux?: number;
  /** Склеить не вышло — почему; тогда остаётся плейлист из кусков и второй раз не пробуем. */
  muxError?: string;
  /** Какой версией склейки пробовали (MUX_VERSION в engine.ts): новая версия пробует ещё раз. */
  muxVersion?: number;
  createdAt: number;
  doneAt?: number;
  /** Субтитры к этой загрузке — все, что нашлись (downloads/subs.ts). */
  subs?: DlSub[];
  /** Когда их искали в последний раз — чтобы не искать заново на каждом запуске. */
  subsAt?: number;
};

const KEY = 'lumiere_downloads_v1';
let tasks: DlTask[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
/** Скорость — только в памяти: на диске она бессмысленна. */
export const speeds = new Map<string, number>();

export function loadDownloads(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      let disk: DlTask[] = [];
      try {
        const raw = await AsyncStorage.getItem(KEY);
        disk = raw ? (JSON.parse(raw) as DlTask[]) : [];
      } catch {
        disk = [];
      }
      // Шедшие при закрытии приложения — снова в очередь: продолжатся с того же куска.
      disk = disk.map((t) => (t.state === 'running' ? { ...t, state: 'queued' } : t));
      // Поставленное, пока список читался с диска, не теряется: оно уже в памяти и идёт первым.
      tasks = [...tasks, ...disk.filter((d) => !tasks.some((t) => t.id === d.id || t.key === d.key))];
      loaded = true;
      emit();
    })();
  }
  return loading;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveSoon(now = false) {
  if (saveTimer) clearTimeout(saveTimer);
  const run = () => {
    saveTimer = null;
    AsyncStorage.setItem(KEY, JSON.stringify(tasks)).catch(() => undefined);
  };
  if (now) run();
  else saveTimer = setTimeout(run, 1500);
}

function emit() {
  listeners.forEach((cb) => cb());
}

export function allDownloads(): DlTask[] {
  return tasks;
}

export function taskById(id: string): DlTask | undefined {
  return tasks.find((t) => t.id === id);
}

export function taskForKey(key: string): DlTask | undefined {
  return tasks.find((t) => t.key === key);
}

export function addTask(t: DlTask): void {
  tasks = [t, ...tasks.filter((x) => x.key !== t.key)];
  saveSoon(true);
  emit();
}

/** Изменить загрузку. `important` — сохранить на диск сразу (смена состояния), иначе — чуть позже. */
export function patchTask(id: string, patch: Partial<DlTask>, important = false): void {
  let hit = false;
  tasks = tasks.map((t) => {
    if (t.id !== id) return t;
    hit = true;
    return { ...t, ...patch };
  });
  if (!hit) return;
  saveSoon(important);
  /*
    Пока идёт кино, «важное» сохранение каждые десять кусков — это всё ещё ход загрузки, а не смена
    состояния: будить им экраны под плеером незачем. Сразу сообщается только смена состояния.
  */
  if (important && (!quiet || patch.state !== undefined)) emit();
  else emitSoon();
}

/*
  ХОД ЗАГРУЗКИ — ЭКРАНАМ НЕ ЧАЩЕ ТРЁХ РАЗ В СЕКУНДУ.

  Каждый скачанный кусок (а их несколько в секунду) раньше будил все экраны, которые следят за
  загрузками: главную, страницу фильма, список серий, настройки — и каждый пересобирался. Проценты
  глазу хватает обновлять раз в треть секунды; смена состояния (пауза, готово, ошибка) — сразу.
*/
let emitTimer: ReturnType<typeof setTimeout> | null = null;
/*
  ПОКА ИДЁТ КИНО — ХОД ЗАГРУЗКИ ЭКРАНАМ НЕ СООБЩАЕТСЯ ВОВСЕ. Под плеером лежат главная и страница
  тайтла, и каждые треть секунды они пересобирались ради процентов, которых никто не видит, —
  отнимая кадры у самого кино. Ход копится молча; плеер закрылся — одно обновление со всем сразу.
*/
let quiet = false;
let missed = false;
export function setDownloadsQuiet(on: boolean): void {
  quiet = on;
  if (on) return;
  if (missed) {
    missed = false;
    emit();
  }
}
function emitSoon() {
  if (quiet) {
    missed = true;
    return;
  }
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    emit();
  }, 330);
}

export function dropTask(id: string): void {
  tasks = tasks.filter((t) => t.id !== id);
  speeds.delete(id);
  saveSoon(true);
  emit();
}

export function subscribeDownloads(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Список загрузок для экранов — перерисовывается при каждом изменении. */
export function useDownloads(): DlTask[] {
  return useSyncExternalStore(subscribeDownloads, () => tasks);
}

/*
  ОДНА ЗАГРУЗКА — ДЛЯ ОДНОЙ СТРОКИ. Строка серии следит только за своей загрузкой: пока качается
  другая серия, объект этой не меняется (patchTask трогает лишь свой), и строка не перерисовывается.
  Раньше весь список серий пересобирался на каждое обновление любой загрузки.
*/
export function useDownloadFor(key: string): DlTask | undefined {
  return useSyncExternalStore(subscribeDownloads, () => tasks.find((t) => t.key === key));
}
