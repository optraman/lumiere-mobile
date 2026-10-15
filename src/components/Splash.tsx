import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { StaticGlow } from './StaticGlow';
import { LogoWordmark } from './Logo';
import { usePortraitWindow } from '../nav/portrait';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

/*
  ЗАСТАВКА — ПРОСТО «ЛЮМЬЕР» НА СВЕЧЕНИИ (просьба Марка): пока лента собирается, на чёрном стоит
  надпись, за ней тёплый свет приложения (векторный — есть с первого кадра). Лента готова — всё
  вместе растворяется за полсекунды, и пункты Главной проявляются из пустоты один за другим
  (см. FeedScreen).

  Чёрный лист держит касания, пока под ним собирается лента (нажатие вслепую открыло бы то, чего
  человек не видел). Готовности ждём не дольше 9 секунд.
*/
const MAX_WAIT_MS = 9000;

export function Splash({ ready, onDone }: { ready: boolean; onDone?: () => void }) {
  const [gone, setGone] = useState(false);
  const [expired, setExpired] = useState(false);
  const started = useRef(false);
  const o = useSharedValue(1);

  useEffect(() => {
    const t = setTimeout(() => setExpired(true), MAX_WAIT_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!(ready || expired) || started.current) return;
    started.current = true;
    o.value = withTiming(0, { duration: 520, easing: Easing.inOut(Easing.quad) }, () => {
      runOnJS(setGone)(true);
    });
    // Страховка: заставка снимается в любом случае — даже если её уход чем-то перебили.
    setTimeout(() => setGone(true), 900);
  }, [ready, expired, o]);

  useEffect(() => {
    if (gone) onDone?.();
  }, [gone, onDone]);

  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  const { width, height } = usePortraitWindow();
  if (gone) return null;
  const logoH = Math.round(width * 0.11);
  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.black, st]} pointerEvents={ready || expired ? 'none' : 'auto'}>
      <StaticGlow width={width} height={height} strength={1.6} />
      <View style={styles.center}>
        <LogoWordmark height={logoH} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  black: { backgroundColor: '#000' },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
});
