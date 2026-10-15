/*
 * ПРОВЕРКА СКЛЕЙКИ ЗАГРУЗОК В MP4 (src/downloads/remux.ts) — без телефона и без сети.
 *
 * В tools/fixtures/remux лежат куски, нарезанные ffmpeg из шестисекундной пробы (160×90, 25 к/с,
 * H.264 с B-кадрами + AAC 44.1 кГц): 150 кадров картинки и 260 кадров звука. Три случая, что
 * встречаются у раздач: TS со звуком внутри; fMP4 с отдельной звуковой дорожкой; TS-картинка +
 * голый AAC. Каждый склеивается, а итог разбирается обратно: оглавление на месте, размер данных
 * сходится с файлом, в каждой дорожке ровно столько кадров, сколько в пробе, длительность — 6 с.
 *
 * (На машине с ffmpeg я дополнительно декодировал каждый итог целиком: ошибок нет, кадров столько же.)
 *
 * Запуск:  node tools/remux-check.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'remux-'));
const tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
try {
  execFileSync(process.execPath, [tsc, path.join(root, 'src/downloads/remux.ts'), '--outDir', out, '--module', 'commonjs',
    '--target', 'es2020', '--skipLibCheck', '--lib', 'es2020,dom'], { cwd: out, stdio: 'pipe' });
} catch {
  /* замечания о типах не мешают */
}
const { remux } = require(path.join(out, 'remux.js'));
const fx = path.join(__dirname, 'fixtures', 'remux');

function input(dir, ext) {
  const d = path.join(fx, dir);
  const names = fs.readdirSync(d).filter((f) => f.endsWith(ext) && f !== 'init.mp4').sort();
  const init = fs.existsSync(path.join(d, 'init.mp4'));
  return {
    init: init ? async () => new Uint8Array(fs.readFileSync(path.join(d, 'init.mp4'))) : undefined,
    pieces: names.length,
    read: async (i) => new Uint8Array(fs.readFileSync(path.join(d, names[i]))),
  };
}

function boxes(buf, from, to) {
  const list = [];
  let o = from;
  while (o + 8 <= to) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    let body = o + 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(o + 8));
      body = o + 16;
    }
    list.push({ type, start: o, body, end: o + size });
    o += size;
  }
  return list;
}
const find = (buf, b, type) => boxes(buf, b.body, b.end).find((x) => x.type === type);

let fail = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${text}`);
  if (!ok) fail++;
};

(async () => {
  const cases = [
    ['TS со звуком внутри', [['ts', '.ts']]],
    ['fMP4: картинка и звук отдельными дорожками', [['vfm', '.m4s'], ['afm', '.m4s']]],
    ['TS-картинка + голый AAC', [['vts', '.ts'], ['aac', '.aac']]],
  ];
  for (const [name, specs] of cases) {
    const file = path.join(out, 'o.mp4');
    const fd = fs.openSync(file, 'w');
    const res = await remux(specs.map(([d, e]) => input(d, e)), {
      write: (b) => void fs.writeSync(fd, b),
      patch: (o, b) => void fs.writeSync(fd, b, 0, b.length, o),
    });
    fs.closeSync(fd);
    const buf = fs.readFileSync(file);
    const top = boxes(buf, 0, buf.length);
    check(top.map((b) => b.type).join(',') === 'ftyp,mdat,moov', `${name}: ftyp, mdat, moov — ${top.map((b) => b.type).join(',')}`);
    check(top[top.length - 1].end === buf.length, `${name}: размеры коробок сходятся с файлом`);
    const moov = top.find((b) => b.type === 'moov');
    const counts = {};
    for (const trak of boxes(buf, moov.body, moov.end).filter((b) => b.type === 'trak')) {
      const mdia = find(buf, trak, 'mdia');
      const hdlr = find(buf, mdia, 'hdlr');
      const kind = buf.toString('latin1', hdlr.body + 8, hdlr.body + 12);
      const stbl = find(buf, find(buf, mdia, 'minf'), 'stbl');
      const stsz = find(buf, stbl, 'stsz');
      counts[kind] = buf.readUInt32BE(stsz.body + 8);
      // Каждый отрезок данных лежит внутри mdat.
      const co64 = find(buf, stbl, 'co64');
      const n = buf.readUInt32BE(co64.body + 4);
      const mdat = top.find((b) => b.type === 'mdat');
      let inside = true;
      for (let i = 0; i < n; i++) {
        const off = Number(buf.readBigUInt64BE(co64.body + 8 + i * 8));
        if (off < mdat.body || off >= mdat.end) inside = false;
      }
      check(inside, `${name}: ${kind} — отрезки данных внутри mdat (${n})`);
    }
    check(counts.vide === 150, `${name}: кадров картинки 150 — ${counts.vide}`);
    check(counts.soun === 260, `${name}: кадров звука 260 — ${counts.soun}`);
    check(Math.abs(res.seconds - 6) < 0.1, `${name}: длительность ≈ 6 с — ${res.seconds}`);
  }
  console.log(fail ? `\nПровалов: ${fail}` : '\nВсё сходится.');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('FAIL', e);
  process.exit(1);
});
