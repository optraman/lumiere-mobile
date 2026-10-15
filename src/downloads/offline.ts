import { Directory, File, Paths } from 'expo-file-system';
import type { MediaItem } from '../types/media';
import type { PlaybackRequest } from '../player/request';
import { episodeKey, resumePositionFor, titleKey } from '../data/watchProgress';
import { allDownloads, type DlTask } from './store';

/**
 * ОФЛАЙН-ПРОСМОТР: готовая загрузка → запрос плеера, без единого обращения к сети.
 */
export function downloadsRoot(): Directory {
  return new Directory(Paths.document, 'downloads');
}

export function taskDir(id: string): Directory {
  return new Directory(Paths.document, 'downloads', id);
}

export function keyFor(item: Pick<MediaItem, 'type' | 'id'>, target: { season: number; episode: number } | null): string {
  return target ? episodeKey(item.type, item.id, String(target.season), String(target.episode)) : titleKey(item.type, item.id);
}

/** Готовая загрузка этого фильма или серии, если файл на месте. */
export function readyTask(key: string): DlTask | null {
  /*
    Только готовый ФАЙЛ. Плейлист из кусков iPhone с диска не играет — плеер стоял на нуле; такую
    загрузку лучше не предлагать вовсе: с сетью кино пойдёт онлайн, а в «Загрузках» видно, что она
    ещё не подготовлена.
  */
  const t = allDownloads().find((x) => x.key === key && x.state === 'done' && x.playlist && /\.mp4$/i.test(x.playlist));
  if (!t || !t.playlist) return null;
  try {
    if (!new File(taskDir(t.id), t.playlist).exists) return null;
  } catch {
    return null;
  }
  return t;
}

export function localRequest(
  item: Pick<MediaItem, 'type' | 'id' | 'title' | 'posterUrl' | 'backdropUrl'>,
  target: { season: number; episode: number } | null,
): PlaybackRequest | null {
  const key = keyFor(item, target);
  const t = readyTask(key);
  if (!t || !t.playlist) return null;
  const file = new File(taskDir(t.id), t.playlist);

  /*
    Соседние серии — только скачанные этого же сериала: без сети других нет. Плеер переходит по
    ним кнопками и лентой серий; когда сеть есть, переход на не скачанную серию всё равно пойдёт
    через источник (changeEpisode → episodeRequest).
  */
  const siblings = target
    ? allDownloads()
        .filter((x) => x.item.id === item.id && x.item.type === item.type && x.state === 'done' && x.season != null)
        .sort((a, b) => (a.season! - b.season!) * 10000 + (a.episode! - b.episode!))
        .map((x) => ({ season: String(x.season), episode: String(x.episode), label: `Сезон ${x.season} · Серия ${x.episode}` }))
    : [];
  const currentEpisode = target
    ? siblings.findIndex((e) => e.season === String(target.season) && e.episode === String(target.episode))
    : -1;

  return {
    url: file.uri,
    title: item.title,
    subtitle: target ? `Сезон ${target.season} · Серия ${target.episode}` : null,
    isHls: /\.m3u8$/i.test(t.playlist),
    headers: {},
    // Субтитры, скачанные вместе с видео (downloads/subs.ts), — работают и без сети.
    subtitleTracks: (t.subs ?? [])
      .filter((x) => {
        try {
          return new File(taskDir(t.id), x.file).exists;
        } catch {
          return false;
        }
      })
      .map((x) => ({ label: x.label, lang: x.lang, url: new File(taskDir(t.id), x.file).uri })),
    voices: [],
    durationSec: null,
    mediaKey: key,
    mediaId: item.id,
    mediaType: item.type,
    posterUrl: item.posterUrl,
    backdropUrl: item.backdropUrl,
    startPositionMs: resumePositionFor(key),
    imdb: null,
    season: target ? String(target.season) : null,
    episode: target ? String(target.episode) : null,
    episodes: siblings,
    currentEpisode,
    sourceId: 'offline',
    sourceName: 'с устройства',
    // Номер −1 (OFFLINE_CHOICE в playback.ts): онлайн-озвучки, которые добавятся при наличии сети,
    // нумеруются с нуля, и пункт «скачанная» не должен с ними совпасть.
    choices: [{ voice: t.voice ?? 'Скачанная озвучка', quality: t.quality ?? null, source: 'с устройства', index: -1 }],
    choice: -1,
  };
}
