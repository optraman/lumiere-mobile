import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * НАСТРОЙКИ ДЛЯ РАЗРАБОТЧИКОВ (раздел «Для разработчиков» в настройках).
 *
 * showSource — подписывать ли в плеере, с какого балансера идёт видео («· Collaps»). Человеку это
 * не нужно — по умолчанию выключено (решение Марка); включают, когда разбираются с источниками.
 */
export type DevPrefs = { showSource: boolean };

const KEY = 'lumiere_dev_v1';
let prefs: DevPrefs = { showSource: false };
const listeners = new Set<() => void>();

void AsyncStorage.getItem(KEY)
  .then((raw) => {
    if (!raw) return;
    prefs = { ...prefs, ...(JSON.parse(raw) as Partial<DevPrefs>) };
    listeners.forEach((f) => f());
  })
  .catch(() => undefined);

export function devPrefs(): DevPrefs {
  return prefs;
}

export function setDevPrefs(patch: Partial<DevPrefs>): void {
  prefs = { ...prefs, ...patch };
  listeners.forEach((f) => f());
  AsyncStorage.setItem(KEY, JSON.stringify(prefs)).catch(() => undefined);
}

export function useDevPrefs(): DevPrefs {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return prefs;
}
