import { AppState } from 'react-native';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MediaItem } from '../types/media';
import { downloadSource } from '../api/sources/playback';
import { say } from '../data/journal';
import {
  addTask,
  allDownloads,
  dropTask,
  loadDownloads,
  patchTask,
  setDownloadsQuiet,
  speeds,
  taskById,
  type DlItem,
  type DlTask,
} from './store';
import { keyFor, taskDir } from './offline';
import { backfillSubs, fetchSubsFor } from './subs';
import { audioFor, isMaster, localMaster, pickVariant, trackOf, variantsOf, type Piece } from './hls';
import { remux, type Input } from './remux';
import { kindOf, topBoxes } from './inspect';

/**
 * ВЕРСИЯ СКЛЕЙКИ. Загрузка, которую не удалось склеить, второй раз не пробуется — иначе каждый
 * запуск снова тратил бы минуты на заведомый провал. Но когда склейка исправлена, старые неудачи
 * надо перепроверить: версия выросла — пробуем ещё раз.
 */
const MUX_VERSION = 2;

/**
 * ЗАГРУЗКИ — ОЧЕРЕДЬ И КАЧАЛКА. Устроено как у планшетного Люмьера (lumiere.tab.Dl):
 *
 *  — ОЧЕРЕДЬ. Одновременно качается столько, сколько выбрано в настройках (по умолчанию одна);
 *    остальные ждут. Новые встают в конец.
 *  — ПАУЗА И ПРОДОЛЖЕНИЕ. Пауза обрывает текущие запросы; продолжение берёт свежую ссылку и качает
 *    только недостающие куски — скачанные лежат на диске и второй раз не трогаются.
 *  — МЕСТО. Перед стартом сверяется ожидаемый размер со свободным местом (с запасом 300 МБ).
 *  — СБОИ. Кусок, который не скачался, пробуется ещё дважды; не вышло — загрузка встаёт с ошибкой и
 *    продолжается по кнопке «Повторить» с того же места.
 *
 * Чего на iPhone нет, в отличие от Android: качать в свёрнутом приложении. Система усыпляет его
 * через несколько секунд после ухода с экрана; загрузка встаёт на паузу сама и продолжается, как
 * только приложение снова открыто.
 */

const PREF_PARALLEL = 'lumiere_dl_parallel_v1';
let parallel = 1;
void AsyncStorage.getItem(PREF_PARALLEL).then((v) => {
  const n = Number(v);
  if (n >= 1 && n <= 3) parallel = n;
});

/** Через сколько после запуска продолжать недокачанное (см. ниже). */
export const BOOT_DELAY_MS = 4000;

export function parallelDownloads(): number {
  return parallel;
}
export function setParallelDownloads(n: number): void {
  parallel = Math.max(1, Math.min(3, n));
  AsyncStorage.setItem(PREF_PARALLEL, String(parallel)).catch(() => undefined);
  kick();
}

/** Сколько кусков одной загрузки качается одновременно. */
const PIECE_PARALLEL = 4;
const RESERVE_BYTES = 300 * 1024 * 1024;

const running = new Map<string, AbortController>();

function snapshot(item: MediaItem): DlItem {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    originalTitle: item.originalTitle,
    posterUrl: item.posterUrl,
    backdropUrl: item.backdropUrl,
    year: item.year,
  };
}

function asItem(d: DlItem): MediaItem {
  return {
    id: d.id,
    type: d.type,
    title: d.title,
    originalTitle: d.originalTitle,
    overview: '',
    posterUrl: d.posterUrl,
    backdropUrl: d.backdropUrl,
    year: d.year,
    rating: 0,
    releaseDate: null,
    originalLanguage: null,
    genreIds: [],
    voteCount: 0,
  };
}

/** Поставить в очередь фильм (target = null) или серию. Уже скачанное/качающееся не дублируется. */
export function enqueueDownload(
  item: MediaItem,
  target: { season: number; episode: number } | null,
  voice?: string,
): DlTask {
  const key = keyFor(item, target);
  const have = allDownloads().find((t) => t.key === key);
  if (have && have.state !== 'failed') {
    if (have.state === 'paused') resumeDownload(have.id);
    return have;
  }
  if (have) removeDownload(have.id);
  const task: DlTask = {
    id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    key,
    item: snapshot(item),
    season: target?.season,
    episode: target?.episode,
    label: target ? `Сезон ${target.season} · Серия ${target.episode}` : '',
    voice,
    state: 'queued',
    piecesDone: 0,
    piecesTotal: 0,
    bytes: 0,
    bytesTotal: 0,
    createdAt: Date.now(),
  };
  addTask(task);
  kick();
  return task;
}

