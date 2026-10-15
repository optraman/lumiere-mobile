// Портировано из data/search/QueryRepair.kt — один в один, включая пороги и правила.
//
// Чинит то, что человек набрал неточно, чтобы поиск, который ДОЛЖЕН был сработать, не возвращал
// пустоту. Две независимые починки, обе применяются только когда обычный поиск ничего не нашёл:
//   swapLayout — набрано не в той раскладке («Bfhbfyn» → «Вариант»);
//   fuzzyPick  — в запросе опечатка, поэтому точного вхождения не существует.
//
// Чистые функции, ничего не знающие про TMDB: когда к ним обращаться, решает вызывающий.

// Порядок физических клавиш: символ №N одной строки лежит на той же клавише, что символ №N другой.
const LATIN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const CYRILLIC = 'йцукенгшщзхъфывапролджэячсмитьбюё';

const latToCyr = new Map<string, string>();
const cyrToLat = new Map<string, string>();
for (let i = 0; i < LATIN.length; i++) {
  latToCyr.set(LATIN[i], CYRILLIC[i]);
  cyrToLat.set(CYRILLIC[i], LATIN[i]);
}

/**
 * Те же нажатия клавиш, прочитанные в другой раскладке, или null, когда запрос непохож на промах
 * раскладкой (нечего преобразовывать, либо текст уже смешанный).
 *
 * Регистр сохраняется, чтобы исправленный запрос читался естественно, если показать его человеку.
 */
export function swapLayout(query: string): string | null {
  const letters = [...query].filter((c) => /\p{L}/u.test(c));
  if (letters.length === 0) return null;
  const cyr = letters.filter((c) => CYRILLIC.includes(c.toLowerCase())).length;
  const lat = letters.filter((c) => LATIN.includes(c.toLowerCase())).length;
  // Неоднозначные смеси («Terminator 2 часть») — не промах раскладкой, их не трогаем.
  if (cyr > 0 && lat > 0) return null;
  const map = lat > 0 ? latToCyr : cyrToLat;
  let out = '';
  for (const ch of query) {
    const mapped = map.get(ch.toLowerCase());
    if (mapped == null) out += ch;
    else out += ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? mapped.toUpperCase() : mapped;
  }
  return out !== query ? out : null;
}

/**
 * Более короткое и безопасное начало запроса: достаточно длинное, чтобы всё ещё опознать тайтл, и
 * достаточно короткое, чтобы опечатка ближе к концу с него слетела. TMDB ищет подстроки, а не
 * звучание, поэтому одна неверная буква в «Интерстелар» убивает весь запрос; поиск по «Интерсте» с
 * последующей сортировкой по расстоянию правок находит нужное.
 */
export function prefixProbe(query: string): string | null {
  const q = query.trim();
  if (q.length < 6) return null;
  const cut = Math.max(4, Math.floor((q.length * 2) / 3));
  const p = q.slice(0, cut).trim();
  return p.length >= 4 && p.length < q.length ? p : null;
}

/**
 * Более короткие запросы, которые стоит попробовать, когда полный ничего не нашёл — каждый есть
 * кусок исходного, переживший опечатку. Сначала длинные (самая точная проба получает лучший шанс),
 * не больше четырёх, чтобы неудачный поиск не превращался в очередь запросов.
 *
 * Отдельные СЛОВА важны не меньше начала: опечатка в первом слове («чкловек паук») невидима для
 * пробы по началу, а второе слово обычно цело и вытягивает нужных кандидатов.
 */
export function probesFor(query: string): string[] {
  const q = query.trim();
  if (q.length < 4) return [];
  const words = q
    .split(/[ \-:,]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
  const all = [prefixProbe(q), ...words].filter((x): x is string => !!x);
  const seen = new Set<string>();
  return all
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.toLowerCase() !== q.toLowerCase())
    .filter((x) => {
      const k = x.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.length - a.length)
    .slice(0, 4);
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[b.length];
}

/**
 * Расстояние до ближайшего НАЧАЛА строки, или -1, когда даже лучшее превышает [max].
 *
 * Сравнивать с названием целиком нельзя: длинные названия наказывались бы за длину («Начало» и
 * «Начало: Расширенная версия» отличаются на 19 правок и очевидно один фильм). Поэтому берутся
 * начала около длины самого запроса — и несколько, а не одно: единственное фиксированное окно
 * штрафовало «Человек-паук: Через вселенные» за подзаголовок и выбрасывало все сиквелы из поиска,
 * который явно имел в виду именно их.
 */
function distanceWithin(q: string, text: string, max: number): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (let k = -max; k <= max; k++) {
    const len = q.length + k;
    if (len <= 0 || len > text.length) continue;
    best = Math.min(best, levenshtein(q, text.slice(0, len)));
    if (best === 0) break;
  }
  return best <= max ? best : -1;
}

/**
 * Оставляет только тех кандидатов, чьё название достаточно близко к запросу, чтобы быть его
 * опечаткой; лучшие первыми.
 *
 * Допуск растёт с длиной запроса: шесть букв — одна неверная, пятнадцать — три. Щедро для реальных
 * опечаток и достаточно строго, чтобы «Дюна» не тащила за собой «Луна».
 */
export function fuzzyPick<T>(query: string, candidates: T[], titleOf: (c: T) => string): T[] {
  const q = normalize(query);
  if (!q) return [];
  const tolerance = Math.min(Math.max(Math.floor(q.length / 5), 1), 3);
  return candidates
    .map((c) => {
      const title = normalize(titleOf(c));
      if (!title) return null;
      // Кандидат, который просто СОДЕРЖИТ запрос, — обычное совпадение, расстояние 0.
      const d = title.includes(q) ? 0 : distanceWithin(q, title, tolerance);
      return d < 0 ? null : { c, d };
    })
    .filter((x): x is { c: T; d: number } => x !== null)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.c);
}
