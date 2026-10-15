import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * ВНЕШНИЙ ВИД СУБТИТРОВ — перенесено из AppSettings.kt и PlayerScreen.kt Влада.
 *
 * Четыре настройки, те же значения по умолчанию и те же ступени:
 *   размер    — 0 маленький, 1 средний (по умолчанию), 2 крупный, 3 огромный;
 *   фон       — 0 без фона (обводка), 1 тень-подложка (по умолчанию), 2 сплошная плашка;
 *   положение — 0 низко (по умолчанию), 1 выше, 2 по центру;
 *   шрифт     — 0 обычный (по умолчанию), 1 с засечками, 2 моноширинный.
 */
export type SubtitlePrefs = { size: number; background: number; position: number; font: number };

const DEFAULTS: SubtitlePrefs = { size: 1, background: 1, position: 0, font: 0 };
const KEY = 'lumiere_subtitles_v1';

let current: SubtitlePrefs = DEFAULTS;
const listeners = new Set<() => void>();

export async function loadSubtitlePrefs(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) current = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<SubtitlePrefs>) };
  } catch {
    /* не прочиталось — остаются значения по умолчанию */
  }
  listeners.forEach((l) => l());
}

export function setSubtitlePrefs(patch: Partial<SubtitlePrefs>): void {
  current = { ...current, ...patch };
  listeners.forEach((l) => l());
  AsyncStorage.setItem(KEY, JSON.stringify(current)).catch(() => undefined);
}

/** Подписка на настройки: плеер перестраивает субтитры сразу, как только их поменяли. */
export function useSubtitlePrefs(): SubtitlePrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

// ───────────── числа Влада ─────────────

/**
 * Размер текста — доля высоты КАДРА. В плеере у Влада лесенка сдвинута: «средний» на 22% меньше
 * прежнего, «маленький» на столько же меньше среднего, «огромный» не тронут.
 */
export const PLAYER_SIZE = [0.0351, 0.0468, 0.06, 0.095];
/** В окне предпросмотра — свои доли: окно маленькое, и это макет в масштабе. */
export const PREVIEW_SIZE = [0.045, 0.06, 0.075, 0.095];
/** Подъём над нижним краем кадра — доля его высоты. */
export const POSITION_LIFT = [0, 0.1, 0.3];
/** Тень-подложка — чёрный на 40% (0x66), плашка — на 90% (0xE6). */
export const PLAQUE = ['transparent', 'rgba(0,0,0,0.4)', 'rgba(0,0,0,0.9)'];

/** Шрифты: системный, с засечками и моноширинный — по-своему на каждой платформе. */
export function fontFamilyOf(font: number): string | undefined {
  if (font === 1) return Platform.select({ ios: 'Georgia', default: 'serif' });
  if (font === 2) return Platform.select({ ios: 'Menlo', default: 'monospace' });
  return undefined;
}

export const SIZE_LABELS = ['Маленький', 'Средний', 'Крупный', 'Огромный'];
export const BACKGROUND_LABELS = ['Без фона', 'Тень', 'Плашка'];
export const POSITION_LABELS = ['Низко', 'Выше', 'По центру'];
export const FONT_LABELS = ['Обычный', 'С засечками', 'Моноширинный'];
