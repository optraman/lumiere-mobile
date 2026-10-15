import { useEffect, useRef, useState } from 'react';
import { Animated, Image, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { Motion } from '../theme/motion';
import { useLogoLook, markBox } from '../api/logoLook';
import { LogoMark } from './LogoMark';

/**
 * Площадь марки на странице фильма. Больше, чем в карточке: здесь логотип — заголовок экрана, а не
 * подпись, и стоит он один.
 */
const MARK_AREA = 11000;
const MIN_H = 34;
/** Марка не занимает строку целиком: поля по бокам — часть того, что делает её заголовком. */
const MAX_W_FRACTION = 0.86;

/**
 * Название фильма: набранный текст, который ПЕРЕТЕКАЕТ в логотип с афиши, когда тот загрузится.
 *
 * Логотип приходит отдельным запросом и позже подробностей, поэтому подмена всегда происходит уже
 * на глазах у человека. Мгновенная замена читается как сбой: текст моргнул и стал картинкой.
 *
 * Здесь оба слоя лежат друг на друге в блоке фиксированной высоты и меняются встречно — текст
 * гаснет ровно с той скоростью, с какой проявляется логотип. Высота фиксирована намеренно: если бы
 * блок подстраивался под содержимое, при подмене поехала бы вся страница под ним.
 *
 * РАЗМЕР МАРКИ считается так же, как в карточках на главной (см. BillboardTitle): по площади самой
 * марки и по рамке непрозрачного, а не по холсту файла. Причина та же — у логотипов TMDB вокруг
 * марки бывает прозрачное поле в половину файла, и подгонка по холсту делала одни названия вдвое
 * мельче других без всякой на то причины. Не разобрался файл — показываем его целиком вписанным,
 * как было раньше.
 *
 * Переход запускается не по приходу ССЫЛКИ, а по событию загрузки самой картинки: иначе текст
 * успевал бы исчезнуть раньше, чем логотип реально появится, и в середине оставалась бы пустота.
 */
export function TitleMark({
  logoUrl,
  title,
  textStyle,
  height = 70,
}: {
  logoUrl: string | null;
  title: string;
  textStyle?: StyleProp<TextStyle>;
  height?: number;
}) {
  const [ready, setReady] = useState(false);
  const [boxW, setBoxW] = useState(0);
  const t = useRef(new Animated.Value(0)).current;
  const look = useLogoLook(logoUrl);

  useEffect(() => {
    if (!ready) return;
    Animated.timing(t, {
      toValue: 1,
      duration: Motion.ENTER,
      easing: Motion.curve,
      useNativeDriver: true,
    }).start();
  }, [ready, t]);

  // Ссылка сменилась (открыли другой фильм) — начинаем заново с текста.
  useEffect(() => {
    setReady(false);
    t.setValue(0);
  }, [logoUrl, t]);

  /** Есть ли из чего считать марку. Нет — покажем файл целиком вписанным, как было раньше. */
  const box = markBox(look ?? null, null, {
    maxW: boxW * MAX_W_FRACTION,
    maxH: height,
    area: MARK_AREA,
    minH: MIN_H,
  });

  return (
    <View style={[styles.box, { height }]} onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}>
      {/* Каждый слой лежит в СВОЁЙ растянутой обёртке с центрированием. Центрировать сам текст или
          картинку через absoluteFill нельзя: он задаёт left и right по нулям, и любая заданная
          ширина переопределяет правый край — элемент прижимается влево. */}
      <Animated.View
        style={[
          styles.layer,
          { opacity: t.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) },
        ]}
        pointerEvents="none"
      >
        <Text style={[styles.text, textStyle]} numberOfLines={2}>
          {title}
        </Text>
      </Animated.View>

      {/* Ждём, пока о файле станет известно всё (look !== undefined): иначе марка появилась бы по
          холсту и через мгновение прыгнула бы в свой настоящий размер. */}
      {logoUrl && look !== undefined && (
        <Animated.View style={[styles.layer, { opacity: t }]} pointerEvents="none">
          {box ? (
            <LogoMark
              url={logoUrl}
              look={look ?? null}
              maxWidth={boxW * MAX_W_FRACTION}
              maxHeight={height}
              area={MARK_AREA}
              minHeight={MIN_H}
              onLoad={() => setReady(true)}
            />
          ) : (
            <Image
              source={{ uri: logoUrl }}
              resizeMode="contain"
              onLoad={() => setReady(true)}
              style={styles.logo}
            />
          )}
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: '100%' },
  layer: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  text: { textAlign: 'center' },
  // Ширина и высота в процентах ОТ ОБЁРТКИ, а не через абсолютные края: обёртка уже центрирует,
  // поэтому логотип остаётся посередине при любой своей пропорции.
  logo: { width: '80%', height: '100%' },
});
