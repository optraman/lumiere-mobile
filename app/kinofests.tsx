import { useMemo, useState } from 'react';
import { go } from '../src/nav/navGuard';
import { TopGlow } from '../src/components/TopGlow';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../src/theme/colors';
import { font, type as typo } from '../src/theme/fonts';
import { usePortraitInsets, usePortraitWindow } from '../src/nav/portrait';
import { ZoomPage, useZoomClose } from '../src/nav/ZoomPage';
import { usePlaylists, type Playlist } from '../src/data/playlists';
import { countdown, kinofestsNow, type Kinofest } from '../src/data/kinofests';
import { Mosaic, countLabel } from '../src/components/PlaylistCover';
import { FadeInImage } from '../src/components/FadeInImage';
import { PlaylistSheet } from '../src/components/PlaylistSheet';

/**
 * КИНОФЕСТ — плитка с главной (вместо «Плейлистов»). Большие квадратные плитки в две колонки:
 * сверху свои кинофесты (то, что человек собрал сам, кнопкой «В кинофест» на странице фильма) и
 * «Новый кинофест», ниже — каталог кинофестов Влада (src/data/kinofests.ts), сезонные — первыми.
 */
export default function KinofestsScreen() {
  return (
    <ZoomPage>
      <Body />
    </ZoomPage>
  );
}

type Cell = { kind: 'new' } | { kind: 'mine'; p: Playlist } | { kind: 'fest'; k: Kinofest };
type Row = { kind: 'head'; title: string } | { kind: 'pair'; cells: Cell[] };

function pairs(cells: Cell[]): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < cells.length; i += 2) out.push({ kind: 'pair', cells: cells.slice(i, i + 2) });
  return out;
}

function Body() {
  const close = useZoomClose();
  const insets = usePortraitInsets();
  const { width } = usePortraitWindow();
  const mine = usePlaylists();
  const [creating, setCreating] = useState(false);
  const size = Math.floor((width - 32 - 14) / 2);
  const fests = useMemo(() => kinofestsNow(), []);

  const rows: Row[] = useMemo(
    () => [
      { kind: 'head', title: 'Мои кинофесты' },
      ...pairs([{ kind: 'new' }, ...mine.map((p) => ({ kind: 'mine' as const, p }))]),
      { kind: 'head', title: 'Кинофесты' },
      ...pairs(fests.map((k) => ({ kind: 'fest' as const, k }))),
    ],
    [mine, fests],
  );

  const cell = (c: Cell) => {
    if (c.kind === 'new')
      return (
        <Pressable
          key="new"
          onPress={() => {
            void Haptics.selectionAsync();
            setCreating(true);
          }}
          style={({ pressed }) => [{ width: size }, pressed && styles.down]}
        >
          <View style={[styles.newBox, { width: size, height: size }]}>
            <SymbolView name="plus" size={30} tintColor={colors.focusFill} />
          </View>
          <Text style={styles.name}>Новый кинофест</Text>
        </Pressable>
      );
    if (c.kind === 'mine')
      return (
        <Pressable
          key={c.p.id}
          onPress={() => go({ pathname: '/playlist/[id]', params: { id: c.p.id } })}
          style={({ pressed }) => [{ width: size }, pressed && styles.down]}
        >
          {c.p.cover ? (
            <FadeInImage source={{ uri: c.p.cover }} style={{ width: size, height: size }} resizeMode="cover" />
          ) : (
            <Mosaic uris={c.p.items.map((e) => e.posterUrl)} size={size} icon="film.stack" />
          )}
          <Text style={styles.name} numberOfLines={1}>
            {c.p.name}
          </Text>
          <Text style={styles.count}>{countLabel(c.p.items.length)}</Text>
        </Pressable>
      );
    const k = c.k;
    const when = countdown(k);
    return (
      <Pressable
        key={k.id}
        onPress={() => go({ pathname: '/kinofest/[id]', params: { id: k.id } })}
        style={({ pressed }) => [{ width: size }, pressed && styles.down]}
      >
        <View style={{ width: size, height: size, overflow: 'hidden', backgroundColor: colors.surfaceHi }}>
          <FadeInImage source={{ uri: `https://image.tmdb.org/t/p/w780${k.heroBackdrop}` }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          <LinearGradient colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.78)']} locations={[0.4, 1]} style={StyleSheet.absoluteFill} />
          <View style={styles.festText}>
            {when ? <Text style={styles.when}>{when}</Text> : null}
            <Text style={styles.festTitle} numberOfLines={2}>
              {k.title}
            </Text>
          </View>
        </View>
        <Text style={styles.count} numberOfLines={1}>
          {countLabel(k.entries.length).replace('тайтл', 'фильм')}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={styles.screen}>
      <TopGlow />
      <View style={[styles.head, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={close} hitSlop={12} style={styles.back}>
          <SymbolView name="chevron.backward" size={20} tintColor={colors.onBg} />
        </Pressable>
        <Text style={styles.title}>Кинофест</Text>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r, i) => (r.kind === 'head' ? `h${r.title}` : `p${i}`)}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 30 }}
        initialNumToRender={6}
        windowSize={7}
        renderItem={({ item: r }) =>
          r.kind === 'head' ? (
            <Text style={styles.section}>{r.title}</Text>
          ) : (
            <View style={styles.pair}>{r.cells.map(cell)}</View>
          )
        }
      />
      <PlaylistSheet open={creating} onClose={() => setCreating(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 12, gap: 6 },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title: { ...typo.pageTitle, color: colors.onBg, flex: 1 },
  section: { ...typo.titleMedium, color: colors.mutedWarm, marginTop: 8, marginBottom: 12 },
  pair: { flexDirection: 'row', gap: 14, marginBottom: 18 },
  newBox: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(204,204,153,0.35)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  name: { ...typo.titleMedium, color: colors.onBg, marginTop: 8 },
  count: { ...typo.labelMedium, color: colors.mutedWarm, marginTop: 6 },
  festText: { position: 'absolute', left: 12, right: 12, bottom: 12 },
  festTitle: { fontFamily: font.display, fontSize: 17, lineHeight: 21, color: colors.onBg },
  when: { fontFamily: font.bold, fontSize: 11, color: colors.focusFill, marginBottom: 4, letterSpacing: 0.3 },
  down: { opacity: 0.7, transform: [{ scale: 0.98 }] },
});
