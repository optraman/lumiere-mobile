/*
  ПРОВЕРКА РАЗБОРА СУБТИТРОВ — на настоящем файле src/player/vtt.ts, а не на его копии.

  Копия проверяет копию: правку в модуле она не заметит. Поэтому модуль берётся как есть и
  прогоняется через тот же babel, каким его собирает приложение.
*/
const fs = require('fs');
const babel = require('@babel/core');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'player', 'vtt.ts');
const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), {
  filename: file,
  presets: [['@babel/preset-typescript', {}]],
  plugins: [['@babel/plugin-transform-modules-commonjs', {}]],
  babelrc: false,
  configFile: false,
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', code)(mod, mod.exports, require);
const { parseCues, cueAt } = mod.exports;

let bad = 0;
const ok = (name, cond) => {
  if (!cond) { bad++; console.log('НЕ СОШЛОСЬ: ' + name); }
  else console.log('ок: ' + name);
};

const vtt = [
  'WEBVTT',
  '',
  '1',
  '00:00:01.000 --> 00:00:04.500',
  '<i>Первая</i> реплика',
  'вторая строка',
  '',
  '2',
  '00:01:02.250 --> 00:01:03.000',
  '{\\an8}Вторая',
  '',
].join('\n');

const srt = [
  '1',
  '00:00:05,000 --> 00:00:06,000',
  'Из SRT',
  '',
].join('\r\n');

const a = parseCues(vtt);
ok('две реплики из vtt', a.length === 2);
ok('время начала', Math.abs(a[0].from - 1) < 1e-6);
ok('время конца', Math.abs(a[0].to - 4.5) < 1e-6);
ok('теги сняты', a[0].text === 'Первая реплика\nвторая строка');
ok('часы и минуты', Math.abs(a[1].from - 62.25) < 1e-6);
ok('позиционный тег снят', a[1].text === 'Вторая');

const b = parseCues(srt);
ok('srt с запятой и CRLF', b.length === 1 && Math.abs(b[0].from - 5) < 1e-6 && b[0].text === 'Из SRT');

ok('до первой реплики пусто', cueAt(a, 0.5).cue === null);
ok('внутри первой', cueAt(a, 2).cue === a[0]);
ok('в промежутке пусто', cueAt(a, 30).cue === null);
ok('внутри второй', cueAt(a, 62.5).cue === a[1]);
// Подсказка вперёд и перемотка назад: результат не должен от неё зависеть.
ok('подсказка вперёд не мешает', cueAt(a, 2, 1).cue === a[0]);
ok('подсказка назад не мешает', cueAt(a, 62.5, 0).cue === a[1]);
ok('пустой список', cueAt([], 5).cue === null);

console.log(bad === 0 ? '\nВСЁ СОШЛОСЬ' : `\nОШИБОК: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
