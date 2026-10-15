import { NativeTabs } from 'expo-router/unstable-native-tabs';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { colors } from '../../src/theme/colors';

/**
 * Вкладки рисует САМА iOS (UITabBarController через expo-router/unstable-native-tabs). Отсюда
 * жидкое стекло, скользящая подсветка, перетаскивание пальцем и сворачивание при прокрутке — всё
 * это даёт система, а не наш код.
 *
 * Иконки — набор Влада, Material Icons Filled: home / movie / live-tv / search (см. TopNav.kt, он
 * берёт Icons.Filled.Home, .Movie, .LiveTv, .Search). SF Symbols дали бы «эппловский» вид, но это
 * были бы ЧУЖИЕ иконки; VectorIcon позволяет отдать системной панели родные иконки приложения, не
 * отказываясь ни от чего нативного.
 *
 * tintColor — пергаментный #CCCC99, акцент приложения из Theme.kt.
 *
 * Я его однажды убрал, сославшись на правило «тонирование только смысловое», и это была ошибка в
 * применении правила: без своего цвета система подставляет СИСТЕМНЫЙ СИНИЙ, а он не нейтральное
 * решение — он просто чужой акцент вместо фирменного. Правило про тонирование говорит не красить
 * панель декоративно в произвольный цвет, а не «отказаться от акцента приложения».
 */
export default function TabsLayout() {
  return (
    <NativeTabs tintColor={colors.focusFill} labelStyle={{ fontSize: 10.5 }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon
          renderingMode="template"
          src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name="home" />}
        />
        <NativeTabs.Trigger.Label>Главная</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="movies">
        <NativeTabs.Trigger.Icon
          renderingMode="template"
          src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name="movie" />}
        />
        <NativeTabs.Trigger.Label>Фильмы</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="series">
        <NativeTabs.Trigger.Icon
          renderingMode="template"
          src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name="live-tv" />}
        />
        <NativeTabs.Trigger.Label>Сериалы</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="search">
        <NativeTabs.Trigger.Icon
          renderingMode="template"
          src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name="search" />}
        />
        <NativeTabs.Trigger.Label>Поиск</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
