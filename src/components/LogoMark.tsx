import { useMemo } from 'react';
import { Image, View } from 'react-native';
import { markBox, type LogoLook } from '../api/logoLook';
import { colors } from '../theme/colors';

/**
 * Логотип названия — везде, где он показывается: в карточке на главной, заголовком страницы фильма
 * и ярлыком в её шапке.
 *
 * Один компонент, потому что правил ровно два и они общие. Размер считается по площади самой марки
 * (см. markBox). Марка, нарисованная исключительно чёрным, показывается силуэтом в цвете текста —
 * иначе на тёмной афише её не видно вовсе; прозрачность файла при этом сохраняется, теряется
 * только собственный цвет, а у чёрного логотипа терять нечего.
 *
 * Возвращает null, если размер посчитать не из чего: тогда место вызова показывает свой запасной
 * вариант (текст названия или логотип, вписанный целиком).
 */
export function LogoMark({
  url,
  look,
  fallbackRatio = null,
  maxWidth,
  maxHeight,
  area,
  minHeight = 22,
  onLoad,
}: {
  url: string;
  look: LogoLook | null;
  fallbackRatio?: number | null;
  maxWidth: number;
  maxHeight: number;
  /** Сколько места марка должна занимать в этом месте интерфейса. */
  area: number;
  minHeight?: number;
  onLoad?: () => void;
}) {
  const box = useMemo(
    () => markBox(look, fallbackRatio, { maxW: maxWidth, maxH: maxHeight, area, minH: minHeight }),
    [look, fallbackRatio, maxWidth, maxHeight, area, minHeight],
  );

  if (!box) return null;

  return (
    // Окно ровно по марке; холст лежит в нём растянутым и сдвинутым так, что поля файла остаются
    // снаружи. resizeMode="stretch" здесь не искажает: iw/ih в точности равны пропорции холста.
    <View style={{ width: box.w, height: box.h, overflow: 'hidden' }}>
      <Image
        source={{ uri: url }}
        resizeMode="stretch"
        onLoad={onLoad}
        style={{
          position: 'absolute',
          left: box.left,
          top: box.top,
          width: box.iw,
          height: box.ih,
          tintColor: look?.dark ? colors.onBg : undefined,
        }}
      />
    </View>
  );
}
