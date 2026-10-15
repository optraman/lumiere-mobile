import { StyleSheet, View, type ViewProps } from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';

/**
 * ЖИДКОЕ СТЕКЛО — НАСТОЯЩЕЕ, А НЕ ПОХОЖЕЕ.
 *
 * На iOS 26 есть системный материал Liquid Glass: он не просто размывает фон, а преломляет его,
 * подхватывает движение под собой и подстраивает контраст под то, что сейчас за ним. Нарисовать
 * такое вручную нельзя — можно только позвать. Зовём: expo-glass-effect отдаёт ровно этот материал.
 *
 * Там, где его нет (iOS до 26), падаем на размытие. Это честная замена, а не подделка: тот же
 * тёмный полупрозрачный слой, просто без преломления.
 *
 * Поверх видео материал обязан быть ТЁМНЫМ и НЕ интерактивным: кадр под панелью бывает и белым, и
 * чёрным, а подписи на ней должны читаться в обоих случаях.
 */
export function Glass({
  style,
  radius = 22,
  children,
  ...rest
}: ViewProps & { radius?: number }) {
  const shape = [styles.base, { borderRadius: radius }, style];
  if (isLiquidGlassAvailable()) {
    return (
      <GlassView {...rest} style={shape} glassEffectStyle="regular" colorScheme="dark" tintColor="rgba(10,10,12,0.35)">
        {children}
      </GlassView>
    );
  }
  return (
    <View {...rest} style={shape}>
      <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, styles.fallbackTint]} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { overflow: 'hidden' },
  // Тот же тон, что даёт tintColor у стекла, — чтобы на старых системах панель не «светлела».
  fallbackTint: { backgroundColor: 'rgba(10,10,12,0.35)' },
});