export function pauseDownload(id: string): void {
  running.get(id)?.abort();
  running.delete(id);
  speeds.delete(id);
  patchTask(id, { state: 'paused' }, true);
  kick();
}

export function resumeDownload(id: string): void {
  const t = taskById(id);
  if (!t || t.state === 'done') return;
  patchTask(id, { state: 'queued', error: undefined }, true);
  kick();
}

export function pauseAll(): void {
  allDownloads()
    .filter((t) => t.state === 'queued' || t.state === 'running')
    .forEach((t) => pauseDownload(t.id));
}

export function resumeAll(): void {
  allDownloads()
    .filter((t) => t.state === 'paused' || t.state === 'failed')
    .forEach((t) => resumeDownload(t.id));
}

/** Убрать загрузку и всё, что она успела положить на диск. */
export function removeDownload(id: string): void {
  running.get(id)?.abort();
  running.delete(id);
  try {
    const dir = taskDir(id);
    if (dir.exists) dir.delete();
  } catch {
    // нечего удалять
  }
  dropTask(id);
  kick();
}

/** Сколько места занимают все загрузки, байт. */
export function downloadsSize(): number {
  return allDownloads().reduce((n, t) => n + (t.bytes || 0), 0);
}

export function freeSpace(): number {
  try {
    return Paths.availableDiskSpace;
  } catch {
    return -1;
  }
}

const BOOT_AT = Date.now();
let lateKick: ReturnType<typeof setTimeout> | null = null;

/** Запустить столько ожидающих, сколько позволяет «одновременно». */
export function kick(): void {
  void loadDownloads().then(() => {
    /*
      СТАРЫЕ ГОТОВЫЕ ЗАГРУЗКИ — ДОКЛЕИТЬ. До склейки в MP4 готовая загрузка оставалась плейлистом из
      кусков, а его iPhone с диска не играет. Такие встают в очередь ещё раз: куски уже на диске,
      сеть не нужна — run() сразу перейдёт к склейке.
    */
    /*
      Не в первые секунды после запуска: в это время грузится лента и человек начинает листать —
      склейка подождёт, пока приложение «устаканится».
    */
    const settled = Date.now() - BOOT_AT > 12_000;
    if (!settled && !lateKick) lateKick = setTimeout(() => kick(), 12_500);
    for (const t of settled ? allDownloads() : []) {
      const retry = !t.muxError || (t.muxVersion ?? 1) < MUX_VERSION;
      if (t.state === 'done' && t.playlist && /\.m3u8$/i.test(t.playlist) && retry && !running.has(t.id)) {
        patchTask(t.id, { state: 'queued', mux: 0 }, true);
      }
    }
    const queue = allDownloads()
      .filter((t) => t.state === 'queued' && !running.has(t.id))
      // Очередь — в порядке постановки: раньше поставленное качается раньше.
      .sort((a, b) => a.createdAt - b.createdAt);
    let free = parallel - running.size;
    for (const t of queue) {
      if (free <= 0) break;
      free -= 1;
      void run(t.id);
    }
  });
}

// Вернулись в приложение — продолжаем; ушли — система всё равно усыпит, честно ставим «очередь».
AppState.addEventListener('change', (s) => {
  if (s === 'active') kick();
});
// Недокачанное с прошлого раза продолжается не сразу, а через несколько секунд после запуска:
// куски видео иначе делят сеть с лентой, которую ждёт заставка.
void loadDownloads().then(() => {
  setTimeout(kick, BOOT_DELAY_MS);
  // Готовым загрузкам без субтитров (скачанным раньше) — добрать их, чуть позже и в фоне.
  setTimeout(() => void backfillSubs(), BOOT_DELAY_MS + 6_000);
});

class Stopped extends Error {}


async function fetchText(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { headers, signal });
  if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
  return res.text();
}

