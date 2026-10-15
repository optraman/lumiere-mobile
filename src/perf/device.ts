import { Dimensions, PixelRatio, Platform } from 'react-native';

/*
  НА ЧЁМ ЗАПУЩЕНО ПРИЛОЖЕНИЕ.

  Модель iPhone из JS напрямую не узнать (без отдельного нативного модуля, а его в Expo Go не
  добавить), но экран её выдаёт однозначно: размер в точках и плотность. По ним — семейство:

    402×874 @3x — iPhone 16 Pro, 17 Pro, 17 (ProMotion 120 Гц);
    440×956 @3x — iPhone 16 Pro Max, 17 Pro Max (ProMotion);
    393×852 / 430×932 @3x — 14 Pro…16 и Plus (у Pro-версий ProMotion, у остальных 60 Гц);
    меньше — старшие поколения.

  Что из этого следует для приложения:
    • ProMotion: любая непрерывная анимация рисуется до 120 раз в секунду — вдвое дороже, чем на
      60 Гц. Поэтому фон приложения — запечённая картинка с двумя медленными пятнами, а не живые
      слои, и анимации, которые не видны, останавливаются (см. AmbientGlow, RatingFx).
    • Большой экран @3x: кадры в списках берутся ровно того размера, который виден (w300 для
      кадров серий, w780 для широких карточек) — не больше: разжатие лишних пикселей и есть нагрев.
    • Списки держат в памяти столько строк, сколько помещается на экран этой модели, с небольшим
      запасом — не больше.
*/
export type DeviceProfile = {
  family: 'pro' | 'pro-max' | 'standard' | 'plus' | 'older' | 'other';
  promotion: boolean;
  /** Сколько строк высотой ~100 точек помещается на экран. */
  rowsOnScreen: number;
};

let cached: DeviceProfile | null = null;

export function device(): DeviceProfile {
  if (cached) return cached;
  const { width, height } = Dimensions.get('screen');
  const w = Math.round(Math.min(width, height));
  const h = Math.round(Math.max(width, height));
  const scale = PixelRatio.get();
  let family: DeviceProfile['family'] = 'other';
  let promotion = false;
  if (Platform.OS === 'ios' && scale >= 3) {
    if (w === 402 && h === 874) {
      family = 'pro';
      promotion = true;
    } else if (w === 440 && h === 956) {
      family = 'pro-max';
      promotion = true;
    } else if (w === 393 && h === 852) family = 'standard';
    else if (w === 430 && h === 932) family = 'plus';
    else if (w < 393) family = 'older';
  }
  cached = { family, promotion, rowsOnScreen: Math.ceil(h / 100) };
  return cached;
}
