import {Button, Card, StatusPill, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {View} from 'react-native';
import type {KycStatus} from '../../../kyc/domain/entities';
import {IconShield} from './icons';

export interface KycGateProps {
  /** Estado de verificación del pasajero (dominio). El gate solo se muestra si NO es 'approved'. */
  status: KycStatus;
  /** Inicia la verificación facial (navega a KycCamera). */
  onVerify: () => void;
}

/**
 * Gate de verificación CONTEXTUAL en el momento de pedir el viaje (mejor UX que la emboscada): en vez de
 * dejar que el pasajero llene todo, confirme y reciba un 403 KYC_REQUIRED, le explica ANTES el paso ÚNICO
 * de seguridad. El gate REAL es server-side (el BFF gatea con 403); esta UI solo REFLEJA el estado y guía
 * — coherente con la regla "la UI no autoriza, refleja". Dos caras según el estado:
 *  - `unverified` / `rejected` → CTA "Verificar ahora" con el motivo (seguridad, una sola vez).
 *  - `pending` → informativo (en revisión), SIN CTA: ya hizo su parte, no lo mandamos de nuevo a la cámara.
 *
 * Mismo lenguaje visual que la card "Confirmá que sos vos" del Perfil (lente de fidelidad): Card + ícono
 * de escudo + título + motivo + CTA acento.
 */
export function KycGate({status, onVerify}: KycGateProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const pending = status === 'pending';

  return (
    <Card variant="filled" padding="lg">
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
        }}>
        <IconShield color={theme.colors.accent} size={20} />
        <Text variant="headline" style={{flex: 1}}>
          {pending ? t('trip.kycPendingTitle') : t('trip.kycGateTitle')}
        </Text>
        {pending ? (
          <StatusPill label={t('trip.kycPendingPill')} tone="warn" dot />
        ) : null}
      </View>

      <Text
        variant="footnote"
        color="inkMuted"
        style={{marginTop: theme.spacing.xs}}>
        {pending ? t('trip.kycPendingBody') : t('trip.kycGateBody')}
      </Text>

      {!pending ? (
        <Button
          label={t('trip.kycGateCta')}
          variant="accent"
          fullWidth
          onPress={onVerify}
          style={{marginTop: theme.spacing.md}}
        />
      ) : null}
    </Card>
  );
}
