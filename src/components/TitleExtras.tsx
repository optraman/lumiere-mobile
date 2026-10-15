import { memo, useEffect, useState } from 'react';
import { go } from '../nav/navGuard';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { TmdbApi } from '../api/tmdb';
import { mapItems } from '../api/mapper';
import type { TmdbItemDto } from '../api/tmdbTypes';
import type { MediaItem, MediaType } from '../types/media';
import { PosterCard } from './PosterCard';
import { colors } from '../theme/colors';
import { font, type as typo } from '../theme/fonts';

/*
  НИЗ СТРАНИЦЫ ТАЙТЛА — ряды, которые есть у Влада после «Похожих»:
    Франшиза        — другие части той же коллекции (только у фильмов), по порядку выхода;
    Другие работы   — режиссёра (у сериала — создателя), самые известные, без этого тайтла;
    Больше от студии — популярное у первой студии из титров;
    Теги            — ключевые слова TMDB; касание открывает подборку по тегу.
  Данные — из того же ответа details (он уже в памяти, см. кэш tmdb.ts) и пары коротких запросов.
  Пустой ряд не рисуется.
*/

type Extra = {
  franchise: { name: string; items: MediaItem[] } | null;
  works: { name: string; items: MediaItem[] } | null;
  studio: { name: string; items: MediaItem[] } | null;
  tags: { id: number; name: string }[];
};

type Raw = {
  belongs_to_collection?: { id: number; name?: string } | null;
  production_companies?: { id: number; name: string }[];
  keywords?: { keywords?: { id: number; name: string }[]; results?: { id: number; name: string }[] };
  credits?: { crew?: { id: number; name: string; job: string }[] };
  created_by?: { id: number; name: string }[];
};

async function load(type: MediaType, id: number): Promise<Extra> {
  const d = (await TmdbApi.details(type, id)) as unknown as Raw;
  const not = (m: MediaItem) => !(m.id === id && m.type === type);

  const coll = type === 'movie' ? d.belongs_to_collection : null;
  const director = type === 'movie' ? d.credits?.crew?.find((c) => c.job === 'Director') : d.created_by?.[0];
  const studio = d.production_companies?.[0];

  const [franchise, works, studioItems] = await Promise.all([
    coll
      ? TmdbApi.collection(coll.id)
          .then((c) => {
            const parts = (c.parts ?? []).slice().sort((a, b) => (a.release_date ?? '9').localeCompare(b.release_date ?? '9'));
            return { name: c.name ?? coll.name ?? 'Франшиза', items: mapItems(parts, 'movie').filter(not) };
          })
          .catch(() => null)
      : Promise.resolve(null),
    director
      ? TmdbApi.person(director.id)
          .then((p) => {
            const list = (type === 'movie' ? p.combined_credits?.crew?.filter((c) => c.job === 'Director') : [
              ...(p.combined_credits?.crew ?? []).filter((c) => c.job === 'Creator' || c.job === 'Executive Producer' || c.job === 'Director'),
            ]) ?? [];
            const seen = new Set<string>();
            const uniq = list
              .filter((c) => {
                const k = `${c.media_type}-${c.id}`;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
              })
              .sort((a, b) => ((b as TmdbItemDto & { popularity?: number }).popularity ?? 0) - ((a as TmdbItemDto & { popularity?: number }).popularity ?? 0));
            return { name: director.name, items: mapItems(uniq).filter(not).filter((m) => m.posterUrl).slice(0, 20) };
          })
          .catch(() => null)
      : Promise.resolve(null),
    studio
      ? TmdbApi.discover(type, { with_companies: String(studio.id), 'vote_count.gte': '100' })
          .then((r) => ({ name: studio.name, items: mapItems(r.results, type).filter(not).slice(0, 20) }))
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const tags = (d.keywords?.keywords ?? d.keywords?.results ?? []).slice(0, 14);
  return { franchise, works, studio: studioItems, tags };
}

export const TitleExtras = memo(function TitleExtras({ type, id }: { type: MediaType; id: number }) {
  const [x, setX] = useState<Extra | null>(null);
  useEffect(() => {
    let dead = false;
    setX(null);
    void load(type, id)
      .then((v) => !dead && setX(v))
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [type, id]);
  if (!x) return null;
  return (
    <View>
      {x.franchise && x.franchise.items.length > 0 ? <Row title="Франшиза" sub={x.franchise.name} items={x.franchise.items} /> : null}
      {x.works && x.works.items.length > 0 ? (
        <Row title="Другие работы" sub={x.works.name} items={x.works.items} />
      ) : null}
      {x.studio && x.studio.items.length > 0 ? <Row title="Больше от студии" sub={x.studio.name} items={x.studio.items} /> : null}
      {x.tags.length > 0 ? (
        <>
          <Text style={styles.title}>Теги</Text>
          <View style={styles.tags}>
            {x.tags.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => go({ pathname: '/library/[list]', params: { list: `kw:${type}:${t.id}:${t.name}` } })}
                style={({ pressed }) => [styles.tag, pressed && { opacity: 0.6 }]}
              >
                <Text style={styles.tagText}>{t.name}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
});

function Row({ title, sub, items }: { title: string; sub?: string; items: MediaItem[] }) {
  return (
    <View>
      <Text style={styles.title}>{title}</Text>
      {sub ? <Text style={styles.sub}>{sub}</Text> : null}
      <FlatList
        horizontal
        scrollsToTop={false}
        data={items}
        keyExtractor={(m) => `${m.type}-${m.id}`}
        showsHorizontalScrollIndicator={false}
        initialNumToRender={4}
        windowSize={3}
        renderItem={({ item }) => <PosterCard item={item} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  title: { ...typo.headlineLarge, color: colors.onBg, marginTop: 26, marginBottom: 4 },
  sub: { ...typo.labelMedium, color: colors.mutedWarm, marginBottom: 10 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  tag: { paddingHorizontal: 14, height: 32, borderRadius: 16, justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)' },
  tagText: { fontFamily: font.bold, fontSize: 13, color: colors.onBg },
});
