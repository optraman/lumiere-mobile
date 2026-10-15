import { useEffect, useState } from 'react';
import { probePng } from './pngProbe';

/**
 * Что мы знаем о конкретном логотипе, кроме его адреса.
 *
 * Доли, а не пиксели: файл показывается в другом размере, чем разбирается, и всё, что переносится
 * между ними без пересчёта, — это отношения.
 */
export type LogoLook = {
  /** Отступ марки от левого/верхнего края холста, в долях холста. */
  ox: number;
  oy: number;
  /** Размер самой марки, в долях холста. */
  fw: number;
  fh: number;
  /** Пропорция МАРКИ (а не холста): по ней и считается размер на экране. */
  ratio: number;
  /** Марка нарисована ИСКЛЮЧИТЕЛЬНО чёрным — на афише её не видно. */
  dark: boolean;
};

/**
 * КОГДА МАРКА СЧИТАЕТСЯ ЧЁРНОЙ — и почему одной средней светлоты для этого мало.
 *
 * По средней светлоте чёрной оказывалась и красная марка «Человека-паука»: чистый красный весит
 * около шестидесяти из двухсот пятидесяти пяти, потому что глаз (и формула светлоты вслед за ним)
 * считает красный тёмным цветом. Перекрашивать её было нечего — она прекрасно видна.
 *
 * Поэтому условий два, и оба обязательны.
 *
 * САМЫЕ СВЕТЛЫЕ пиксели марки должны быть тёмными. Берётся не среднее, а 97-й процентиль: у
 * чёрной марки с белой деталью среднее вполне может остаться низким, а деталь — единственное, что
 * на афише и видно, и трогать такую марку нельзя.
 *
 * ЦВЕТА не должно быть вовсе. Разброс между каналами больше сорока — это уже цвет, а не оттенок
 * серого; два процента таких пикселей списываются на кайму и сжатие, больше — марка цветная.
 */
const DARK_LUM_HI = 60;
const DARK_COLOR_FRAC = 0.02;

const cache = new Map<string, LogoLook | null>();
/*
  РАЗБОРЫ В ПУТИ. Готовый результат лежит в cache, но пока он не готов, страница фильма и её
  TitleMark (и заставка через primeLogoLook) запрашивали и разбирали один и тот же PNG каждый
  сам — два запроса и два разбора разом, в момент открытия. Теперь второй ждёт первый.
*/
const pending = new Map<string, Promise<LogoLook | null>>();

/** Один разбор на адрес: готовый — из кэша, идущий — тот же самый промис. */
function lookOnce(url: string): Promise<LogoLook | null> {
  const hit = cache.get(url);
  if (hit !== undefined) return Promise.resolve(hit);
  let p = pending.get(url);
  if (!p) {
    p = lookAt(url).then(
      (l) => {
        cache.set(url, l);
        pending.delete(url);
        return l;
      },
      (e) => {
        // Сбой не кэшируется (как и раньше): следующий показ попробует заново.
        pending.delete(url);
        throw e;
      },
    );
    pending.set(url, p);
  }
  return p;
}

function bytesOf(url: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    // XMLHttpRequest, а не fetch: у fetch в React Native не работает response.arrayBuffer() —
    // под ним FileReader без readAsArrayBuffer. XHR с responseType 'arraybuffer' поддержан.
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    // Ограничение обязательно: без него зависший запрос оставил бы название текстом навсегда —
    // разбор ждут, чтобы не дёргать логотип в размере, и ждать его молча нельзя.
    xhr.timeout = 8000;
    xhr.onload = () =>
      resolve(xhr.status === 200 && xhr.response ? new Uint8Array(xhr.response as ArrayBuffer) : null);
    xhr.onerror = () => resolve(null);
    xhr.ontimeout = () => resolve(null);
    xhr.send();
  });
}

