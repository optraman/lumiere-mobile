// Портировано из TmdbRepository.liveRowSpec() — ряд «по времени суток», один из двух рядов,
// которые отвечают на вопрос «почему именно это сегодня».

export interface LiveRow {
  title: string;
  params: Record<string, string>;
}

/**
 * Настроение привязано к ЧАСУ, а вот КАКАЯ страница этого настроения — к дате: сортировка TMDB по
 * популярности стабильна несколько дней подряд, поэтому страница 1 «вечера пятницы» была буквально
 * одними и теми же десятью фильмами каждую неделю. Прокрутка дня года по страницам делает ряд
 * свежим ежедневно, не меняя того, о чём он.
 */
export function liveRowSpec(now = new Date()): LiveRow {
  const h = now.getHours();
  const dayOfWeek = now.getDay(); // 0 = воскресенье
  const weekend = dayOfWeek === 0 || dayOfWeek === 6;
  const friday = dayOfWeek === 5;

  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now.getTime() - start.getTime()) / 86400000);

  const page = String((dayOfYear % 4) + 1);
  // Порог числа оценок «едет» вместе с датой: в одни дни ряд тяготеет к известному, в другие копает
  // чуть глубже.
  const floor = dayOfYear % 2 === 0 ? '200' : '120';

  // Наборы жанров ОБЪЕДИНЯЮТСЯ (вертикальная черта), а не пересекаются (запятая). Проверено на живом
  // API: "18,53,9648" — это драма И триллер И детектив, что при пороге 7.6 даёт девятнадцать фильмов
  // во всём TMDB, поэтому вторая страница была уже пустой. Через ИЛИ у того же настроения ~1000.
  const p = (extra: Record<string, string>): Record<string, string> => ({
    sort_by: 'popularity.desc',
    'vote_count.gte': floor,
    // В ряду настроения — только по-настоящему хорошее кино: это предложение на СЕГОДНЯШНИЙ вечер,
    // и оно не вправе подсовывать просто популярное.
    'vote_average.gte': '7.6',
    page,
    ...extra,
  });

  // Праздничные варианты («ночь под Новый год», «Хэллоуин») в мобильной версии пока не переносил —
  // за них в оригинале отвечает Occasions.kt (25 КБ календаря), это отдельный этап.

  /*
    ПРАЗДНИК — СВОИ РЯДЫ ПО ВРЕМЕНИ СУТОК (как у Влада, R4/j3.A): в сезон Хэллоуина и Нового года
    ряд «по времени суток» тоже праздничный, отсортирован по оценке, порог — 120 оценок.
  */
  const v = (now.getMonth() + 1) * 100 + now.getDate();
  const hp = (extra: Record<string, string>): Record<string, string> => ({
    sort_by: 'vote_average.desc',
    'vote_count.gte': '120',
    page,
    ...extra,
  });
  if (v >= 1212 || v <= 107) {
    if (h < 5) return { title: 'Ночь под Новый год', params: hp({ with_keywords: '207317|252123', with_genres: '18|14|53' }) };
    if (h < 12) return { title: 'Новогоднее утро', params: hp({ with_keywords: '207317|252123|337410', with_genres: '10751|16|35' }) };
    if (h < 17) return { title: 'Праздничный день', params: hp({ with_keywords: '207317|252123|5570', with_genres: '10751|35|14' }) };
    return { title: 'Новогодний вечер', params: hp({ with_keywords: '207317|252123|613', with_genres: '35|10749|14' }) };
  }
  if (v >= 1008 && v < 1104) {
    if (h < 5) return { title: 'Ночь ужасов', params: hp({ with_genres: '27', 'vote_count.gte': '800' }) };
    if (h < 12) return { title: 'Утро перед Хэллоуином', params: hp({ with_keywords: '3335|616', with_genres: '10751|16|35' }) };
    if (h < 17) return { title: 'Тыквы и ведьмы', params: hp({ with_keywords: '3335|616|3358', with_genres: '14|35|10751' }) };
    return { title: 'Хэллоуинский вечер', params: hp({ with_genres: '27|53', 'vote_count.gte': '500' }) };
  }

  if (h < 5) {
    // Глубокая ночь: ужасы и триллеры уместны именно здесь — и только здесь.
    return { title: 'Для позднего вечера', params: p({ with_genres: '27|53' }) };
  }
  if (weekend && h >= 6 && h <= 11) {
    // Выходное утро: неспешно — комедии/семейное/мультфильмы, ничего мрачного.
    return {
      title: 'Неспешное утро',
      params: p({ with_genres: '35|10751|16', without_genres: '27,53,80' }),
    };
  }
  if (h >= 5 && h <= 11) {
    return {
      title: 'С добрым утром!',
      params: p({ with_genres: '35|12|10751', without_genres: '27,53,80' }),
    };
  }
  if (h >= 12 && h <= 16) {
    // День: приключения и комедии, никакой расчленёнки к обеду.
    return { title: 'Днём под настроение', params: p({ with_genres: '12|35|28', without_genres: '27' }) };
  }
  if (friday && h >= 17) {
    return { title: 'Вечер пятницы — время кино', params: p({ with_genres: '28|12|878' }) };
  }
  if (h >= 17 && h <= 23) {
    // Обычный вечер: драма/триллер, ужасы всё ещё ждут ночи.
    return { title: 'Сегодня вечером', params: p({ with_genres: '18|53|9648', without_genres: '27' }) };
  }
  return { title: 'Популярные фильмы', params: p({}) };
}

/** Ключ «дата + слот настроения»: если экран открыт с обеда до ночи или пережил полночь, лента
 * должна пересобраться, иначе она так и будет предлагать «Днём под настроение». */
export function feedSlotKey(now = new Date()): string {
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now.getTime() - start.getTime()) / 86400000);
  return `${now.getFullYear()}-${dayOfYear}|${liveRowSpec(now).title}`;
}
