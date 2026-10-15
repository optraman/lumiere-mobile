import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme/colors';
import { type as typo } from '../theme/fonts';

/**
 * Подпись в тёмно-серой подложке: год, продолжительность, жанр.
 *
 * Подложка нужна, потому что эти подписи лежат ПОВЕРХ кадра, а кадр бывает любым: на светлом небе
 * серый текст исчезает. Подложка даёт ему собственный фон и не зависит от того, что под ней.
 *
 * Оценка сюда НЕ заворачивается намеренно: у неё свой цвет, несущий смысл (зелёное — хорошо), и
 * серая подложка вокруг спорила бы с ним, превращая оценку в такой же нейтральный тег, как жанр.
 */
export function MetaPill({ text }: { text: string }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.text} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    backgroundColor: 'rgba(28, 28, 34, 0.78)',
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  text: { ...typo.labelMedium, color: colors.onBg, fontSize: 11 },
});
