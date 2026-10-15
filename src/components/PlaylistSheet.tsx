import { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { GlassSheet } from './GlassSheet';
import { colors } from '../theme/colors';
import { font, type as typo } from '../theme/fonts';
import type { MediaItem } from '../types/media';
import {
  createPlaylist,
  deletePlaylist,
  inPlaylist,
  pickCover,
  setPlaylistCover,
  togglePlaylistItem,
  updatePlaylist,
  usePlaylists,
  type Playlist,
} from '../data/playlists';

/**
 * «В ПЛЕЙЛИСТ» и «НОВЫЙ ПЛЕЙЛИСТ» — в том же стекле и тех же капсулах, что выбор озвучки.
 *
 *   item  — добавить тайтл: список плейлистов, касание кладёт/убирает (галочка), снизу «Новый
 *           плейлист» — форма прямо здесь, и тайтл сразу ляжет в созданный;
 *   edit  — переименовать плейлист, сменить фото или удалить;
 *   иначе — просто создать плейлист.
 */
export function PlaylistSheet({
  open,
  onClose,
  item,
  edit,
}: {
  open: boolean;
  onClose: () => void;
  item?: MediaItem | null;
  edit?: Playlist | null;
}) {
  const lists = usePlaylists();
  const [form, setForm] = useState(false);
  const [name, setName] = useState('');
  const [cover, setCover] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(!item || !!edit);
    setName(edit?.name ?? '');
    setCover(edit?.cover ?? null);
  }, [open, item, edit]);

  const choosePhoto = async () => {
    const uri = await pickCover();
    if (uri) setCover(uri);
  };

  const submit = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (edit) {
      updatePlaylist(edit.id, { name });
      if (cover !== edit.cover) setPlaylistCover(edit.id, cover);
    } else {
      createPlaylist(name, cover, item ?? undefined);
    }
    onClose();
  };

  return (
    <GlassSheet open={open} onClose={onClose}>
      {form ? (
        <View>
          <View style={styles.head}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{edit ? 'Кинофест' : 'Новый кинофест'}</Text>
              {item && !edit ? (
                <Text style={styles.sub} numberOfLines={1}>
                  и в него — «{item.title}»
                </Text>
              ) : null}
            </View>
          </View>
          <View style={styles.formRow}>
            {/* Обложка: своё фото из галереи. Пусто — в плейлисте будет мозаика из постеров. */}
            <Pressable onPress={() => void choosePhoto()} style={({ pressed }) => [styles.coverBtn, pressed && styles.down]}>
              {cover ? (
                <Image source={{ uri: cover }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              ) : (
                <SymbolView name="photo.badge.plus" size={22} tintColor={colors.focusFill} />
              )}
            </Pressable>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Название"
              placeholderTextColor={colors.faint}
              style={styles.input}
              autoFocus={!edit}
              returnKeyType="done"
              onSubmitEditing={submit}
              maxLength={40}
            />
          </View>
          <View style={styles.actions}>
            <Pressable onPress={submit} style={({ pressed }) => [styles.primary, pressed && styles.down]}>
              <Text style={styles.primaryText}>{edit ? 'Сохранить' : 'Создать'}</Text>
            </Pressable>
            {edit ? (
              <Pressable
                onPress={() => {
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                  deletePlaylist(edit.id);
                  onClose();
                }}
                style={({ pressed }) => [styles.ghost, pressed && styles.down]}
              >
                <Text style={[styles.ghostText, { color: colors.error }]}>Удалить кинофест</Text>
              </Pressable>
            ) : (
              <Pressable onPress={item ? () => setForm(false) : onClose} style={({ pressed }) => [styles.ghost, pressed && styles.down]}>
                <Text style={styles.ghostText}>{item ? 'Назад' : 'Отмена'}</Text>
              </Pressable>
            )}
          </View>
        </View>
      ) : (
        <View>
          <View style={styles.head}>
            <View style={styles.headIcon}>
              <SymbolView name="text.badge.plus" size={15} tintColor="#000" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>В кинофест</Text>
              {item ? (
                <Text style={styles.sub} numberOfLines={1}>
                  {item.title}
                </Text>
              ) : null}
            </View>
          </View>
          <ScrollView style={styles.list} contentContainerStyle={styles.listPad} showsVerticalScrollIndicator={false}>
            {item
              ? lists.map((p) => {
                  const on = inPlaylist(p, item);
                  return (
                    <Pressable
                      key={p.id}
                      onPress={() => {
                        void Haptics.selectionAsync();
                        togglePlaylistItem(p.id, item);
                      }}
                      style={({ pressed }) => [styles.row, on && styles.rowOn, pressed && styles.down]}
                    >
                      <View style={styles.thumb}>
                        {p.cover || p.items[0]?.posterUrl ? (
                          <Image source={{ uri: (p.cover ?? p.items[0]?.posterUrl) as string }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                        ) : null}
                      </View>
                      <Text style={[styles.rowText, on && styles.rowTextOn]} numberOfLines={1}>
                        {p.name}
                      </Text>
                      <Text style={[styles.count, on && styles.rowTextOn]}>{p.items.length}</Text>
                      {on ? <SymbolView name="checkmark" size={14} tintColor="#000" /> : null}
                    </Pressable>
                  );
                })
              : null}
            <Pressable onPress={() => setForm(true)} style={({ pressed }) => [styles.row, styles.rowNew, pressed && styles.down]}>
              <SymbolView name="plus" size={14} tintColor={colors.focusFill} />
              <Text style={[styles.rowText, { color: colors.focusFill }]}>Новый кинофест</Text>
            </Pressable>
          </ScrollView>
          <Pressable onPress={onClose} style={({ pressed }) => [styles.ghost, pressed && styles.down]}>
            <Text style={styles.ghostText}>Готово</Text>
          </Pressable>
        </View>
      )}
    </GlassSheet>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingBottom: 14 },
  headIcon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.focusFill },
  title: { fontFamily: font.display, fontSize: 20, color: colors.onBg },
  sub: { ...typo.labelMedium, color: colors.mutedWarm, marginTop: 2 },
  list: { flexGrow: 0 },
  listPad: { paddingHorizontal: 12, gap: 6, paddingBottom: 6 },
  row: {
    height: 48,
    borderRadius: 24,
    paddingLeft: 8,
    paddingRight: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  rowOn: { backgroundColor: colors.focusFill },
  rowNew: { paddingLeft: 18, backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(204,204,153,0.35)' },
  thumb: { width: 32, height: 32, borderRadius: 16, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.1)' },
  rowText: { flex: 1, fontFamily: font.bold, fontSize: 15, color: colors.onBg },
  rowTextOn: { color: '#000' },
  count: { fontFamily: font.display, fontSize: 13, color: colors.faint },
  down: { opacity: 0.6, transform: [{ scale: 0.97 }] },
  formRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingBottom: 14 },
  coverBtn: {
    width: 64,
    height: 64,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  input: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    paddingHorizontal: 18,
    backgroundColor: 'rgba(255,255,255,0.08)',
    color: colors.onBg,
    fontFamily: font.bold,
    fontSize: 15,
  },
  actions: { paddingHorizontal: 12, gap: 4 },
  primary: { height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.focusFill },
  primaryText: { fontFamily: font.bold, fontSize: 15, color: '#000' },
  ghost: { height: 46, marginHorizontal: 12, marginTop: 2, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontFamily: font.bold, fontSize: 15, color: colors.mutedWarm },
});
