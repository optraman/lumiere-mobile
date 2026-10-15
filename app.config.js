/*
  НАСТРОЙКИ ДЛЯ СОБСТВЕННОЙ СБОРКИ (.ipa) И ПАТЧЕЙ ПОВЕРХ app.json.

  Локально (Expo Go) этот файл ничего не меняет: всё ниже включается только на сборочной машине
  GitHub, где выставлены нужные переменные (.github/workflows/). Причина одна: npm здесь закрыт,
  и модулей, которые ставятся только там, в node_modules нет — впиши их в app.json, и
  `expo start` перестанет запускаться.
*/
module.exports = ({ config }) => {
  let out = config;

  /*
    ПАТЧИ ПО ВОЗДУХУ (expo-updates, сервер — EAS Update). Номер проекта на expo.dev приходит из
    секрета EXPO_PROJECT_ID. Патч ложится только на сборки с тем же runtimeVersion, а он равен
    версии приложения из app.json: пока версия та же — патчи доходят; поменял нативную часть
    (модуль, иконку, разрешения) — подними version, собери новый .ipa, и старым сборкам патчи
    для новой уже не придут (они бы на них упали).
  */
  const projectId = process.env.EXPO_PROJECT_ID;
  if (projectId) {
    out = {
      ...out,
      runtimeVersion: { policy: 'appVersion' },
      updates: {
        url: `https://u.expo.dev/${projectId}`,
        // Канал вместо сборки EAS: сборка у нас своя, поэтому канал вписывается прямо в неё.
        requestHeaders: { 'expo-channel-name': 'production' },
        // Запуск не ждёт сети: открывается то, что уже есть, патч качается в фоне и
        // включается со следующего запуска.
        checkAutomatically: 'ON_LOAD',
        fallbackToCacheTimeout: 0,
      },
      extra: { ...(out.extra ?? {}), eas: { projectId } },
    };
  }

  /*
    НАТИВНЫЕ МОДУЛИ, КОТОРЫЕ В EXPO GO ДАЁТ САМ EXPO GO. Заставка и цвет корневого окна:
    без expo-splash-screen и expo-system-ui приложение стартует с белой вспышкой.
  */
  if (process.env.LUMIERE_IPA) {
    out = {
      ...out,
      plugins: [
        ...(out.plugins ?? []),
        'expo-system-ui',
        // Однотонная заставка цвета фона приложения: дальше её сменяет собственное вступление.
        ['expo-splash-screen', { backgroundColor: '#08080A', image: './assets/splash-blank.png', imageWidth: 1 }],
        ...(projectId ? ['expo-updates'] : []),
      ],
    };
  }
  return out;
};
