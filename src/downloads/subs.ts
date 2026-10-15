import { Directory, File } from 'expo-file-system';
import { imdbId } from '../api/tmdb';
import { findOnlineSubtitles, loadOpenSubtitle } from '../player/opensubs';
import { say } from '../data/journal';
import { allDownloads, patchTask, taskById, type DlSub, type DlTask } from './store';
import { taskDir } from './offline';

/**
 * СУБТИТРЫ К ЗАГРУЗКАМ — ВСЕ, ЧТО ЕСТЬ (решение Марка).
 *
 * Скачанное смотрят без сети — значит, и субтитры должны лежать рядом с видео, а не искаться при
 * просмотре. К каждой загрузке собирается всё доступное:
 *   • субтитры самого источника (у Collaps это VTT-файлы на той же раздаче, по нескольку языков);
 *   • найденные онлайн по номеру IMDb (Wyzie / OpenSubtitles): русские, английские, немецкие.
 * Каждый файл пишется в папку загрузки (subs/NN.vtt|srt), список — в саму задачу (task.subs).
 * Плеер без сети берёт их оттуда же (offline.ts).
 *
 * Всё это — «по возможности»: не нашлось или сеть оборвалась — видео скачано всё равно, а для
 * уже готовых загрузок без субтитров поиск повторяется при следующем запуске (backfillSubs).
 */

/** Язык по подписи источника: «Rus», «Русские», «Eng. full», «English» … */
function langOf(label: string): string | null {
  const l = label.toLowerCase();
  if (/rus|рус/.test(l)) return 'ru';
  if (/eng|англ/.test(l)) return 'en';
  if (/ukr|укр/.test(l)) return 'uk';
  if (/ger|deu|нем/.test(l)) return 'de';
  return null;
}

function extOf(text: string): string {
  return /^﻿?WEBVTT/.test(text.trimStart()) ? 'vtt' : 'srt';
}

/** Похоже ли на субтитры: есть отметка времени «00:00:01,000 --> …». */
function looksLikeSubs(text: string): boolean {
  return /\d{1,2}:\d{2}[:.,]\d{2}[.,]?\d*\s*-->\s*/.test(text);
}

const running = new Set<string>();

/**
 * Собрать субтитры к загрузке. captions/headers — от источника, с которого качаем (их может не
 * быть); imdb — для поиска онлайн. Повторный вызов для той же задачи, пока идёт первый, — пропуск.
 */
export async function fetchSubsFor(
  id: string,
  captions: { name: string; url: string }[],
  headers: Record<string, string>,
  imdb: string | null,
): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    const t = taskById(id);
    if (!t) return;
    const target = t.season != null && t.episode != null ? { season: t.season, episode: t.episode } : null;
    const got: { label: string; lang: string | null; text: string }[] = [];

    // 1. Субтитры источника — с теми же заголовками, что и видео: раздача иначе отказывает.
    for (const c of captions) {
      try {
        const res = await fetch(c.url, { headers });
        if (!res.ok) continue;
        const text = await res.text();
        if (looksLikeSubs(text)) got.push({ label: c.name || 'Субтитры', lang: langOf(c.name || ''), text });
      } catch {
        /* следующий */
      }
    }

    // 2. Онлайн по IMDb — если номер известен (у загрузки его может не быть: спросим у ТМДБ).
    const num = imdb ?? (await imdbId(t.item.type, t.item.id).catch(() => null));
    if (num) {
      const { tracks } = await findOnlineSubtitles(num, target?.season ?? null, target?.episode ?? null).catch(() => ({ tracks: [] }));
      for (const tr of tracks) {
        const text = await loadOpenSubtitle(tr.url).catch(() => null);
        if (text && looksLikeSubs(text)) got.push({ label: tr.label, lang: tr.lang, text });
      }
    }

    if (!taskById(id)) return; // загрузку успели удалить
    const dir = new Directory(taskDir(id), 'subs');
    if (!dir.exists) dir.create({ intermediates: true });
    const subs: DlSub[] = [];
    const seen = new Set<string>();
    got.forEach((g, i) => {
      // Одинаковые подписи (две «Русские» — от источника и онлайн) различаются пометкой.
      let label = g.label;
      if (seen.has(label.toLowerCase())) label = `${label} · ${i + 1}`;
      seen.add(label.toLowerCase());
      const name = `${String(i + 1).padStart(2, '0')}.${extOf(g.text)}`;
      try {
        new File(dir, name).write(g.text);
        subs.push({ label, lang: g.lang, file: `subs/${name}` });
      } catch {
        /* место кончилось или папку удалили — без этого файла */
      }
    });
    patchTask(id, { subs, subsAt: Date.now() }, true);
    say(`ЛЮМЬЕР · загрузка · субтитры: ${subs.map((s) => s.label).join(', ') || 'не нашлись'}`);
  } catch {
    /* по возможности */
  } finally {
    running.delete(id);
  }
}

/**
 * Готовые загрузки без субтитров (скачанные до этой версии или когда поиск не удался) — добрать.
 * По одной, без спешки: это фон, а не то, что человек ждёт. Пробуем не чаще раза в сутки на задачу.
 */
export async function backfillSubs(): Promise<void> {
  const day = 24 * 60 * 60_000;
  const todo = allDownloads().filter((x: DlTask) => x.state === 'done' && !x.subs?.length && (!x.subsAt || Date.now() - x.subsAt > day));
  for (const x of todo) await fetchSubsFor(x.id, [], {}, null);
}
