import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { TitleMenuHost } from '../components/TitleMenu';
import { useOwnBack } from './useOwnBack';
import { Animated, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useScreenZoom } from './useScreenZoom';
import { useZoomBack } from './zoomBack';
import { ScreenBackdrop } from '../components/ScreenBackdrop';
import { colors } from '../theme/colors';

/**
 * СТРАНИЦА С ТЕМ ЖЕ ПОЯВЛЕНИЕМ, ЧТО У ВСЕГО ПРИЛОЖЕНИЯ.
 *
 * Списки с главной («Моё», «История», «Загрузки»…) открывались системным сдвигом справа, а всё
 * остальное в Люмьере — своим: страница вырастает из 88% и проявляется, закрывается обратным
 * движением, а жест от левого края тянет эту же величину под пальцем (useScreenZoom). Два
 * разных движения в одном приложении читались как два разных приложения. Теперь одно.
 */
const CloseCtx = createContext<() => void>(() => router.back());

/** Закрыть страницу тем же движением, что и жестом (для стрелки «назад»). */
export function useZoomClose(): () => void {
  return useContext(CloseCtx);
}

export function ZoomPage({ children }: { children: ReactNode }) {
  const goBack = useOwnBack();
  const zoom = useScreenZoom(goBack);
  const close = useCallback(() => zoom.close(0), [zoom]);

  // Жест от левого края: только движение вправо — горизонтальные ряды внутри страницы не страдают.
  const back = useZoomBack({
    setProgress: zoom.setProgress,
    settleOpen: zoom.settleOpen,
    close: zoom.close,
    failY: true,
  });

  return (
    <View style={styles.root} pointerEvents={zoom.interactive ? 'auto' : 'none'}>
      <ScreenBackdrop style={zoom.backdropStyle} />
      <GestureDetector gesture={back}>
        <Animated.View style={[styles.page, zoom.pageStyle]}>
          <CloseCtx.Provider value={close}>{children}</CloseCtx.Provider>
        </Animated.View>
      </GestureDetector>
      {/* Своё меню тайтла: корневое лежит под этим модальным окном и его не видно (TitleMenu). */}
      <TitleMenuHost />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  page: { flex: 1, backgroundColor: colors.bg },
});
