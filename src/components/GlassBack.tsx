import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { colors } from '../theme/colors';

/**
 * СТРЕЛКА «НАЗАД» ИЗ СТЕКЛА — одна на всё приложение, ТОЧНО ТАКАЯ ЖЕ, КАК В ПЛЕЕРЕ.
 *
 * Первая версия брала тёмную панель плеера (Glass, с подкрашиванием) — на экране это читалось как
 * прежний тёмный кружок, а не как стекло. Теперь материал один в один с кнопками плеера
 * (GlassButton): прозрачное Liquid Glass без подкраски, которое само отзывается на касание; на iOS
 * ниже 26 — то же размытие с лёгким тоном. Размер тот же — 40.
 *
 * Стекло лежит отдельным неподвижным слоем под значком: его не трогают ни прозрачностью, ни
 * масштабом — от этого системный материал иногда пропадает (см. GlassButton, п. 1).
 */
export const BACK_SIZE = 40;

/** Сколько места оставить справа от кнопки, чтобы заголовок рядом её не касался. */
export const BACK_GAP = 14;

const R = BACK_SIZE / 2;

export function GlassBack({ onPress, style }: { onPress: () => void; style?: StyleProp<ViewStyle> }) {
  const glass = isLiquidGlassAvailable();
  return (
    <Pressable onPress={onPress} hitSlop={12} style={style}>
      {({ pressed }) => (
        <View style={[styles.circle, !glass && styles.clip]}>
          {glass ? (
            <GlassView style={[StyleSheet.absoluteFill, styles.round]} glassEffectStyle="clear" colorScheme="dark" isInteractive />
          ) : (
            <BlurView intensity={40} tint="dark" style={[StyleSheet.absoluteFill, styles.fallback]} />
          )}
          <View style={[styles.icon, pressed && styles.pressed]}>
            <SymbolView name="chevron.backward" size={19} type="hierarchical" tintColor={colors.onBg} />
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  circle: { width: BACK_SIZE, height: BACK_SIZE, borderRadius: R, alignItems: 'center', justifyContent: 'center' },
  round: { borderRadius: R },
  clip: { overflow: 'hidden' },
  fallback: { backgroundColor: 'rgba(10,10,12,0.22)' },
  // Стрелка на пару точек левее середины выглядит смещённой: у шеврона «вес» справа.
  icon: { marginLeft: -2 },
  pressed: { opacity: 0.45 },
});
