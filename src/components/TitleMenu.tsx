import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { GlassSheet } from './GlassSheet';
import { PlaylistSheet } from './PlaylistSheet';
import { useVoicePicker } from './VoicePicker';
import { colors } from '../theme/colors';
import { font, type as typo } from '../theme/fonts';
import type { MediaItem } from '../types/media';
import { setThumb, thumbOf, useFeedbackVersion } from '../data/feedback';
import { toggleMine, useIsMine } from '../data/mine';
import { openTitle } from '../nav/openTitle';
import { enqueueDownload } from '../downloads/engine';
import { voicesFor } from '../api/sources/playback';
import { hideFromContinue } from '../data/watchProgress';
import { watchOnline } from '../nav/openOnline';

/*
  МЕНЮ ТАЙТЛА ПО ДОЛГОМУ НАЖАТИЮ — на карточках карусели вверху Фильмов/Сериалов и в «Продолжить
  просмотр». Тем же тёмным листом, что выбор озвучки:
    • нравится / не нравится — влияет на ленты (см. data/feedback);
    • открыть страницу, в «Моё», в кинофест;
    • загрузить — сразу окно выбора озвучки (у серии из «Продолжить» — именно эта серия);
    • в «Продолжить просмотр» ещё: переместить (ряд начинает дрожать, как значки на экране
      «Домой», карточки перетаскиваются и убираются крестиком) и убрать из ряда.
  Один на всё приложение: хост живёт в корне, карточки только зовут openTitleMenu.
*/
export type MenuRequest = {
  item: MediaItem;
  /** Серия, если меню открыто на серии из «Продолжить просмотр». */
  episode?: { season: number; episode: number } | null;
  /** Есть — показываются «Переместить» и «Убрать из ряда». */
  onMove?: () => void;
  inContinue?: boolean;
};

/*
  ХОСТЫ МЕНЮ — СТОПКОЙ. Страницы (фильм, человек, загрузки, списки…) открываются системными
  модальными окнами ПОВЕРХ корня приложения, и меню, нарисованное в корне, оказывалось ПОД ними:
  его не было видно, а его невидимая подложка потом перехватывала касания на главной — отсюда
  «фриз» после попытки открыть меню в загрузках. Теперь у каждой такой страницы свой хост
  (ZoomPage, страницы фильма и человека), и меню открывает самый верхний — тот, что на экране.
*/
const hosts: ((r: MenuRequest) => void)[] = [];

export function openTitleMenu(r: MenuRequest): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  hosts[hosts.length - 1]?.(r);
}

export function TitleMenuHost() {
  const [req, setReq] = useState<MenuRequest | null>(null);
  const [open, setOpen] = useState(false);
  const [fest, setFest] = useState<MediaItem | null>(null);
  const { picker, askVoice } = useVoicePicker();
  useFeedbackVersion();

  useEffect(() => {
    const f = (r: MenuRequest) => {
      setReq(r);
      setOpen(true);
    };
    hosts.push(f);
    return () => {
      const i = hosts.lastIndexOf(f);
      if (i >= 0) hosts.splice(i, 1);
    };
  }, []);

  const close = () => setOpen(false);
  const item = req?.item ?? null;

  const download = async () => {
    if (!item) return;
    close();
    // Сериал без конкретной серии — его серии выбирают на странице сезонов.
    if (item.type === 'tv' && !req?.episode) {
      /*
        Страница сезонов — ПОСЛЕ того, как меню уехало (как и «Открыть страницу» ниже): открытая
        в тот же миг, пока стекло меню ещё закрывается, она появлялась сразу готовой, без своего
        разворота.
      */
      setTimeout(() => watchOnline(item), 200);
      return;
    }
    const target = item.type === 'tv' ? req?.episode ?? null : null;
    const voice = await askVoice({
      voices: voicesFor(item, target).catch(() => [] as string[]),
      subtitle: target ? `Сезон ${target.season} · Серия ${target.episode}` : item.title,
    });
    if (!voice) return;
    enqueueDownload(item, target, voice);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <>
      <GlassSheet open={open} onClose={close}>
        {item ? <MenuBody item={item} req={req!} close={close} onFest={() => {
          close();
          setTimeout(() => setFest(item), 220);
        }} onDownload={() => void download()} /> : <View />}
      </GlassSheet>
      <PlaylistSheet open={!!fest} onClose={() => setFest(null)} item={fest} />
      {picker}
    </>
  );
}

