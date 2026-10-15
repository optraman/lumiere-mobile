/*
 * ПРОВЕРКА КАСКАДА — быстрый старт и фоновый допоиск, без сети.
 *
 * Компилирует src/api/sources/playback.ts и index.ts, подменяет источники макетами с заданными
 * задержками и ответами и проверяет: старт с первого годного не ждёт остальных; без годного —
 * лучший из ответивших после короткого ожидания; опоздавшие дописываются в меню и запас;
 * «Очистить историю» заставляет искать заново.
 *
 * Запуск:  node tools/cascade-check.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-'));
const tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
try {
  execFileSync(
    process.execPath,
    [tsc, path.join(root, 'src/api/sources/playback.ts'), '--outDir', out, '--rootDir', path.join(root, 'src'),
      '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck', '--esModuleInterop', '--jsx', 'react-native'],
    { cwd: out, stdio: 'pipe' },
  );
} catch {
  /* ошибки типов в зависимостях не мешают: нужен только выпущенный JS */
}

// ── макеты
const scenario = { byName: {} };
const opens = {};
const stubs = {
  tmdb: { imdbId: async () => 'tt0000001' },
  watchProgress: {
    titleKey: (t, id) => `${t}:${id}`,
    episodeKey: (t, id, s, e) => `${t}:${id}:${s}:${e}`,
    resumePositionFor: () => 0,
  },
  ids: { kinopoiskId: async () => null, setKpStore: () => undefined },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const base = path.basename(request);
  if (base === 'tmdb') return stubs.tmdb;
  if (base === 'watchProgress') return stubs.watchProgress;
  if (base === 'journal') return { say: (...a) => console.log(...a) };
  if (base === 'offline') return { localRequest: () => null };
  if (base === 'async-storage') return { __esModule: true, default: { getItem: async () => null, setItem: async () => undefined } };
  if (base === 'ids' && parent && parent.filename.includes(`${path.sep}sources${path.sep}`)) return stubs.ids;
  return origLoad.apply(this, arguments);
};

const T0 = { t: 0 };
const now = () => Date.now() - T0.t;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function src(id, { ms, quality, voices, original, failResolve = false, serial = false }) {
  const variants = voices.map((v, i) => ({
    voice: i === 0 && original ? 'Оригинал' : v,
    quality: `${quality}p`,
    resolve: async () => (failResolve ? null : `https://${id}/${encodeURIComponent(v)}.m3u8`),
    headers: {},
  }));
  return {
    id, name: id.toUpperCase(), movie: !serial, serial, needs: ['imdb'], typical: quality,
    open: async () => {
      opens[id] = (opens[id] ?? 0) + 1;
      await sleep(ms);
      return serial
        ? { kind: 'serial', seasons: [{ season: 1, episodes: [1, 2].map((e) => ({ episode: e, title: null, variants })) }] }
        : { kind: 'movie', variants };
    },
  };
}

// Список SOURCES в index.ts — фиксированный набор имён; подставляем макеты под эти имена.
const NAMES = ['vixsrc', 'lumex', 'kodik', 'collaps', 'obrut', 'gencit', 'rudub', 'cdnvideohub'];
function setScenario(list) {
  scenario.byName = {};
  const byId = Object.fromEntries(list.map((x) => [x.id, x]));
  NAMES.forEach((n) => {
    scenario.byName[n] = byId[n] ?? { id: n, name: n, movie: true, serial: true, needs: ['imdb'], typical: 0, open: async () => null };
  });
}
// Модуль index.ts читает источники один раз при загрузке — значит макеты должны быть «живыми».
function live(i) {
  return new Proxy({}, { get: (_, k) => (scenario.byName[NAMES[i]] ?? {})[k] });
}
const liveNames = {};
NAMES.forEach((n, i) => (liveNames[n] = live(i)));
const origLoad2 = Module._load;
Module._load = function (request) {
  const base = path.basename(request);
  if (/^s_/.test(base)) return liveNames;
  return origLoad2.apply(this, arguments);
};

