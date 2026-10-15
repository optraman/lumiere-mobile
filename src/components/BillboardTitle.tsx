import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Image,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { logoUrl, logoUrlCached } from '../api/tmdb';
import { useLogoLook, logoLookCached, markBox } from '../api/logoLook';
import { LogoMark } from './LogoMark';
import type { MediaItem } from '../types/media';
import { Motion } from '../theme/motion';

/**
 * Высота блока марки.
 *
 * Фиксирована намеренно: подпись карточки собрана снизу вверх, и если бы блок названия менял
 * высоту в момент подмены текста логотипом, слоган, теги и кнопка под ним подпрыгнули бы.
 */
const MARK_H = 78;

/**
 * РАЗМЕР ЛОГОТИПА СЧИТАЕТСЯ ПО ПЛОЩАДИ САМОЙ МАРКИ.
 *
 * Две причины разнобоя, и обе устранены здесь.
 *
 * ПЕРВАЯ — пропорция. Логотипы на TMDB бывают какими угодно: от квадрата до надписи в шесть ширин.
 * Подгонка по высоте делает из длинной марки полосу во весь экран, подгонка по ширине превращает
 * квадратную в иконку. Глаз же сравнивает не высоту и не ширину, а количество занятого места —
 * поэтому фиксируется площадь, а из неё и пропорции выводится всё остальное.
 *
 * ВТОРАЯ — ПОЛЯ В ФАЙЛЕ. У многих логотипов вокруг марки лежит прозрачное поле, иногда в половину
 * холста, и подгонка по холсту делала такую марку вдвое мельче соседних («История игрушек»).
 * Поэтому считается не холст, а рамка непрозрачного (см. api/logoLook): марка занимает своё место,
 * а поле выносится за края блока.
 */
const MARK_AREA = 9800;
/** Пределы на случай крайних пропорций: квадратная марка не вырастает в столб, а очень длинная не
 * превращается в ниточку. */
const MAX_H = 72;
const MIN_H = 34;

/**
 * Название фильма в карточке верхней панели: набранный текст, ПЕРЕТЕКАЮЩИЙ в логотип с афиши.
 *
 * Тот же приём, что и на странице фильма (TitleMark), но выровненный по левому краю: там марка
 * стоит по центру и ей достаточно resizeMode="contain" в блоке во всю ширину, здесь же подпись
 * прижата влево, а contain вписал бы картинку в середину и отодвинул её от края на пустое поле,
 * разное у каждого фильма.
 *
 * Переход начинается, только когда о логотипе известно всё: и что он собой представляет, и как
 * его показывать. Иначе текст успел бы погаснуть раньше, чем логотип получит размер.
 */
