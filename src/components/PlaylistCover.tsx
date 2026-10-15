import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { FadeInImage } from './FadeInImage';
import { colors } from '../theme/colors';

/*
  РАЗМЕР КАРТИНКИ — ПО РАЗМЕРУ КЛЕТКИ. Постеры приходят адресами w500, а на плитке главной клетка
  мозаики — 28–56 точек: каждая картинка тянула и декодировала в разы больше пикселей, чем
  показывает. Берём ближайший размер TMDB, покрывающий клетку на экране @3x: мелким клеткам — w185,
  средним — w342; крупная обложка плейлиста (180 точек) остаётся на w500, чтобы не размылась.
  Подменяется только сегмент размера в адресе TMDB; чужие адреса остаются как есть.
*/
function cellUrl(u: string, w: number, h: number): string {
  const px = Math.max(w, h * (2 / 3)) * 3; // постер 2:3 — по высоте клетки нужна ширина в 2/3
  const size = px <= 185 ? 'w185' : px <= 342 ? 'w342' : null;
  // Трогаем только постерный w500: задники кинофестов уже w300, и уменьшать их некуда.
  return size ? u.replace('/t/p/w500/', `/t/p/${size}/`) : u;
}

/**
 * ОБЛОЖКА-МОЗАИКА — для плиток главной и плейлистов: сколько есть картинок, столько и показываем.
 *   1 — во всю обложку; 2 — две половины; 3 — большая слева и две справа; 4 и больше — два на два.
 * Картинок нет — значок списка.
 */
/*
  В memo: плитки главной перерисовываются от прогресса загрузок, а обложка от него не меняется —
  при том же массиве адресов мозаика пропускает сборку и не трогает картинки.
*/
export const Mosaic = memo(function Mosaic({ uris, size, icon }: { uris: (string | null | undefined)[]; size: number; icon: SFSymbol }) {
  const list = [...new Set(uris.filter((u): u is string => !!u))].slice(0, 4);
  const half = size / 2;
  const cell = (u: string, w: number, h: number, key: string) => (
    <FadeInImage key={key} source={{ uri: cellUrl(u, w, h) }} style={{ width: w, height: h }} resizeMode="cover" />
  );
  return (
    <View style={[styles.box, { width: size, height: size }]}>
      {list.length === 0 ? (
        <SymbolView name={icon} size={Math.round(size * 0.38)} tintColor={colors.focusFill} />
      ) : list.length === 1 ? (
        cell(list[0], size, size, 'a')
      ) : list.length === 2 ? (
        <View style={styles.row}>
          {cell(list[0], half, size, 'a')}
          {cell(list[1], half, size, 'b')}
        </View>
      ) : list.length === 3 ? (
        <View style={styles.row}>
          {cell(list[0], half, size, 'a')}
          <View>
            {cell(list[1], half, half, 'b')}
            {cell(list[2], half, half, 'c')}
          </View>
        </View>
      ) : (
        <View style={styles.wrap}>{list.map((u, i) => cell(u, half, half, String(i)))}</View>
      )}
    </View>
  );
});

/** «3 тайтла», «пусто». */
export function countLabel(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? 'тайтл' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'тайтла' : 'тайтлов';
  return n === 0 ? 'пусто' : `${n} ${w}`;
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceHi },
  row: { flexDirection: 'row', ...StyleSheet.absoluteFill },
  wrap: { ...StyleSheet.absoluteFill, flexDirection: 'row', flexWrap: 'wrap' },
});
