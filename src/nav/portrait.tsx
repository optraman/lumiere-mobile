import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';

/**
 * ПРИЛОЖЕНИЕ ВСЕГДА СТОИТ, ДАЖЕ КОГДА ЛЕЖИТ ПЛЕЕР.
 *
 * Плеер снимает замок ориентации — и система поворачивает всё окно, в том числе страницы под
 * ним. Их почти не видно (плеер сверху), но при смахивании кадра они открываются — и были
 * лежачими. Поворачивать ради этого весь экран в портрет посреди жеста нельзя: всё ломается.
 *
 * Поэтому страницы приложения живут в «сцене», которая лёжа сама остаётся портретной: это
 * прямоугольник портретных размеров, повёрнутый ровно настолько, чтобы относительно телефона
 * он стоял как раньше. Плеер же открывается системным окном поверх и в сцену не входит — он
 * лежит, как положено. Получается то, что нужно: повернулся только плеер.
 *
 * Страницы внутри сцены не должны знать, что окно легло: для них есть usePortraitWindow и
 * usePortraitInsets — размеры и поля всегда портретные.
 */

let lastPortraitInsets: EdgeInsets | null = null;

/** Размеры окна, всегда портретные: страницы приложения раскладываются только так. */
export function usePortraitWindow(): { width: number; height: number } {
  const { width, height } = useWindowDimensions();
  return { width: Math.min(width, height), height: Math.max(width, height) };
}

/** Безопасные поля, всегда портретные: лёжа берутся последние портретные. */
export function usePortraitInsets(): EdgeInsets {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  if (width <= height) {
    lastPortraitInsets = insets;
    return insets;
  }
  return lastPortraitInsets ?? { top: Math.max(insets.left, insets.right, 47), bottom: insets.bottom || 34, left: 0, right: 0 };
}

export function PortraitStage({ children }: { children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  const [orient, setOrient] = useState<ScreenOrientation.Orientation>(ScreenOrientation.Orientation.PORTRAIT_UP);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void ScreenOrientation.getOrientationAsync()
      .then((o) => alive.current && setOrient(o))
      .catch(() => undefined);
    const sub = ScreenOrientation.addOrientationChangeListener((e) => setOrient(e.orientationInfo.orientation));
    return () => {
      alive.current = false;
      ScreenOrientation.removeOrientationChangeListener(sub);
    };
  }, []);

  const wide = width > height;
  /*
    Дерево одно и то же в обоих положениях — меняется только стиль внутреннего слоя. Иначе при
    каждом повороте плеера все страницы под ним пересоздавались бы с нуля и теряли состояние.

    Угол: экран лёг «влево» (UIInterfaceOrientation.landscapeLeft — телефон повёрнут по часовой)
    — портретная сцена поворачивается на +90°, «вправо» — на −90°.
  */
  const style = wide
    ? {
        position: 'absolute' as const,
        width: height,
        height: width,
        left: (width - height) / 2,
        top: (height - width) / 2,
        transform: [{ rotate: orient === ScreenOrientation.Orientation.LANDSCAPE_RIGHT ? '-90deg' : '90deg' }],
      }
    : { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };

  return (
    <View style={styles.outer}>
      <View style={style}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { flex: 1, overflow: 'hidden' },
});
