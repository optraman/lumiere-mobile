import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Портировано из data/search/SearchHistoryStore.kt — те же правила и тот же предел.

const KEY = 'lumiere_search_history_v1';
/** Двенадцать, как у Влада: столько помещается на экран без прокрутки, и столько человек реально
 * помнит про свои недавние поиски. */
const MAX = 12;
/** Однобуквенные запросы не сохраняются: они ничего не значат и мгновенно вытеснили бы список. */
const MIN_LEN = 2;

async function load(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? raw.split('\n').filter((x) => x.trim().length > 0).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

async function persist(list: string[]) {
  try {
    await AsyncStorage.setItem(KEY, list.join('\n'));
  } catch {
    /* не сохранилось — история потеряется, но поиск работать не перестанет */
  }
}

/**
 * История недавних запросов.
 *
 * Хранится строками через перевод строки — ровно как в оригинале: список короткий, разбирать JSON
 * ради двенадцати строк незачем, а такой формат читаем глазами при отладке.
 *
 * Сравнение БЕЗ УЧЁТА РЕГИСТРА: «дюна» и «Дюна» — один и тот же поиск, и держать их двумя записями
 * значит выкидывать из списка что-то полезное ради дубликата.
 */
export function useSearchHistory() {
  const [items, setItems] = useState<string[]>([]);

  useEffect(() => {
    load().then(setItems);
  }, []);

  const add = useCallback((raw: string) => {
    const query = raw.trim();
    if (query.length < MIN_LEN) return;
    setItems((prev) => {
      const next = [query, ...prev.filter((x) => x.toLowerCase() !== query.toLowerCase())].slice(0, MAX);
      // Ничего не изменилось — возвращаем ПРЕЖНИЙ массив. Новый литерал здесь означал бы лишний
      // рендер на каждое повторное сохранение того же запроса.
      if (prev.length === next.length && prev.every((x, i) => x === next[i])) return prev;
      persist(next);
      return next;
    });
  }, []);

  const remove = useCallback((query: string) => {
    setItems((prev) => {
      const next = prev.filter((x) => x.toLowerCase() !== query.toLowerCase());
      persist(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    persist([]);
  }, []);

  return { items, add, remove, clear };
}