async function savePiece(p: Piece, dir: Directory, headers: Record<string, string>, signal: AbortSignal): Promise<number> {
  const file = new File(dir, p.name);
  if (file.exists && (file.size ?? 0) > 0) return 0; // уже на диске — с прошлого раза
  const h = { ...headers };
  if (p.range) h.Range = `bytes=${p.range.offset}-${p.range.offset + p.range.length - 1}`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw new Stopped();
    try {
      const got = await File.downloadFileAsync(p.url, file, { headers: h, idempotent: true, signal });
      return got.size ?? 0;
    } catch (e) {
      if (signal.aborted) throw new Stopped();
      lastError = e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Кусок не скачался');
}

async function run(id: string): Promise<void> {
  const t0 = taskById(id);
  if (!t0) return;
  const ctrl = new AbortController();
  running.set(id, ctrl);
  const signal = ctrl.signal;
  patchTask(id, { state: 'running', error: undefined }, true);
  try {
    // Все куски уже на диске (пауза на склейке или старая загрузка) — сеть не нужна.
    if (chunksOnDisk(id)) {
      await joinFile(id);
      return;
    }
    if (piecesOnDisk(id)) {
      await finalize(id, signal);
      return;
    }
    const target = t0.season != null && t0.episode != null ? { season: t0.season, episode: t0.episode } : null;
    const src = await downloadSource(asItem(t0.item), target, t0.voice);
    if (signal.aborted) throw new Stopped();
    if (!src) throw new Error('Источник не дал ссылку на это видео');
    patchTask(id, { voice: src.voice, quality: src.quality });
    // Субтитры — все, что есть, рядом с видео (по возможности; на загрузку видео не влияют).
    void fetchSubsFor(id, src.captions ?? [], src.headers, src.imdb ?? null);

    const dir = taskDir(id);
    if (!dir.exists) dir.create({ intermediates: true });

    let jobs: { p: Piece; dir: Directory }[];
    let estimate: number;
    let mode: 'hls' | 'file' = 'hls';
    let hlsPlaylist = 'v/index.m3u8';

    if (src.direct) {
      /*
        ГОТОВЫЙ ФАЙЛ MP4 — кусками по 8 МБ (диапазоны байт), по четыре сразу, как и поток. Так
        работают пауза, продолжение и повтор упавшего куска; в конце куски складываются подряд в
        один файл (joinFile). Раздача без диапазонов — одной загрузкой целиком.
      */
      mode = 'file';
      const size = await remoteSize(src.url, src.headers, signal);
      if (signal.aborted) throw new Stopped();
      const fDir = new Directory(dir, 'f');
      if (!size) {
        await wholeFile(id, src.url, src.headers, signal);
        return;
      }
      const sizeFile = new File(fDir, 'size.txt');
      // Тот же размер, что в прошлый раз, — значит, тот же файл, и куски с диска годятся.
      if (fDir.exists && (!sizeFile.exists || Number(sizeFile.textSync()) !== size)) fDir.delete();
      if (!fDir.exists) fDir.create({ intermediates: true });
      sizeFile.write(String(size));
      const count = Math.ceil(size / CHUNK);
      jobs = Array.from({ length: count }, (_, i) => ({
        p: {
          url: src.url,
          range: { offset: i * CHUNK, length: Math.min(CHUNK, size - i * CHUNK) },
          name: `${String(i + 1).padStart(5, '0')}.bin`,
        },
        dir: fDir,
      }));
      estimate = size;
    } else {
      const first = await fetchText(src.url, src.headers, signal).catch((e) => {
        if (signal.aborted) throw new Stopped();
        throw e;
      });

      // Не плейлист — обычный файл: качается целиком одной загрузкой.
      if (!first.trimStart().startsWith('#EXTM3U')) {
        const file = new File(dir, 'video.mp4');
        const got = await File.downloadFileAsync(src.url, file, { headers: src.headers, idempotent: true, signal });
        patchTask(id, { state: 'done', bytes: got.size ?? 0, bytesTotal: got.size ?? 0, piecesDone: 1, piecesTotal: 1, playlist: 'video.mp4', doneAt: Date.now() }, true);
        return;
      }

      let videoText = first;
      let videoBase = src.url;
      let master: string | null = null;
      let audio: ReturnType<typeof audioFor> = null;
      let variant: ReturnType<typeof pickVariant> = null;
      if (isMaster(first)) {
        variant = pickVariant(variantsOf(first, src.url));
        if (!variant) throw new Error('Пустой плейлист');
        videoBase = variant.url;
        videoText = await fetchText(variant.url, src.headers, signal);
        audio = audioFor(first, src.url, variant.audioGroup, src.audio);
        master = first;
      }
      const video = trackOf(videoText, videoBase);
      const audioTrack = audio ? trackOf(await fetchText(audio.url, src.headers, signal), audio.url) : null;

      const vDir = new Directory(dir, 'v');
      if (!vDir.exists) vDir.create({ intermediates: true });
      const aDir = audioTrack ? new Directory(dir, 'a') : null;
      if (aDir && !aDir.exists) aDir.create({ intermediates: true });
      // Плейлисты пишутся сразу: по ним же при продолжении видно, что уже скачано.
      new File(vDir, 'index.m3u8').write(video.playlist);
      if (aDir && audioTrack) new File(aDir, 'index.m3u8').write(audioTrack.playlist);
      if (variant && audio) new File(dir, 'master.m3u8').write(localMaster(variant, audio));
      hlsPlaylist = variant && audio ? 'master.m3u8' : 'v/index.m3u8';

      jobs = [
        ...video.pieces.map((p) => ({ p, dir: vDir })),
        ...(audioTrack && aDir ? audioTrack.pieces.map((p) => ({ p, dir: aDir })) : []),
      ];
      estimate = variant?.bandwidth ? Math.round((variant.bandwidth / 8) * video.seconds) : 0;
    }

    // Ожидаемый размер: у файла — точный, у потока — полоса × длительность. Не влезает — не начинаем.
    const space = freeSpace();
    const left = Math.max(0, estimate - (taskById(id)?.bytes ?? 0));
    if (estimate > 0 && space >= 0 && left > space - RESERVE_BYTES) {
      throw new Error(`Не хватает места: нужно ${fmtSize(left)}, свободно ${fmtSize(space)}`);
    }

    // Уже скачанное с прошлого раза — посчитать до старта.
    let done = 0;
    let bytes = 0;
    for (const j of jobs) {
      const f = new File(j.dir, j.p.name);
      if (f.exists && (f.size ?? 0) > 0) {
        done += 1;
        bytes += f.size ?? 0;
      }
    }
    patchTask(id, { piecesDone: done, piecesTotal: jobs.length, bytes, bytesTotal: Math.max(estimate, bytes) }, true);

    // Скорость — по скачанному за последние секунды.
    let windowBytes = 0;
    let windowStart = Date.now();
    let next = 0;
    // Один кусок не скачался трижды — останавливаем и остальных: продолжим потом с этого места.
    let failure: Error | null = null;
    const worker = async (slot: number) => {
      while (next < jobs.length) {
        if (signal.aborted) throw new Stopped();
        /*
          ПОКА ИДЁТ КИНО — ОДИН КУСОК ЗА РАЗ. Четыре параллельных запроса делят канал с потоком
          плеера, и кино начинало подгружаться рывками. Остальные «руки» ждут, пока плеер закроется
          (или пока работа не кончится), и сразу подхватывают очередь снова.
        */
        while (slot > 0 && playerBusy && next < jobs.length) {
          if (signal.aborted) throw new Stopped();
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (next >= jobs.length) break;
        const j = jobs[next++];
        let got: number;
        try {
          got = await savePiece(j.p, j.dir, src.headers, signal);
        } catch (e) {
          if (!(e instanceof Stopped) && !failure) {
            failure = e instanceof Error ? e : new Error(String(e));
            ctrl.abort();
          }
          throw e;
        }
        if (got === 0) continue; // был на диске
        done += 1;
        bytes += got;
        windowBytes += got;
        const now = Date.now();
        if (now - windowStart >= 1000) {
          speeds.set(id, Math.round((windowBytes * 1000) / (now - windowStart)));
          windowBytes = 0;
          windowStart = now;
        }
        // Пока качается — оценка размера по средней величине куска точнее полосы из плейлиста.
        const avg = bytes / Math.max(1, done);
        patchTask(id, { piecesDone: done, bytes, bytesTotal: Math.max(bytes, Math.round(avg * jobs.length)) }, done % 10 === 0);
      }
    };
    await Promise.all(Array.from({ length: PIECE_PARALLEL }, (_, slot) => worker(slot))).catch(() => undefined);
    if (failure) throw failure;
    if (signal.aborted) throw new Stopped();

    if (mode === 'file') {
      patchTask(id, { piecesDone: jobs.length, bytes, bytesTotal: bytes }, true);
      await joinFile(id);
      return;
    }
    patchTask(id, { piecesDone: jobs.length, bytes, bytesTotal: bytes, playlist: hlsPlaylist }, true);
    await finalize(id, signal);
  } catch (e) {
    if (e instanceof Stopped || (signal.aborted && taskById(id)?.state !== 'running')) {
      // Пауза или удаление — состояние уже выставил тот, кто остановил.
    } else {
      const message = e instanceof Error ? e.message : String(e);
      say(`ЛЮМЬЕР · загрузка · ${t0.item.title}${t0.label ? ` · ${t0.label}` : ''} — ошибка: ${message}`);
      patchTask(id, { state: 'failed', error: message }, true);
    }
  } finally {
    running.delete(id);
    speeds.delete(id);
    kick();
  }
}

/** Склеить заново — после «Проверить файл», когда склейка не вышла. */
export function remuxAgain(id: string): void {
  const t = taskById(id);
  if (!t || running.has(id)) return;
  patchTask(id, { state: 'queued', mux: 0, muxError: undefined }, true);
  kick();
}

/*
  ПОКА ИДЁТ КИНО — СКЛЕЙКА СТОИТ. Склейка и сложение кусков — это сотни мегабайт через память
  телефона. Вместе с воспроизведением это слишком: система закрывает приложение, чтобы освободить
  память. Поэтому плеер, открываясь, говорит «занят» (setPlayerBusy), и склейка ждёт его ухода.
*/
let playerBusy = false;
export function setPlayerBusy(busy: boolean): void {
  playerBusy = busy;
  // Под плеером ход загрузки экранам не сообщается (store.ts); закрылся — одно обновление.
  setDownloadsQuiet(busy);
}
async function playerFree(signal?: AbortSignal): Promise<void> {
  while (playerBusy) {
    if (signal?.aborted) throw new Stopped();
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Кусок готового файла — 8 МБ: и пауза теряет немного, и запросов не тысячи. */
const CHUNK = 8 * 1024 * 1024;

/** Размер файла на раздаче — если она отдаёт диапазоны байт (иначе 0). */
async function remoteSize(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<number> {
  try {
    const res = await fetch(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal });
    const range = res.headers.get('content-range') ?? '';
    const m = /\/(\d+)\s*$/.exec(range);
    return res.status === 206 && m ? Number(m[1]) : 0;
  } catch (e) {
    if (signal.aborted) throw new Stopped();
    return 0;
  }
}

/** Файл без диапазонов — одной загрузкой, с ходом по байтам. */
async function wholeFile(id: string, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<void> {
  const dir = taskDir(id);
  const file = new File(dir, 'video.mp4');
  const got = await File.downloadFileAsync(url, file, {
    headers,
    idempotent: true,
    signal,
    onProgress: ({ bytesWritten, totalBytes }) =>
      patchTask(id, { bytes: bytesWritten, bytesTotal: totalBytes, piecesDone: 0, piecesTotal: 1 }),
  });
  patchTask(id, { state: 'done', bytes: got.size ?? 0, bytesTotal: got.size ?? 0, piecesDone: 1, piecesTotal: 1, playlist: 'video.mp4', doneAt: Date.now() }, true);
}

/** Все куски готового файла на диске — можно складывать. */
function chunksOnDisk(id: string): boolean {
  const fDir = new Directory(taskDir(id), 'f');
  const sizeFile = new File(fDir, 'size.txt');
  if (!fDir.exists || !sizeFile.exists) return false;
  const size = Number(sizeFile.textSync());
  if (!(size > 0)) return false;
  const count = Math.ceil(size / CHUNK);
  for (let i = 0; i < count; i++) {
    const f = new File(fDir, `${String(i + 1).padStart(5, '0')}.bin`);
    if (!f.exists || (f.size ?? 0) !== Math.min(CHUNK, size - i * CHUNK)) return false;
  }
  return true;
}

/**
 * КУСКИ ФАЙЛА — ПОДРЯД В ОДИН video.mp4. Это не склейка потока, а просто сложение байтов по
 * порядку: каждый кусок дописывается в конец и тут же удаляется, так что лишнего места на диске
 * нужно не больше одного куска. Паузой не прерывается — занимает секунды.
 */
async function joinFile(id: string): Promise<void> {
  const t = taskById(id);
  if (!t) return;
  const dir = taskDir(id);
  const fDir = new Directory(dir, 'f');
  const size = Number(new File(fDir, 'size.txt').textSync());
  const count = Math.ceil(size / CHUNK);
  const part = new File(dir, 'video.part.mp4');
  if (part.exists) part.delete();
  part.create();
  const h = part.open(FileMode.ReadWrite);
  try {
    for (let i = 0; i < count; i++) {
      await playerFree();
      const f = new File(fDir, `${String(i + 1).padStart(5, '0')}.bin`);
      h.writeBytes(await f.bytes());
      f.delete();
      if (i % 4 === 0) patchTask(id, { mux: (i + 1) / count });
    }
  } finally {
    h.close();
  }
  if ((part.size ?? 0) !== size) {
    part.delete();
    fDir.delete();
    throw new Error(`файл сложился не тем размером: ${part.size} из ${size} — скачаю заново`);
  }
  const mp4 = new File(dir, 'video.mp4');
  if (mp4.exists) mp4.delete();
  await part.move(mp4);
  fDir.delete();
  patchTask(id, { state: 'done', mux: undefined, muxError: undefined, playlist: 'video.mp4', bytes: size, bytesTotal: size, doneAt: Date.now() }, true);
  say(`ЛЮМЬЕР · загрузка · ${t.item.title}${t.label ? ` · ${t.label}` : ''} — готово (файл), ${fmtSize(size)}`);
}

/** Скачаны ли все куски: плейлист на диске и каждый кусок из него на месте. */
function piecesOnDisk(id: string): boolean {
  const dir = taskDir(id);
  const v = localTrack(dir, 'v');
  if (!v) return false;
  const a = new Directory(dir, 'a').exists ? localTrack(dir, 'a') : null;
  if (new Directory(dir, 'a').exists && !a) return false;
  return [v, ...(a ? [a] : [])].every((t) => t.names.every((n) => {
    const f = new File(t.dir, n);
    return f.exists && (f.size ?? 0) > 0;
  }));
}

/** Куски дорожки по её плейлисту на диске: init (если есть) и остальные по порядку. */
function localTrack(dir: Directory, sub: string): { dir: Directory; init: string | null; names: string[] } | null {
  const d = new Directory(dir, sub);
  const list = new File(d, 'index.m3u8');
  if (!list.exists) return null;
  let text = '';
  try {
    text = list.textSync();
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const map = lines.find((l) => /^#EXT-X-MAP/i.test(l));
  const init = map ? (/URI="([^"]+)"/i.exec(map)?.[1] ?? null) : null;
  const names = lines.filter((l) => !l.startsWith('#'));
  if (!names.length) return null;
  return { dir: d, init, names: init ? [init, ...names] : names };
}

/**
 * СКЛЕЙКА В ОДИН MP4 — последний шаг загрузки (почему — в remux.ts).
 *
 * Пишется во временный файл и только целиком переименовывается в video.mp4: оборванная склейка не
 * оставит битого файла, который плеер принял бы за готовый. Получилось — куски удаляются (место
 * нужно на диске один раз, а не два). Не получилось — загрузка остаётся плейлистом из кусков, как
 * было, а причина пишется в журнал выбора: по ней видно, что за поток попался.
 */
async function finalize(id: string, signal: AbortSignal): Promise<void> {
  const t = taskById(id);
  if (!t) return;
  const dir = taskDir(id);
  const v = localTrack(dir, 'v');
  const a = new Directory(dir, 'a').exists ? localTrack(dir, 'a') : null;
  const what = `${t.item.title}${t.label ? ` · ${t.label}` : ''}`;
  const keepHls = (why: string) => {
    // К причине — чем начинаются куски: по этому сразу видно, что за поток (или не поток вовсе).
    let what2 = '';
    try {
      const first = v?.names.find((n) => !/^init/.test(n)) ?? v?.names[0];
      if (v && first) {
        const f = new File(v.dir, first);
        const h = f.open(FileMode.ReadOnly);
        const b = h.readBytes(24);
        h.close();
        what2 = ` [куски: ${kindOf(b)}]`;
      }
    } catch {
      // нечего добавить
    }
    const reason = `${why}${what2}`;
    say(`ЛЮМЬЕР · загрузка · ${what} — не склеилось в MP4: ${reason}`);
    patchTask(id, { state: 'done', mux: undefined, muxError: reason, muxVersion: MUX_VERSION, doneAt: t.doneAt ?? Date.now() }, true);
  };
  if (!v) {
    // Обычный файл (не плейлист) — склеивать нечего.
    patchTask(id, { state: 'done', mux: undefined, doneAt: t.doneAt ?? Date.now() }, true);
    return;
  }
  const space = freeSpace();
  if (space >= 0 && space < (t.bytes || 0) + RESERVE_BYTES / 3) {
    throw new Error(`Не хватает места, чтобы подготовить к просмотру: нужно ${fmtSize(t.bytes)}, свободно ${fmtSize(space)}`);
  }
  const toInput = (tr: NonNullable<typeof v>): Input => {
    const names = tr.init ? tr.names.slice(1) : tr.names;
    return {
      init: tr.init ? () => new File(tr.dir, tr.init as string).bytes() : undefined,
      pieces: names.length,
      // Пока открыт плеер, склейка ждёт: кино важнее, а память и процессор телефону нужны ему.
      read: async (i) => {
        await playerFree(signal);
        return new File(tr.dir, names[i]).bytes();
      },
    };
  };
  const part = new File(dir, 'video.part.mp4');
  try {
    if (part.exists) part.delete();
    part.create();
  } catch (e) {
    keepHls(e instanceof Error ? e.message : String(e));
    return;
  }
  const h = part.open(FileMode.ReadWrite);
  /*
    ЗАКРЫТЬ РОВНО ОДИН РАЗ. Повторное закрытие уже закрытого файла система считает грубой ошибкой и
    роняет приложение целиком — именно так «вылетало»: склейка закрывала файл, проверка не сходилась,
    и путь ошибки закрывал его ещё раз.
  */
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    try {
      h.close();
    } catch {
      // нечего закрывать
    }
  };
  patchTask(id, { mux: 0 });
  let lastPct = -1;
  try {
    const res = await remux(
      [toInput(v), ...(a ? [toInput(a)] : [])],
      {
        write: (b) => {
          if (signal.aborted || !open) throw new Stopped();
          h.writeBytes(b);
        },
        patch: (o, b) => {
          if (!open) throw new Stopped();
          const cur = h.offset ?? 0;
          h.offset = o;
          h.writeBytes(b);
          h.offset = cur;
        },
      },
      (done, total) => {
        const pct = Math.floor((done / Math.max(1, total)) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          patchTask(id, { mux: done / Math.max(1, total) });
        }
      },
    );
    close();
    /*
      ПРОВЕРКА СКЛЕЕННОГО ДО ТОГО, КАК ОТДАТЬ ЕГО ПЛЕЕРУ: файл перечитывается с диска, и его
      коробки должны сложиться ровно в размер файла — ftyp, mdat, moov. Не сошлось — значит, запись
      на диск шла не так, как задумано, и плееру такой файл отдавать нельзя.
    */
    const check = topBoxes(part);
    const types = check.list.map((x) => x.split(' ')[0]).join(',');
    if (!check.ok || types !== 'ftyp,mdat,moov' || check.size !== res.bytes) {
      throw new Error(`склеенный файл не сходится: ${check.list.join(', ')}; на диске ${check.size}, записано ${res.bytes}`);
    }
    const mp4 = new File(dir, 'video.mp4');
    if (mp4.exists) mp4.delete();
    await part.move(mp4);
    // Куски больше не нужны — место на диске освобождается сразу.
    for (const sub of ['v', 'a']) {
      const d = new Directory(dir, sub);
      if (d.exists) d.delete();
    }
    const master = new File(dir, 'master.m3u8');
    if (master.exists) master.delete();
    patchTask(id, { state: 'done', mux: undefined, muxError: undefined, muxVersion: MUX_VERSION, playlist: 'video.mp4', bytes: res.bytes, bytesTotal: res.bytes, doneAt: Date.now() }, true);
    say(`ЛЮМЬЕР · загрузка · ${what} — готово, ${fmtSize(res.bytes)}, ${Math.round(res.seconds / 60)} мин`);
  } catch (e) {
    close();
    try {
      if (part.exists) part.delete();
    } catch {
      // нечего удалять
    }
    if (e instanceof Stopped || signal.aborted) throw new Stopped();
    keepHls(e instanceof Error ? e.message : String(e));
  }
}

export function fmtSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} МБ`;
  return `${Math.max(0, Math.round(bytes / 1024))} КБ`;
}

export function fmtSpeed(bps: number): string {
  return bps >= 1024 ** 2 ? `${(bps / 1024 ** 2).toFixed(1)} МБ/с` : `${Math.round(bps / 1024)} КБ/с`;
}
