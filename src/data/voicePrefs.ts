import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * ОЗВУЧКА, КОТОРУЮ ВЫБРАЛИ ДЛЯ ТАЙТЛА — как VoicePreferenceStore у Влада.
 *
 * Выбрал в плеере «LostFilm» — следующая серия, повторное открытие и загрузка берут его же, а
 * не «лучший по рангу». Хранится по тайтлу (тип:номер ТМДБ), а не по серии: голос выбирают
 * сериалу целиком.
 */
const KEY = 'lumiere_voice_v1';
let cache: Record<string, string> = {};
let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) cache = JSON.parse(raw) as Record<string, string>;
  } catch {
    cache = {};
  }
}
void load();

export function voiceFor(titleKey: string): string | undefined {
  return cache[titleKey];
}

export async function voiceForAsync(titleKey: string): Promise<string | undefined> {
  await load();
  return cache[titleKey];
}

export function setVoiceFor(titleKey: string, voice: string): void {
  if (!voice || cache[titleKey] === voice) return;
  cache[titleKey] = voice;
  AsyncStorage.setItem(KEY, JSON.stringify(cache)).catch(() => undefined);
}
