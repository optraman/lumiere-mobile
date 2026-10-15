import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { LayoutAnimation, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { colors } from '../theme/colors';
import { font, type as typo } from '../theme/fonts';

/**
 * «ОЗВУЧКА ДЛЯ СКАЧИВАНИЯ» — В ТОМ ЖЕ ЯЗЫКЕ, ЧТО ПЛЕЕР.
 *
 * Было системное меню iOS: серый список в пузыре, чужой шрифт, чужой синий. Посреди приложения,
 * где всё остальное — тёмное стекло, капсулы и пергаментный акцент, оно читалось как ошибка.
 * Теперь это карточка жидкого стекла снизу, как меню плеера: заголовок шрифтом Влада (Bounded),
 * озвучки — капсулами, запомненная для сериала залита пергаментом. Карточка выезжает снизу и
 * уезжает туда же — быстро, без «лесенки» строк.
 *
 * Окно — системный Modal, а не слой на экране: выбор зовут со страниц, которые сами показаны
 * отдельными окнами (страница фильма, список серий), и слой внутри них не накрыл бы экран целиком.
 */

/** Насколько уезжает карточка: за нижний край с запасом. */
const SLIDE = 520;

type Ask = {
  /**
   * Озвучки — списком или обещанием списка. Обещание — чтобы окно открывалось СРАЗУ по касанию,
   * а не после похода к источнику: пока список едет, в окне «ищу озвучки».
   */
  voices: string[] | Promise<string[]>;
  /** Заголовок вместо «Озвучка» (например, «Замена озвучки»). */
  title?: string;
  /** Пояснение над списком: «Серии 3 и 5 не содержат озвучку …». */
  note?: string;
  /** Подпись под заголовком: «Сезон 1 · Серия 3», название фильма. */
  subtitle?: string;
  /** Отмеченная озвучка — выбранная раньше для этого тайтла. */
  current?: string | null;
};

export function useVoicePicker(): { picker: React.ReactElement; askVoice: (a: Ask) => Promise<string | null> } {
  const [ask, setAsk] = useState<Ask | null>(null);
  const resolver = useRef<((v: string | null) => void) | null>(null);

  const askVoice = useCallback((a: Ask) => {
    resolver.current?.(null);
    setAsk(a);
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const done = useCallback((v: string | null) => {
    resolver.current?.(v);
    resolver.current = null;
    setAsk(null);
  }, []);

  return { picker: <VoicePicker ask={ask} onDone={done} />, askVoice };
}

function VoicePicker({ ask, onDone }: { ask: Ask | null; onDone: (v: string | null) => void }) {
  const insets = useSafeAreaInsets();
  /** Что сейчас показано — держится и во время ухода, когда ask уже снят. */
  const [shown, setShown] = useState<Ask | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  /** Список озвучек: null — ещё ищется. */
  const [list, setList] = useState<string[] | null>(null);
  /*
    ДВИЖЕНИЕ — ТОЛЬКО СДВИГОМ, БЕЗ ПРОЗРАЧНОСТИ КАРТОЧКИ.

    Первая версия проявляла карточку прозрачностью, а под ней — жидкое стекло. Стекло, которое
    рисуется полупрозрачным, система иногда не рисует вовсе — отсюда «не всегда виден фон
    списка». Теперь карточка всегда непрозрачна и просто выезжает снизу (и уезжает туда же);
    тает только затемнение. Строки больше не входят лесенкой: на длинном списке лесенка и была
    той самой медлительностью.
  */
  const dimV = useSharedValue(0);
  const y = useSharedValue(SLIDE);
  const leaving = useRef(false);
  /** Номер вопроса: уход прежнего окна не трогает уже открытое новое. */
  const gen = useRef(0);

  /*
    ОКНО ВЫЕЗЖАЕТ УЖЕ СО СПИСКОМ. Раньше оно появлялось сразу с тремя «призрачными» строками, а
    потом их подменял настоящий список другой высоты — окно прыгало. Теперь: если озвучки нашлись
    быстро (до 0.6 с — обычно они уже в памяти), окно выезжает сразу настоящим. Если ищутся дольше
    — выезжает с одной строкой «Ищу озвучки…», а когда список пришёл, окно плавно вырастает до
    него (без подмены строк).
  */
  useEffect(() => {
    if (!ask) return;
    gen.current += 1;
    let dead = false;
    let presented = false;
    leaving.current = false;
    setPicked(null);
    const present = () => {
      if (dead || presented) return;
      presented = true;
      setShown(ask);
      dimV.value = 0;
      y.value = SLIDE;
      dimV.value = withTiming(1, { duration: 160 });
      // Пружина почти без отскока и быстрая: карточка на месте за ~0,25 с.
      y.value = withSpring(0, { damping: 30, stiffness: 420, mass: 0.7, overshootClamping: true });
    };
    if (Array.isArray(ask.voices)) {
      setList(ask.voices);
      present();
    } else {
      setList(null);
      const t = setTimeout(present, 600);
      ask.voices
        .catch(() => [] as string[])
        .then((v) => {
          if (dead) return;
          clearTimeout(t);
          if (presented) LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
          setList(v);
          present();
        });
      return () => {
        dead = true;
        clearTimeout(t);
      };
    }
    return () => {
      dead = true;
    };
  }, [ask, dimV, y]);

  const leave = useCallback(
    (v: string | null) => {
      if (leaving.current) return;
      leaving.current = true;
      const finish = (value: string | null) => {
        setShown(null);
        onDone(value);
      };
      dimV.value = withTiming(0, { duration: 170 });
      // Уходит вниз с ускорением — тем же путём, каким пришла.
      // Снимается всегда (и по таймеру) — перебитый уход не должен оставлять невидимое окно.
      let done = false;
      const mine = gen.current;
      const once = (value: string | null) => {
        if (done || mine !== gen.current) return;
        done = true;
        finish(value);
      };
      y.value = withTiming(SLIDE, { duration: 190, easing: Easing.in(Easing.cubic) }, () => {
        runOnJS(once)(v);
      });
      setTimeout(() => once(v), 450);
    },
    [onDone, dimV, y],
  );

  /*
    СМАХНУТЬ ВНИЗ — ЗА ПАЛЬЦЕМ, как у остальных меню (GlassSheet): карточка едет за пальцем,
    затемнение тает вместе с ней; отпустил ниже порога или смахнул — уходит, иначе — на место.
  */
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  const cancelFromDrag = () => leaveRef.current(null);
  const drag = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(10)
        .failOffsetY(-8)
        .failOffsetX([-20, 20])
        .onUpdate((e) => {
          const t = e.translationY;
          y.value = t > 0 ? t : -Math.min(18, Math.sqrt(-t) * 2);
          dimV.value = 1 - Math.min(0.85, Math.max(0, t) / 420);
        })
        .onEnd((e) => {
          if (e.translationY > 110 || e.velocityY > 800) runOnJS(cancelFromDrag)();
          else {
            y.value = withSpring(0, { damping: 30, stiffness: 420, mass: 0.7, overshootClamping: true });
            dimV.value = withTiming(1, { duration: 160 });
          }
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [y, dimV],
  );

  const dim = useAnimatedStyle(() => ({ opacity: dimV.value }));
  const card = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));

  if (!shown) return <></>;
  const many = list?.length ?? 0;

  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={() => leave(null)}>
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
      <Pressable style={StyleSheet.absoluteFill} onPress={() => leave(null)}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.dim, dim]} />
      </Pressable>
      <View style={[styles.slot, { paddingBottom: insets.bottom + 10 }]} pointerEvents="box-none">
        <GestureDetector gesture={drag}>
        <Animated.View style={[styles.cardWrap, card]}>
          {/* Под стеклом — своя тёмная подложка: карточка видна всегда, даже если стекло не нарисовалось. */}
          {/*
            ПЛОТНАЯ ТЁМНАЯ КАРТОЧКА ВМЕСТО ЖИДКОГО СТЕКЛА. Стекло на всю карточку пересчитывается
            системой на каждом кадре движения — окно открывалось с подтормаживанием. Цвет и форма
            те же; разница — только в том, что сквозь карточку не просвечивает фон.
          */}
          <View style={styles.cardBase}>
          <View style={styles.card}>
            <View style={styles.head}>
              <View style={styles.headIcon}>
                <SymbolView name="arrow.down" size={15} tintColor="#000" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{shown.title ?? 'Озвучка'}</Text>
                <Text style={styles.sub} numberOfLines={1}>
                  для скачивания{shown.subtitle ? ` · ${shown.subtitle}` : ''}
                </Text>
              </View>
              {list ? <Text style={styles.count}>{many}</Text> : null}
            </View>
            {shown.note ? <Text style={styles.note}>{shown.note}</Text> : null}
            {list === null ? (
              <Text style={styles.wait}>Ищу озвучки…</Text>
            ) : list.length === 0 ? (
              <Text style={styles.wait}>Источник не дал ни одной озвучки.</Text>
            ) : null}
            <ScrollView style={styles.list} contentContainerStyle={styles.listPad} showsVerticalScrollIndicator={false}>
              {(list ?? []).map((v) => {
                const on = picked ? picked === v : shown.current === v;
                return (
                  <View key={v}>
                    <Pressable
                      onPress={() => {
                        void Haptics.selectionAsync();
                        setPicked(v);
                        // Касание сперва видно (капсула заливается), и только потом окно уходит.
                        setTimeout(() => leave(v), 90);
                      }}
                      style={({ pressed }) => [styles.row, on && styles.rowOn, pressed && styles.rowDown]}
                    >
                      <Text style={[styles.rowText, on && styles.rowTextOn]} numberOfLines={1}>
                        {v}
                      </Text>
                      {on ? <SymbolView name="checkmark" size={14} tintColor="#000" /> : null}
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>
            <Pressable onPress={() => leave(null)} style={({ pressed }) => [styles.cancel, pressed && styles.rowDown]}>
              <Text style={styles.cancelText}>Отмена</Text>
            </Pressable>
          </View>
          </View>
        </Animated.View>
        </GestureDetector>
      </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dim: { backgroundColor: 'rgba(0,0,0,0.55)' },
  note: { fontFamily: font.bold, fontSize: 13, lineHeight: 18, color: colors.mutedWarm, paddingHorizontal: 20, paddingBottom: 12 },
  ghostRow: { backgroundColor: 'rgba(255,255,255,0.05)' },
  wait: { fontFamily: font.bold, fontSize: 13, color: colors.faint, textAlign: 'center', paddingVertical: 10 },
  slot: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end', paddingHorizontal: 10 },
  // Высота окна ограничена, а список внутри сжимается и прокручивается — до последней озвучки
  // и до «Отмены» можно добраться при любом их числе.
  cardWrap: { maxHeight: '78%', flexShrink: 1 },
  cardBase: { flexShrink: 1, borderRadius: 30, overflow: 'hidden', backgroundColor: '#16161A', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.1)' },
  card: { flexShrink: 1, paddingTop: 18, paddingBottom: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingBottom: 14 },
  headIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.focusFill,
  },
  title: { fontFamily: font.display, fontSize: 20, color: colors.onBg },
  sub: { ...typo.labelMedium, color: colors.mutedWarm, marginTop: 2 },
  count: { fontFamily: font.display, fontSize: 15, color: colors.faint },
  list: { flexGrow: 0, flexShrink: 1 },
  listPad: { paddingHorizontal: 12, gap: 6, paddingBottom: 10 },
  row: {
    height: 48,
    borderRadius: 24,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  rowOn: { backgroundColor: colors.focusFill },
  rowDown: { opacity: 0.6, transform: [{ scale: 0.97 }] },
  rowText: { flex: 1, fontFamily: font.bold, fontSize: 15, color: colors.onBg },
  rowTextOn: { color: '#000' },
  cancel: { height: 48, marginHorizontal: 12, marginTop: 4, alignItems: 'center', justifyContent: 'center' },
  cancelText: { fontFamily: font.bold, fontSize: 15, color: colors.mutedWarm },
});
