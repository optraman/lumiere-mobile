import { useState } from 'react';
import { TopGlow } from '../../src/components/TopGlow';
import { ActionSheetIOS, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { colors } from '../../src/theme/colors';
import { font, type as typo } from '../../src/theme/fonts';
import { usePortraitInsets, usePortraitWindow } from '../../src/nav/portrait';
import { ZoomPage, useZoomClose } from '../../src/nav/ZoomPage';
import { playlistItems, togglePlaylistItem, usePlaylist } from '../../src/data/playlists';
import { Mosaic, countLabel } from '../../src/components/PlaylistCover';
import { FadeInImage } from '../../src/components/FadeInImage';
import { PosterCard } from '../../src/components/PosterCard';
import { PlaylistSheet } from '../../src/components/PlaylistSheet';

/**
 * ОДИН ПЛЕЙЛИСТ: обложка и имя сверху (по «⋯» — переименовать, сменить фото, удалить), ниже
 * постеры в три колонки. Долгое нажатие на постер — убрать из плейлиста.
 */
export default function PlaylistScreen() {
  return (
    <ZoomPage>
      <Body />
    </ZoomPage>
  );
}

function Body() {
  const close = useZoomClose();
  const { id } = useLocalSearchParams<{ id: string }>();
  const p = usePlaylist(id);
  const insets = usePortraitInsets();
  const { width } = usePortraitWindow();
  const [editing, setEditing] = useState(false);
  const cols = 3;
  const posterW = Math.floor((width - 32 - (cols - 1) * 10) / cols);
  const items = p ? playlistItems(p) : [];

  return (
    <View style={styles.screen}>
      <TopGlow />
      <View style={[styles.head, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={close} hitSlop={12} style={styles.back}>
          <SymbolView name="chevron.backward" size={20} tintColor={colors.onBg} />
        </Pressable>
        <View style={{ flex: 1 }} />
        {p ? (
          <Pressable onPress={() => setEditing(true)} hitSlop={12} style={styles.back}>
            <SymbolView name="ellipsis.circle" size={22} tintColor={colors.onBg} />
          </Pressable>
        ) : null}
      </View>
      <FlatList
        data={items}
        numColumns={cols}
        keyExtractor={(m) => `${m.type}-${m.id}`}
        columnWrapperStyle={{ gap: 10 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 30, gap: 14 }}
        ListHeaderComponent={
          p ? (
            <View style={styles.hero}>
              {p.cover ? (
                <FadeInImage source={{ uri: p.cover }} style={styles.cover} resizeMode="cover" />
              ) : (
                <Mosaic uris={p.items.map((e) => e.posterUrl)} size={180} icon="film.stack" />
              )}
              <Text style={styles.name} numberOfLines={2}>
                {p.name}
              </Text>
              <Text style={styles.count}>{countLabel(p.items.length)}</Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <Text style={styles.empty}>Пусто. На странице фильма или сериала нажмите «В кинофест».</Text>
        }
        renderItem={({ item }) => (
          <PosterCard
            item={item}
            width={posterW}
            style={{ marginRight: 0 }}
            onLongPress={() => {
              if (!p) return;
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              ActionSheetIOS.showActionSheetWithOptions(
                { userInterfaceStyle: 'dark', title: item.title, options: [`Убрать из «${p.name}»`, 'Отмена'], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
                (i) => {
                  if (i === 0) togglePlaylistItem(p.id, item);
                },
              );
            }}
          />
        )}
      />
      <PlaylistSheet open={editing} onClose={() => setEditing(false)} edit={p ?? null} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 6 },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  hero: { alignItems: 'center', paddingBottom: 18 },
  cover: { width: 180, height: 180 },
  name: { ...typo.pageTitle, color: colors.onBg, marginTop: 14, textAlign: 'center', paddingHorizontal: 20 },
  count: { ...typo.labelMedium, color: colors.mutedWarm, marginTop: 4 },
  empty: { ...typo.bodyMedium, color: colors.muted, textAlign: 'center', padding: 40, lineHeight: 22 },
});
