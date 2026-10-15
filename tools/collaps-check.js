/*
 * ПРОВЕРКА РАЗБОРА COLLAPS — без сети, по НАСТОЯЩЕМУ коду приложения.
 *
 * Здесь нет копии разбора «как в src»: модуль src/api/collaps компилируется во временную папку и
 * проверяется именно он. Копия проверяла бы саму себя — ровно так в прошлый раз и прошли мимо
 * ошибки, которую нашли только на живой странице.
 *
 * Образцы:
 *   tools/fixtures/collaps-serial.html — НАСТОЯЩИЙ объект серии из живого ответа (tools/collaps-last.json),
 *                                        размноженный до трёх серий в двух сезонах;
 *   tools/fixtures/collaps-movie.html  — страница фильма в разметке makePlayer.
 *
 * Запуск:  node tools/collaps-check.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'collaps-'));

process.stdout.write('собираю модуль… ');
// Запускаем сам tsc, а не обёртку из .bin: обёртка там заточена под ту систему, где ставили
// пакеты, и на другой падает с «node.exe not found». Точка входа у typescript одна и та же везде.
const tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
// Работаем из временной папки и с полными путями: иначе tsc видит рядом tsconfig.json и
// отказывается (TS5112 — «конфиг есть, но при явных файлах он не применяется»).
const src = (f) => path.join(root, 'src', 'api', 'collaps', f);
try {
  execFileSync(
    process.execPath,
    [tsc, src('parse.ts'), src('types.ts'), src('index.ts'), src('net.ts'),
     '--outDir', out, '--rootDir', path.join(root, 'src', 'api'),
     '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { cwd: out, stdio: 'pipe' }
  );
} catch (e) {
  console.log('\nне собралось:\n' + (e.stdout || '').toString());
  process.exit(1);
}
console.log('готово');

// Collaps пишет в журнал каскада (sources/http.ts), поэтому корень сборки — src/api.
const { parsePage } = require(path.join(out, 'collaps', 'parse.js'));
const api = require(path.join(out, 'collaps', 'index.js'));
const read = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

let bad = 0;
const ok = (cond, name, got) => {
  console.log((cond ? '  ok  ' : 'ПРОВАЛ ') + name + (cond || got === undefined ? '' : `  → ${got}`));
  if (!cond) bad++;
};

// ── СЕРИАЛ ───────────────────────────────────────────────────────────────────
const serial = parsePage(read('collaps-serial.html'));
ok(serial && serial.kind === 'serial', 'сериал: распознан', serial && serial.kind);
const seasons = (serial && serial.seasons) || [];
ok(seasons.length === 2, 'сериал: два сезона', seasons.length);
ok(seasons[0] && seasons[0].episodes.length === 2, 'сериал: в первом сезоне две серии');
ok(seasons[0] && seasons[0].season === 1 && seasons[1] && seasons[1].season === 2, 'сериал: сезоны по порядку');

const e1 = seasons[0] && seasons[0].episodes[0];
ok(!!e1 && /master\.m3u8/.test(e1.hls || ''), 'серия: ссылка hls на месте');
ok(!!e1 && e1.voices.length === 4, 'серия: четыре озвучки', e1 && e1.voices.join(', '));
ok(!!e1 && e1.captions.length >= 2, 'серия: субтитры разобраны', e1 && e1.captions.length);
ok(!!e1 && e1.durationSec === 1378, 'серия: длительность', e1 && e1.durationSec);
ok(!!e1 && typeof e1.title === 'string' && e1.title.includes('1 серия'), 'серия: подпись от источника');
ok(!!e1 && e1.dash !== null && e1.dash.includes('.mpd'), 'серия: dash предпочитает dasha');

// Та самая проверка, на которой месяц горела резка.
const files = new Set(seasons.flatMap((s) => s.episodes.map((e) => e.hls)));
const total = seasons.reduce((n, s) => n + s.episodes.length, 0);
ok(files.size === total, `сериал: ${total} серий — ${files.size} РАЗНЫХ файлов`);

// ── ФИЛЬМ ────────────────────────────────────────────────────────────────────
const movie = parsePage(read('collaps-movie.html'));
ok(movie && movie.kind === 'movie', 'фильм: распознан', movie && movie.kind);
ok(!!movie && /master\.m3u8/.test(movie.movie.hls || ''), 'фильм: hls');
ok(!!movie && (movie.movie.dash || '').includes('.mpd'), 'фильм: dash');
ok(!!movie && movie.movie.voices[0] === 'Дубляж', 'фильм: озвучка');
ok(!!movie && movie.movie.voices.length === 2 && movie.movie.voices[1] === 'Eng.Original', 'фильм: все дорожки подписаны', movie && movie.movie.voices.join(', '));
ok(!!movie && movie.movie.captions.length === 2, 'фильм: два субтитровых трека');

// ── ПОИСК СЕРИИ И СОСЕДИ ───────────────────────────────────────────────────
ok(api.findEpisode(seasons, 1, 2) !== null, 'поиск: сезон 1, серия 2 находится');
ok(api.findEpisode(seasons, 2, 1) !== null, 'поиск: сезон 2, серия 1 находится');
ok(api.findEpisode(seasons, 1, 99) === null, 'поиск: несуществующая серия — null, а не первая попавшаяся');
const flat = api.flatEpisodes(seasons);
ok(flat.length === 3, 'порядок: три серии подряд', flat.length);
ok(
  flat[1].season === 1 && flat[1].episode === 2 && flat[2].season === 2 && flat[2].episode === 1,
  'порядок: после последней серии сезона идёт первая следующего'
);

// ── СРОК ГОДНОСТИ ССЫЛКИ ───────────────────────────────────────────────────
const soon = Math.floor(Date.now() / 1000) + 60;        // минута — меньше запаса в пять
const later = Math.floor(Date.now() / 1000) + 3 * 3600; // три часа
ok(api.linkAlive(`https://x/y.m3u8?t=${later}`) === true, 'срок: ссылка на три часа вперёд — живая');
ok(api.linkAlive(`https://x/y.m3u8?t=${soon}`) === false, 'срок: ссылка, протухающая через минуту, — мёртвая');
ok(api.linkAlive('https://x/y.m3u8') === true, 'срок: без метки считаем живой');

// ── МУСОР ────────────────────────────────────────────────────────────────────
ok(parsePage('<html>совершенно пустая страница</html>') === null, 'мусор: честный null');
ok(parsePage('seasons: [не json]\n') === null, 'битый seasons: честный null, а не пустой сериал');
ok(parsePage('makePlayer({ poster: "x" })') === null, 'makePlayer без ссылок: честный null');

fs.rmSync(out, { recursive: true, force: true });
console.log(bad ? `\nпровалов: ${bad}` : '\nвсё сошлось');
process.exit(bad ? 1 : 0);