async function lookAt(url: string): Promise<LogoLook | null> {
  // Разбираем МАЛЕНЬКУЮ копию: для рамки и светлоты её хватает с запасом, а весит она пару
  // килобайт вместо полусотни.
  const small = url.replace(/\/t\/p\/w\d+\//, '/t/p/w154/');
  const bytes = await bytesOf(small);
  if (!bytes) return null;
  const p = probePng(bytes);
  if (!p) return null;

  const inkW = p.x1 - p.x0 + 1;
  const inkH = p.y1 - p.y0 + 1;
  if (inkW < 2 || inkH < 2) return null;

  return {
    ox: p.x0 / p.w,
    oy: p.y0 / p.h,
    fw: inkW / p.w,
    fh: inkH / p.h,
    ratio: inkW / inkH,
    dark: p.lumHi < DARK_LUM_HI && p.colorFrac < DARK_COLOR_FRAC,
  };
}

/** Разбор, если он уже сделан. Undefined — ещё не разбирали. */
export function logoLookCached(url: string): LogoLook | null | undefined {
  return cache.get(url);
}

/**
 * Разобрать логотип заранее и положить в тот же кэш, из которого берёт useLogoLook.
 *
 * Нужно заставке: разбор занимает один небольшой запрос, и лучше он произойдёт под ней, чем на
 * глазах у человека — иначе логотип на карточке появится не сразу и не в том размере.
 */
export async function primeLogoLook(url: string): Promise<void> {
  if (cache.has(url)) return;
  // Через общий разбор: если страница уже разбирает этот же файл, второго запроса не будет.
  await lookOnce(url);
}

/**
 * Разбор логотипа. Один раз на файл за всё время работы приложения — результат не меняется.
 *
 * ТРИ СОСТОЯНИЯ, и это важно: undefined — разбор ещё идёт, null — разобрать не вышло (и логотип
 * надо показывать как есть), объект — разобрали. Без различия между «ещё не знаем» и «знаем, что
 * ничего» логотип пришлось бы сначала показать по холсту, а потом на глазах пересчитать по марке —
 * то есть дёрнуть его в размере через полсекунды после появления.
 */
export function useLogoLook(url: string | null): LogoLook | null | undefined {
  /*
    Начальное значение читается из кэша ПРЯМО ПРИ СБОРКЕ, а не в эффекте. Эффекты выполняются после
    кадра, и известный ответ приходил бы через кадр после появления — а этого кадра хватает, чтобы
    показать пустоту там, где логотип уже готов.
  */
  const [look, setLook] = useState<LogoLook | null | undefined>(() =>
    url ? cache.get(url) : null,
  );

  useEffect(() => {
    if (!url) {
      setLook(null);
      return;
    }
    const hit = cache.get(url);
    if (hit !== undefined) {
      setLook(hit);
      return;
    }
    let cancelled = false;
    setLook(undefined);
    // Общий промис на адрес (lookOnce): страница и TitleMark больше не качают файл дважды.
    void lookOnce(url).then((l) => {
      if (!cancelled) setLook(l);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return look;
}

/** Готовая геометрия марки: коробка окна и положение растянутого холста внутри него. */
export type MarkBox = {
  /** Размер видимой марки. */
  w: number;
  h: number;
  /** Размер и сдвиг всего холста — так, чтобы в окне оказалась ровно марка. */
  iw: number;
  ih: number;
  left: number;
  top: number;
};

/**
 * РАЗМЕР МАРКИ — общий расчёт для всех мест, где показывается логотип.
 *
 * Правило одно на всё приложение: фиксируется ПЛОЩАДЬ марки, а высота и ширина выводятся из
 * пропорции. Глаз сравнивает не высоту и не ширину, а количество занятого места, поэтому длинная
 * надпись выходит ниже и шире, короткая — выше и уже, но весят они одинаково. Меняется от места к
 * месту только сама площадь: в карточке марка — подпись, на странице фильма — заголовок, в шапке —
 * строка ярлыка, и это три разных размера одного и того же.
 *
 * Считается по РАМКЕ НЕПРОЗРАЧНОГО, а не по холсту файла: у логотипов TMDB вокруг марки бывает
 * прозрачное поле в половину файла, и подгонка по холсту делала такие названия вдвое мельче
 * прочих без всякой причины.
 */
export function markBox(
  look: LogoLook | null,
  /** Пропорция холста — запасной вариант, когда файл разобрать не удалось. */
  fallbackRatio: number | null,
  box: { maxW: number; maxH: number; area: number; minH: number },
): MarkBox | null {
  const ratio = look ? look.ratio : fallbackRatio;
  if (!ratio || !box.maxW) return null;

  let h = Math.min(Math.max(Math.sqrt(box.area / ratio), box.minH), box.maxH);
  let w = h * ratio;
  // Шире отведённого быть не может — тогда упираемся в ширину и пересчитываем высоту обратно.
  if (w > box.maxW) {
    w = box.maxW;
    h = w / ratio;
  }

  const fw = look?.fw ?? 1;
  const fh = look?.fh ?? 1;
  const iw = w / fw;
  const ih = h / fh;
  return { w, h, iw, ih, left: -(look?.ox ?? 0) * iw, top: -(look?.oy ?? 0) * ih };
}
