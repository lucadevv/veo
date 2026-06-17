import {tripStatus, type TripStatus} from '@veo/api-client';
import {Text, useReducedMotion, useTheme} from '@veo/ui-kit';
import React, {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View, type LayoutChangeEvent} from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import {VehicleIcon} from '../../../dispatch/presentation/components/VehicleIcon';

/**
 * FRANJA DE ESTADO DEL VIAJE (canónica) — una línea sutil de extremo a extremo con el VehicleIcon del
 * trip animado y una etiqueta de estado debajo. Reemplaza el texto plano del estado en `ActiveTripBody`
 * por una pieza con MOTION CON PROPÓSITO (filosofía Emil): el movimiento comunica la fase, no decora.
 *
 *  · enRoute/arriving → el vehículo se DESLIZA → en loop lento (va hacia vos), texto "En camino".
 *  · arrived          → el vehículo QUIETO al inicio del track con un pulso sutil (te está esperando),
 *                       texto "Tu conductor llegó".
 *  · inProgress       → el vehículo se DESLIZA → (vas en viaje), texto "En viaje".
 *
 * Motion (Emil): un solo barrido lento (~7s) con easing inOut leve (no linear puro); opacidad/escala
 * constantes salvo un fade corto en los extremos para enmascarar el reinicio del loop (sin parpadeo). Todo
 * en el UI thread (reanimated `withRepeat`/`withTiming` sobre transform) — sin timers JS, así que al ir a
 * background reanimated PAUSA solo (no queda un setInterval vivo). Respeta reduce-motion (estado estático).
 *
 * Accesibilidad: el TEXTO es el contenido informativo (lo lee el lector de pantalla). El ícono animado es
 * decorativo → `accessibilityElementsHidden` / `importantForAccessibility="no-hide-descendants"`.
 */

/** Modo visual de la franja, derivado del estado del viaje. */
type StripMode = 'moving' | 'arrived';

export interface TripStatusStripProps {
  /** Estado efectivo del viaje (socket o REST). Puede llegar como string crudo (EXPIRED/FAILED/…). */
  status: TripStatus | string;
}

/** Tamaño del vehículo en la franja (px). Chico y legible, no compite con la DriverCard. */
const ICON_SIZE = 22;
/** Duración de UN barrido del vehículo de izquierda a derecha (ms). Lento = calmo (Emil). */
const SWEEP_MS = 7_000;
/** Duración de medio pulso en 'arrived' (ms). El conductor "respira" esperándote. */
const PULSE_MS = 900;
/** Alto del track (línea sutil). */
const TRACK_HEIGHT = 2;

/** Mapea el estado del viaje al modo de la franja + su etiqueta i18n. */
function resolveStrip(status: string): {mode: StripMode; labelKey: string} {
  switch (status) {
    case tripStatus.enum.ARRIVED:
      return {mode: 'arrived', labelKey: 'tripStrip.arrived'};
    case tripStatus.enum.IN_PROGRESS:
      return {mode: 'moving', labelKey: 'tripStrip.inProgress'};
    // ASSIGNED / ACCEPTED / ARRIVING y cualquier otro estado del viaje activo: conductor en camino.
    default:
      return {mode: 'moving', labelKey: 'tripStrip.enRoute'};
  }
}

