import { useReducedMotion, useTheme } from '@veo/ui-kit';
import React, { useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

/**
 * Interruptor (Toggle) temático del flujo de seguridad/privacidad del pasajero (CameraControl).
 * Espejo del `<Toggle/>` del design-handoff: pista redondeada que vira a `accent` al estar ON y un
 * pulgar que se desliza. ui-kit aún no expone un Switch propio, así que este vive en el feature de
 * trip (mismo patrón que los íconos del feature). Accesible (role switch + estado) y respeta
 * reduce-motion (sin animar el pulgar si el SO lo pide).
 */

const TRACK_WIDTH = 46;
const TRACK_HEIGHT = 28;
const THUMB_SIZE = 22;
const THUMB_TRAVEL = TRACK_WIDTH - THUMB_SIZE - 6; // 3px de margen a cada lado

export interface ToggleProps {
  /** Estado encendido/apagado. */
  on: boolean;
  /** Alterna el estado. Si se omite o `disabled`, el toggle no responde al tap. */
  onChange?: (next: boolean) => void;
  /** Deshabilita la interacción (p. ej. contactos cuando el master está apagado). */
  disabled?: boolean;
  /** Etiqueta accesible (qué se está activando/desactivando). */
  accessibilityLabel: string;
}

export function Toggle({
  on,
  onChange,
  disabled = false,
  accessibilityLabel,
}: ToggleProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(on ? 1 : 0);

  useEffect(() => {
    progress.value = reduced ? (on ? 1 : 0) : withTiming(on ? 1 : 0, { duration: 160 });
  }, [on, reduced, progress]);

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * THUMB_TRAVEL }],
  }));

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor:
      progress.value > 0.5 ? theme.colors.accent : theme.colors.surfaceElevated,
  }));

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled }}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled || !onChange}
      hitSlop={8}
      onPress={() => onChange?.(!on)}
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      <Animated.View
        style={[
          styles.track,
          { borderColor: theme.colors.border },
          trackStyle,
        ]}
      >
        <Animated.View
          style={[
            styles.thumb,
            { backgroundColor: on ? theme.colors.onAccent : theme.colors.inkMuted },
            thumbStyle,
          ]}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    borderWidth: 1,
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
  },
});
