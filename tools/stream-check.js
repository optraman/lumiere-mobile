/*
 * ПРОВЕРКА «ПРОЙТИ ПОТОК, КАК ПЛЕЕР» (src/api/sources/check.ts) — на своём маленьком сервере.
 *
 * Сервер изображает раздачу: главный плейлист → плейлист качества (относительная ссылка) →
 * кусок видео, который отдаётся только с нужным Origin. Проверяется, что звенья проходятся
 * по порядку, относительные ссылки разрешаются верно, а обрыв называется своим звеном.
 *
 * Запуск:  node tools/stream-check.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-'));
const tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
try {
  execFileSync(process.execPath, [tsc, path.join(root, 'src/api/sources/check.ts'), '--outDir', out, '--rootDir', path.join(root, 'src'),
    '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck', '--lib', 'es2020,dom'], { cwd: out, stdio: 'pipe' });
} catch (e) {
  // Замечания о типах (например, process в tmdb.ts) JS не мешают; провал — только если файла нет.
  if (!fs.existsSync(path.join(out, 'api', 'sources', 'check.js'))) {
    console.log((e.stdout || '').toString());
    process.exit(1);
  }
}
const { checkStream, resolveUri } = require(path.join(out, 'api', 'sources', 'check.js'));

let bad = 0;
const ok = (c, name, extra = '') => {
  console.log(`${c ? 'ok   ' : 'ПРОВАЛ'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!c) bad++;
};

const server = http.createServer((req, res) => {
  const good = req.headers.origin === 'https://player.example';
  const u = req.url;
  if (u.startsWith('/v/master.m3u8')) {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhd/index.m3u8?t=1\n');
  }
  if (u.startsWith('/v/hd/index.m3u8')) {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return res.end('#EXTM3U\n#EXTINF:4,\n/seg/1.ts\n');
  }
  if (u.startsWith('/seg/1.ts')) {
    res.writeHead(good ? 206 : 403, { 'content-type': 'video/mp2t' });
    return res.end(good ? Buffer.alloc(1024) : 'forbidden');
  }
  if (u.startsWith('/broken.m3u8')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html>заглушка</html>');
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const signal = new AbortController().signal;

  ok(resolveUri('hd/a.m3u8?x=1', 'https://h.io/v/master.m3u8?t=2') === 'https://h.io/v/hd/a.m3u8?x=1', 'относительная ссылка');
  ok(resolveUri('/s/1.ts', 'https://h.io/v/a.m3u8') === 'https://h.io/s/1.ts', 'ссылка от корня');
  ok(resolveUri('//cdn.io/1.ts', 'https://h.io/v/a.m3u8') === 'https://cdn.io/1.ts', 'ссылка без схемы');

  const good = await checkStream(`${base}/v/master.m3u8`, { Origin: 'https://player.example' }, signal);
  ok(good.ok && good.steps.length === 3, 'с нужными заголовками — до куска видео', good.steps.map((s) => s.status).join(' → '));

  const noOrigin = await checkStream(`${base}/v/master.m3u8`, {}, signal);
  ok(!noOrigin.ok && noOrigin.broke === 'кусок видео', 'без Origin — обрыв на куске видео', `${noOrigin.broke}, ${noOrigin.steps.at(-1).status}`);

  const stub = await checkStream(`${base}/broken.m3u8`, {}, signal);
  ok(!stub.ok && stub.broke === 'плейлист', 'заглушка вместо плейлиста', stub.steps[0].hint);

  const gone = await checkStream(`${base}/nope.m3u8`, {}, signal);
  ok(!gone.ok && gone.steps[0].status === 404, '404 на плейлисте');

  server.close();
  console.log(bad ? `\nПРОВАЛОВ: ${bad}` : '\nВсё сходится.');
  process.exit(bad ? 1 : 0);
});
