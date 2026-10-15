import { Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import { forgetAllSources } from '../api/sources/playback';
import { forgetAll as forgetCollaps } from '../api/collaps';
import { forgetAllPlayback } from '../player/request';
import { clearWatchProgress } from './watchProgress';

/**
 * ОЧИСТИТЬ ИСТОРИЮ — одно действие на два места: настройки и сам список «История».
 *
 * Вместе с позициями забываются и выбранные балансеры: иначе тайтл ещё полчаса играл бы с
 * прежнего, и «очистить» значило бы не то, что написано.
 */
export function askClearHistory(done?: () => void): void {
  Alert.alert(
    'Очистить историю просмотра?',
    'Пропадут позиции во всех фильмах и сериалах, а выбранные балансеры забудутся — следующий просмотр начнёт поиск заново. Отменить это нельзя.',
    [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Очистить',
        style: 'destructive',
        onPress: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          forgetAllSources();
          forgetCollaps();
          forgetAllPlayback();
          void clearWatchProgress().then(() => done?.());
        },
      },
    ],
  );
}
