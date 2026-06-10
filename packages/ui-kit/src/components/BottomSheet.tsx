import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme/ThemeProvider';
import { useReducedMotion } from '../theme/useReducedMotion';
import { Text } from './Text';

export interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
  /** Muestra el asa de arrastre superior. */
  showHandle?: boolean;
  /** Permite cerrar tocando el backdrop. */
  dismissOnBackdrop?: boolean;
  /** Footer fijo dentro del sheet (CTA), por encima del inset inferior. */
  footer?: ReactNode;
  contentStyle?: ViewStyle;
}

const OFFSCREEN = 1000;

/**
 * Bottom sheet modal. Slide + fade del backdrop con curva tipo drawer, arrastre para descartar
 * (umbral de distancia o velocidad, estilo emil) y respeto a reduce-motion. Scrim 45-60% para
 * aislar el contenido. Esc/back de Android cierran.
 */
export function BottomSheet({
  visible,
  onClose,
  children,
  title,
  showHandle = true,
  dismissOnBackdrop = true,
  footer,
  contentStyle,
}: BottomSheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const { height: windowHeight } = useWindowDimensions();
  const [rendered, setRendered] = useState(visible);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Altura del teclado (para acotar el sheet entre el notch y el teclado). En iOS `will*` da el alto
  // antes de la animación (sin salto); en Android `did*`. El KeyboardAvoidingView hace el LIFT; este
  // estado solo alimenta el `maxHeight` para que el sheet NUNCA se meta bajo el notch.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => setKeyboardHeight(e.endCoordinates?.height ?? 0));
    const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Tope de altura: deja libre el safe-area superior (notch/Dynamic Island) y el alto del teclado.
  // Si el contenido excede esto, el sheet se queda acá y su cuerpo SCROLLEA (no se va a pantalla).
  const maxSheetHeight = Math.max(
    240,
    windowHeight - insets.top - keyboardHeight - theme.spacing.xl,
  );

  const translateY = useSharedValue(OFFSCREEN);
  const backdrop = useSharedValue(0);
  const heightRef = useRef(OFFSCREEN);

  const drawerEasing = Easing.bezier(...theme.motion.easing.drawer);

  const animateOpen = useCallback(() => {
    if (reduced) {
      backdrop.value = 1;
      translateY.value = 0;
      return;
    }
    backdrop.value = withTiming(1, { duration: theme.motion.duration.base });
    translateY.value = withTiming(0, { duration: theme.motion.duration.slow, easing: drawerEasing });
  }, [reduced, theme, backdrop, translateY, drawerEasing]);

  const animateClose = useCallback(() => {
    const finish = () => setRendered(false);
    if (reduced) {
      backdrop.value = 0;
      translateY.value = heightRef.current;
      finish();
      return;
    }
    backdrop.value = withTiming(0, { duration: theme.motion.exit.base });
    translateY.value = withTiming(
      heightRef.current,
      { duration: theme.motion.exit.slow, easing: drawerEasing },
      (completed) => {
        if (completed) runOnJS(finish)();
      },
    );
  }, [reduced, theme, backdrop, translateY, drawerEasing]);

  useEffect(() => {
    if (visible) {
      setRendered(true);
    } else if (rendered) {
      animateClose();
    }
  }, [visible, rendered, animateClose]);

  useEffect(() => {
    if (rendered && visible) animateOpen();
  }, [rendered, visible, animateOpen]);

  const onLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) heightRef.current = h;
  };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) => gesture.dy > 6,
      onPanResponderMove: (_evt, gesture) => {
        translateY.value = Math.max(0, gesture.dy);
      },
      onPanResponderRelease: (_evt, gesture) => {
        const shouldClose = gesture.dy > heightRef.current * 0.3 || gesture.vy > 0.6;
        if (shouldClose) {
          onClose();
        } else {
          translateY.value = withTiming(0, { duration: theme.motion.duration.base, easing: drawerEasing });
        }
      },
    }),
  ).current;

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));

  if (!rendered) return null;

  return (
    <Modal transparent visible={rendered} animationType="none" onRequestClose={onClose} statusBarTranslucent>
      {/* El teclado tapaba los inputs del sheet (anclado abajo dentro de un Modal). En iOS el Modal
          no reacomoda solo: KeyboardAvoidingView con `padding` empuja el sheet por encima del teclado.
          En Android lo resuelve el `adjustResize` del sistema (behavior undefined). */}
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Animated.View style={[styles.backdrop, { backgroundColor: theme.colors.overlay }, backdropStyle]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cerrar"
            style={styles.flex}
            disabled={!dismissOnBackdrop}
            onPress={dismissOnBackdrop ? onClose : undefined}
          />
        </Animated.View>

        <Animated.View
          accessibilityViewIsModal
          onLayout={onLayout}
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radii.xl,
              borderTopRightRadius: theme.radii.xl,
              paddingBottom: insets.bottom + theme.spacing.lg,
              maxHeight: maxSheetHeight,
              ...theme.elevation.level3,
            },
            sheetStyle,
            contentStyle,
          ]}
        >
          {showHandle ? (
            <View {...panResponder.panHandlers} style={styles.handleArea}>
              <View style={[styles.handle, { backgroundColor: theme.colors.borderStrong }]} />
            </View>
          ) : null}

          {title ? (
            <Text variant="title3" style={styles.title}>
              {title}
            </Text>
          ) : null}

          {/* Cuerpo SCROLLABLE: con el sheet acotado por `maxSheetHeight`, si el contenido (input +
              lista de sugerencias) excede, scrollea acá adentro en vez de empujar el sheet bajo el
              notch. `keyboardShouldPersistTaps` deja tocar una sugerencia sin que el teclado se cierre antes. */}
          <ScrollView
            style={styles.body}
            contentContainerStyle={{ paddingHorizontal: theme.spacing.xl }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>

          {footer ? (
            <View style={[styles.footer, { paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }]}>
              {footer}
            </View>
          ) : null}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  flex: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFill },
  sheet: { width: '100%' },
  handleArea: { alignItems: 'center', paddingVertical: 10 },
  handle: { width: 40, height: 5, borderRadius: 999 },
  title: { paddingHorizontal: 20, paddingBottom: 8 },
  // flexShrink permite que el ScrollView ceda altura dentro del `maxHeight` del sheet y scrollee;
  // sin esto el cuerpo intentaría crecer con el contenido y empujaría el sheet fuera de pantalla.
  body: { flexShrink: 1 },
  footer: {},
});
