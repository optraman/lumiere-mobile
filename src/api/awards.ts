import { KEYS } from './sources/keys';

/*
  ОЦЕНКИ И НАГРАДЫ — как на странице тайтла у Влада (APK: E4/q, E4/m, E4/j, E4/t, E4/u, E4/w).

  ОЦЕНКИ: OMDb по номеру IMDb. Rotten Tomatoes — «NN%» из Ratings[], IMDb — «8.5/10» оттуда же.
  Кинопоиска у Влада здесь нет — и здесь нет.

  НАГРАДЫ: сперва Викиданные — фильм по свойству P345 (номер IMDb), его утверждения P166
  («получил награду») и P1411 («номинирован»), год из уточнения P585, названия наград по-русски.
  Важные премии — первыми, по списку Влада (Оскар, Золотой глобус, BAFTA, Эмми, Каннская пальмовая
  ветвь, Венеция/Берлин, Гильдия актёров, Сезар/Гойя, Грэмми, Выбор критиков, Сатурн, Хьюго/Небьюла,
  Независимый дух, Энни); по четыре в столбик. Если Викиданные молчат — текст наград OMDb,
  переведённый теми же правилами, что у Влада («Won 2 Oscars» → «„Оскар“: 2 победы»).

  Всё помнится в памяти на время работы: страница открывается не раз, а ответы не меняются.
*/

export type Award = { name: string; year: string | null; won: boolean };
export type TitleScores = { rt: number | null; imdb: number | null };
export type TitleAwards = { won: Award[]; nominated: Award[] };

const UA = { 'User-Agent': 'Lumiere/1.0 (iOS app)', Accept: 'application/json' };

async function json<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

// ── OMDb ────────────────────────────────────────────────────────────────────────────────────────

type Omdb = { Awards?: string; Ratings?: { Source: string; Value: string }[]; Response?: string };
const omdbCache = new Map<string, Promise<Omdb | null>>();

function omdb(imdb: string): Promise<Omdb | null> {
  let p = omdbCache.get(imdb);
  if (!p) {
    const key = (KEYS as Record<string, string>).omdb;
    p = key
      ? json<Omdb>(`https://www.omdbapi.com/?i=${imdb}&apikey=${key}`)
          .then((d) => (d.Response === 'False' ? null : d))
          .catch(() => {
            omdbCache.delete(imdb);
            return null;
          })
      : Promise.resolve(null);
    omdbCache.set(imdb, p);
  }
  return p;
}

const ratingOf = (d: Omdb, source: string) => d.Ratings?.find((r) => r.Source === source)?.Value ?? null;

export async function titleScores(imdb: string | null): Promise<TitleScores> {
  if (!imdb) return { rt: null, imdb: null };
  const d = await omdb(imdb);
  if (!d) return { rt: null, imdb: null };
  const rtRaw = ratingOf(d, 'Rotten Tomatoes');
  const rt = rtRaw ? parseInt(rtRaw.replace('%', '').trim(), 10) : NaN;
  const imRaw = ratingOf(d, 'Internet Movie Database');
  const im = imRaw ? parseFloat(imRaw.split('/')[0].trim()) : NaN;
  return {
    rt: Number.isFinite(rt) && rt >= 0 && rt <= 100 ? rt : null,
    imdb: Number.isFinite(im) && im > 0 ? im : null,
  };
}

/** Русская множественная форма — та же функция, что w.d у Влада. */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = n % 10;
  const b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && !(b >= 12 && b <= 14)) return few;
  return many;
}
const wins = (n: number) => `${n} ${plural(n, 'победа', 'победы', 'побед')}`;
const noms = (n: number) => `${n} ${plural(n, 'номинация', 'номинации', 'номинаций')}`;

