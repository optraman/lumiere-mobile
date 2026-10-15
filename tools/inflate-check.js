/*
 * ПРОВЕРКА РАСПАКОВЩИКА — против настоящего zlib.
 *
 * Компилирует src/player/inflate.ts и сравнивает побайтно с zlib из Node на сотнях случаев:
 * случайные данные (все три вида блоков DEFLATE), длинные повторы, пустой файл, настоящий
 * текст субтитров в UTF-8 и в windows-1251. Плюс отдельная проверка распознавания кодировки.
 *
 * Запуск:  node tools/inflate-check.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'inflate-'));
const tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
execFileSync(process.execPath, [tsc, path.join(root, 'src/player/inflate.ts'), '--outDir', out, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'], { cwd: out, stdio: 'pipe' });
const { gunzip, decodeSmart, strictUtf8 } = require(path.join(out, 'inflate.js'));

let bad = 0;
const ok = (c, name) => {
  if (!c) {
    bad++;
    console.log('ПРОВАЛ ' + name);
  }
};

function rnd(n, alphabet) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = alphabet ? alphabet[Math.floor(Math.random() * alphabet.length)] : Math.floor(Math.random() * 256);
  return b;
}

let cases = 0;
for (const level of [0, 1, 6, 9]) {
  for (const size of [0, 1, 7, 100, 1000, 20000, 70000]) {
    for (const kind of ['random', 'text', 'repeat']) {
      const src =
        kind === 'random' ? rnd(size) : kind === 'text' ? rnd(size, Buffer.from('абвгд ежзий\n0123:->')) : Buffer.alloc(size, 0x41);
      const gz = zlib.gzipSync(src, { level });
      const got = Buffer.from(gunzip(new Uint8Array(gz)));
      ok(got.equals(src), `уровень ${level}, ${size} байт, ${kind}`);
      cases++;
    }
  }
}
// Только фиксированные коды Хаффмана
const fixedSrc = Buffer.from('Привет, мир! '.repeat(50));
ok(Buffer.from(gunzip(new Uint8Array(zlib.gzipSync(fixedSrc, { strategy: zlib.constants.Z_FIXED })))).equals(fixedSrc), 'фиксированные коды');
cases++;

// Кодировки: настоящий русский текст субтитров
const srt = '1\n00:00:01,000 --> 00:00:03,500\nЁжик в тумане — «Привет», сказал он.\n';
const utf = Buffer.from(srt, 'utf8');
ok(decodeSmart(new Uint8Array(utf)) === srt, 'UTF-8 читается как UTF-8');
// windows-1251 вручную: Node её не знает, кодируем таблицей обратно
const map = { 'Ё': 0xa8, 'ё': 0xb8, '«': 0xab, '»': 0xbb, '—': 0x97 };
const cp = Buffer.from([...srt].map((ch) => {
  const c = ch.charCodeAt(0);
  if (c < 0x80) return c;
  if (map[ch] !== undefined) return map[ch];
  if (c >= 0x410 && c <= 0x44f) return 0xc0 + (c - 0x410);
  throw new Error('нет в таблице: ' + ch);
}));
ok(strictUtf8(new Uint8Array(cp)) === null, 'windows-1251 не принимается за UTF-8');
ok(decodeSmart(new Uint8Array(cp)) === srt, 'windows-1251 раскодирована верно');

fs.rmSync(out, { recursive: true, force: true });
console.log(bad ? `\nпровалов: ${bad} из ${cases + 3}` : `\nвсё сошлось: ${cases} распаковок совпали с zlib побайтно, кодировки распознаются`);
process.exit(bad ? 1 : 0);
