/*
 * ПРОВЕРКА VIXSRC БЕЗ СЕТИ — разбор страницы и плейлиста, путь фильма и сериала.
 *
 * Сеть подменяется: fetch отвечает заготовками в двух видах разметки (masterPlaylist прямо в
 * странице и через /api/… → встроенный плеер). Проверяется, что ссылка собирается с токеном,
 * сроком, h=1 и lang=en, что дорожки и качество читаются из плейлиста, а сериал строится по
 * сезонам ТМДБ и спрашивает ссылки только по запросу.
 *
 * Запуск:  node tools/vixsrc-check.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vix-'));
const tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
try {
  execFileSync(process.execPath, [tsc, path.join(root, 'src/api/sources/s_vixsrc.ts'), '--outDir', out, '--rootDir', path.join(root, 'src'),
    '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck', '--lib', 'es2020,dom'], { cwd: out, stdio: 'pipe' });
} catch (e) {
  // Замечания о типах (например, process в tmdb.ts) JS не мешают; провал — только если файла нет.
  if (!fs.existsSync(path.join(out, 'api', 'sources', 's_vixsrc.js'))) {
    console.log((e.stdout || '').toString());
    process.exit(1);
  }
}
process.env.EXPO_PUBLIC_TMDB_API_KEY = 'test';

const PAGE_A = `<script>
    window.video = {"id":1};
    window.masterPlaylist = {
        params: {
            'token': 'abc123',
            'expires': '1999999999',
            'asn': '',
        },
        url: 'https:\\/\\/vixsrc.to\\/playlist\\/77?b=1',
    }
    window.canPlayFHD = true
</script>`;
const PAGE_B = `<script>window.masterPlaylist = { params: { "token": "zz9", "expires": 1888888888 }, url: "/playlist/88" }</script>`;
const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="eng",DEFAULT=YES
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Italian",LANGUAGE="ita"
#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,AUDIO="a"
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1920x1080,AUDIO="a"
1080/index.m3u8`;

const asked = [];
global.fetch = async (url, init) => {
  asked.push({ url, headers: init && init.headers });
  const r = (status, body) => ({ status, ok: status < 300, url, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) });
  if (url.startsWith('https://api.themoviedb.org/3/tv/1418')) return r(200, JSON.stringify({ seasons: [{ season_number: 0, episode_count: 3 }, { season_number: 1, episode_count: 17 }, { season_number: 2, episode_count: 23 }] }));
  if (url.startsWith('https://vixsrc.to/movie/603')) return r(200, PAGE_A);
  if (url.startsWith('https://vixsrc.to/playlist/77')) return r(200, MASTER);
  if (url.startsWith('https://vixsrc.to/tv/1418/')) return r(200, '<html>no player here</html>');
  if (url.startsWith('https://vixsrc.to/api/tv/1418/')) return r(200, JSON.stringify({ src: '/embed/88?x=1' }));
  if (url.startsWith('https://vixsrc.to/embed/88')) return r(200, PAGE_B);
  return r(404, '');
};

const { vixsrc, playlistFrom, describeMaster } = require(path.join(out, 'api', 'sources', 's_vixsrc.js'));

let bad = 0;
const ok = (c, name, extra = '') => {
  console.log(`${c ? 'ok   ' : 'ПРОВАЛ'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!c) bad++;
};

(async () => {
  const a = playlistFrom(PAGE_A);
  ok(a === 'https://vixsrc.to/playlist/77?b=1&token=abc123&expires=1999999999&h=1&lang=en', 'ссылка из страницы (вид А)', a);
  const b = playlistFrom(PAGE_B);
  ok(b === 'https://vixsrc.to/playlist/88?token=zz9&expires=1888888888&lang=en', 'ссылка из встроенного плеера (вид Б)', b);
  ok(playlistFrom('<html></html>') === null, 'без masterPlaylist — null');
  const d = describeMaster(MASTER);
  ok(d.tracks.join(',') === 'English,Italian' && d.quality === 1080, 'дорожки и качество', JSON.stringify(d));

  const signal = new AbortController().signal;
  const movie = await vixsrc.open({ title: 'Матрица', originalTitle: 'The Matrix', year: 1999, imdb: null, kp: null, tmdb: 603, kind: 'movie' }, signal);
  const v = movie && movie.variants[0];
  ok(v && v.voice === 'Оригинал' && v.quality === '1080p' && v.hideTracks && v.url.includes('token=abc123'), 'фильм — один пункт «Оригинал»', v && `${v.voice}, ${v.quality}`);
  ok(v && v.headers.Referer === 'https://vixsrc.to/', 'заголовки потока');

  asked.length = 0;
  const show = await vixsrc.open({ title: 'ТБВ', originalTitle: null, year: 2007, imdb: null, kp: null, tmdb: 1418, kind: 'serial' }, signal);
  ok(show && show.seasons.length === 2 && show.seasons[0].season === 1 && show.seasons[1].episodes.length === 23, 'сериал по сезонам ТМДБ, без нулевого');
  ok(asked.filter((x) => x.url.includes('vixsrc.to')).length <= 3, 'при открытии сериала — только первая серия', `${asked.length} запросов`);
  ok(show.seasons[0].episodes[0].variants[0].url && !show.seasons[0].episodes[0].variants[0].resolve, 'первая серия — готовая ссылка');
  ok(show.seasons[1].episodes[0].variants[0].voice === 'Оригинал' && show.seasons[1].episodes[0].variants[0].hideTracks, 'серия — «Оригинал» без дорожек');
  const later = await show.seasons[1].episodes[4].variants[0].resolve(signal);
  ok(later && later.includes('/playlist/88') && asked.some((x) => x.url.startsWith('https://vixsrc.to/tv/1418/2/5')), 'серия 2×5 по запросу', later);

  const none = await vixsrc.open({ title: 'x', originalTitle: null, year: null, imdb: null, kp: null, tmdb: 999, kind: 'movie' }, signal);
  ok(none === null, 'нет у источника — null');

  console.log(bad ? `\nПРОВАЛОВ: ${bad}` : '\nВсё сходится.');
  process.exit(bad ? 1 : 0);
})();
