/**
 * КОГДА ПАНЕЛЬ ПЛЕЕРА НА ЭКРАНЕ — одна функция, без состояния и без часов.
 *
 * Портировано 1:1 с PlayerChrome.kt. Смысл там объяснён так, и он верен и здесь: спрашиваешь у неё,
 * какая сейчас обстановка, — она отвечает, что показывать. За этим ответом стоят все правила сразу,
 * и поэтому они не разъезжаются.
 *
 * Раньше у меня те же правила были размазаны по таймеру, четырём переменным и трём условиям прямо в
 * разметке — и, как и у Влада до этой функции, отвечали на один и тот же вопрос по-разному.
 */

export type Situation = {
  shown: boolean;
  playing: boolean;
  /** Открытое меню, полоса серий — всё, что удерживает панель, чем бы ни было. */
  pinned: boolean;
  hasError: boolean;
  msSinceInteraction: number;
};

/** «через 3 секунды БЕЗДЕЙСТВИЯ» — считается от последнего нажатия, а не от появления. */
export const HIDE_AFTER_MS = 3_000;

export function shouldShowChrome(s: Situation): boolean {
  /*
    Прятать — только во время воспроизведения. Плеер на паузе это плеер, от которого отошли на
    середине мысли, и отбирать у него кнопки незачем.
  */
  const hide = s.playing && s.shown && !s.pinned && !s.hasError && s.msSinceInteraction > HIDE_AFTER_MS;
  return hide ? false : s.shown;
}

/**
 * НА СКОЛЬКО СДВИГАЕТ ОДНО НАЖАТИЕ ПЕРЕМОТКИ — портировано 1:1 с SeekRamp.kt.
 *
 * Первые пара нажатий идут базовым шагом, чтобы обычная подводка была точной; только затяжная серия
 * начинает разгоняться — и разгоняется БЫСТРЕЕ с каждым нажатием: на пять секунд больше, чем
 * прошлая прибавка, а не чем прошлый шаг. При ровных пяти за нажатие до потолка в пять минут надо
 * было бы жать шестьдесят раз; так удержание идёт 15 → 20 → 30 → 45 → 65 → 90 и приходит к пяти
 * минутам примерно за дюжину — столько её и держат.
 */
export class SeekRamp {
  /** «ход перемотки в фильмах — 15 секунд, в сериалах — 10». */
  static readonly SERIES_STEP = 10_000;
  static readonly MOVIE_STEP = 15_000;
  private static readonly MAX_STEP = 300_000;
  private static readonly RAMP_PER_PRESS = 5_000;
  private static readonly GRACE_PRESSES = 2;
  private static readonly STREAK_GAP_MS = 800;

  private streak = 0;
  private lastAt = 0;
  private lastDirection = 0;

  constructor(private readonly baseStep: number) {}

  static forSeries(): SeekRamp {
    return new SeekRamp(SeekRamp.SERIES_STEP);
  }
  static forMovie(): SeekRamp {
    return new SeekRamp(SeekRamp.MOVIE_STEP);
  }

  /**
   * Шаг для нажатия в сторону [direction] (−1 назад, +1 вперёд).
   *
   * Вызов ЕСТЬ нажатие: он двигает разгон. Спросить дважды за одно нажатие — получить ответ
   * торопливее нужного; это единственный способ ошибиться, и поэтому это глагол, а не свойство.
   */
  step(direction: number, now = Date.now()): number {
    const continues = now - this.lastAt < SeekRamp.STREAK_GAP_MS && direction === this.lastDirection;
    this.streak = continues ? this.streak + 1 : 0;
    this.lastAt = now;
    this.lastDirection = direction;
    const n = Math.max(0, this.streak - SeekRamp.GRACE_PRESSES);
    const ramp = (SeekRamp.RAMP_PER_PRESS * n * (n + 1)) / 2;
    return Math.min(this.baseStep + ramp, SeekRamp.MAX_STEP);
  }
}
