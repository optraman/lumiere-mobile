import { useState } from 'react';
import { go } from '../nav/navGuard';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import type { MediaItem } from '../types/media';
import { colors } from '../theme/colors';
import { type as typo } from '../theme/fonts';
import { toggleMine, useIsMine } from '../data/mine';
import { useDownloads } from '../downloads/store';
import { enqueueDownload } from '../downloads/engine';
import { keyFor } from '../downloads/offline';
import { voicesFor } from '../api/sources/playback';
import { useVoicePicker } from './VoicePicker';
import { PlaylistSheet } from './PlaylistSheet';
import { usePlaylists } from '../data/playlists';

/**
 * «В МОЁ» И «СКАЧАТЬ» — рядом со «Смотреть» на странице тайтла.
 *
 * «Скачать» у фильма спрашивает озвучку, если их несколько (как «Озвучка для скачивания» у
 * планшета), и ставит в очередь. Серии сериала качаются из списка серий — там видно, какие именно.
 */
/**
 * unreleased — тайтл ещё не вышел: скачивать нечего, а в кинофест (подборку к просмотру) класть
 * рано. Остаётся только «Моё» — отложить, чтобы не забыть.
 */
export function TitleActions({ item, unreleased = false }: { item: MediaItem; unreleased?: boolean }) {
  const mine = useIsMine(item.type, item.id);
  const tasks = useDownloads();
  const [asking, setAsking] = useState(false);
  const { picker, askVoice } = useVoicePicker();
  const [listOpen, setListOpen] = useState(false);
  const playlists = usePlaylists();
  const inSome = playlists.some((p) => p.items.some((e) => e.type === item.type && e.id === item.id));
  const movie = item.type === 'movie';
  const task = movie ? tasks.find((t) => t.key === keyFor(item, null)) : undefined;
  const episodesDone = !movie ? tasks.filter((t) => t.item.id === item.id && t.item.type === item.type).length : 0;

  const download = async () => {
    if (task?.state === 'done' || (!movie && episodesDone > 0)) {
      go('/downloads');
      return;
    }
    if (task) {
      go('/downloads');
      return;
    }
    // Окно — сразу по касанию; озвучки доезжают в него сами. Спрашиваем всегда, даже если она одна.
    const voice = await askVoice({ voices: voicesFor(item, null).catch(() => [] as string[]), subtitle: item.title });
    if (!voice) return;
    enqueueDownload(item, null, voice);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const dlLabel = !movie
    ? episodesDone > 0
      ? 'Загрузки'
      : null
    : task?.state === 'done'
      ? 'Скачано'
      : task
        ? `${task.piecesTotal ? Math.round((task.piecesDone / task.piecesTotal) * 100) : 0}%`
        : 'Скачать';

  return (
    <View style={styles.row}>
      <Round
        icon={mine ? 'bookmark.fill' : 'bookmark'}
        on={mine}
        onPress={() => {
          void Haptics.selectionAsync();
          toggleMine(item);
        }}
      />
      {dlLabel && !unreleased ? (
        <Round
          icon={task?.state === 'done' || (!movie && episodesDone) ? 'checkmark.circle.fill' : 'arrow.down.circle'}
          // Пока качается — вместо значка проценты.
          text={task && task.state !== 'done' ? dlLabel : undefined}
          on={task?.state === 'done'}
          busy={asking}
          onPress={() => void download()}
        />
      ) : null}
      {/* В КИНОФЕСТ — меню в том же стекле, что выбор озвучки (PlaylistSheet). */}
      {/* Значок — «плюс» и киноплёнка: кладём в кинофест (уже лежит — галочка и плёнка). */}
      {unreleased ? null : (
      <Round
        icon="film"
        glyph={(c) => (
          <View style={styles.fest}>
            <SymbolView name={inSome ? 'checkmark' : 'plus'} size={11} weight="bold" tintColor={c} />
            <SymbolView name="film" size={18} tintColor={c} />
          </View>
        )}
        on={inSome}
        onPress={() => {
          void Haptics.selectionAsync();
          setListOpen(true);
        }}
      />
      )}
      {picker}
      <PlaylistSheet open={listOpen} onClose={() => setListOpen(false)} item={item} />
    </View>
  );
}

function Round({
  icon,
  glyph,
  text,
  on,
  busy,
  onPress,
}: {
  icon: React.ComponentProps<typeof SymbolView>['name'];
  glyph?: (color: string) => React.ReactNode;
  text?: string;
  on?: boolean;
  busy?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} hitSlop={6} style={({ pressed }) => [styles.btn, pressed && { opacity: 0.6, transform: [{ scale: 0.96 }] }]}>
      <View style={[styles.circle, on && styles.circleOn]}>
        {busy ? (
          <ActivityIndicator color={colors.onBg} />
        ) : text ? (
          <Text style={styles.pct}>{text}</Text>
        ) : glyph ? (
          glyph(on ? '#000' : colors.onBg)
        ) : (
          <SymbolView name={icon} size={21} tintColor={on ? '#000' : colors.onBg} />
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10 },
  btn: { alignItems: 'center' },
  // Высота — как у «Смотреть» (48): три кнопки читаются одной строкой.
  circle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  circleOn: { backgroundColor: colors.focusFill },
  fest: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  pct: { ...typo.labelMedium, color: colors.onBg, fontSize: 11 },
});
