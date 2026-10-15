/**
 * ОТКРЫТЫЕ КЛЮЧИ ИСТОЧНИКОВ.
 *
 * Все значения — публичные константы из открытого кода, а не чьи-то личные учётные записи:
 *   hdvbToken                         — Lampac, Modules/OnlineRUS/HDVB/ModInit.cs;
 *   kodikToken                        — online_mod.js (nb557), function kodik;
 *   lumexHost, lumexApi, lumexSuffix  — online_mod.js, function lumex;
 *   filmixPlaceholder                 — online_mod.js, function filmix (гостевой токен).
 *
 * Сгенерировано скриптом прямо из исходников — руками не переписывалось. Ключи там меняются, и
 * при смене их правят здесь, в одном месте.
 */
export const KEYS = {
  /** TheIntroDB — отрезки заставки и титров (как у Влада: IntroDbClient). */
  introDb: 'theintrodb:user_3GdfBg9hUBDEz3ifQfSYBKPtklV:d4-jVlpG11jD0DBjf2Mm9vmGkKEFv4gxCgOeKTRruf0',
  /** OMDb — оценки Rotten Tomatoes и IMDb и текст наград (встроенный ключ APK, D4/c). */
  omdb: '2e6ed24',
  hdvbToken: "5e2fe4c70bafd9a7414c4f170ee1b192",
  kodikToken: "41dd95f84c21719b09d6c71182237a25",
  lumexHost: "https://p.lumex.space",
  lumexApi: "https://api.lumex.space/",
  lumexSuffix: "clientId=CWfKXLc1ajId&domain=movielab.one&url=movielab.one",
  filmixPlaceholder: "aaaabbbbccccddddeeeeffffaaaabbbb",
} as const;
