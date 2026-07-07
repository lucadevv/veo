import {useReducedMotion, useTheme} from '@veo/ui-kit';
import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
} from 'react';
import {
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  ScrollView as GHScrollView,
} from 'react-native-gesture-handler';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import Animated, {
  clamp,
  runOnJS,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

/**
 * Anclaje del sheet. Puede ser:
 *  - Una FRACCIÓN de la altura disponible (0..1). Ej. `0.92` = casi pantalla completa.
 *  - El literal `'content'` (CONTENT-HUGGING): la altura se MIDE del contenido (vía `onLayout`) y se
 *    CAPA a `maxContentFraction`. El sheet "abraza" lo que renderiza hasta ese máximo; si lo supera,
 *    se queda en el máximo y la lista scrollea adentro.
 */
export type SnapPoint = number | 'content';

export interface DraggableSheetHandle {
  /** Anima el sheet al punto de anclaje con ese índice (clamped al rango válido). */
  snapToIndex: (index: number) => void;
}

/** Render-prop para el contenido scrolleable, que recibe el `ScrollView` ya cableado al gesto. */
export type DraggableSheetScrollRenderer = (
  ScrollComponent: typeof GHScrollView,
) => React.ReactNode;

export interface DraggableSheetProps {
  /**
   * Puntos de anclaje, de menor a mayor altura. Una fracción `0..1` ancla a esa proporción de la
   * altura disponible; el literal `'content'` ancla a la altura MEDIDA del contenido (capada a
   * `maxContentFraction`). Ej.: `['content', 0.92]` → peek que abraza el contenido / casi completo.
   */
  snapPoints: ReadonlyArray<SnapPoint>;
  /**
   * Tope (fracción de la altura disponible) para los anclajes `'content'`. Por defecto `0.62`: el
   * peek nunca supera el 62% aunque el contenido sea más alto (entonces scrollea adentro).
   */
  maxContentFraction?: number;
  /** Índice de anclaje inicial (por defecto 0 · el más bajo/peek). */
  initialIndex?: number;
  /** Notifica el índice de anclaje al que se asentó el sheet tras soltar (snap con momentum). */
  onSnap?: (index: number) => void;
  /**
   * Contenido fijo del sheet (no scrolleable). Para contenido scrolleable que coopere con el drag,
   * usar `renderScroll` en su lugar (resuelve gesto-del-sheet vs scroll interno).
   */
  children?: React.ReactNode;
  /**
   * Render-prop que recibe un `ScrollView` cableado al gesto del sheet. El scroll interno solo se
   * activa cuando el contenido NO entra en la altura actual del sheet; al llegar arriba del scroll,
   * arrastrar hacia abajo vuelve a mover el sheet. Estándar Uber/Flutter, sin pelear el gesto.
   */
  renderScroll?: DraggableSheetScrollRenderer;
  /**
   * Contenido FIJO del sheet (no scrollea): se renderiza entre el grabber y el cuerpo scrolleable y
   * sigue siendo arrastrable (como el grabber). Pensado para el buscador + atajos que deben quedar
   * SIEMPRE visibles. Cuando hay header, el peek ABRAZA al header (+ `peekPreviewPx`), NO a toda la
   * lista → peek compacto y estable (no crece con el contenido del cuerpo).
   */
  renderHeader?: () => React.ReactNode;
  /** Notifica (en JS) la altura VISIBLE del peek en px, para compensar la cámara del mapa (paddingBottom). */
  onPeekHeightChange?: (px: number) => void;
  /**
   * Capa de FONDO decorativa (p. ej. el gradiente de vidrio del Home, pen P/Home · HomeContent),
   * renderizada absoluteFill DEBAJO del grabber/header/contenido y recortada por las esquinas
   * redondeadas del sheet. No intercepta gestos.
   */
  renderBackground?: () => React.ReactNode;
  /**
   * Alto del chrome inferior (típicamente el tab bar) que YA recorta la pantalla del tab. Se descuenta
   * del área útil para que las FRACCIONES de los anclajes midan contra el alto real visible — pero el
   * sheet sigue anclado en `bottom: 0` (pegado al borde inferior, NO se levanta: levantarlo lo haría
   * ver "flotando" porque la pantalla del tab ya termina arriba del tab bar).
   */
  bottomOffset?: number;
  style?: ViewStyle;
}

// Reanimated 4 unificó los umbrales de reposo `restDisplacementThreshold` + `restSpeedThreshold` en un
// solo `energyThreshold`; usamos su default (el asentamiento lo determina la energía del sistema). La
// SENSACIÓN del spring la fijan damping/stiffness/mass, que se mantienen idénticos.

/** Spring de asentamiento: rápido pero con cuerpo (sensación premium, sin rebote excesivo). */
const SPRING: WithSpringConfig = {
  damping: 22,
  stiffness: 240,
  mass: 0.9,
  overshootClamping: false,
};

/** Spring suave para re-acomodar la altura del peek cuando el contenido cambia (sin tirón). */
const RESIZE_SPRING: WithSpringConfig = {
  damping: 26,
  stiffness: 200,
  mass: 0.9,
  overshootClamping: true,
};

/** Umbral de velocidad (px/s) a partir del cual el flick decide la dirección del snap. */
const FLICK_VELOCITY = 600;

/** Tope por defecto para anclajes `'content'` (fracción de la altura útil). */
const DEFAULT_MAX_CONTENT_FRACTION = 0.62;

/** Anclaje mínimo absoluto para `'content'` mientras aún no se midió el contenido (evita 0). */
const MIN_CONTENT_FRACTION = 0.16;

/** Altura física de la fila del grabber (paddingTop 8 + grabber 4 + paddingBottom 6), no medible. */
const GRABBER_CHROME = 8 + 4 + 6;

/** ScrollView de GH animable por reanimated (para `scrollTo` desde worklets del pan). */
const AnimatedGHScrollView = Animated.createAnimatedComponent(GHScrollView);

/**
 * Bottom sheet ARRASTRABLE de verdad (estilo Flutter DraggableScrollableSheet / Uber) con altura
 * DINÁMICA basada en el contenido (content-hugging). El usuario lo arrastra hacia arriba/abajo con el
 * dedo y, al soltar, hace SNAP con momentum (withSpring) al punto de anclaje más cercano —o al
 * siguiente en la dirección del flick si la velocidad es alta—.
 *
 * Todo el drag corre en el hilo de UI vía worklets de Reanimated (sin cruzar el bridge por frame),
 * por lo que se mantiene a 60fps. Respeta `useReducedMotion` (asentamiento instantáneo, sin spring).
 *
 * MODELO DE ALTURA. El cuerpo se monta a la altura MÁXIMA posible (la fracción más alta) y siempre
 * se ancla abajo; cada anclaje se expresa como cuánto se DESPLAZA el cuerpo hacia abajo (`translateY`)
 * respecto de esa altura máxima. Así el contenido del estado expandido ya está montado y "asoma" al
 * subir, sin remontar nada.
 *
 * CONTENT-HUGGING. Para anclajes `'content'`, su altura visible no es fija: se MIDE la altura natural
 * del contenido (un `onLayout` en un wrapper SIN restricción de alto) y se deriva el offset del peek
 * como `maxHeight - min(medido + chrome, maxContentHeight)`. La medida vive en un shared value, de
 * modo que el offset se recalcula en el hilo de UI y la altura re-anima suave (`withSpring`) cuando el
 * contenido cambia (idle→searching, aparición de sugerencias) sin saltos.
 *
 * Estilo visual `.bsheet` del design-handoff: fondo surface, esquinas superiores redondeadas (≈26),
 * borde superior, sombra hacia ARRIBA y un grabber (40×5) centrado. El área del grabber + el cuerpo
 * son arrastrables.
 */
export const DraggableSheet = forwardRef<
  DraggableSheetHandle,
  DraggableSheetProps
>(function DraggableSheet(
  {
    snapPoints,
    maxContentFraction = DEFAULT_MAX_CONTENT_FRACTION,
    initialIndex = 0,
    onSnap,
    children,
    renderScroll,
    renderHeader,
    onPeekHeightChange,
    renderBackground,
    bottomOffset = 0,
    style,
  },
  ref,
): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const {height: windowHeight} = useWindowDimensions();

  // Altura útil para anclar: descuenta el inset superior (el sheet nunca tapa la status bar) y el
  // `bottomOffset` (p. ej. el tab bar), de modo que las fracciones se midan contra el alto REAL
  // disponible entre la status bar y el tab bar.
  const available = Math.max(windowHeight - insets.top - bottomOffset, 1);

  // Normaliza los anclajes preservando su tipo, ORDENADOS por su altura estimada ascendente. Para
  // ordenar, `'content'` usa su tope (`maxContentFraction`) como cota superior; en runtime su altura
  // real puede ser menor (la medida manda), pero a efectos de orden de anclajes el tope es estable.
  const {maxFraction, anchors} = useMemo(() => {
    const estimated = snapPoints.map(p =>
      p === 'content' ? clampFraction(maxContentFraction) : clampFraction(p),
    );
    const indexed = snapPoints
      .map((point, i) => ({point, estimate: estimated[i]!}))
      .sort((a, b) => a.estimate - b.estimate);
    const max = indexed[indexed.length - 1]?.estimate ?? 0.5;
    return {maxFraction: max, anchors: indexed.map(it => it.point)};
  }, [snapPoints, maxContentFraction]);

  // Altura física del cuerpo montado (= la del anclaje MÁS ALTO). El peek "asoma" empujándolo.
  const sheetHeight = useMemo(
    () => Math.round(available * maxFraction),
    [available, maxFraction],
  );

  // Chrome no-medible que rodea al contenido medido (la fila del grabber). Se suma a la medida.
  const chrome = GRABBER_CHROME;

  // Tope absoluto (px) para anclajes `'content'`.
  const maxContentPx = useMemo(
    () => Math.round(available * clampFraction(maxContentFraction)),
    [available, maxContentFraction],
  );

  // Altura medida del contenido scrolleable (px). 0 = aún sin medir → se usa una cota mínima.
  const measuredContent = useSharedValue(0);
  // Altura medida del header FIJO (px). > 0 ⇒ el peek abraza al header (+ preview), no a la lista.
  const measuredHeader = useSharedValue(0);

  // Offset (px que se baja el cuerpo) de CADA anclaje, derivado en el hilo de UI. Para fracciones es
  // constante; para `'content'` depende de `measuredContent` (de ahí `useDerivedValue`).
  const fractionOffsets = useMemo(
    () =>
      anchors.map(p =>
        p === 'content'
          ? null
          : Math.round((maxFraction - clampFraction(p)) * available),
      ),
    [anchors, maxFraction, available],
  );

  // Altura VISIBLE del anclaje `'content'` (peek) = CONTENT-HUGGING del header fijo + el cuerpo
  // (la lista), capado a `maxContentPx`. Así el peek muestra las cards (no solo el header); si el
  // contenido supera el tope, se queda en el tope y el cuerpo scrollea adentro bajo el header fijo.
  const peekContentVisible = useDerivedValue<number>(() => {
    const minContent = Math.round(available * MIN_CONTENT_FRACTION);
    const measured = measuredHeader.value + measuredContent.value;
    const raw = measured > 0 ? chrome + measured : minContent;
    return Math.min(Math.max(raw, minContent), maxContentPx);
  }, [available, chrome, maxContentPx]);

  const offsets = useDerivedValue<number[]>(() => {
    const contentOffset = Math.round(sheetHeight - peekContentVisible.value);
    return fractionOffsets.map(o => (o === null ? contentOffset : o));
  }, [fractionOffsets, sheetHeight]);

  // Reporta a JS la altura visible del peek (para que el Home compense la cámara del mapa). Cambia
  // solo cuando se (re)mide el header/contenido, no por frame de drag.
  const emitPeekHeight = useCallback(
    (px: number) => {
      onPeekHeightChange?.(px);
    },
    [onPeekHeightChange],
  );
  useAnimatedReaction(
    () => Math.round(peekContentVisible.value),
    (px, prev) => {
      if (px !== prev && px > 0) runOnJS(emitPeekHeight)(px);
    },
    [emitPeekHeight],
  );

  const anchorCount = anchors.length;
  const safeInitial = clampIndex(initialIndex, anchorCount);

  // Estimación del offset inicial para sembrar `translateY` SIN flash en el primer frame (antes de
  // que el `onLayout` mida): un anclaje `'content'` sin medir parte de la cota mínima.
  const initialOffsetEstimate = useMemo(() => {
    const fo = fractionOffsets[safeInitial];
    if (fo !== null && fo !== undefined) {
      return fo;
    }
    const minContent = Math.round(available * MIN_CONTENT_FRACTION);
    return Math.round(sheetHeight - minContent);
  }, [fractionOffsets, safeInitial, available, sheetHeight]);

  // Índice de anclaje actualmente "fijado" (al que apunta el sheet). El offset real se lee del
  // derivado para que, si el contenido cambia mientras estamos en ese índice, la altura siga.
  const snapIndex = useSharedValue(safeInitial);
  // `translateY` del cuerpo: 0 = totalmente expandido; mayor = más bajo (peek).
  const translateY = useSharedValue(initialOffsetEstimate);
  // Posición de referencia al iniciar el gesto (para arrastrar relativo, no absoluto).
  const startY = useSharedValue(initialOffsetEstimate);
  // Offset del scroll interno (0 = arriba del todo). Gobierna gesto-del-sheet vs scroll.
  const scrollOffset = useSharedValue(0);
  // True mientras el cuerpo del sheet está tomando el gesto (vs. dejar scrollear el contenido).
  const dragging = useSharedValue(false);
  // True mientras el usuario arrastra: inhibe el re-acomodo automático de altura (no pelear el dedo).
  const interacting = useSharedValue(false);

  // Siembra translateY con el offset inicial una vez que el derivado tiene un valor utilizable, y
  // re-acomoda suave cuando el offset del índice fijado cambia (contenido nuevo) si no se interactúa.
  useAnimatedReaction(
    () => offsets.value[snapIndex.value] ?? 0,
    (target, prev) => {
      if (interacting.value) {
        return;
      }
      if (prev === null) {
        // Primer asentamiento: sin animación (evita un "pop" al montar).
        translateY.value = target;
        return;
      }
      if (Math.abs(target - translateY.value) < 0.5) {
        return;
      }
      translateY.value = reduced ? target : withSpring(target, RESIZE_SPRING);
    },
    [reduced],
  );

  const emitSnap = useCallback(
    (index: number) => {
      onSnap?.(index);
    },
    [onSnap],
  );

  // Asienta el cuerpo en el offset de un índice de anclaje (spring con momentum o instantáneo).
  const settleTo = useCallback(
    (index: number) => {
      'worklet';
      snapIndex.value = index;
      const target = offsets.value[index] ?? 0;
      if (reduced) {
        translateY.value = target;
      } else {
        translateY.value = withSpring(target, SPRING);
      }
      runOnJS(emitSnap)(index);
    },
    [offsets, reduced, translateY, snapIndex, emitSnap],
  );

  // Elige el índice de anclaje destino dado el offset actual y la velocidad del flick.
  const resolveSnapIndex = useCallback(
    (current: number, velocityY: number): number => {
      'worklet';
      const offs = offsets.value;
      // velocityY > 0 → arrastrando hacia abajo (cierra) · < 0 → hacia arriba (abre).
      let nearest = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let i = 0; i < offs.length; i += 1) {
        const distance = Math.abs(offs[i]! - current);
        if (distance < bestDistance) {
          bestDistance = distance;
          nearest = i;
        }
      }
      // Flick fuerte: salta un anclaje en la dirección del gesto. offsets ordenados DESC por índice
      // (index 0 = mayor offset/peek; último = 0/full). Subir el dedo = abrir (índice mayor).
      if (velocityY < -FLICK_VELOCITY && nearest < offs.length - 1) {
        return nearest + 1; // hacia arriba (más alto)
      }
      if (velocityY > FLICK_VELOCITY && nearest > 0) {
        return nearest - 1; // hacia abajo (más bajo)
      }
      return nearest;
    },
    [offsets],
  );

  useImperativeHandle(
    ref,
    () => ({
      snapToIndex: (index: number) => {
        const safe = clampIndex(index, anchorCount);
        settleTo(safe);
      },
    }),
    [anchorCount, settleTo],
  );

  // Ref ANIMADA al scroll interno: permite congelarlo (`scrollTo`) desde el worklet del pan
  // mientras el SHEET es lo que se mueve (sin doble desplazamiento sheet+lista).
  const scrollRef = useAnimatedRef<Animated.ScrollView>();

  // Gesto NATIVO del scroll interno, con su PROPIO detector alrededor del ScrollView (ver render).
  // CLAVE del fix: antes `Gesture.Native()` vivía suelto en el detector del contenedor — no
  // referenciaba al scrollable real, así que cuando el pan se activaba CANCELABA el scroll del hijo
  // y la lista no scrolleaba nunca dentro del sheet. Atado + `simultaneousWithExternalGesture`,
  // ambos corren de verdad y el gating de abajo decide quién mueve qué.
  const nativeScroll = useMemo(() => Gesture.Native(), []);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .simultaneousWithExternalGesture(nativeScroll)
        .onStart(() => {
          startY.value = translateY.value;
          dragging.value = false;
          interacting.value = true;
        })
        .onUpdate(event => {
          const offs = offsets.value;
          const minOffset = offs[offs.length - 1] ?? 0; // anclaje más alto (full) = menor offset.
          const maxOffset = offs[0] ?? 0; // anclaje más bajo (peek) = mayor offset.
          // "Expandido" aquí significa: el sheet está en (o por encima de) su anclaje más alto, donde
          // el contenido puede exceder el alto y debe scrollear. Gating gesto-vs-scroll:
          const expanded = translateY.value <= minOffset + 0.5;
          const atTop = scrollOffset.value <= 0;
          // Si el sheet está expandido y el scroll interno NO está arriba, el contenido scrollea (no
          // movemos el sheet). Solo retomamos el sheet cuando el scroll llega arriba y se sigue
          // arrastrando hacia abajo (translation positiva).
          if (expanded && !atTop && !dragging.value) {
            startY.value = translateY.value;
            return;
          }
          if (expanded && atTop && event.translationY <= 0 && !dragging.value) {
            // Arriba del scroll y empujando hacia arriba: ya está expandido, deja scrollear.
            startY.value = translateY.value;
            return;
          }
          dragging.value = true;
          // INDEPENDENCIA drag/scroll (decisión del dueño): el DRAG mueve el SHEET y nada más — la
          // lista se congela arriba mientras tanto (sin traspaso del excedente al scroll). El scroll
          // de la lista es SU propio gesto, sobre el body.
          scrollTo(scrollRef, 0, 0, false);
          // Arrastre relativo, acotado al rango [minOffset(full), maxOffset(peek)].
          translateY.value = clamp(
            startY.value + event.translationY,
            minOffset,
            maxOffset,
          );
        })
        .onEnd(event => {
          if (!dragging.value) {
            return;
          }
          const index = resolveSnapIndex(translateY.value, event.velocityY);
          settleTo(index);
        })
        .onFinalize(() => {
          interacting.value = false;
        }),
    [
      nativeScroll,
      scrollRef,
      startY,
      translateY,
      dragging,
      interacting,
      scrollOffset,
      offsets,
      resolveSnapIndex,
      settleTo,
    ],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollOffset.value = event.nativeEvent.contentOffset.y;
    },
    [scrollOffset],
  );

  // Mide la altura natural del contenido. El wrapper que dispara esto NO debe estar restringido en
  // alto, de modo que reporte la altura intrínseca; con ella se deriva el offset del peek.
  const onContentLayout = useCallback(
    (event: LayoutChangeEvent) => {
      measuredContent.value = event.nativeEvent.layout.height;
    },
    [measuredContent],
  );

  // Mide la altura del header FIJO (define el peek cuando hay header).
  const onHeaderLayout = useCallback(
    (event: LayoutChangeEvent) => {
      measuredHeader.value = event.nativeEvent.layout.height;
    },
    [measuredHeader],
  );

  // `ScrollView` cableado: reporta su offset al worklet y lleva la ref ANIMADA (scrollTo del pan).
  // Va DENTRO de su propio GestureDetector con `nativeScroll` (ver render): así el pan de afuera
  // y el scroll de adentro corren simultáneos DE VERDAD y el gating decide. Cuando el contenido
  // entra en la altura actual NO scrollea (hug); cuando la supera, scrollea adentro.
  const ScrollComponent = useMemo(() => {
    function WiredScroll(
      props: React.ComponentProps<typeof GHScrollView>,
    ): React.JSX.Element {
      const {contentContainerStyle, ...rest} = props;
      return (
        <GestureDetector gesture={nativeScroll}>
          <AnimatedGHScrollView
            {...rest}
            ref={scrollRef}
            onScroll={onScroll}
            scrollEventThrottle={16}
            keyboardShouldPersistTaps="handled">
            {/* Wrapper medido: reporta la altura intrínseca del contenido (sin restricción de alto). */}
            <View onLayout={onContentLayout} style={contentContainerStyle}>
              {props.children}
            </View>
          </AnimatedGHScrollView>
        </GestureDetector>
      );
    }
    return WiredScroll as unknown as typeof GHScrollView;
  }, [nativeScroll, scrollRef, onScroll, onContentLayout]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{translateY: translateY.value}],
  }));

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View
        style={[
          styles.sheet,
          {
            // bottom: 0 (de styles.sheet) — anclado al borde inferior, NO se levanta con bottomOffset
            // (eso solo achica el área útil de las fracciones; ver el doc del prop).
            height: sheetHeight,
            borderTopLeftRadius: theme.radii['2xl'],
            borderTopRightRadius: theme.radii['2xl'],
            // Sombra hacia ARRIBA (pen C/DraggableSheet: 0 -10 blur 44). iOS via shadowOffset
            // negativo; Android via elevation (no direccional, pero da profundidad equivalente).
            shadowColor: '#000000',
            shadowOffset: {width: 0, height: -12},
            shadowOpacity: 0.5,
            shadowRadius: 30,
            elevation: 18,
          },
          animatedStyle,
          style,
        ]}>
        {/* PIEL DE VIDRIO canónica (pen C/DraggableSheet · XFjV8): gradiente #272C38→#14161C sobre la
            base casi opaca de styles.sheet. Los hex van crudos también en el pen (no son variables);
            el background_blur 34 del pen no tiene lib en el proyecto — la opacidad ~95% lo aproxima. */}
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          <Defs>
            <SvgLinearGradient id="sheetGlass" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#272C38" stopOpacity={0.82} />
              <Stop offset="1" stopColor="#272C38" stopOpacity={0} />
            </SvgLinearGradient>
          </Defs>
          <Rect
            x="0"
            y="0"
            width="100%"
            height="100%"
            fill="url(#sheetGlass)"
          />
        </Svg>
        {renderBackground ? (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {renderBackground()}
          </View>
        ) : null}
        <View style={styles.grabberRow} pointerEvents="box-none">
          {/* Handle PRIMARIO 36×4: el canónico del sistema (pen C/DraggableSheet · XFjV8) — igual
              que el BottomSheet modal del ui-kit. Antes iba gris (borderStrong) y divergía. */}
          <View
            style={[styles.grabber, {backgroundColor: theme.colors.accent}]}
          />
        </View>
        {renderHeader ? (
          <View onLayout={onHeaderLayout}>{renderHeader()}</View>
        ) : null}
        {renderScroll ? renderScroll(ScrollComponent) : children}
      </Animated.View>
    </GestureDetector>
  );
});

/** Acota una fracción de anclaje a un rango sano (evita 0 exacto que ocultaría el grabber). */
function clampFraction(fraction: number): number {
  'worklet';
  if (Number.isNaN(fraction)) {
    return 0.5;
  }
  return Math.min(Math.max(fraction, 0.05), 0.98);
}

/** Acota un índice de anclaje al rango disponible. */
function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.min(Math.max(index, 0), length - 1);
}

const styles = StyleSheet.create({
  // Base del VIDRIO del pen (C/DraggableSheet): fondo casi opaco (el color inferior del gradiente)
  // + borde 1px #4C5468 en top y laterales. El gradiente lo pinta el SVG de adentro.
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#14161CF2',
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: '#4C5468',
    overflow: 'hidden',
  },
  grabberRow: {alignItems: 'center', paddingTop: 8, paddingBottom: 6},
  grabber: {width: 36, height: 4, borderRadius: 999},
});
