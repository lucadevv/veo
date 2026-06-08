import React from 'react';
import {ActivityIndicator, Linking, StyleSheet, View} from 'react-native';
import Svg, {Circle, Path, Rect} from 'react-native-svg';
import {useTranslation} from 'react-i18next';
import {Button, SafeScreen, Text, useTheme} from '@veo/ui-kit';
import {
  IconAccount,
  IconCar,
  IconCheck,
  IconDocument,
  IconLifebuoy,
} from '../../../../shared/presentation/icons';
import {Reveal} from '../../../../shared/presentation/components/motion';
import {env} from '../../../../core/config/env';
import {VeoWordmark, hexAlpha} from '../components';

/** Ícono de KYC (rostro escaneado) para la fila de verificación facial. */
function ScanFaceGlyph({color, size = 22}: {color: string; size?: number}): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <Circle cx={12} cy={11} r={2.5} stroke={color} strokeWidth={2} />
      <Path d="M8.5 16a4 4 0 0 1 7 0" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

/** Ilustración de portapapeles con checks + reloj (line art cian) de la pantalla de revisión. */
function ReviewClipboard({color}: {color: string}): React.JSX.Element {
  return (
    <Svg width={132} height={132} viewBox="0 0 132 132" fill="none">
      <Rect x={26} y={20} width={70} height={92} rx={8} stroke={color} strokeWidth={2.4} />
      <Rect x={48} y={12} width={26} height={16} rx={5} stroke={color} strokeWidth={2.4} />
      <Circle cx={61} cy={46} r={9} stroke={color} strokeWidth={2.4} />
      <Path d="M40 70h26M40 82h20" stroke={color} strokeWidth={2.4} strokeLinecap="round" />
      <Path
        d="M38 70l3 3 5-6M38 82l3 3 5-6"
        stroke={color}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={96} cy={92} r={20} stroke={color} strokeWidth={2.4} fill="none" />
      <Path d="M96 82v10l6 4" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

interface ChecklistRowProps {
  icon: React.ReactNode;
  label: string;
  done: boolean;
  pendingLabel?: string;
  isLast?: boolean;
}

/** Fila del checklist de revisión con marcador de timeline a la izquierda. */
function ChecklistRow({icon, label, done, pendingLabel, isLast}: ChecklistRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.checkRow}>
      <View style={styles.timeline}>
        {done ? (
          <View style={[styles.marker, {backgroundColor: theme.colors.success}]}>
            <IconCheck size={13} color={theme.colors.onSuccess} strokeWidth={3} />
          </View>
        ) : (
          <View style={[styles.marker, {backgroundColor: hexAlpha(theme.colors.accent, 0.18)}]}>
            <ActivityIndicator size="small" color={theme.colors.accent} />
          </View>
        )}
        {!isLast ? <View style={[styles.connector, {backgroundColor: theme.colors.border}]} /> : null}
      </View>
      <View style={styles.checkIcon}>{icon}</View>
      <Text variant="bodyStrong" style={styles.checkLabel} numberOfLines={1}>
        {label}
      </Text>
      {done ? (
        <IconCheck size={20} color={theme.colors.success} strokeWidth={2.6} />
      ) : (
        <Text variant="subhead" color="accent">
          {pendingLabel}
        </Text>
      )}
    </View>
  );
}

/**
 * Pantalla "Estamos revisando tus datos" (drv-08). El conductor llega aquí tras enviar el alta
 * (estado `in_review`). "Entendido" es solo un acuse de recibo: NO aprueba el alta localmente. La
 * transición a `approved` la decide EXCLUSIVAMENTE el backend, vía
 * `applyBackendStatus(mapProfileToRegistrationStatus(GET /drivers/me))` en `useRegistrationGate`;
 * mientras tanto el conductor permanece en `in_review` y el `RootNavigator` lo mantiene aquí.
 */
export const UnderReviewScreen = (): React.JSX.Element => {
  const {t} = useTranslation();
  const theme = useTheme();

  const onUnderstood = () => {
    // Acuse de recibo. El conductor permanece en `in_review`: la aprobación NUNCA se hace localmente,
    // viene del backend (ver `useRegistrationGate`). El gate ya muestra esta pantalla mientras el
    // estado siga en revisión, así que no hay navegación ni cambio de estado que disparar aquí.
  };

  const onContactSupport = () => {
    // El canal de soporte se resuelve desde la configuración de entorno (no hardcodeado en la UI).
    Linking.openURL(`mailto:${env.SUPPORT_EMAIL}`).catch(() => undefined);
  };

  return (
    <SafeScreen
      scroll
      footer={
        <View style={{gap: theme.spacing.sm}}>
          <Button label={t('registration.review.understood')} variant="secondary" fullWidth onPress={onUnderstood} />
          <Button
            label={t('registration.review.contactSupport')}
            variant="ghost"
            fullWidth
            leftIcon={<IconLifebuoy size={18} color={theme.colors.accent} strokeWidth={2} />}
            onPress={onContactSupport}
          />
        </View>
      }>
      <View style={[styles.body, {gap: theme.spacing.xl}]}>
        <Reveal style={styles.brand}>
          <VeoWordmark size="sm" peru />
        </Reveal>

        <Reveal delay={60} spring style={styles.illustration}>
          <ReviewClipboard color={theme.colors.accent} />
        </Reveal>

        <Reveal delay={120} style={styles.intro}>
          <Text variant="title1" align="center">
            {t('registration.review.title')}
          </Text>
          <Text variant="callout" color="inkMuted" align="center">
            {t('registration.review.subtitle')}
          </Text>
        </Reveal>

        <Reveal delay={180}>
          <View
            style={[
              styles.card,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.lg,
                padding: theme.spacing.lg,
                gap: theme.spacing.lg,
              },
            ]}>
            <ChecklistRow
              icon={<IconAccount size={22} color={theme.colors.accent} strokeWidth={1.8} />}
              label={t('registration.review.personal')}
              done
            />
            <ChecklistRow
              icon={<IconCar size={22} color={theme.colors.accent} strokeWidth={1.8} />}
              label={t('registration.review.vehicle')}
              done
            />
            <ChecklistRow
              icon={<IconDocument size={22} color={theme.colors.accent} strokeWidth={1.8} />}
              label={t('registration.review.documents')}
              done
            />
            <ChecklistRow
              icon={<ScanFaceGlyph color={theme.colors.accent} />}
              label={t('registration.review.facial')}
              done={false}
              pendingLabel={t('registration.review.inReview')}
              isLast
            />
          </View>
        </Reveal>
      </View>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  body: {paddingTop: 16, alignItems: 'stretch'},
  brand: {alignItems: 'center', gap: 6},
  illustration: {alignItems: 'center'},
  intro: {gap: 8},
  card: {alignSelf: 'stretch'},
  checkRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  timeline: {width: 24, alignItems: 'center'},
  marker: {width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center'},
  connector: {position: 'absolute', top: 24, width: 2, height: 26},
  checkIcon: {width: 26, alignItems: 'center'},
  checkLabel: {flex: 1},
});
