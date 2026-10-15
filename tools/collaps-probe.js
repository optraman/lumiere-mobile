/*
 * ПРОВЕРКА COLLAPS — один прогон всей цепочки, от названия до живого файла.
 *
 * Протокол списан с открытого исходника Lampac (Modules/OnlineRUS/Collaps:
 * ModInit.cs, Controller.cs, Model.cs, Services/Invoke.cs).
 *
 * ВАЖНОЕ ПРО ТОКЕН. У Collaps токен нужен ТОЛЬКО их собственному поиску /list. Страница плеера
 * открывается по внешнему идентификатору и никакого токена не спрашивает:
 *
 *     GET {embed}/embed/imdb/{tt…}      ← этим и ходим
 *     GET {embed}/embed/kp/{kinopoisk}
 *     GET {embed}/embed/movie/{их id}   ← только это и даёт их поиск
 *
 * Поэтому поиск по названию здесь делает ТМДБ — у нас уже есть его ключ и уже есть каталог, —
 * а из ТМДБ берётся imdb_id. Токен Collaps при таком пути не нужен вовсе.
 *
 * Три шага:
 *   1. НАЗВАНИЕ → ТМДБ → imdb_id
 *   2. СТРАНИЦА  GET {embed}/embed/imdb/{tt…}   → makePlayer({…}) у фильма, seasons:[…] у сериала
 *   3. ФАЙЛ      HEAD первой ссылки             → жив ли CDN
 *
 * Запуск (на машине с интернетом):
 *     node tools/collaps-probe.js "теория большого взрыва"
 *     node tools/collaps-probe.js --imdb tt0898266
 *     node tools/collaps-probe.js --kp 301
 *     node tools/collaps-probe.js --token            ← отдельно проверить их поиск и токен
 *     node tools/collaps-probe.js "…" --preview       ← ещё и разобрать ленту кадриков для перемотки
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'collaps.config.json'), 'utf8'));

/** Ключ ТМДБ берём из .env проекта — тот же, на котором живёт каталог. */
function tmdbKey() {
  for (const f of ['.env', '.env.local']) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    const m = /EXPO_PUBLIC_TMDB_API_KEY\s*=\s*(.+)/.exec(fs.readFileSync(p, 'utf8'));
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Заголовки переписки — ровно те, что у Lampac в ModInit.headers. */
const talk = () => ({ 'User-Agent': UA, Origin: cfg.origin, Referer: cfg.origin + '/' });

/** Заголовки самого файла — ModInit.headers_stream. */
const stream = () => ({
  'User-Agent': UA,
  Origin: cfg.origin,
  Referer: cfg.origin + '/',
  accept: '*/*',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'cross-site',
});

function ask(url, headers, method = 'GET', hops = 0) {
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method, headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        return resolve(ask(new URL(res.headers.location, url).toString(), headers, method, hops + 1));
      }
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b, url }));
    });
    r.on('error', reject);
    r.end();
  });
}

/** Срез от метки до конца строки — так же, как Rx.Slice у Lampac. */
function sliceTo(html, mark) {
  const at = html.indexOf(mark);
  if (at < 0) return null;
  const end = html.indexOf('\n', at);
  return html.slice(at + mark.length, end < 0 ? html.length : end).trim().replace(/,$/, '');
}

const one = (h, re) => (re.exec(h) || [])[1] || null;

/**
 * ОТЧЁТ В ФАЙЛ.
 *
 * Консоль PowerShell не предназначена для того, чтобы её вывод возили туда-сюда руками: кириллица
 * ломается, длинные строки рвутся, а вставленный обратно текст терминал пытается выполнить.
 * Поэтому всё, что нужно разбирать глазами, кладём в файл рядом.
 */
function save(data) {
  const out = path.join(__dirname, 'collaps-last.json');
  fs.writeFileSync(out, JSON.stringify(data, null, 2), 'utf8');
  console.log(`   отчёт записан: tools/collaps-last.json`);
}

/** Название → ТМДБ → {imdb, тип, год}. */
async function byTitle(title) {
  const key = tmdbKey();
  if (!key) throw new Error('в .env нет EXPO_PUBLIC_TMDB_API_KEY');

  const q = encodeURIComponent(title);
  const res = await ask(
    `https://api.themoviedb.org/3/search/multi?api_key=${key}&language=ru-RU&query=${q}`,
    { 'User-Agent': UA }
  );
  const hits = (JSON.parse(res.body).results || []).filter(
    (r) => r.media_type === 'movie' || r.media_type === 'tv'
  );
  if (!hits.length) throw new Error('ТМДБ ничего не нашёл');

  const top = hits[0];
  const kind = top.media_type;
  const name = top.title || top.name;
  const year = (top.release_date || top.first_air_date || '').slice(0, 4);
  console.log(`   ТМДБ: ${name} (${year}), ${kind === 'tv' ? 'сериал' : 'фильм'}, id=${top.id}`);

  const ext = await ask(
    `https://api.themoviedb.org/3/${kind}/${top.id}/external_ids?api_key=${key}`,
    { 'User-Agent': UA }
  );
  const imdb = JSON.parse(ext.body).imdb_id;
  if (!imdb) throw new Error('у ТМДБ нет imdb_id для этого тайтла');
  return { imdb, name };
}

