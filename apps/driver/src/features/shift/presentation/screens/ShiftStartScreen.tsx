import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ApiError } from '@veo/api-client';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button, SafeScreen } from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { NoticeHero } from '../../../../shared/presentation/components/NoticeHero';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { IconFace, IconLock } from '../../../../shared/presentation/icons';
import {
  BIOMETRIC_CAPTURE_UNAVAILABLE,
  BIOMETRIC_BACKEND_UNAVAILABLE,
  BIOMETRIC_FRAME_GRABBER_UNAVAILABLE,
  BIOMETRIC_LOCKED,
  BIOMETRIC_REJECTED,
} from '../../domain';
import { BiometricGate, type BiometricGateBanner } from '../components/BiometricGate';
import { useShiftStartFlow } from '../hooks/useShiftStartFlow';

type Props = NativeStackScreenProps<RootStackParamList, 'ShiftStart'>;

/**
 * Inicio de turno con verificación biométrica obligatoria (regla #1 de CLAUDE.md).
 * La captura/liveness por cámara es nativa (frame-grabber): aquí se construye la UI del flujo y, al
 * obtener el `sessionRef`, se llama al backend. Si el conductor no está enrolado, se le redirige a
 * registrar su rostro. El layout premium (hero editorial + cara EN VIVO en círculo, mismo lenguaje que el
 * KYC del alta) vive en `BiometricGate`, que orquesta el handoff de cámara antes de la captura de liveness.
 *
 * Los DOS caminos infelices con frame dedicado (no un banner inline sobre el gate normal) se atienden
 * como layouts centrados aparte, fieles a los frames `C/ShiftStart-Error` y `C/Biometrico-Bloqueado`:
 * el rechazo de liveness/match y el bloqueo de 1h. El resto de avisos (cámara/servicio no disponible,
 * éxito) sí son banners inline sobre el gate porque el diseño no les dio pantalla propia.
 */
export const ShiftStartScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const { run, phase, error, score, isBusy } = useShiftStartFlow(
    () => navigation.goBack(),
    () => navigation.navigate('BiometricEnroll'),
  );

  const errorCode = error instanceof Error ? (error as { code?: string }).code : undefined;
  // Bloqueo biométrico (regla #1: 3 fallos → 1h, solo la central destraba). Es un callejón sin salida
  // por diseño: NO se reintenta, la única acción es contactar a la central.
  const locked =
    errorCode === BIOMETRIC_LOCKED || (error instanceof ApiError && error.status === 403);
  // Rechazo de liveness/match (sin bloqueo): el conductor puede reintentar. Solo cuando el flujo ya
  // volvió a reposo (`idle`) con el error puesto — mientras captura no mostramos la pantalla de error.
  const rejected = !locked && errorCode === BIOMETRIC_REJECTED && phase === 'idle';

  // "Contactar a la central": no existe un deep-link de teléfono propio, así que reusamos el flujo de
  // soporte/ayuda en la app (mismo destino que "Contactar a soporte" del dashboard). DEUDA/BACKEND: si
  // más adelante hay una línea directa de la central (tel:/WhatsApp), cablear acá.
  const contactCentral = (): void => {
    navigation.navigate('Support');
  };

  // Bloqueo biométrico (frame C/Biometrico-Bloqueado): layout centrado dedicado con candado, título y
  // UNA sola acción real (contactar a la central) — reemplaza el ex "botón verificar deshabilitado"
  // que era un callejón sin salida. BACKEND: el countdown de reintento (`lockedUntil`) no viene del
  // servidor; por eso el cuerpo lo OMITE en vez de inventar minutos.
  if (locked) {
    return (
      <SafeScreen
        header={<TopBar title={t('shift.startTitle')} onBack={() => navigation.goBack()} />}
        footer={
          <Button
            label={t('shift.contactCentral')}
            variant="primary"
            fullWidth
            onPress={contactCentral}
          />
        }
      >
        <NoticeHero
          tone="danger"
          icon={({ size, color }) => <IconLock size={size} color={color} strokeWidth={2} />}
          title={t('shift.blockedTitle')}
          description={t('shift.blockedBody')}
        />
      </SafeScreen>
    );
  }

  // Rechazo de verificación (frame C/ShiftStart-Error): layout centrado dedicado con el rostro escaneado,
  // "No pudimos verificarte" y dos acciones — reintentar (relanza el flujo biométrico completo) y contactar
  // a la central. BACKEND: el contador "te quedan N intentos" no viene del servidor; se OMITE el pill de
  // intentos en vez de fabricar el número.
  if (rejected) {
    return (
      <SafeScreen
        header={<TopBar title={t('shift.startTitle')} onBack={() => navigation.goBack()} />}
        footer={
          <View style={styles.footer}>
            <Button
              label={t('shift.biometricRetry')}
              variant="primary"
              fullWidth
              loading={isBusy}
              onPress={run}
            />
            <Button
              label={t('shift.contactCentral')}
              variant="ghost"
              fullWidth
              onPress={contactCentral}
            />
          </View>
        }
      >
        <NoticeHero
          tone="danger"
          icon={({ size, color }) => <IconFace size={size} color={color} strokeWidth={2} />}
          title={t('shift.biometricFailedTitle')}
          description={t('shift.biometricRejectedBody')}
        />
      </SafeScreen>
    );
  }

  const banner = resolveBanner(error, score, phase, t);

  return (
    <BiometricGate
      topTitle={t('shift.startTitle')}
      heading={t('shift.biometricTitle')}
      body={t('shift.biometricBody')}
      banner={banner}
      ctaLabel={isBusy ? t('shift.biometricCapturing') : t('shift.biometricStart')}
      loading={isBusy}
      onCapture={run}
      onBack={navigation.goBack}
    />
  );
};

/**
 * Traduce el resultado del flujo a un aviso INLINE para el gate normal. Los caminos con pantalla propia
 * (rechazo y bloqueo) se atienden antes con layouts dedicados, así que aquí solo quedan: éxito, cámara/
 * servicio no disponible y el error genérico del servidor.
 */
function resolveBanner(
  error: unknown,
  score: number | null,
  phase: string,
  t: TFunction,
): BiometricGateBanner | null {
  if (phase === 'done' && score !== null) {
    return { tone: 'success', title: t('shift.biometricSuccess', { score }) };
  }
  if (!error) {
    return null;
  }
  const errorCode = error instanceof Error ? (error as { code?: string }).code : undefined;
  if (
    errorCode === BIOMETRIC_CAPTURE_UNAVAILABLE ||
    errorCode === BIOMETRIC_FRAME_GRABBER_UNAVAILABLE
  ) {
    return {
      tone: 'warn',
      title: t('shift.biometricUnavailableTitle'),
      description: t('shift.biometricUnavailableBody'),
    };
  }
  if (errorCode === BIOMETRIC_BACKEND_UNAVAILABLE) {
    return {
      tone: 'warn',
      title: t('shift.biometricBackendTitle'),
      description: t('shift.biometricBackendBody'),
    };
  }
  if (error instanceof ApiError) {
    return { tone: 'danger', title: t('errors.generic'), description: error.message };
  }
  return { tone: 'danger', title: t('errors.generic') };
}

const styles = StyleSheet.create({
  footer: { gap: 8 },
});
