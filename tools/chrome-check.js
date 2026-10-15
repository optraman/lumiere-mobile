/*
  ПРОВЕРКА ПРАВИЛ ПАНЕЛИ И РАЗГОНА ПЕРЕМОТКИ — портировано 1:1 с PlayerChrome.kt и SeekRamp.kt.

  У Влада обе вещи сделаны чистыми функциями именно затем, чтобы их можно было спросить, а не
  «устроить плеер и посидеть с секундомером». Здесь их и спрашивают.
*/
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const file = path.join(__dirname, '..', 'src', 'player', 'chrome.ts');
const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), {
  filename: file,
  presets: [['@babel/preset-typescript', {}]],
  plugins: [['@babel/plugin-transform-modules-commonjs', {}]],
  babelrc: false, configFile: false,
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', code)(mod, mod.exports, require);
const { shouldShowChrome, SeekRamp, HIDE_AFTER_MS } = mod.exports;

let bad = 0;
const ok = (n, c) => { if (!c) { bad++; console.log('НЕ СОШЛОСЬ: ' + n); } else console.log('ок: ' + n); };

const S = (o) => ({ shown: true, playing: true, pinned: false, hasError: false, msSinceInteraction: 0, ...o });

ok('три секунды — именно три', HIDE_AFTER_MS === 3000);
ok('во время воспроизведения панель уходит после трёх секунд', shouldShowChrome(S({ msSinceInteraction: 3100 })) === false);
ok('до трёх секунд — остаётся', shouldShowChrome(S({ msSinceInteraction: 2900 })) === true);
ok('НА ПАУЗЕ НЕ УХОДИТ НИКОГДА', shouldShowChrome(S({ playing: false, msSinceInteraction: 999999 })) === true);
ok('открытое меню удерживает панель', shouldShowChrome(S({ pinned: true, msSinceInteraction: 999999 })) === true);
ok('ошибка удерживает панель', shouldShowChrome(S({ hasError: true, msSinceInteraction: 999999 })) === true);
ok('спрятанная сама не появляется', shouldShowChrome(S({ shown: false, msSinceInteraction: 0 })) === false);

// Разгон: базовый шаг, льгота на два нажатия, рост прибавки, потолок.
let r = SeekRamp.forMovie();
ok('фильм: первый шаг — 15 секунд', r.step(1, 1000) === 15000);
ok('второй — тоже 15', r.step(1, 1200) === 15000);
ok('третий — тоже 15 (льгота на два)', r.step(1, 1400) === 15000);
ok('четвёртый уже больше', r.step(1, 1600) === 20000);
ok('пятый растёт быстрее', r.step(1, 1800) === 30000);
ok('шестой ещё быстрее', r.step(1, 2000) === 45000);
r = SeekRamp.forSeries();
ok('сериал: базовый шаг — 10 секунд', r.step(1, 1000) === 10000);
r = SeekRamp.forMovie();
for (let i = 0; i < 4; i++) r.step(1, 1000 + i * 200);
ok('смена направления сбрасывает разгон', r.step(-1, 1800) === 15000);
r = SeekRamp.forMovie();
for (let i = 0; i < 4; i++) r.step(1, 1000 + i * 200);
ok('пауза дольше 800 мс сбрасывает разгон', r.step(1, 5000) === 15000);
r = SeekRamp.forMovie();
let last = 0;
for (let i = 0; i < 40; i++) last = r.step(1, 1000 + i * 100);
ok('потолок — пять минут', last === 300000);

console.log(bad === 0 ? '\nВСЁ СОШЛОСЬ' : `\nОШИБОК: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
