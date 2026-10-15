import { memo } from 'react';
import { go } from '../nav/navGuard';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import type { CastMember } from '../types/media';
import { colors } from '../theme/colors';
import { FadeInImage } from './FadeInImage';
import { type as typo } from '../theme/fonts';

/** Человек в ряду «В ролях» / «Режиссёр». Кликабельный — ведёт на его страницу с работами. */
export const PersonChip = memo(function PersonChip({ person }: { person: CastMember }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.item, { opacity: pressed ? 0.6 : 1 }]}
      onPress={() =>
        go({ pathname: '/person/[id]', params: { id: String(person.id), name: person.name } })
      }
    >
      <View style={styles.photoBox}>
        {person.photoUrl ? (
          <FadeInImage source={{ uri: person.photoUrl }} style={styles.photo} />
        ) : (
          <MaterialIcons name="person" size={30} color={colors.faint} />
        )}
      </View>
      <Text style={styles.name} numberOfLines={2}>
        {person.name}
      </Text>
      {person.character ? (
        <Text style={styles.role} numberOfLines={1}>
          {person.character}
        </Text>
      ) : null}
    </Pressable>
  );
})

const styles = StyleSheet.create({
  item: { width: 82, marginRight: 12, alignItems: 'center' },
  photoBox: {
    width: 76,
    height: 76,
    borderRadius: 38,
    overflow: 'hidden',
    backgroundColor: colors.surfaceHi,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photo: { width: '100%', height: '100%' },
  name: { ...typo.labelMedium, color: colors.onBg, fontSize: 11, textAlign: 'center', marginTop: 6 },
  role: { ...typo.labelMedium, color: colors.faint, fontSize: 10, textAlign: 'center', marginTop: 1 },
});