export function BillboardTitle({
  item,
  maxWidth,
  scale,
  textStyle,
  fallback,
}: {
  item: MediaItem;
  /** Сколько места есть под марку по горизонтали. */
  maxWidth: number;
  /** Уменьшение при уходе карточки с центра — то же, что было у текста. */
  scale: Animated.AnimatedInterpolation<number>;
  textStyle?: StyleProp<TextStyle>;
  /** Текст названия. Остаётся видимым, пока (и если) логотипа нет. */
  fallback: string;
}) {
  /*
    ГОТОВОЕ ПОКАЗЫВАЕТСЯ СРАЗУ, БЕЗ ПОЯВЛЕНИЯ.

    Заставка прогревает логотипы карточек заранее — и адрес, и файл, и разбор. Но карточка всё
    равно начинала с пустоты: спрашивала адрес обещанием, получала его через кадр и проигрывала
    перетекание текста в логотип. Со стороны это и выглядело как «ничего не прогрелось», хотя всё
    уже лежало в памяти.

    Поэтому сначала СИНХРОННЫЙ вопрос к кэшу. Ответ есть — марка стоит на месте с первого кадра, и
    перетекать нечему. Ответа нет (заставка не успела, открыт другой фильм) — работает прежний
    путь с ожиданием и перетеканием.
  */
  const known = useMemo(() => logoUrlCached(item.type, item.id), [item.type, item.id]);
  /*
    Вопрос задаётся ОДИН РАЗ НА ФИЛЬМ, и это принципиально. Если считать «известно ли» на каждой
    сборке, ответ меняется по ходу жизни карточки: сначала нет, потом разбор доходит до кэша — и
    да. А значение это управляет ещё и тем, нужно ли проигрывать появление; переключившись
    посередине, оно отменяло появление, которое ещё не начиналось, и логотип не показывался ВООБЩЕ
    — карточка так и оставалась с текстом. Ответ снимается на входе и держится до смены фильма.
  */
  const instant = useMemo(
    () => !!known && logoLookCached(known) !== undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item.type, item.id],
  );

  const [logo, setLogo] = useState<string | null>(instant ? known ?? null : null);
  /** Пропорция ХОЛСТА — запасной вариант на случай, если разобрать файл не удалось. */
  const [canvasRatio, setCanvasRatio] = useState<number | null>(null);
  const look = useLogoLook(logo);
  const t = useRef(new Animated.Value(instant ? 1 : 0)).current;

  useEffect(() => {
    let cancelled = false;
    // Известное заново не спрашиваем и не гасим: значение уже стоит на единице.
    if (!instant) {
      setLogo(null);
      setCanvasRatio(null);
      t.setValue(0);
    }

    logoUrl(item.type, item.id)
      .then((u) => {
        if (cancelled || !u) return;
        // Тот же адрес уже стоит (известная марка с первого кадра) — не будим лишнюю сборку.
        setLogo((prev) => (prev === u ? prev : u));
        /*
          ПРОПОРЦИЯ ХОЛСТА НУЖНА ТОЛЬКО ЗАПАСНОМУ ПУТИ. Если разбор марки уже лежит в кэше и удался,
          её размер считается по нему (markBox берёт look.ratio), а canvasRatio не читается вовсе.
          Раньше getSize всё равно ходил за файлом на каждой сборке карточки — а карточек в ленте
          панели много и они пересоздаются при листании. Разбор не удался или ещё не готов —
          спрашиваем, как прежде.
        */
        if (logoLookCached(u)) return;
        Image.getSize(
          u,
          (w, h) => {
            if (!cancelled && h > 0) setCanvasRatio(w / h);
          },
          () => {
            /* размер не пришёл — остаётся текст, это нормальное состояние */
          },
        );
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [item.type, item.id, t, instant]);

  /**
   * Готов ли показывать марку. Считается тем же расчётом, что и рисуется, — только когда разбор
   * завершён (успехом или неудачей), иначе размер поменялся бы на глазах.
   */
  const box =
    look === undefined
      ? null
      : markBox(look, canvasRatio, { maxW: maxWidth, maxH: MAX_H, area: MARK_AREA, minH: MIN_H });

  useEffect(() => {
    if (!box) return;
    // Уже показано — доигрывать нечего.
    if (instant) return;
    Animated.timing(t, {
      toValue: 1,
      duration: Motion.ENTER,
      easing: Motion.curve,
      useNativeDriver: true,
    }).start();
    // Зависимость по размеру, а не по объекту: markBox возвращает новый литерал на каждый рендер.
  }, [box?.w, box?.h, t, instant]);

  return (
    <Animated.View style={[styles.box, { transform: [{ scale }] }]} pointerEvents="none">
      <Animated.View
        style={[
          styles.layer,
          { opacity: t.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) },
        ]}
      >
        <Animated.Text style={textStyle} numberOfLines={2}>
          {fallback}
        </Animated.Text>
      </Animated.View>

      {logo && box && (
        <Animated.View style={[styles.layer, { opacity: t }]}>
          <LogoMark
            url={logo}
            look={look ?? null}
            fallbackRatio={canvasRatio}
            maxWidth={maxWidth}
            maxHeight={MAX_H}
            area={MARK_AREA}
            minHeight={MIN_H}
          />
        </Animated.View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Ширина по содержимому не годится: слои лежат друг на друге, и блок должен занимать всю строку,
  // иначе при подмене он менял бы ширину вслед за логотипом.
  box: { width: '100%', height: MARK_H, transformOrigin: 'left center' },
  // Оба слоя прижаты ВЛЕВО и центрированы по вертикали — как стоял текст.
  layer: {
    ...StyleSheet.absoluteFill,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
});
