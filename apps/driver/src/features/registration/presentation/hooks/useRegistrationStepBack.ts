import { useCallback, useLayoutEffect, useRef } from 'react';
import { BackHandler, type NativeEventSubscription } from 'react-native';
import { CommonActions, useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  buildResumeRoutes,
  ORDERED_STEPS,
  type RegistrationResumeStack,
} from '../../../../navigation/registrationStackRoutes';
import type { RegistrationStackParamList } from '../../../../navigation/types';
import { useRegistrationStore } from '../state/registrationStore';
import { useRegistrationExit, type RegistrationExit } from './useRegistrationExit';

/** Navegación de cualquier paso del wizard (la pila de registro completa). */
type RegistrationStepNavigation = NativeStackNavigationProp<RegistrationStackParamList>;

export interface RegistrationStepBack {
  /**
   * Handler de "atrás" SEGURO para el header del paso (reemplaza a `navigation.goBack` pelado): si hay
   * un paso anterior en la pila lo recorre (`goBack`); si NO (la reconstrucción no llegó a aplicarse,
   * caso límite), abre el exit-confirm en vez de disparar un `GO_BACK` muerto. Pasarlo a `onBack`.
   */
  onBack: () => void;
  /** Maquinaria del exit-confirm (Lote 1) para montar `<RegistrationExitSheet exit={exit} />`. */
  exit: RegistrationExit;
}

/**
 * Back robusto de los pasos 2/3 del wizard (LOTE B, 3 pasos: Vehículo/KYC). Une la RECONSTRUCCIÓN del
 * stack al reanudar (Opción A) con un back que NUNCA muere (Opción B), todo desde DENTRO de la pila de
 * registro (acá `useNavigation()` resuelve la navegación del wizard, no la del root).
 *
 * 1. RECONSTRUCCIÓN (una vez, en mount): `initialRouteName` del navigator monta UNA sola pantalla, así
 *    que al REANUDAR en un paso > 1 (MMKV persistido, o `RejectedScreen.onFix`→`setCurrentStep`) la
 *    pila queda `[pasoN]` y un `goBack` muere. Si la pila es superficial (`!canGoBack()`) y el store
 *    está en un paso > 1, sembramos `[PersonalData … pasoN]` con `CommonActions.reset` (rutas/índice
 *    derivados de `buildResumeRoutes`, sin strings mágicos). Corre en `useLayoutEffect` (tras el render,
 *    antes del paint) y UNA SOLA VEZ (ref): el top visible no cambia (ya era el paso N) → sin flash; el
 *    ref evita el loop de reset.
 * 2. BACK SEGURO (`onBack`): si hay paso anterior, `goBack`; si no, abre el exit-confirm (Lote 1) en vez
 *    de un `GO_BACK` muerto. Red de seguridad por si (1) no se aplicó por cualquier motivo.
 * 3. HARDWARE BACK: a diferencia del guard "tonto" del Lote 1 (que SIEMPRE abre el exit-confirm, válido
 *    solo en las pantallas raíz), acá el back de hardware es STEP-AWARE y espeja a `onBack`: si el
 *    confirm está abierto lo cierra; si hay paso anterior, retrocede; si no, abre el exit-confirm. Así el
 *    back de Android conserva el comportamiento natural (volver al paso previo) y, en el caso límite de
 *    pila superficial, NUNCA cierra la app por sorpresa. Ningún back —software ni hardware, en ningún
 *    paso— puede morir ni cerrar la app inesperadamente.
 */
export function useRegistrationStepBack(enabled = true): RegistrationStepBack {
  const navigation = useNavigation<RegistrationStepNavigation>();
  const exit = useRegistrationExit();
  const seeded = useRef(false);

  useLayoutEffect(() => {
    // EMBEBIDO en el wizard de un solo screen (`enabled=false`): la pila/back/exit los maneja el HOST. No
    // reconstruimos la pila ni registramos el back de hardware acá (sería un doble handler con el del host).
    if (!enabled || seeded.current) {
      return;
    }
    seeded.current = true;
    // Solo reconstruimos si la pila es superficial (un único paso): así no pisamos una pila ya formada
    // por navegación normal (avanzar paso a paso deja `canGoBack() === true`).
    if (navigation.canGoBack()) {
      return;
    }
    const resume: RegistrationResumeStack | null = buildResumeRoutes(
      useRegistrationStore.getState().currentStep,
    );
    if (resume) {
      navigation.dispatch(CommonActions.reset(resume));
    }
  }, [navigation, enabled]);

  const onBack = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    // Pila SUPERFICIAL (re-mount del navigator por un cambio de `registrationStatus` en el root / la
    // reconstrucción de mount no llegó a aplicarse): en vez de claudicar al exit-confirm —que SOLO
    // corresponde al paso 1, donde NO hay paso anterior—, reconstruimos `[PersonalData … pasoN]` y
    // retrocedemos al paso ANTERIOR. La FUENTE DE VERDAD es `currentStep` del store, no la pila frágil:
    // así el "atrás" SIEMPRE camina los pasos ya completados (lo que el conductor espera), y el exit queda
    // solo cuando de verdad no hay anterior. `setCurrentStep` mantiene el wizard y la pila en sync.
    const store = useRegistrationStore.getState();
    const resume = buildResumeRoutes(store.currentStep);
    if (resume && resume.index > 0) {
      const routes = resume.routes.slice(0, resume.index); // dropea el paso actual → `[PersonalData … pasoN-1]`
      const prevStep = ORDERED_STEPS[routes.length - 1]; // paso anterior (existe: `index > 0` ⇒ length ≥ 1)
      if (prevStep !== undefined) {
        store.setCurrentStep(prevStep);
        navigation.dispatch(CommonActions.reset({ index: routes.length - 1, routes }));
        return;
      }
    }
    // Paso 1 (sin paso anterior): ofrecemos la salida del onboarding (Lote 1).
    exit.requestExit();
  }, [navigation, exit]);

  // Back de hardware STEP-AWARE (Android): si el confirm está abierto, lo cierra; si no, espeja a
  // `onBack` (retrocede al paso previo, o abre el exit-confirm si la pila quedó superficial). Consume el
  // evento (`true`) para que Android nunca cierre la app por sorpresa. Montado solo en foco.
  useFocusEffect(
    useCallback(() => {
      // Embebido (`enabled=false`): el back de hardware lo maneja el host del wizard, no la página.
      if (!enabled) {
        return undefined;
      }
      const subscription: NativeEventSubscription = BackHandler.addEventListener(
        'hardwareBackPress',
        () => {
          if (exit.confirmVisible) {
            exit.dismissExit();
          } else {
            onBack();
          }
          return true;
        },
      );
      return () => subscription.remove();
    }, [exit, onBack, enabled]),
  );

  return { onBack, exit };
}
