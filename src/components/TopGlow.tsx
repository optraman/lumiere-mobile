import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { StaticGlow } from './StaticGlow';
import { colors } from '../theme/colors';
import { usePortraitInsets, usePortraitWindow } from '../nav/portrait';

/**
 * СВЕЧЕНИЕ ТОЛЬКО СВЕРХУ — как на странице сезонов: тот же свет приложения у шапки, а ниже он
 * очень плавно уходит в чёрное (чуть ниже заголовка, без обрыва). Под списками свет не нужен, а
 * рисовать его там — лишняя работа телефону. Одни пропорции на все страницы: настройки, списки с
 * главной, загрузки, кинофесты, сезоны.
 */
export const TopGlow = memo(function TopGlow() {
  const insets = usePortraitInsets();
  const { width, height } = usePortraitWindow();
  return (
    <View style={[styles.wrap, { height: insets.top + 300 }]} pointerEvents="none">
      {/* Векторный свет — есть с первого кадра, без подгрузки картинок. */}
      {/* Чуть ярче фона лент (×1.35): у страниц свет только вверху, и он должен читаться. */}
      <StaticGlow width={width} height={height} strength={1.35} visible={insets.top + 300} />
      <LinearGradient
        colors={['rgba(8,8,10,0)', 'rgba(8,8,10,0)', 'rgba(8,8,10,0.55)', colors.bg]}
        locations={[0, 0.3, 0.62, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' },
});
