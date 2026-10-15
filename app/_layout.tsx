import { useEffect, useState } from 'react';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Appearance, View } from 'react-native';

/*
  ВСЕГДА ТЁМНОЕ. Системные меню (контекстное меню, выбор действия, предупреждения, клавиатура) и
  жидкое стекло следуют теме ТЕЛЕФОНА, а не приложения: в светлой теме iOS они выходили белыми
  посреди тёмного Люмьера. Здесь приложение говорит системе: у меня всегда тёмная — и всё системное
  внутри него тоже рисуется тёмным.
*/
Appearance.setColorScheme('dark');
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { colors } from '../src/theme/colors';
import { fontAssets, font } from '../src/theme/fonts';
import { Splash } from '../src/components/Splash';
import { PortraitStage } from '../src/nav/portrait';
import { TitleMenuHost } from '../src/components/TitleMenu';
import { prewarm } from '../src/boot/prewarm';

export default function RootLayout() {
  // Шрифты Влада (Bounded + Manrope) грузятся до первого кадра — иначе заголовки на мгновение
  // отрисуются системным шрифтом и «моргнут».
  const [loaded] = useFonts(fontAssets);
  /** Прогрелась ли лента. Пока нет — поверх приложения стоит заставка. */
  const [warm, setWarm] = useState(false);

  /*
    ПОРТРЕТ — ПРАВИЛО ПРИЛОЖЕНИЯ, АЛЬБОМ — ИСКЛЮЧЕНИЕ ПЛЕЕРА.

    В app.json поворот пришлось открыть («default»): пока там стояло «portrait», система вообще не
    разрешала повернуть окно, и плеер, как бы он ни просил альбом, оставался стоять. Открытая
    настройка сама по себе означала бы, что лента и страница фильма тоже начнут крутиться, — а они
    свёрстаны под вертикаль. Поэтому запрет возвращается здесь, из кода: всё приложение стоит
    портретом, и только экран просмотра на время себя отпускает.
  */
  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Неудача греется так же, как удача: если сеть не ответила, заставка всё равно обязана уйти —
    // экран под ней покажет свою ошибку, а не оставит человека перед логотипом навсегда.
    prewarm()
      .catch(() => {})
      .then(() => {
        if (!cancelled) setWarm(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
    НАВИГАТОР СТРОИТСЯ ВСЕГДА, дальше причина.

    Здесь стоял ранний выход: пока грузятся шрифты — только заставка, без Stack. Расчёт был на то,
    что текст не должен разложиться системным шрифтом и переверстаться. Но expo-router ждёт от
    корневой раскладки НАВИГАТОР: пока его нет, у приложения нет ни одного маршрута, и если именно
    в этот момент роутер разбирает начальный адрес, он показывает «Unmatched Route». Окно
    маленькое, но оно есть, и растёт вместе со всем, что мы вешаем на запуск.

    Поэтому Stack строится сразу, а забота о шрифтах решается иначе: дерево помечено ключом, и в
    момент, когда шрифты пришли, оно пересобирается один раз — под заставкой, которой всё это время
    закрыт экран. Ни мигания, ни окна без маршрутов.
  */

  return (
    // GestureHandlerRootView обязателен для жестов (жест «назад» на странице фильма).
    <GestureHandlerRootView style={{ flex: 1 }}>
      <>
        <StatusBar style="light" />
        {/*
          СЦЕНА — страницы приложения в ней всегда стоят, даже когда плеер лёг (src/nav/portrait.tsx).
          Плеер открывается системным окном поверх и в сцену не входит.
        */}
        <PortraitStage>
        <Stack
          key={loaded ? 'fonts-ready' : 'fonts-loading'}
          screenOptions={{
            headerStyle: { backgroundColor: colors.bg },
            headerTintColor: colors.onBg,
            headerTitleStyle: { fontFamily: font.bold },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.bg },
            // Только стрелка, без подписи. По умолчанию iOS пишет рядом со стрелкой имя предыдущего
            // экрана — а он называется «(tabs)», это служебное имя папки маршрутов, и показывать
            // его человеку незачем.
            headerBackButtonDisplayMode: 'minimal',
            headerBackTitle: '',
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          {/* Списки с главной (Моё, История, …) и Загрузки — тем же появлением, что страница
              фильма и человека: своя анимация (ZoomPage), системная выключена. */}
          <Stack.Screen
            name="library/[list]"
            options={{ headerShown: false, animation: 'none', presentation: 'transparentModal', contentStyle: { backgroundColor: 'transparent' } }}
          />
          <Stack.Screen
            name="downloads"
            options={{ headerShown: false, animation: 'none', presentation: 'transparentModal', contentStyle: { backgroundColor: 'transparent' } }}
          />
          <Stack.Screen
            name="settings"
            options={{ headerShown: false, animation: 'none', presentation: 'transparentModal', contentStyle: { backgroundColor: 'transparent' } }}
          />
          <Stack.Screen
            name="developer"
            options={{ headerShown: false, animation: 'none', presentation: 'transparentModal', contentStyle: { backgroundColor: 'transparent' } }}
          />
          <Stack.Screen
            name="mood/[mood]"
            options={{ headerShown: false, animation: 'none', presentation: 'transparentModal', contentStyle: { backgroundColor: 'transparent' } }}
          />
          <Stack.Screen
            name="kinofests"
            options={{ headerShown: false, animation: 'none', presentation: 'transparentModal', contentStyle: { backgroundColor: 'transparent' } }}
          />
          <Stack.Screen
            name="playlist/[id]"
            options={{ headerShown: false, animation: 'none', presentation: 'transparentModal', contentStyle: { backgroundColor: 'transparent' } }}
          />
          <Stack.Screen
            name="kinofest/[id]"
            options={{ headerShown: false, animation: 'none', presentation: 'transparentModal', contentStyle: { backgroundColor: 'transparent' } }}
          />
          {/* Без этой строки экран берёт стандартную шапку из screenOptions и подписывается
              ИМЕНЕМ МАРШРУТА — «person/[id]». Заодно уходит и полоса шапки. */}
          <Stack.Screen
            name="person/[id]"
            options={{
              headerShown: false,
              // Своя анимация: системная 'fade' шла ПОВЕРХ нашей, и два движения на один переход
              // читались как рывок посередине.
              animation: 'none',
              presentation: 'transparentModal',
              contentStyle: { backgroundColor: 'transparent' },
            }}
          />
          {/* Загрузчик просмотра и плеер: своих шапок у них нет, переход — системное затухание
              (оно идёт на стороне системы и ничего не занимает в JS-потоке). У плеера выключен
              жест «назад»: смахнуть экран пальцем посреди фильма слишком легко, выход — по кнопке. */}
          {/*
            ЭКРАН ВЫБОРА СЕРИИ — ОТДЕЛЬНОЕ ОКНО НА ВЕСЬ ЭКРАН, И СМАХНУТЬ ЕГО НЕЛЬЗЯ.

            Открывают его со страницы тайтла, а она сама показана поверх ленты отдельным окном.
            Всё, что кладётся сверху, наследует её оправу: остаётся полоска предыдущего экрана
            наверху и живёт жест «потянуть вниз, чтобы закрыть». Для страницы фильма это уместно,
            для списка серий — нет: он занимает весь экран и закрывается стрелкой, а не случайным
            движением пальца посреди прокрутки.

            fullScreenModal выводит его из этой оправы: своё окно, во весь экран, без жеста.
          */}
          <Stack.Screen
            name="online"
            options={{
              headerShown: false,
              // Системной анимации нет: разворот и сворачивание экран делает сам (useScreenZoom).
              animation: 'none',
              // Своё окно поверх страницы тайтла, во весь экран и БЕЗ системного жеста: закрывается
              // тем же движением, что страница фильма, — оно живёт на самом экране (см. online.tsx).
              presentation: 'transparentModal',
              contentStyle: { backgroundColor: 'transparent' },
              gestureEnabled: false,
            }}
          />
          <Stack.Screen
            name="watch"
            options={{
              headerShown: false,
              animation: 'fade',
              gestureEnabled: false,
              /*
                ПРОСМОТР — ВО ВЕСЬ ЭКРАН.

                Обычный экран стека остаётся страницей внутри приложения: под ним просвечивает то,
                откуда пришли, а сам он живёт между системными отступами. Для кино это неверно —
                кадр должен занимать стекло целиком, до краёв и под вырез.

                fullScreenModal — то самое окно: непрозрачное, поверх всего, без полос по краям.

                ТЕПЕРЬ ОКНО ПРОЗРАЧНОЕ (transparentModal): чёрный фон рисует сам плеер отдельным
                слоем, и при смахивании он тает — за улетающим кадром видна страница, с которой
                пришли, а не чёрный экран. Кадр по-прежнему на весь экран, до краёв и под вырез.
              */
              presentation: 'transparentModal',
              contentStyle: { backgroundColor: 'transparent' },
            }}
          />
          <Stack.Screen
            name="title/[type]/[id]"
            options={{
              // ШАПКИ НЕТ ВОВСЕ — именно она давала чёрную полосу сверху.
              // headerTransparent убирает у шапки ФОН, но сама шапка остаётся: она занимает полосу
              // над содержимым и на тёмной теме читается как чёрный прямоугольник под стрелкой.
              // Стрелка «назад» живёт на самой странице, поверх обложки, поэтому шапка не нужна
              // ни для чего.
              headerShown: false,
              // Системная анимация ВЫКЛЮЧЕНА: разворот постера страница делает сама
              // (см. nav/useScreenZoom). Две анимации на один переход — это и есть дёрганье.
              animation: 'none',
              contentStyle: { backgroundColor: 'transparent' },
              presentation: 'transparentModal',
            }}
          />
        </Stack>
        </PortraitStage>
        {/*
          НЕВИДИМАЯ СТРАНИЦА РЕЗКИ — живёт всё время работы приложения.

          Она проходит проверку «вы не бот» сама (своим же сценарием) и держит пропуск, а все
          запросы к резке идут изнутри неё. Стоит в корне, потому что переживать переходы между
          экранами обязана: пропуск зарабатывается один раз, а не на каждое «Смотреть».
        */}
        {/* Заставка ПОВЕРХ приложения, а не вместо него: дерево под ней уже построено и успевает
            разложиться, поэтому в момент её ухода лента не «собирается на глазах», а просто
            открывается. */}
        {/* Меню тайтла по долгому нажатию — одно на всё приложение. */}
        <TitleMenuHost />
        <Splash ready={warm && loaded} />
      </>
    </GestureHandlerRootView>
  );
}