export function TripStatusStrip({
  status,
}: TripStatusStripProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const reduced = useReducedMotion();
  const {mode, labelKey} = resolveStrip(status);

  // Ancho REAL del track (lo mide el layout) → el recorrido del vehículo es [0, width - icon].
  const [trackWidth, setTrackWidth] = useState(0);
  const onTrackLayout = (e: LayoutChangeEvent): void => {
    const w = e.nativeEvent.layout.width;
    if (w !== trackWidth) setTrackWidth(w);
  };

  // Progreso 0→1 del barrido (modo 'moving'). Loop forward-only: cada barrido va →, el reinicio se
  // enmascara con un fade en los extremos (no ping-pong: el auto NUNCA va marcha atrás).
  const sweep = useSharedValue(0);
  // Pulso de escala (modo 'arrived'): respiración sutil del vehículo quieto.
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      // Reduce-motion: sin animación. 'moving' deja el auto a mitad del track; 'arrived' al inicio.
      cancelAnimation(sweep);
      cancelAnimation(pulse);
      sweep.value = mode === 'moving' ? 0.5 : 0;
      pulse.value = 0;
      return;
    }
    if (mode === 'moving') {
      cancelAnimation(pulse);
      pulse.value = 0;
      sweep.value = 0;
      sweep.value = withRepeat(
        withTiming(1, {
          duration: SWEEP_MS,
          easing: Easing.bezier(0.45, 0, 0.55, 1),
        }),
        -1,
        false,
      );
    } else {
      cancelAnimation(sweep);
      sweep.value = 0;
      pulse.value = withRepeat(
        withSequence(
          withTiming(1, {
            duration: PULSE_MS,
            easing: Easing.inOut(Easing.quad),
          }),
          withTiming(0, {
            duration: PULSE_MS,
            easing: Easing.inOut(Easing.quad),
          }),
        ),
        -1,
        false,
      );
    }
    return () => {
      cancelAnimation(sweep);
      cancelAnimation(pulse);
    };
  }, [mode, reduced, sweep, pulse]);

  const iconStyle = useAnimatedStyle(() => {
    const travel = Math.max(trackWidth - ICON_SIZE, 0);
    const x = sweep.value * travel;
    // Fade corto en los extremos (primer/último 10%) para que el salto de fin→inicio del loop no se vea.
    // En 'arrived' (sweep fijo en 0) esto da opacidad plena. La escala "respira" solo en 'arrived'.
    const edgeFade =
      mode === 'moving'
        ? interpolate(sweep.value, [0, 0.1, 0.9, 1], [0, 1, 1, 0])
        : 1;
    const scale =
      mode === 'arrived' ? interpolate(pulse.value, [0, 1], [1, 1.14]) : 1;
    return {
      opacity: edgeFade,
      transform: [{translateX: x}, {scale}],
    };
  });

  // Halo de "esperándote" detrás del vehículo en 'arrived': un punto que pulsa en opacidad/escala.
  const haloStyle = useAnimatedStyle(() => ({
    opacity:
      mode === 'arrived' ? interpolate(pulse.value, [0, 1], [0.28, 0]) : 0,
    transform: [
      {
        scale:
          mode === 'arrived' ? interpolate(pulse.value, [0, 1], [1, 2.2]) : 1,
      },
    ],
  }));

  return (
    <View style={[styles.container, {gap: theme.spacing.sm}]}>
      <View
        style={[styles.track, {height: ICON_SIZE}]}
        onLayout={onTrackLayout}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden>
        {/* Línea base sutil (token de borde), centrada verticalmente. */}
        <View
          style={[
            styles.line,
            {
              backgroundColor: theme.colors.border,
              borderRadius: TRACK_HEIGHT,
              top: (ICON_SIZE - TRACK_HEIGHT) / 2,
            },
          ]}
        />
        {/* Vehículo animado. Rotado 90° (el glyph es top-down apuntando ↑) para que apunte → (sentido
            de avance). Decorativo: el track entero ya está oculto a accesibilidad. */}
        <Animated.View style={[styles.icon, iconStyle]} pointerEvents="none">
          <Animated.View
            style={[
              styles.halo,
              {backgroundColor: theme.colors.safe, borderRadius: ICON_SIZE / 2},
              haloStyle,
            ]}
          />
          <View style={styles.iconRotate}>
            <VehicleIcon size={ICON_SIZE} />
          </View>
        </Animated.View>
      </View>
      {/* El estado del viaje es la info MÁS importante de este momento (esperás al conductor) → legible,
          no en el tamaño/color más apagado. */}
      <Text variant="subhead" color="ink">
        {t(labelKey)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {width: '100%'},
  // Track de extremo a extremo del contenido del sheet (el padre da el ancho).
  track: {width: '100%', justifyContent: 'center'},
  line: {position: 'absolute', left: 0, right: 0, height: TRACK_HEIGHT},
  icon: {
    position: 'absolute',
    left: 0,
    width: ICON_SIZE,
    height: ICON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconRotate: {transform: [{rotate: '90deg'}]},
  halo: {position: 'absolute', width: ICON_SIZE, height: ICON_SIZE},
});
