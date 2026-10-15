import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors } from '../theme/colors';
import { font } from '../theme/fonts';

/**
 * Портировано из Cards.kt (RatingChip). Маленькая ненавязчивая плашка рейтинга.
 *
 * Два начертания. У залитого углы ОСТРЫЕ — прямое требование владельца: «рейтинг в карточках —
 * без скругления углов, тоже с острыми углами». Никакого borderRadius здесь быть не должно.
 *
 * Отступы растут вместе с кеглем, чтобы крупное число не оказалось в коробке, рассчитанной на мелкое.
 *
 * ШРИФТ ИЗМЕНЁН ОТНОСИТЕЛЬНО ОРИГИНАЛА, по просьбе владельца — «оценка более жирным шрифтом».
 * У Влада здесь Bounded («как в хиро»), но Bounded поставляется одним начертанием 700, жирнее в
 * этой гарнитуре просто нет. Поэтому взят Manrope ExtraBold (800) — это тоже его шрифт, тот
 * самый, которым набран весь интерфейс, и он даёт реальный вес, а не подделку системным
 * псевдожирным (для подключённых файлом шрифтов fontWeight ничего не меняет).
 *
 * Начертание утяжелено (fontWeight 800): у Влада в Cards.kt на этом же шрифте стоит
 * FontWeight.Bold, и цифра должна держать вес плашки — на маленьком кегле тонкая цифра на
 * цветном фоне читается вяло.
 */
export function RatingChip({
  rating,
  fontSize = 13,
  variant = 'plain',
  style,
}: {
  rating: number;
  fontSize?: number;
  /**
   * plain — цветные цифры без подложки. Так оценка стоит В СТРОКЕ с годом и жанрами: там она часть
   * фразы, и плашка вокруг разрывала бы строку.
   * solid — залитая плашка Влада, для угла постера. Там цифра лежит НА КАРТИНКЕ, и без подложки её
   * читаемость зависела бы от того, что на кадре: на светлом небе цветные цифры пропадают.
   */
  variant?: 'plain' | 'solid';
  style?: StyleProp<ViewStyle>;
}) {
  if (rating <= 0.1) return null;
  // Пороги едины для обоих начертаний — они и есть смысл оценки: зелёное хорошо, янтарное так
  // себе, серое слабо. Меняется только то, что ими красится: цифры или подложка.
  const tone = rating >= 7 ? '#46C755' : rating >= 5.5 ? '#D69A34' : '#6B6B76';

  if (variant === 'solid') {
    return (
      <View
        style={[
          styles.chip,
          {
            backgroundColor: tone,
            paddingHorizontal: fontSize * 0.56,
            paddingVertical: fontSize * 0.19,
          },
          style,
        ]}
      >
        <Text style={[styles.text, { fontSize, color: colors.onBg }]} allowFontScaling={false}>
          {rating.toFixed(1)}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.chip, style]}>
      <Text
        style={[styles.text, { fontSize, color: rating >= 5.5 ? tone : '#9A9AA6' }]}
        allowFontScaling={false}
      >
        {rating.toFixed(1)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { alignSelf: 'flex-start' },
  text: { fontFamily: font.display, fontWeight: '800', color: colors.onBg },
});