/** Строки «Awards» OMDb по-русски — те же шаблоны и в том же порядке, что E4/q. */
const OMDB_RULES: [RegExp, (a: number, b: number) => string][] = [
  [/^Won (\d+) Oscars?$/i, (a) => `«Оскар»: ${wins(a)}`],
  [/^Nominated for (\d+) Oscars?$/i, (a) => `«Оскар»: ${noms(a)}`],
  [/^Won (\d+) Golden Globes?$/i, (a) => `«Золотой глобус»: ${wins(a)}`],
  [/^Nominated for (\d+) Golden Globes?$/i, (a) => `«Золотой глобус»: ${noms(a)}`],
  [/^Won (\d+) BAFTA(?: Film)? Awards?$/i, (a) => `BAFTA: ${wins(a)}`],
  [/^Won (\d+) Primetime Emmys?$/i, (a) => `«Эмми»: ${wins(a)}`],
  [/^Nominated for (\d+) Primetime Emmys?$/i, (a) => `«Эмми»: ${noms(a)}`],
];
/*
  «1 nomination total», «Another 12 wins & 31 nominations» — это не награды, а счётчики без названий:
  читать их нечего. Такие строки отбрасываются; остаются только названные премии (Оскар, Глобус,
  BAFTA, Эмми). Если Викиданные не дали ничего и у OMDb нет названных премий — блока наград нет.
*/

function omdbAwards(text: string | undefined): Award[] {
  if (!text || !text.trim() || text.trim().toUpperCase() === 'N/A') return [];
  return text
    .split('. ')
    .map((part) => part.trim().replace(/\.+$/, ''))
    .map((part) => {
      for (const [re, fmt] of OMDB_RULES) {
        const m = part.match(re);
        if (m) return fmt(parseInt(m[1], 10), parseInt(m[2] ?? '0', 10));
      }
      return '';
    })
    .filter((s) => s.trim().length > 0)
    .map((name) => ({ name, year: null, won: true }));
}

// ── Викиданные ──────────────────────────────────────────────────────────────────────────────────

const WD = 'https://www.wikidata.org/w/api.php?format=json';

/** Важность премий — список Влада (E4/m.f2537d): чем раньше, тем выше. */
const PRIORITY: string[][] = [
  ['оскар', 'academy award'],
  ['золотой глобус', 'golden globe'],
  ['бафта', 'bafta'],
  ['эмми', 'emmy'],
  ['золотая пальмовая', "palme d'or"],
  ['золотой лев', 'золотой медведь', 'серебряный медведь', 'golden lion', 'golden bear'],
  ['гильдии киноактёров', 'гильдии киноактеров', 'screen actors guild'],
  ['сезар', 'césar', 'гойя', 'goya'],
  ['грэмми', 'grammy'],
  ['выбор критиков', "critics' choice", 'critics choice'],
  ['сатурн', 'saturn award'],
  ['хьюго', 'небьюла', 'hugo award', 'nebula award'],
  ['независимый дух', 'independent spirit'],
  ['энни', 'annie award'],
];
function rank(name: string): number {
  const n = name.toLowerCase();
  const i = PRIORITY.findIndex((keys) => keys.some((k) => n.includes(k)));
  return i < 0 ? PRIORITY.length : i;
}

type Claim = { mainsnak?: { datavalue?: { value?: { id?: string } } }; qualifiers?: Record<string, { datavalue?: { value?: { time?: string } } }[]> };

async function entityOf(imdb: string): Promise<string | null> {
  const d = await json<{ query?: { search?: { title?: string }[] } }>(
    `${WD}&action=query&list=search&srlimit=1&srsearch=${encodeURIComponent(`haswbstatement:P345=${imdb}`)}`,
    UA,
  );
  return d.query?.search?.[0]?.title ?? null;
}

async function claims(entity: string, prop: string): Promise<{ id: string; year: string | null }[]> {
  const d = await json<{ claims?: Record<string, Claim[]> }>(`${WD}&action=wbgetclaims&entity=${entity}&property=${prop}`, UA);
  return (d.claims?.[prop] ?? [])
    .map((c) => {
      const id = c.mainsnak?.datavalue?.value?.id;
      const time = c.qualifiers?.P585?.[0]?.datavalue?.value?.time;
      return id ? { id, year: time ? time.slice(1, 5) : null } : null;
    })
    .filter((x): x is { id: string; year: string | null } => x !== null);
}

