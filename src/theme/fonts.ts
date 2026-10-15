// Портировано из ui/theme/Theme.kt. Два голоса, как в ТВ-версии:
//   Bounded  — характерный дисплейный шрифт, ТОЛЬКО для крупных заголовков (герой, названия секций).
//   Manrope  — весь остальной интерфейс: подписи, чипы, текст. Мягкий, с полной кириллицей.
// Manrope подключён СТАТИЧЕСКИМИ начертаниями (как в оригинале), иерархия задаётся весом.

/*
  Заставка ждёт загрузки ВСЕХ шрифтов, а в Expo Go они едут с сервера разработки. Поэтому здесь
  только те начертания, которыми что-то написано: Bounded ExtraLight, Bounded Regular и Manrope
  Medium не использовались нигде (1,1 МБ впустую), а цифры «Топ 10» — урезанная копия шрифта
  только с 0–9 (26 КБ вместо 843 КБ; tools: pyftsubset --text=0123456789). Всего ~0,5 МБ вместо 2,4.
*/
export const fontAssets = {
  bounded: require('../../assets/fonts/bounded.ttf'),
  manrope_regular: require('../../assets/fonts/manrope_regular.ttf'),
  manrope_semibold: require('../../assets/fonts/manrope_semibold.ttf'),
  manrope_bold: require('../../assets/fonts/manrope_bold.ttf'),
  manrope_extrabold: require('../../assets/fonts/manrope_extrabold.ttf'),
  // Только для гигантских цифр ряда «Топ 10» — как RankFont в Cards.kt.
  array_boldwide: require('../../assets/fonts/array_boldwide_digits.otf'),
};

/** Имена семейств для style.fontFamily. */
export const font = {
  display: 'bounded',
  regular: 'manrope_regular',
  semibold: 'manrope_semibold',
  bold: 'manrope_bold',
  extrabold: 'manrope_extrabold',
  rank: 'array_boldwide',
} as const;

/**
 * Типографика. Размеры из Theme.kt, ПЕРЕСЧИТАННЫЕ под телефон: в ТВ-версии вся сетка умножалась на
 * UI_SCALE = 0.6 (шрифты задавались крупно «под комнату», потом сжимались плотностью). На телефоне
 * экран в тридцати сантиметрах от глаз, поэтому взяты уже сжатые значения, а не исходные sp.
 */
export const type = {
  displayLarge: { fontFamily: font.display, fontSize: 26, letterSpacing: -0.5 },
  headlineLarge: { fontFamily: font.display, fontSize: 19 },
  /**
   * Заголовок отдельной страницы («Настройки», «Загрузки», «История»…) — ЖИРНЕЕ: у Bounded одно
   * начертание, поэтому штрих утолщается тенью того же цвета с нулевым сдвигом (как название на
   * странице фильма), и кегль чуть больше.
   */
  pageTitle: {
    fontFamily: font.display,
    fontSize: 24,
    letterSpacing: 0.3,
    textShadowColor: '#F6F6F8',
    textShadowRadius: 2.4,
    textShadowOffset: { width: 0, height: 0 },
  },
  headlineMedium: { fontFamily: font.bold, fontSize: 21 },
  titleLarge: { fontFamily: font.bold, fontSize: 19 },
  titleMedium: { fontFamily: font.bold, fontSize: 16 },
  bodyLarge: { fontFamily: font.regular, fontSize: 15 },
  bodyMedium: { fontFamily: font.regular, fontSize: 14 },
  labelLarge: { fontFamily: font.bold, fontSize: 14 },
  labelMedium: { fontFamily: font.semibold, fontSize: 12 },
} as const;