// В приложении три источника (Collaps, CDNVideoHub, VixSrc), а проверять надо логику выбора между многими:
// список источников подменяется макетами ДО загрузки playback (он читает порядок при загрузке).
const idx = require(path.join(out, 'api/sources/index.js'));
idx.SOURCES.length = 0;
NAMES.forEach((n) => idx.SOURCES.push(liveNames[n]));
const pb = require(path.join(out, 'api/sources/playback.js'));
const item = (id, type = 'movie') => ({ id, type, title: `T${id}`, originalTitle: '', year: '2020', posterUrl: null, backdropUrl: null });

let bad = 0;
const ok = (c, name, extra = '') => {
  console.log(`${c ? 'ok   ' : 'ПРОВАЛ'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!c) bad++;
};
const quiet = console.log;
const logs = [];
console.log = (...a) => (String(a[0]).startsWith('ЛЮМЬЕР') ? logs.push(a.join(' ')) : quiet(...a));

(async () => {
  // 1. Годный отвечает быстро, лучший — медленно: старт не ждёт медленного.
  // (Общая логика проверяется на нейтральных именах: у Collaps — своё правило основного, тесты 7–11.)
  setScenario([
    src('obrut', { ms: 3000, quality: 1080, voices: ['a', 'b', 'c', 'd', 'e'], original: true }),
    src('lumex', { ms: 200, quality: 1080, voices: ['x', 'y', 'z'], original: true }),
    src('kodik', { ms: 100, quality: 720, voices: ['k1', 'k2', 'k3', 'k4'], original: false }),
  ]);
  T0.t = Date.now();
  const r1 = await pb.movieRequest(item(1));
  ok(r1 && r1.sourceId === 'lumex', 'годный стартует сразу', `${r1?.sourceId} за ${now()} мс`);
  ok(now() < 800, 'без долгого ожидания', `${now()} мс`);
  let pushed = null;
  const off = pb.watchChoices(r1.mediaKey, (c) => (pushed = c));
  await sleep(3200);
  off();
  ok(pushed && pushed.some((c) => c.source === 'OBRUT'), 'опоздавший дописан в меню', pushed ? `${pushed.length} пунктов` : 'нет');
  const idx = pushed.map((c) => c.index);
  ok(new Set(idx).size === idx.length && idx.includes(r1.choice), 'номера пунктов постоянны и уникальны');
  ok(pushed[0].source === 'OBRUT', 'лучший опоздавший — выше в меню');
  const fb = await pb.nextFallback(r1);
  ok(fb && fb.sourceId === 'obrut', 'запас: сначала лучший из опоздавших', fb?.sourceId);

  // 2. Годного нет: лучший из ответивших после короткого ожидания, медленный не ждём.
  setScenario([
    src('obrut', { ms: 6000, quality: 1080, voices: ['a', 'b', 'c'], original: true }),
    src('lumex', { ms: 900, quality: 1080, voices: ['x', 'y'], original: false }),
    src('kodik', { ms: 100, quality: 720, voices: ['k1', 'k2'], original: false }),
  ]);
  T0.t = Date.now();
  const r2 = await pb.movieRequest(item(2));
  ok(r2 && r2.sourceId === 'lumex', 'без годного — лучший из успевших', r2?.sourceId);
  ok(now() >= 2400 && now() < 3500, 'ожидание короткое', `${now()} мс`);

  // 3. Годный не дал ни одной ссылки — ждём следующего ответившего, а не «не нашлось».
  setScenario([
    src('lumex', { ms: 100, quality: 1080, voices: ['a', 'b', 'c'], original: true, failResolve: true }),
    src('kodik', { ms: 1500, quality: 720, voices: ['x'], original: false }),
  ]);
  T0.t = Date.now();
  const r3 = await pb.movieRequest(item(3));
  ok(r3 && r3.sourceId === 'kodik', 'годный без ссылок — следующий', `${r3?.sourceId} за ${now()} мс`);

  // 4. Никто не нашёл — null, без зависания.
  setScenario([src('lumex', { ms: 100, quality: 1080, voices: [], original: false })]);
  const r4 = await pb.movieRequest(item(4));
  ok(r4 === null, 'никто не нашёл — null');

  // 5. Сериал: следующая серия у того же источника — сразу, без ожидания.
  setScenario([
    src('lumex', { ms: 300, quality: 720, voices: ['a'], original: false, serial: true }),
    src('kodik', { ms: 1200, quality: 720, voices: ['b'], original: false, serial: true }),
  ]);
  const show = item(5, 'tv');
  const e1 = await pb.episodeRequest(show, 1, 1);
  T0.t = Date.now();
  const e2 = await pb.changeEpisode(e1, 1, 2);
  ok(e2 && e2.sourceId === e1.sourceId && now() < 100, 'следующая серия — тот же источник, сразу', `${e2?.sourceId} за ${now()} мс`);
  const list = await pb.openFor(show);
  ok(list && list.kind === 'serial' && list.seasons[0].episodes.length === 2, 'список серий');

  // 6. «Очистить историю»: следующий просмотр спрашивает источники заново.
  setScenario([src('lumex', { ms: 50, quality: 1080, voices: ['a', 'b', 'c'], original: true })]);
  await pb.movieRequest(item(6));
  const before = opens.lumex;
  await pb.movieRequest(item(6));
  ok(opens.lumex === before, 'без очистки — поиск не повторяется');
  pb.forgetAllSources();
  await pb.movieRequest(item(6));
  ok(opens.lumex === before + 1, 'после очистки — поиск заново');

  // 7. COLLAPS — ОСНОВНОЙ: CDNVideoHub ответил раньше и «идеально», но старт ждёт Collaps.
  setScenario([
    src('cdnvideohub', { ms: 100, quality: 1080, voices: ['a', 'b', 'c', 'd'], original: true }),
    src('collaps', { ms: 1500, quality: 1080, voices: ['Оригинал', 'Дубляж'], original: true }),
  ]);
  T0.t = Date.now();
  const r7 = await pb.movieRequest(item(7));
  ok(r7 && r7.sourceId === 'collaps', 'Collaps — основной, его ждут', `${r7?.sourceId} за ${now()} мс`);
  ok(r7 && r7.choices.some((c) => c.source === 'CDNVIDEOHUB'), 'голоса CDNVideoHub — в меню рядом');

  // 8. Collaps не нашёл тайтл — сразу CDNVideoHub, без долгого ожидания.
  setScenario([
    src('cdnvideohub', { ms: 100, quality: 1080, voices: ['LostFilm', 'Кубик'], original: false }),
    src('collaps', { ms: 300, quality: 1080, voices: [], original: false }),
  ]);
  T0.t = Date.now();
  const r8 = await pb.movieRequest(item(8));
  ok(r8 && r8.sourceId === 'cdnvideohub', 'Collaps не нашёл — CDNVideoHub', `${r8?.sourceId} за ${now()} мс`);
  ok(now() < 3500, 'без ожидания основного', `${now()} мс`);

  // 9. Collaps ответил, но не дал ни одной ссылки — CDNVideoHub.
  setScenario([
    src('cdnvideohub', { ms: 100, quality: 1080, voices: ['LostFilm'], original: false }),
    src('collaps', { ms: 300, quality: 1080, voices: ['Оригинал', 'Дубляж'], original: true, failResolve: true }),
  ]);
  const r9 = await pb.movieRequest(item(9));
  ok(r9 && r9.sourceId === 'cdnvideohub', 'Collaps без ссылок — CDNVideoHub', r9?.sourceId);

  // 10. Collaps молчит (завис) — ждём его не дольше 8 с, потом CDNVideoHub; VixSrc — только в меню.
  const vix = src('vixsrc', { ms: 150, quality: 1080, voices: ['Оригинал'], original: false });
  vix.open = ((open) => async (...a) => {
    const f = await open(...a);
    f.variants.forEach((x) => (x.hideTracks = true));
    return f;
  })(vix.open);
  setScenario([
    vix,
    src('cdnvideohub', { ms: 400, quality: 1080, voices: ['LostFilm', 'HDrezka'], original: false }),
    src('collaps', { ms: 30000, quality: 1080, voices: ['Оригинал'], original: true }),
  ]);
  T0.t = Date.now();
  const r10 = await pb.movieRequest(item(10));
  ok(r10 && r10.sourceId === 'cdnvideohub', 'Collaps молчит — CDNVideoHub, не VixSrc', `${r10?.sourceId} за ${now()} мс`);
  ok(now() >= 7900 && now() < 8600, 'основного ждут не дольше 8 с, и сразу дальше', `${now()} мс`);
  ok(r10 && r10.choices.some((c) => c.voice === 'Оригинал'), 'Оригинал VixSrc — в меню');

  // 11. Сериал: следующая серия — тот же Collaps, сразу (поиск один на тайтл).
  setScenario([
    src('cdnvideohub', { ms: 100, quality: 1080, voices: ['LostFilm', 'Кубик'], original: false, serial: true }),
    src('collaps', { ms: 800, quality: 1080, voices: ['Оригинал', 'Дубляж'], original: true, serial: true }),
  ]);
  const s11 = item(11, 'tv');
  const e11 = await pb.episodeRequest(s11, 1, 1);
  ok(e11 && e11.sourceId === 'collaps', 'сериал: Collaps — основной', e11?.sourceId);
  T0.t = Date.now();
  const e11b = await pb.changeEpisode(e11, 1, 2);
  ok(e11b && e11b.sourceId === 'collaps' && now() < 200, 'следующая серия — Collaps, сразу', `${e11b?.sourceId} за ${now()} мс`);

  // 11b. Collaps знает фильм только по Кинопоиску: номер ищется дольше старта — Collaps его дожидается.
  stubs.ids.kinopoiskId = async () => {
    await sleep(700);
    return 42;
  };
  const kpOnly = src('collaps', { ms: 200, quality: 1080, voices: ['Оригинал', 'Дубляж'], original: true });
  kpOnly.open = ((open) => async (ids, sig) => ((await ids.kpLater?.()) === 42 ? open(ids, sig) : null))(kpOnly.open);
  setScenario([kpOnly, src('cdnvideohub', { ms: 100, quality: 1080, voices: ['LostFilm'], original: false })]);
  const r11k = await pb.movieRequest(item(111));
  ok(r11k && r11k.sourceId === 'collaps', 'Collaps по номеру Кинопоиска — дождался номера', r11k?.sourceId);
  stubs.ids.kinopoiskId = async () => null;

  // 12. Сериал без Collaps: одноголосый RuDub отвечает первым, CDNVideoHub с выбором — позже: играет CDNVideoHub.
  setScenario([
    src('rudub', { ms: 100, quality: 1080, voices: ['RuDub'], original: false, serial: true }),
    src('cdnvideohub', { ms: 4000, quality: 1080, voices: ['LostFilm', 'Кубик', 'NewStudio'], original: false, serial: true }),
  ]);
  T0.t = Date.now();
  const r12 = await pb.episodeRequest(item(12, 'tv'), 1, 1);
  ok(r12 && r12.sourceId === 'cdnvideohub', 'одноголосый RuDub не перехватывает', `${r12?.sourceId} за ${now()} мс`);
  ok(r12 && r12.choices[r12.choices.length - 1].voice === 'RuDub', 'RuDub — последним в меню');

  // 13. Кроме RuDub никого — играет он, но не позже WEAK_WAIT_MS.
  setScenario([
    src('rudub', { ms: 100, quality: 1080, voices: ['RuDub'], original: false, serial: true }),
    src('kodik', { ms: 15000, quality: 720, voices: ['a', 'b'], original: false, serial: true }),
  ]);
  T0.t = Date.now();
  const r13 = await pb.episodeRequest(item(13, 'tv'), 1, 1);
  ok(r13 && r13.sourceId === 'rudub' && now() < 9000, 'только RuDub — через ожидание', `${r13?.sourceId} за ${now()} мс`);

  quiet('\nЖурнал выбора:\n  ' + logs.slice(0, 8).join('\n  '));
  quiet(bad ? `\nПРОВАЛОВ: ${bad}` : '\nВсё сходится.');
  process.exit(bad ? 1 : 0);
})();
