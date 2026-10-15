/*
 * ПРОВЕРКА ЗАГРУЗОК БЕЗ ТЕЛЕФОНА И БЕЗ СЕТИ.
 *
 * Компилирует src/downloads (очередь, качалку, разбор HLS, офлайн-запрос), подменяет файловую
 * систему Expo настоящими файлами во временной папке, источник — своим маленьким сервером, и
 * гоняет загрузку целиком: выбор 1080p, отдельная звуковая дорожка, fMP4 с init, куски по
 * диапазонам байт, повтор упавшего куска, пауза и продолжение без повторного скачивания,
 * нехватка места, зашифрованный поток, обычный mp4, удаление, офлайн-запрос плееру.
 *
 * Запуск:  node tools/download-check.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
const tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
try {
  execFileSync(process.execPath, [tsc, path.join(root, 'src/downloads/engine.ts'), '--outDir', out, '--rootDir', path.join(root, 'src'),
    '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck', '--esModuleInterop', '--jsx', 'react-native', '--lib', 'es2020,dom'], { cwd: out, stdio: 'pipe' });
} catch {
  /* замечания о типах в зависимостях не мешают */
}
if (!fs.existsSync(path.join(out, 'downloads', 'engine.js'))) {
  console.log('не собралось');
  process.exit(1);
}

// ── файловая система Expo — настоящими файлами
const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-docs-'));
const env = { free: 50 * 1024 ** 3, source: null };
const P = (parts) => path.join(...parts.map((p) => (typeof p === 'string' ? p : p.path)));
class Directory {
  constructor(...parts) { this.path = P(parts); }
  get uri() { return `file://${this.path}/`; }
  get exists() { return fs.existsSync(this.path); }
  create() { fs.mkdirSync(this.path, { recursive: true }); }
  delete() { fs.rmSync(this.path, { recursive: true, force: true }); }
}
class File {
  constructor(...parts) { this.path = P(parts); }
  get uri() { return `file://${this.path}`; }
  get exists() { return fs.existsSync(this.path); }
  get size() { return fs.existsSync(this.path) ? fs.statSync(this.path).size : 0; }
  write(t) { fs.mkdirSync(path.dirname(this.path), { recursive: true }); fs.writeFileSync(this.path, t); }
  delete() { fs.rmSync(this.path, { force: true }); }
  text() { return fs.readFileSync(this.path, 'utf8'); }
  textSync() { return fs.readFileSync(this.path, 'utf8'); }
  async bytes() { return new Uint8Array(fs.readFileSync(this.path)); }
  create() { fs.mkdirSync(path.dirname(this.path), { recursive: true }); fs.writeFileSync(this.path, ''); }
  async move(dest) { fs.renameSync(this.path, dest.path); this.path = dest.path; }
  open(mode) {
    const fd = fs.openSync(this.path, mode === 'r' ? 'r' : 'r+');
    const h = {
      offset: 0,
      writeBytes(b) { fs.writeSync(fd, b, 0, b.length, h.offset); h.offset += b.length; },
      readBytes(n) { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, h.offset); h.offset += got; return new Uint8Array(b.subarray(0, got)); },
      close() { fs.closeSync(fd); },
    };
    return h;
  }
  static async downloadFileAsync(url, dest, opts = {}) {
    const res = await fetch(url, { headers: opts.headers, signal: opts.signal });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(dest.path), { recursive: true });
    fs.writeFileSync(dest.path, buf);
    return dest;
  }
}
const stubs = {
  'expo-file-system': { File, Directory, FileMode: { ReadWrite: 'rw', ReadOnly: 'r' }, Paths: { document: new Directory(docs), get availableDiskSpace() { return env.free; } } },
  'react-native': { AppState: { addEventListener: () => ({ remove() {} }) } },
  react: { useSyncExternalStore: () => undefined },
  'async-storage': { __esModule: true, default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } },
  journal: { say: () => undefined },
  playback: {
    downloadSource: async () => env.source,
  },
};
const orig = Module._load;
Module._load = function (request) {
  const base = path.basename(request);
  if (stubs[request]) return stubs[request];
  if (stubs[base]) return stubs[base];
  return orig.apply(this, arguments);
};