async function labels(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const d = await json<{ entities?: Record<string, { labels?: Record<string, { value: string }> }> }>(
      `${WD}&action=wbgetentities&props=labels&languages=ru|en&ids=${chunk.join('|')}`,
      UA,
    );
    for (const [id, e] of Object.entries(d.entities ?? {})) {
      const l = e.labels?.ru?.value ?? e.labels?.en?.value;
      if (l) out.set(id, l);
    }
  }
  return out;
}

const awardsCache = new Map<string, Promise<TitleAwards>>();

/*
  ВИКИДАННЫЕ ОДНИМ ЗАПРОСОМ (SPARQL). Поиск «haswbstatement:P345=…» живёт на поисковом индексе,
  который отстаёт и у многих фильмов ничего не находит — отсюда «наград нет» или пустые счётчики
  OMDb. Запрос к самой базе находит фильм по номеру IMDb всегда и сразу отдаёт премии, номинации,
  годы и русские названия.
*/
async function sparqlAwards(imdb: string): Promise<TitleAwards | null> {
  const q = `SELECT ?award ?awardLabel ?year ?kind WHERE {
    ?film wdt:P345 "${imdb}" .
    { ?film p:P166 ?st . ?st ps:P166 ?award . BIND("won" AS ?kind) }
    UNION { ?film p:P1411 ?st . ?st ps:P1411 ?award . BIND("nom" AS ?kind) }
    OPTIONAL { ?st pq:P585 ?date . BIND(YEAR(?date) AS ?year) }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "ru,en". }
  }`;
  const d = await json<{ results?: { bindings?: Record<string, { value: string }>[] } }>(
    `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`,
    { ...UA, Accept: 'application/sparql-results+json' },
  );
  const rows = d.results?.bindings ?? [];
  if (!rows.length) return null;
  const seen = new Set<string>();
  const all = rows
    .map((r) => ({ name: r.awardLabel?.value ?? '', year: r.year?.value ?? null, won: r.kind?.value === 'won' }))
    .filter((a) => a.name && !/^Q\d+$/.test(a.name))
    .filter((a) => {
      const k = `${a.won}|${a.name}|${a.year}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const pick = (won: boolean) =>
    all
      .filter((a) => a.won === won)
      .sort((a, b) => rank(a.name) - rank(b.name) || (b.year ?? '').localeCompare(a.year ?? ''))
      .slice(0, 4);
  const res = { won: pick(true), nominated: pick(false) };
  return res.won.length || res.nominated.length ? res : null;
}

async function loadAwards(imdb: string): Promise<TitleAwards> {
  try {
    const viaSparql = await sparqlAwards(imdb);
    if (viaSparql) return viaSparql;
  } catch {
    /* SPARQL не ответил — пробуем обычный поиск Викиданных */
  }
  try {
    const entity = await entityOf(imdb);
    if (entity) {
      const [won, nom] = await Promise.all([claims(entity, 'P166'), claims(entity, 'P1411')]);
      if (won.length || nom.length) {
        const names = await labels([...new Set([...won, ...nom].map((c) => c.id))]);
        const make = (list: typeof won, isWon: boolean): Award[] =>
          list
            .map((c) => ({ name: names.get(c.id) ?? '', year: c.year, won: isWon }))
            .filter((a) => a.name && !/^Q\d+$/.test(a.name))
            .sort((a, b) => rank(a.name) - rank(b.name) || (b.year ?? '').localeCompare(a.year ?? ''))
            .slice(0, 4);
        const res = { won: make(won, true), nominated: make(nom, false) };
        if (res.won.length || res.nominated.length) return res;
      }
    }
  } catch {
    /* Викиданные не ответили — пробуем OMDb */
  }
  const d = await omdb(imdb);
  return { won: omdbAwards(d?.Awards).slice(0, 4), nominated: [] };
}

export function titleAwards(imdb: string | null): Promise<TitleAwards> {
  if (!imdb) return Promise.resolve({ won: [], nominated: [] });
  let p = awardsCache.get(imdb);
  if (!p) {
    p = loadAwards(imdb);
    awardsCache.set(imdb, p);
  }
  return p;
}