/** Отдельная проверка их собственного поиска — она же проверка токена. */
async function checkToken() {
  const url = `${cfg.search}/list?token=${cfg.token}&name=matrix`;
  console.log(`ПОИСК COLLAPS  ${cfg.search}/list`);
  const res = await ask(url, talk());
  console.log(`   ответ ${res.status}: ${res.body.slice(0, 200)}`);
  console.log(
    res.status === 200
      ? '\n   Токен живой — можно пользоваться и их поиском.'
      : '\n   Токен не принят. Это НЕ мешает: страница плеера открывается по imdb/kp без токена.'
  );
}

/** Размер WebP/JPEG/PNG прямо из заголовка файла — без единой сторонней библиотеки. */
function imageSize(buf) {
  // WebP: RIFF....WEBP, дальше чанк VP8 / VP8L / VP8X — у каждого размер лежит по-своему.
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  if (buf.length > 24 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

function raw(url, headers) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        const parts = [];
        res.on('data', (d) => parts.push(d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      })
      .on('error', reject);
  });
}

/**
 * ЧТО ВНУТРИ ЛЕНТЫ КАДРИКОВ.
 *
 * Чтобы показывать кадры при перемотке, нужны три числа: размер одного кадрика, сколько их в
 * картинке и сколько секунд между соседними. Источник отдаёт только адрес. Поэтому качаем первые
 * картинки, смотрим их настоящий размер и перебираем сетки, при которых кадрик выходит близко к
 * 16:9 — это и есть кандидаты.
 *
 * ОТЧЁТ ВОЗВРАЩАЕТСЯ ВСЕГДА, даже когда ничего не вышло. Пустой результат «ничего не нашлось»
 * неотличим от «проверку не запускали», а это совершенно разные беды, и чинят их по-разному.
 */
async function previewProbe(tpl, durationSec) {
  const report = { requested: true, template: tpl || null, attempts: [], w: null, h: null, grids: [] };
  console.log('\nЛЕНТА КАДРИКОВ');
  if (!tpl) {
    report.note = 'в ответе нет шаблона preview.src';
    console.log('   ' + report.note);
    return report;
  }
  console.log(`   шаблон: ${tpl.replace(/\?.*$/, '?…')}`);

  for (let n = 0; n < 4; n++) {
    const url = tpl.replace('${spriteNum}', String(n));
    let res;
    try {
      res = await raw(url, stream());
    } catch (e) {
      report.attempts.push({ n, error: String(e && e.message) });
      console.log(`   картинка ${n}: сорвалось — ${e && e.message}`);
      break;
    }
    const head = res.body.slice(0, 16).toString('hex');
    const size = imageSize(res.body);
    const got = {
      n,
      status: res.status,
      type: res.headers['content-type'] || null,
      bytes: res.body.length,
      head,
      size,
      // Если это не картинка, а страница с отказом, её первые строки скажут больше, чем байты.
      text: res.body.length < 2000 ? res.body.toString('utf8').slice(0, 300) : null,
    };
    report.attempts.push(got);
    console.log(
      `   картинка ${n}: ответ ${res.status}, ${res.body.length} байт, ${got.type || 'тип не указан'}, ` +
        (size ? `${size.w}×${size.h}` : `размер не прочитался (начало: ${head})`)
    );
    if (res.status !== 200 || !size) break;
    if (!report.w) {
      report.w = size.w;
      report.h = size.h;
    }
  }

  const ok = report.attempts.filter((a) => a.size);
  if (!report.w) {
    report.note = 'ни одной читаемой картинки';
    return report;
  }

  const { w, h } = report;
  for (let cols = 1; cols <= 20; cols++) {
    if (w % cols) continue;
    for (let rows = 1; rows <= 20; rows++) {
      if (h % rows) continue;
      const tw = w / cols;
      const th = h / rows;
      const ratio = tw / th;
      if (ratio > 1.6 && ratio < 1.85 && tw >= 80) report.grids.push({ cols, rows, tw, th, tiles: cols * rows });
    }
  }
  console.log('   подходящие сетки (кадрик близок к 16:9):');
  for (const g of report.grids.slice(0, 8)) {
    const total = g.tiles * ok.length;
    const step = durationSec ? (durationSec / total).toFixed(1) : '?';
    console.log(`     ${g.cols}×${g.rows} = ${g.tiles} по ${g.tw}×${g.th} → всего ${total}, шаг ≈ ${step} с`);
  }
  if (!report.grids.length) console.log('     ни одной — кадрик не 16:9, надо смотреть картинку глазами');
  report.spritesRead = ok.length;
  return report;
}

