import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {BottomSheet, Text, useTheme} from '@veo/ui-kit';
import {PressableScale} from '../../../../shared/presentation/components/motion';
import {IconClock, IconMail, IconPhone, IconWhatsapp} from './icons';

/** Verde de marca de WhatsApp (color explícito del diseño, no es un token de tema). */
const WHATSAPP_GREEN = '#25D366';

export interface OtpHelpSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Avisa al padre que el método elegido aún no tiene backend (degradación honesta). */
  onComingSoon: (method: 'call' | 'whatsapp' | 'email') => void;
  /** Reenvío real de SMS (mismo flujo que el botón de la pantalla). */
  onResend: () => void;
  /** Segundos restantes del cooldown de reenvío (0 = habilitado). */
  cooldown: number;
  /** Texto del cooldown ya formateado (m:ss). */
  cooldownLabel: string;
  /** El reenvío está en curso. */
  resending: boolean;
}

interface RowProps {
  icon: React.ReactNode;
  label: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress: () => void;
}

/**
 * Bottom-sheet de ayuda del paso OTP ("¿No te llegó el SMS?"). Ofrece vías alternativas: llamada,
 * WhatsApp y correo (sin backend → degradación honesta vía `onComingSoon`) y el reenvío de SMS real.
 * Construido sobre el `BottomSheet` del ui-kit (arrastre para descartar, scrim, reduce-motion).
 */
export function OtpHelpSheet({
  visible,
  onClose,
  onComingSoon,
  onResend,
  cooldown,
  cooldownLabel,
  resending,
}: OtpHelpSheetProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  const Row = ({
    icon,
    label,
    accessibilityLabel,
    disabled,
    onPress,
  }: RowProps) => (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{disabled: Boolean(disabled)}}
      disabled={disabled}
      onPress={onPress}
      contentStyle={[
        styles.row,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.md,
          opacity: disabled ? 0.55 : 1,
        },
      ]}>
      <View style={styles.rowIcon}>{icon}</View>
      <Text variant="bodyStrong" color="ink">
        {label}
      </Text>
    </PressableScale>
  );

  const resendDisabled = cooldown > 0 || resending;
  const resendLabel =
    cooldown > 0
      ? `${t('auth.otpHelpResend')} · ${cooldownLabel}`
      : t('auth.otpHelpResend');

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('auth.otpHelpTitle')}>
      <Text variant="callout" color="inkMuted" style={styles.subtitle}>
        {t('auth.otpHelpSubtitle')}
      </Text>

      <View style={{gap: theme.spacing.sm}}>
        <Row
          icon={<IconPhone color={theme.colors.ink} size={20} />}
          label={t('auth.otpHelpCall')}
          onPress={() => onComingSoon('call')}
        />
        <Row
          icon={<IconWhatsapp color={WHATSAPP_GREEN} size={20} />}
          label={t('auth.otpHelpWhatsapp')}
          onPress={() => onComingSoon('whatsapp')}
        />
        <Row
          icon={<IconMail color={theme.colors.ink} size={20} />}
          label={t('auth.otpHelpEmail')}
          onPress={() => onComingSoon('email')}
        />
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={resendLabel}
          accessibilityState={{disabled: resendDisabled}}
          disabled={resendDisabled}
          onPress={() => {
            onResend();
          }}
          contentStyle={[
            styles.row,
            {
              backgroundColor: theme.colors.surfaceElevated,
              borderColor: theme.colors.border,
              borderRadius: theme.radii.md,
              opacity: resendDisabled ? 0.55 : 1,
            },
          ]}>
          <View style={styles.rowIcon}>
            <IconClock color={theme.colors.accent} size={20} />
          </View>
          <Text variant="bodyStrong" color="accent" tabular>
            {resendLabel}
          </Text>
        </PressableScale>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  subtitle: {marginBottom: 16},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 16,
    borderWidth: 1,
  },
  rowIcon: {width: 24, alignItems: 'center', justifyContent: 'center'},
});
