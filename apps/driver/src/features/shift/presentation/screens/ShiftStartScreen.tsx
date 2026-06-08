import React from 'react';
import {useTranslation} from 'react-i18next';
import type {TFunction} from 'i18next';
import {ApiError} from '@veo/api-client';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../../../../navigation/types';
import {
  BIOMETRIC_CAPTURE_UNAVAILABLE,
  BIOMETRIC_BACKEND_UNAVAILABLE,
  BIOMETRIC_FRAME_GRABBER_UNAVAILABLE,
  BIOMETRIC_LOCKED,
  BIOMETRIC_REJECTED,
} from '../../domain';
import {BiometricGate, type BiometricGateBanner} from '../components/BiometricGate';
import {useShiftStartFlow} from '../hooks/useShiftStartFlow';

type Props = NativeStackScreenProps<RootStackParamList, 'ShiftStart'>;

/**
 * Inicio de turno con verificación biométrica obligatoria (regla #1 de CLAUDE.md).
 * La captura/liveness por cámara es nativa (frame-grabber): aquí se construye la UI del flujo y, al
 * obtener el `sessionRef`, se llama al backend. Si el conductor no está enrolado, se le redirige a
 * registrar su rostro. El layout premium (escudo + halo cian) vive en `BiometricGate`.
 */
export const ShiftStartScreen = ({navigation}: Props): React.JSX.Element => {
  const {t} = useTranslation();
  const {run, phase, error, score, isBusy} = useShiftStartFlow(
    () => navigation.goBack(),
    () => navigation.navigate('BiometricEnroll'),
  );

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

/** Traduce el resultado del flujo a un aviso accionable (éxito/fallo/bloqueo/cámara no disponible). */
function resolveBanner(
  error: unknown,
  score: number | null,
  phase: string,
  t: TFunction,
): BiometricGateBanner | null {
  if (phase === 'done' && score !== null) {
    return {tone: 'success', title: t('shift.biometricSuccess', {score})};
  }
  if (!error) {
    return null;
  }
  const errorCode = error instanceof Error ? (error as {code?: string}).code : undefined;
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
  if (errorCode === BIOMETRIC_LOCKED) {
    const message = error instanceof Error ? error.message : undefined;
    return {tone: 'danger', title: t('shift.blockedTitle'), description: message || t('shift.blockedBody')};
  }
  if (errorCode === BIOMETRIC_REJECTED) {
    const message = error instanceof Error ? error.message : undefined;
    return {tone: 'danger', title: t('shift.biometricFailedTitle'), description: message || t('shift.biometricRejectedBody')};
  }
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return {tone: 'danger', title: t('shift.blockedTitle'), description: error.message || t('shift.blockedBody')};
    }
    return {tone: 'danger', title: t('errors.generic'), description: error.message};
  }
  return {tone: 'danger', title: t('errors.generic')};
}
