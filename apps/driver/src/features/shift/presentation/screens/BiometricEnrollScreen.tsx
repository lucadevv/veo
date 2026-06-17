import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../../../navigation/types';
import {
  BIOMETRIC_BACKEND_UNAVAILABLE,
  BIOMETRIC_CAPTURE_UNAVAILABLE,
  BIOMETRIC_FRAME_GRABBER_UNAVAILABLE,
} from '../../domain';
import { BiometricGate, type BiometricGateBanner } from '../components/BiometricGate';
import { useBiometricEnroll } from '../hooks/useBiometricEnroll';

type Props = NativeStackScreenProps<RootStackParamList, 'BiometricEnroll'>;

/**
 * Enrolamiento de rostro del conductor (una sola vez): captura una foto y la registra en el backend.
 * Requisito previo al gate biométrico de inicio de turno. Comparte el layout premium con
 * `ShiftStartScreen` vía `BiometricGate` para mantener coherencia visual.
 */
export const BiometricEnrollScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const { run, phase, error, isBusy } = useBiometricEnroll(() => navigation.goBack());

  const banner = resolveBanner(error, phase, t);

  return (
    <BiometricGate
      topTitle={t('shift.enrollTitle')}
      heading={t('shift.enrollHeading')}
      body={t('shift.enrollBody')}
      banner={banner}
      ctaLabel={isBusy ? t('shift.enrollCapturing') : t('shift.enrollStart')}
      loading={isBusy}
      onCapture={run}
      onBack={navigation.goBack}
    />
  );
};

/** Traduce el resultado del enrolamiento a un aviso accionable. */
function resolveBanner(error: unknown, phase: string, t: TFunction): BiometricGateBanner | null {
  if (phase === 'done') {
    return { tone: 'success', title: t('shift.enrollSuccess') };
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
  const message = error instanceof Error ? error.message : undefined;
  return { tone: 'danger', title: t('shift.enrollFailedTitle'), description: message };
}
