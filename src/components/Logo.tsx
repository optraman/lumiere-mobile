import { Image, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../theme/colors';

/**
 * Портировано из ui/components/Logo.kt.
 *
 * Надпись «ЛЮМЬЕР» — настоящие файлы Влада. С 12 декабря по 7 января бренд надевает шапку Деда
 * Мороза, остальное время — обычная надпись, и переключается это само, без сборки.
 *
 * ОКНО ДАТ ВЗЯТО ИЗ КОДА, А НЕ ИЗ КОММЕНТАРИЯ. В Logo.kt написано «From 10 December to 8 January»,
 * но сама isNewYearSeason() в Occasions.kt считает иначе:
 *     v = месяц*100 + день;  return v >= 1212 || v <= 107
 * то есть с 12 декабря по 7 января включительно. Комментарий у Влада устарел; здесь повторено
 * поведение кода — «двадцать дней до Нового года, и всё заканчивается седьмого января».
 *
 * Это ОДНО окно на весь праздник: та же проверка включает карточку «Итоги года» и новогодний
 * марафон. Если менять даты — менять здесь, а не заводить второй календарь.
 */
export function isNewYearSeason(now = new Date()): boolean {
  const v = (now.getMonth() + 1) * 100 + now.getDate();
  return v >= 1212 || v <= 107;
}

/**
 * ОДИН размер логотипа на всё приложение. Он стоял по-разному на разных экранах (26 в поиске, 29 на
 * главной), и это читалось как небрежность: логотип — постоянная величина, он не может быть на
 * одном экране крупнее, чем на соседнем.
 */
export const LOGO_HEIGHT = 28;

const WORDMARK = require('../../assets/brand/brand_wordmark.png');
const WORDMARK_NY = require('../../assets/brand/brand_wordmark_ny.png');
const WORDMARK_HALLOWEEN = require('../../assets/brand/brand_wordmark_halloween.png');

/** Хэллоуинское окно Влада (Occasions.kt): с 8 октября по 3 ноября — паук вместо треугольника в «Ю». */
export function isHalloweenSeason(now = new Date()): boolean {
  const v = (now.getMonth() + 1) * 100 + now.getDate();
  return v >= 1008 && v <= 1103;
}

/**
 * Где в каждом файле стоят БУКВЫ (в пикселях файла). Файлы разные: обычный и новогодний —
 * с большим полем под свечение, хэллоуинский из APK обрезан плотно. Чтобы надпись была одного
 * размера и стояла на одном месте в любой сезон (и чтобы заставка прилетала ровно в неё),
 * коробка логотипа всегда считается по обычному файлу, а сезонная картинка подгоняется в неё по
 * буквам.
 */
type Art = { src: number; w: number; h: number; x0: number; x1: number; y0: number; y1: number };
const BASE: Art = { src: WORDMARK, w: 1469, h: 333, x0: 51, x1: 1391, y0: 79, y1: 252 };
const NY: Art = { src: WORDMARK_NY, w: 1584, h: 333, x0: 51, x1: 1391, y0: 79, y1: 252 };
const HALLOWEEN: Art = { src: WORDMARK_HALLOWEEN, w: 1140, h: 186, x0: 15, x1: 1119, y0: 21, y1: 162 };

/** Соотношение сторон коробки логотипа (ширина / высота). */
export const LOGO_RATIO = BASE.w / BASE.h;
/** Доля ширины коробки, которую занимают буквы, и их центр — нужны заставке. */
export const LOGO_LETTERS = { w: (BASE.x1 - BASE.x0) / BASE.w, cx: (BASE.x0 + BASE.x1) / 2 / BASE.w, cy: (BASE.y0 + BASE.y1) / 2 / BASE.h };

function artNow(): Art {
  if (isNewYearSeason()) return NY;
  if (isHalloweenSeason()) return HALLOWEEN;
  return BASE;
}

/**
 * Полная надпись «ЛЮМЬЕР». Пропорции у файлов РАЗНЫЕ, поэтому коробка — по обычному файлу, а
 * картинка сезона кладётся внутрь так, чтобы её буквы совпали с буквами обычной (см. Art).
 * tint/blur — для ореола на заставке (тот же силуэт, размытый и окрашенный).
 */
export function LogoWordmark({
  height = LOGO_HEIGHT,
  style,
  tint,
  blur,
}: {
  height?: number;
  style?: StyleProp<ViewStyle>;
  tint?: string;
  blur?: number;
}) {
  const art = artNow();
  const boxW = height * LOGO_RATIO;
  // Масштаб, при котором высота букв сезонной картинки равна высоте букв обычной.
  const k = (height * (BASE.y1 - BASE.y0)) / BASE.h / (art.y1 - art.y0);
  const left = (BASE.x0 / BASE.h) * height - art.x0 * k;
  const top = (BASE.y0 / BASE.h) * height - art.y0 * k;
  return (
    <View style={[{ width: boxW, height, overflow: 'visible' }, style]} pointerEvents="none">
      <Image
        source={art.src}
        style={{ position: 'absolute', left, top, width: art.w * k, height: art.h * k, tintColor: tint }}
        blurRadius={blur}
        resizeMode="stretch"
      />
    </View>
  );
}

/**
 * Компактный знак — рамка киноплёнки с треугольником-лучом, перенесён путь в путь из
 * res/drawable/logo_mark.xml.
 *
 * У Влада в этом месте (LogoMark) используется растровый logo_mark_img — «металлический» знак.
 * Его в передаче нет: `.gitignore` с безусловным правилом `*.png` вынес всю папку
 * res/drawable-nodpi. Вектор ниже — то, что дошло, потому что он .xml. Если знак найдётся,
 * заменить здесь.
 */
export function LogoMark({ size = 26, color = colors.onBg }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path
        d="M16,7 L32,7 A9,9 0 0 1 41,16 L41,32 A9,9 0 0 1 32,41 L16,41 A9,9 0 0 1 7,32 L7,16 A9,9 0 0 1 16,7 Z"
        stroke={color}
        strokeWidth={3.2}
        fill="none"
      />
      <Path d="M20,16.5 L20,31.5 L32,24 Z" fill={color} />
    </Svg>
  );
}
