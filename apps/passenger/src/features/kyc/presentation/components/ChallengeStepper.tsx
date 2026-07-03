import {hexAlpha, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {IconCheck, IconEye, IconScanFace} from './icons';

/** Paso del reto de liveness: 0 rostro encuadrado · 1 gesto (parpadeo/movimiento) · 2 listo. */
export type ChallengeStep = 0 | 1 | 2;

export interface ChallengeStepperProps {
  /** Paso ACTIVO (los anteriores se pintan como completados). */
  active: ChallengeStep;
  /**
   * Label del paso del gesto. El pen (jPGX1) dice "Parpadeo", pero el reto real del server puede
   * pedir girar la cabeza: el caller pasa la etiqueta VERDADERA según `challenge.action`.
   */
  gestureLabel: string;
}

/**
 * Stepper de 3 chips del flujo KYC (pen jPGX1): Rostro · Parpadeo/Movimiento · Listo.
 * Refleja el AVANCE REAL del reto de liveness (fases de la pantalla de cámara), no una animación
 * decorativa: completado = success, activo = accent, pendiente = apagado.
 */
export function ChallengeStepper({
  active,
  gestureLabel,
}: ChallengeStepperProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  const steps = [
    {label: t('kyc.stepFace'), Icon: IconScanFace},
    {label: gestureLabel, Icon: IconEye},
    {label: t('kyc.stepDone'), Icon: IconCheck},
  ] as const;

  return (
    <View
      style={[styles.row, {gap: theme.spacing.xl}]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${steps[active].label} (${active + 1}/3)`}>
      {steps.map(({label, Icon}, index) => {
        const done = index < active;
        const current = index === active;
        const tone = done
          ? theme.colors.success
          : current
            ? theme.colors.accent
            : theme.colors.inkSubtle;
        return (
          <View key={label} style={[styles.step, {gap: theme.spacing.sm}]}>
            <View
              style={[
                styles.iconWrap,
                {
                  borderRadius: theme.radii.pill,
                  backgroundColor:
                    done || current
                      ? hexAlpha(tone, 0.15)
                      : theme.colors.surface,
                },
              ]}>
              {/* Un paso completado muestra el check (hecho), no su ícono original. */}
              {done ? (
                <IconCheck color={tone} size={22} />
              ) : (
                <Icon color={tone} size={22} />
              )}
            </View>
            <Text
              variant="footnote"
              color={done || current ? 'ink' : 'inkSubtle'}>
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', justifyContent: 'center'},
  step: {alignItems: 'center', width: 80},
  iconWrap: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
