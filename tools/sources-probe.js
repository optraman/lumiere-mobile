/*
 * ПРОВЕРКА ВСЕХ ИСТОЧНИКОВ ОДНИМ ПРОГОНОМ — по НАСТОЯЩЕМУ коду приложения.
 *
 * Компилирует src/api/sources во временную папку и прогоняет ту же проверку, что «Проверить
 * источники» в настройках (src/api/sources/check.ts): каждый источник — от поиска до первого
 * куска видео, с теми же заголовками, что у плеера. Для каждого звена пишется, куда ходили и что
 * ответили, — без ключей в адресах.
 *
 * Запуск (на машине с интернетом):   node tools/sources-probe.js
 *                                    node tools/sources-probe.js "Обсессия"            ← один тайтл
 *                                    node tools/sources-probe.js "Обсессия" --s 1 --e 3
 * Отчёт:                              tools/sources-report.json (его я прочитаю сам)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sources-'));

function tmdbKey() {
  for (const f of ['.env', '.env.local']) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    const m = /EXPO_PUBLIC_TMDB_API_KEY\s*=\s*(.+)/.exec(fs.readFileSync(p, 'utf8'));
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

// Английским источникам нужен список серий у ТМДБ — модуль tmdb.ts берёт ключ из окружения, как в приложении.
if (!process.env.EXPO_PUBLIC_TMDB_API_KEY && tmdbKey()) process.env.EXPO_PUBLIC_TMDB_API_KEY = tmdbKey();

process.stdout.write('собираю источники… ');
const tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
try {
  execFileSync(
    process.execPath,
    [tsc, path.join(root, 'src/api/sources/check.ts'), '--outDir', out, '--rootDir', path.join(root, 'src'),
     '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck', '--lib', 'es2020,dom'],
    { cwd: out, stdio: 'pipe' },
  );
} catch (e) {
  // Замечания о типах (например, process в tmdb.ts) JS не мешают; провал — только если файла нет.
  if (!fs.existsSync(path.join(out, 'api', 'sources', 'check.js'))) {
    console.log('\nне собралось:\n' + (e.stdout || '').toString());
    process.exit(1);
  }
}
console.log('готово');
const { checkTitle, verdict } = require(path.join(out, 'api', 'sources', 'check.js'));

/** На чём проверяем: сериал и фильм, оба широко известные, плюс свежий сериал. */
const TITLES = [
  { tmdb: 1418, type: 'tv', title: 'Теория большого взрыва', originalTitle: 'The Big Bang Theory', year: 2007, s: 1, e: 1 },
  { tmdb: 603, type: 'movie', title: 'Матрица', originalTitle: 'The Matrix', year: 1999 },
  { tmdb: 1399, type: 'tv', title: 'Игра престолов', originalTitle: 'Game of Thrones', year: 2011, s: 1, e: 1 },
];

async function imdbOf(t) {
  const key = tmdbKey();
  if (!key) return null;
  try {
    const r = await fetch(`https://api.themoviedb.org/3/${t.type}/${t.tmdb}/external_ids?api_key=${key}`);
    const j = await r.json();
    return j.imdb_id || null;
  } catch {
    return null;
  }
}

/** Тайтл по названию — через поиск ТМДБ, как его найдёт и приложение. */
async function fromTmdb(query, season, episode) {
  const key = tmdbKey();
  if (!key) throw new Error('в .env нет EXPO_PUBLIC_TMDB_API_KEY');
  const r = await fetch(
    `https://api.themoviedb.org/3/search/multi?api_key=${key}&language=ru-RU&query=${encodeURIComponent(query)}`,
  );
  const hit = ((await r.json()).results || []).find((x) => x.media_type === 'movie' || x.media_type === 'tv');
  if (!hit) throw new Error('ТМДБ не нашёл');
  const type = hit.media_type;
  return {
    tmdb: hit.id,
    type,
    title: hit.title || hit.name,
    originalTitle: hit.original_title || hit.original_name || null,
    year: Number((hit.release_date || hit.first_air_date || '').slice(0, 4)) || null,
    s: season,
    e: episode,
  };
}

(async () => {
  const argv = process.argv.slice(2);
  const flag = (n, d) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d;
  };
  const words = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  const list = words.length ? [await fromTmdb(words.join(' '), flag('--s', 1), flag('--e', 1))] : TITLES;

  const report = { at: new Date().toISOString(), titles: [] };
  for (const t of list) {
    const imdb = await imdbOf(t);
    console.log(`\n■ ${t.title} (${t.year})  imdb=${imdb || '—'}${t.type === 'tv' ? `  · проверяю сезон ${t.s} серию ${t.e}` : ''}`);
    const ctrl = new AbortController();
    const target = t.type === 'tv' ? { season: t.s, episode: t.e } : null;
    const c = await checkTitle(
      { title: t.title, originalTitle: t.originalTitle, year: t.year, imdb, kp: null, tmdb: t.tmdb, kind: t.type === 'movie' ? 'movie' : 'serial' },
      target,
      ctrl.signal,
    );
    console.log(`   номер Кинопоиска: ${c.kp ?? 'не найден'}`);
    const step = (x) => `        ${x.at} → ${x.status} · ${x.ms} мс${x.hint ? ` · ${x.hint}` : ''}`;
    if (!c.kp) c.kpSteps.forEach((x) => console.log(step(x)));
    const rows = c.sources;
    for (const r of rows) {
      const v = verdict(r);
      console.log(`${v.startsWith('работает') ? ' ✔ ' : '  —'} ${r.name.padEnd(12)} ${v}`);
      if (!v.startsWith('работает')) {
        [...r.steps, ...(r.linkSteps || []), ...((r.stream && r.stream.steps) || [])].forEach((x) => console.log(step(x)));
      }
    }
    ctrl.abort();
    report.titles.push({ title: t.title, imdb, kp: c.kp, kpSteps: c.kpSteps, rows });
  }
  fs.writeFileSync(path.join(__dirname, 'sources-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\nотчёт: tools/sources-report.json');
  fs.rmSync(out, { recursive: true, force: true });
  process.exit(0);
})();