function MenuBody({ item, req, close, onFest, onDownload }: { item: MediaItem; req: MenuRequest; close: () => void; onFest: () => void; onDownload: () => void }) {
  const mine = useIsMine(item.type, item.id);
  const thumb = thumbOf(item.type, item.id);
  const thumbBtn = (v: 'like' | 'dislike') => {
    const on = thumb === v;
    return (
      <Pressable
        onPress={() => {
          void Haptics.selectionAsync();
          setThumb(item, v);
        }}
        style={({ pressed }) => [styles.thumb, on && styles.thumbOn, pressed && styles.down]}
      >
        <SymbolView name={(v === 'like' ? (on ? 'hand.thumbsup.fill' : 'hand.thumbsup') : on ? 'hand.thumbsdown.fill' : 'hand.thumbsdown') as SFSymbol} size={18} tintColor={on ? '#000' : colors.onBg} />
        <Text style={[styles.thumbText, on && { color: '#000' }]}>{v === 'like' ? 'Нравится' : 'Не нравится'}</Text>
      </Pressable>
    );
  };
  const row = (icon: SFSymbol, text: string, onPress: () => void, danger = false) => (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.down]}>
      <SymbolView name={icon} size={19} tintColor={danger ? colors.error : colors.onBg} />
      <Text style={[styles.rowText, danger && { color: colors.error }]}>{text}</Text>
    </Pressable>
  );
  return (
    <View>
      <View style={styles.head}>
        <View style={styles.poster}>{item.posterUrl ? <Image source={{ uri: item.posterUrl }} style={StyleSheet.absoluteFill} /> : null}</View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={2}>
            {item.title}
          </Text>
          {req.episode ? <Text style={styles.sub}>Сезон {req.episode.season} · Серия {req.episode.episode}</Text> : item.year ? <Text style={styles.sub}>{item.year}</Text> : null}
        </View>
      </View>
      <View style={styles.thumbs}>
        {thumbBtn('like')}
        {thumbBtn('dislike')}
      </View>
      {row('rectangle.portrait.on.rectangle.portrait', 'Открыть страницу', () => {
        close();
        setTimeout(() => openTitle(item), 200);
      })}
      {row(mine ? 'bookmark.fill' : 'bookmark', mine ? 'Убрать из «Моё»' : 'В «Моё»', () => {
        void Haptics.selectionAsync();
        toggleMine(item);
      })}
      {row('film', 'В кинофест', onFest)}
      {row('arrow.down.circle', 'Загрузить', onDownload)}
      {req.onMove
        ? row('arrow.left.arrow.right', 'Переместить', () => {
            close();
            setTimeout(() => req.onMove?.(), 250);
          })
        : null}
      {req.inContinue
        ? row('xmark.circle', 'Убрать из «Продолжить просмотр»', () => {
            close();
            hideFromContinue(item.type, item.id);
          }, true)
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingBottom: 14 },
  poster: { width: 44, height: 66, overflow: 'hidden', backgroundColor: colors.surfaceHi },
  title: { fontFamily: font.display, fontSize: 18, color: colors.onBg },
  sub: { ...typo.labelMedium, color: colors.mutedWarm, marginTop: 3 },
  thumbs: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  thumb: { flex: 1, height: 46, borderRadius: 23, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.08)' },
  thumbOn: { backgroundColor: colors.focusFill },
  thumbText: { fontFamily: font.bold, fontSize: 14, color: colors.onBg },
  row: { height: 50, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 22 },
  rowText: { fontFamily: font.bold, fontSize: 15, color: colors.onBg },
  down: { opacity: 0.6 },
});