async function main() {
  const all = process.argv.slice(2);
  // Флаги НЕ ЧАСТЬ НАЗВАНИЯ. Склеенные с ним, они уезжали в поиск ТМДБ, тот честно ничего не
  // находил, и прогон обрывался на первом шаге — ещё до того, что мы собрались проверять.
  const flags = all.filter((a) => a.startsWith('--'));
  const argv = all.filter((a) => !a.startsWith('--'));
  const wants = (f) => flags.includes(f);

  if (wants('--token')) return checkToken();

  let embedUrl;
  if (wants('--imdb')) embedUrl = `${cfg.embed}/embed/imdb/${argv[0]}`;
  else if (wants('--kp')) embedUrl = `${cfg.embed}/embed/kp/${argv[0]}`;
  else {
    const title = argv.join(' ') || 'матрица';
    console.log(`1. НАЗВАНИЕ «${title}»`);
    const { imdb } = await byTitle(title);
    console.log(`   imdb_id: ${imdb}`);
    embedUrl = `${cfg.embed}/embed/imdb/${imdb}`;
  }

  console.log(`\n2. СТРАНИЦА ПЛЕЕРА  ${embedUrl}`);
  const page = await ask(embedUrl, talk());
  console.log(`   ответ ${page.status}, ${page.body.length} байт`);
  if (page.status !== 200) {
    console.log('   тело:', page.body.slice(0, 300));
    return;
  }

  let first = null;

  if (page.body.includes('seasons:')) {
    console.log('   это СЕРИАЛ');
    let seasons;
    try {
      seasons = JSON.parse(sliceTo(page.body, 'seasons:'));
    } catch {
      console.log('   seasons не разобрался:', String(sliceTo(page.body, 'seasons:')).slice(0, 200));
      return;
    }
    seasons.sort((a, b) => a.season - b.season);
    console.log(`   сезонов ${seasons.length}`);
    for (const s of seasons) {
      const eps = s.episodes || [];
      const names = new Set();
      eps.forEach((e) => (e.audio?.names || []).forEach((n) => names.add(n)));
      console.log(
        `   сезон ${s.season}: серий ${eps.length}, озвучек ${names.size}` +
          (names.size ? ` (${[...names].slice(0, 4).join(', ')})` : '')
      );
    }
    const all = seasons.flatMap((s) => (s.episodes || []).map((e) => e.hls || e.dasha || e.dash));
    const uniq = new Set(all.filter(Boolean));
    console.log(`   серий всего ${all.length}, разных файлов ${uniq.size}` +
      (all.length && uniq.size < all.length ? '  ← ВНИМАНИЕ: повторы' : ''));
    const e1 = seasons[0].episodes[0];
    console.log(`   субтитров у 1-й серии: ${(e1.cc || []).length}`);
    // Самое важное для будущего источника: ОДИН файл на серию с дорожками внутри или
    // по файлу на озвучку. Отсюда зависит, чем станет меню «Озвучка» в плеере.
    const preview = wants('--preview')
      ? await previewProbe(e1.preview && e1.preview.src, e1.duration)
      : { requested: false, note: 'запускали без --preview' };
    save({ kind: 'serial', seasons: seasons.length, episodes: all.length, uniqueFiles: uniq.size, firstEpisode: e1, preview });
    first = e1.hls || e1.dasha || e1.dash;
  } else if (page.body.includes('makePlayer({')) {
    console.log('   это ФИЛЬМ');
    const tail = page.body.slice(page.body.indexOf('makePlayer({'));
    const hls = one(tail, /hls: +"(https?:\/\/[^"]+\.m3u[^"]+)"/);
    const dash = one(tail, /dasha?: +"(https?:\/\/[^"]+\.mp[^"]+)"/);
    const voice = one(tail, /audio: +\{"names":\["([^"]+)"/);
    const cc = sliceTo(tail, 'cc:');
    save({ kind: 'movie', voice, hls, dash, cc: cc && cc.startsWith('[') ? cc : null });
    console.log(`   озвучка: ${voice || '—'}`);
    console.log(`   hls:  ${hls || '—'}`);
    console.log(`   dash: ${dash || '—'}`);
    console.log(`   cc:   ${cc && cc.startsWith('[') ? cc.slice(0, 160) : '—'}`);
    first = hls || dash;
  } else {
    console.log('   ни makePlayer, ни seasons — страница не та, что ждёт Lampac');
    console.log('   первые 400 символов:', page.body.slice(0, 400).replace(/\s+/g, ' '));
    return;
  }

  if (!first) {
    console.log('\n   Ссылки на файл нет — дальше проверять нечего.');
    return;
  }

  console.log(`\n3. ФАЙЛ  …${first.slice(-70)}`);
  const head = await ask(first, stream(), 'HEAD');
  console.log(`   ответ ${head.status}  тип ${head.headers['content-type'] || '—'}`);
  console.log(
    head.status === 200
      ? '\n   ГОДИТСЯ: ссылка живая, можно писать источник.'
      : `\n   CDN не пустил. Проверить Origin и Referer — должны быть ${cfg.origin}`
  );
}

main().catch((e) => console.error('сорвалось:', e.message));