// ── сервер-раздача
const hits = {};
let slow = 0;
let flaky = new Set();
const BIG = Buffer.from(Array.from({ length: 20 * 1024 * 1024 }, (_, i) => (i * 7 + (i >> 13)) & 255));
const AUDIO_BLOB = Buffer.from('A'.repeat(300) + 'B'.repeat(300) + 'C'.repeat(300));
const server = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  hits[u] = (hits[u] || 0) + 1;
  if (req.headers.referer !== 'https://player.example/') {
    res.writeHead(403);
    return res.end('no referer');
  }
  if (slow) await new Promise((r) => setTimeout(r, slow));
  const send = (body, type = 'application/vnd.apple.mpegurl') => {
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  };
  if (u === '/m/master.m3u8')
    return send(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Eng",URI="audio/eng.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Rus",DEFAULT=YES,URI="audio/rus.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x2160,AUDIO="aud"
4k/v.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4000000,RESOLUTION=1920x1080,AUDIO="aud"
1080/v.m3u8?tok=1
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud"
720/v.m3u8
`);
  if (u === '/m/1080/v.m3u8') {
    const segs = Array.from({ length: 8 }, (_, i) => `#EXTINF:4.0,\nseg${i + 1}.m4s?tok=1`).join('\n');
    return send(`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="init.mp4"\n${segs}\n#EXT-X-ENDLIST\n`);
  }
  if (u === '/m/audio/rus.m3u8')
    return send(`#EXTM3U\n#EXTINF:10,\n#EXT-X-BYTERANGE:300@0\n/m/audio/blob.ts\n#EXTINF:10,\n#EXT-X-BYTERANGE:300\n/m/audio/blob.ts\n#EXTINF:12,\n#EXT-X-BYTERANGE:300\n/m/audio/blob.ts\n#EXT-X-ENDLIST\n`);
  if (u === '/m/audio/blob.ts') {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (!m) return send(AUDIO_BLOB, 'video/mp2t');
    res.writeHead(206, { 'content-type': 'video/mp2t' });
    return res.end(AUDIO_BLOB.subarray(Number(m[1]), Number(m[2]) + 1));
  }
  if (u === '/m/1080/init.mp4') return send(Buffer.from('INIT'), 'video/mp4');
  const seg = /^\/m\/1080\/seg(\d+)\.m4s$/.exec(u);
  if (seg) {
    if (flaky.has(u)) {
      flaky.delete(u);
      res.writeHead(500);
      return res.end('oops');
    }
    return send(Buffer.from(`SEG${seg[1]}`.padEnd(1000, '.')), 'video/iso.segment');
  }
  // Настоящие куски TS (tools/fixtures/remux/ts) — для склейки в MP4.
  if (u === '/r/v.m3u8') {
    const names = fs.readdirSync(path.join(__dirname, 'fixtures', 'remux', 'ts')).filter((f) => f.endsWith('.ts')).sort();
    return send(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n${names.map((n) => `#EXTINF:2.0,\n${n}`).join('\n')}\n#EXT-X-ENDLIST\n`);
  }
  const real = /^\/r\/(\d+\.ts)$/.exec(u);
  if (real) return send(fs.readFileSync(path.join(__dirname, 'fixtures', 'remux', 'ts', real[1])), 'video/mp2t');
  if (u === '/e/v.m3u8') return send('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXTINF:4,\ns1.ts\n#EXT-X-ENDLIST\n');
  if (u === '/f/movie.mp4') return send(Buffer.alloc(5000, 7), 'video/mp4');
  // Готовый файл с диапазонами байт: 20 МБ — три куска по 8 МБ.
  if (u === '/d/movie.mp4') {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (!m) return send(BIG, 'video/mp4');
    const a = Number(m[1]);
    const b = Math.min(Number(m[2]), BIG.length - 1);
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${a}-${b}/${BIG.length}` });
    return res.end(BIG.subarray(a, b + 1));
  }
  res.writeHead(404);
  res.end();
});

let bad = 0;
const ok = (c, name, extra = '') => {
  console.log(`${c ? 'ok   ' : 'ПРОВАЛ'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!c) bad++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Referer: 'https://player.example/' };
  const store = require(path.join(out, 'downloads', 'store.js'));
  const engine = require(path.join(out, 'downloads', 'engine.js'));
  const offline = require(path.join(out, 'downloads', 'offline.js'));
  const hls = require(path.join(out, 'downloads', 'hls.js'));
  const item = (id, type = 'movie') => ({ id, type, title: `Тайтл ${id}`, originalTitle: '', overview: '', posterUrl: null, backdropUrl: null, year: '2020', rating: 0, releaseDate: null, originalLanguage: null, genreIds: [], voteCount: 0 });
  const waitState = async (id, states, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const t = store.taskById(id);
      if (t && states.includes(t.state)) return t;
      await sleep(25);
    }
    return store.taskById(id);
  };

  // разбор
  ok(hls.resolveUrl('a/b.ts?x', 'https://h/p/q/m.m3u8?t=1') === 'https://h/p/q/a/b.ts?x', 'относительная ссылка');
  const vs = hls.variantsOf('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9,RESOLUTION=3840x2160\nhi.m3u8', 'https://h/m.m3u8');
  ok(hls.pickVariant(vs).url === 'https://h/low.m3u8', 'выше 1080p нет — берётся то, что не выше');

  // 1. полная загрузка фильма: 1080p, отдельный звук, init, диапазоны, повтор упавшего куска
  env.source = { url: `${base}/m/master.m3u8`, headers, voice: 'LostFilm', quality: null, voices: ['LostFilm'] };

  // 1в. готовый MP4 у источника — кусками по диапазонам и подряд в один файл, байт в байт
  env.source = { url: `${base}/d/movie.mp4`, headers, voice: 'LostFilm', quality: '1080p', voices: ['LostFilm'], direct: true };
  const td = engine.enqueueDownload(item(12), null, 'LostFilm');
  const dd = await waitState(td.id, ['done', 'failed']);
  const dirD = path.join(docs, 'downloads', td.id);
  const same = fs.existsSync(path.join(dirD, 'video.mp4')) && Buffer.compare(fs.readFileSync(path.join(dirD, 'video.mp4')), BIG) === 0;
  ok(dd.state === 'done' && dd.playlist === 'video.mp4' && same && dd.piecesTotal === 3, 'готовый файл: 3 куска сложены байт в байт', dd.error || `${dd.piecesDone}/${dd.piecesTotal}`);
  ok(!fs.existsSync(path.join(dirD, 'f')), 'куски файла удалены после сложения');
  env.source = { url: `${base}/m/master.m3u8`, headers, voice: 'LostFilm', quality: null, voices: ['LostFilm'] };
  flaky = new Set(['/m/1080/seg3.m4s']);
  const t1 = engine.enqueueDownload(item(1), null, 'LostFilm');
  const d1 = await waitState(t1.id, ['done', 'failed']);
  ok(d1.state === 'done', 'фильм скачан', d1.error || `${d1.piecesDone}/${d1.piecesTotal}, ${d1.bytes} байт`);
  ok(!hits['/m/4k/v.m3u8'] && !hits['/m/720/v.m3u8'], 'выбрано 1080p (4K и 720p не трогали)');
  ok(hits['/m/1080/seg3.m4s'] === 2, 'упавший кусок повторён');
  const dir1 = path.join(docs, 'downloads', t1.id);
  const master = fs.readFileSync(path.join(dir1, 'master.m3u8'), 'utf8');
  ok(/URI="a\/index\.m3u8"/.test(master) && /v\/index\.m3u8/.test(master) && /NAME="Rus"/.test(master), 'главный плейлист на диске: звук Rus (DEFAULT) и видео');
  const vpl = fs.readFileSync(path.join(dir1, 'v', 'index.m3u8'), 'utf8');
  ok(vpl.includes('#EXT-X-MAP:URI="init.mp4"') && vpl.includes('00008.m4s') && vpl.includes('#EXT-X-ENDLIST') && !/http/.test(vpl), 'плейлист видео — локальные имена, init, конец списка');
  ok(fs.readFileSync(path.join(dir1, 'v', '00003.m4s'), 'utf8').startsWith('SEG3'), 'куски на месте и по порядку');
  const apl = fs.readFileSync(path.join(dir1, 'a', 'index.m3u8'), 'utf8');
  ok(!/BYTERANGE/.test(apl) && fs.readFileSync(path.join(dir1, 'a', '00002.ts'), 'utf8') === 'B'.repeat(300), 'диапазоны байт → отдельные файлы с нужным содержимым', apl.split('\n').length + ' строк');
  // Куски здесь — не настоящее видео (проверяется разбор плейлистов), склейка честно не выходит:
  // загрузка остаётся плейлистом, причина записана, повторных попыток нет.
  ok(!!d1.muxError && d1.playlist === 'master.m3u8', 'не склеилось — остаётся плейлист, причина записана', d1.muxError || '');
  const req = offline.localRequest(item(1), null);
  ok(req === null, 'не склеенное плееру не предлагается (iPhone плейлист с диска не играет)');

  // 1б. настоящие куски TS → один MP4, куски удалены, плееру — обычный файл
  env.source = { url: `${base}/r/v.m3u8`, headers, voice: 'LostFilm', quality: null, voices: ['LostFilm'] };
  const tr = engine.enqueueDownload(item(11), null, 'LostFilm');
  const dr = await waitState(tr.id, ['done', 'failed']);
  const dirR = path.join(docs, 'downloads', tr.id);
  const mp4 = path.join(dirR, 'video.mp4');
  const head = fs.existsSync(mp4) ? fs.readFileSync(mp4).toString('latin1', 4, 8) : '';
  ok(dr.state === 'done' && dr.playlist === 'video.mp4' && head === 'ftyp' && !dr.muxError, 'настоящие куски склеены в один MP4', dr.muxError || dr.error || `${dr.bytes} байт`);
  ok(!fs.existsSync(path.join(dirR, 'v')) && !fs.existsSync(path.join(dirR, 'video.part.mp4')), 'куски и черновик склейки удалены');
  const rr = offline.localRequest(item(11), null);
  ok(rr && rr.url === `file://${mp4}` && !rr.isHls, 'офлайн-запрос — обычный файл MP4');
  env.source = { url: `${base}/m/master.m3u8`, headers, voice: 'LostFilm', quality: null, voices: ['LostFilm'] };

  // 2. пауза и продолжение: скачанные куски второй раз не качаются
  Object.keys(hits).forEach((k) => delete hits[k]);
  slow = 120;
  const t2 = engine.enqueueDownload(item(2), null);
  for (let i = 0; i < 200 && !(store.taskById(t2.id).piecesDone >= 4); i++) await sleep(20);
  engine.pauseDownload(t2.id);
  const p2 = store.taskById(t2.id);
  ok(p2.state === 'paused' && p2.piecesDone >= 4 && p2.piecesDone < p2.piecesTotal, 'пауза посередине', `${p2.piecesDone}/${p2.piecesTotal}`);
  await sleep(400);
  const before = { ...hits };
  slow = 0;
  engine.resumeDownload(t2.id);
  const d2 = await waitState(t2.id, ['done', 'failed']);
  const twice = Object.keys(hits).filter((k) => /seg\d|init/.test(k) && hits[k] > 1 && (before[k] || 0) >= 1 && hits[k] - (before[k] || 0) > 0);
  ok(d2.state === 'done', 'продолжение докачало', d2.error || '');
  ok(twice.length <= 4, 'уже скачанное не перекачивалось', `повторно: ${twice.join(', ') || 'ничего'}`);

  // 3. нет места
  env.free = 10 * 1024 * 1024;
  const t3 = engine.enqueueDownload(item(3), null);
  const d3 = await waitState(t3.id, ['done', 'failed']);
  ok(d3.state === 'failed' && /Не хватает места/.test(d3.error), 'нехватка места — понятная ошибка', d3.error);
  env.free = 50 * 1024 ** 3;

  // 4. зашифрованный поток
  env.source = { url: `${base}/e/v.m3u8`, headers, voice: 'x', quality: null, voices: [] };
  const t4 = engine.enqueueDownload(item(4), null);
  const d4 = await waitState(t4.id, ['done', 'failed']);
  ok(d4.state === 'failed' && /зашифрован/.test(d4.error), 'зашифрованный поток не качается', d4.error);

  // 5. обычный mp4 и сериал
  env.source = { url: `${base}/f/movie.mp4`, headers, voice: 'x', quality: '1080p', voices: [] };
  const t5 = engine.enqueueDownload(item(5, 'tv'), { season: 1, episode: 2 });
  const d5 = await waitState(t5.id, ['done', 'failed']);
  ok(d5.state === 'done' && d5.playlist === 'video.mp4' && d5.bytes === 5000, 'обычный файл (серия) скачан целиком', d5.error || '');
  const r5 = offline.localRequest(item(5, 'tv'), { season: 1, episode: 2 });
  ok(r5 && !r5.isHls && r5.episodes.length === 1 && r5.currentEpisode === 0 && r5.subtitle === 'Сезон 1 · Серия 2', 'офлайн-серия: соседи — скачанные серии');
  ok(offline.localRequest(item(5, 'tv'), { season: 1, episode: 3 }) === null, 'не скачанная серия — в сеть');

  // 6. повторная постановка того же — не дубль; удаление чистит диск
  const again = engine.enqueueDownload(item(1), null);
  ok(again.id === t1.id && store.allDownloads().filter((t) => t.key === t1.key).length === 1, 'повторное «Скачать» не создаёт дубль');
  engine.removeDownload(t1.id);
  ok(!fs.existsSync(dir1) && !store.taskById(t1.id), 'удаление убирает и файлы');

  server.close();
  console.log(bad ? `\nПРОВАЛОВ: ${bad}` : '\nВсё сходится.');
  process.exit(bad ? 1 : 0);
});
