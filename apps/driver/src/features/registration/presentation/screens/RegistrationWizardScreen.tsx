import React, { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button, SafeScreen, Text } from '@veo/ui-kit';
import { ORDERED_STEPS } from '../../../../navigation/registrationStackRoutes';
import { RegistrationStep } from '../../domain';
import { useRegistrationStore } from '../state/registrationStore';
import { useRegistrationExit } from '../hooks/useRegistrationExit';
import { useRegistrationExitGuard } from '../hooks/useRegistrationExitGuard';
import {
  RegistrationExitSheet,
  RegistrationHeader,
  RegistrationProgress,
  WizardPager,
} from '../components';
import {
  RegistrationWizardContext,
  type WizardContextValue,
  type WizardPageFooter,
} from './RegistrationWizardContext';
import { PersonalDataScreen } from './PersonalDataScreen';
import { VehicleScreen } from './VehicleScreen';
import { IdentityVerificationScreen } from './IdentityVerificationScreen';

/** Índice 0-based de la página a partir del `currentStep` persistido (resume). Cae a 0 si el paso es inválido. */
function stepToIndex(step: number): number {
  const idx = ORDERED_STEPS.indexOf(step as RegistrationStep);
  return idx >= 0 ? idx : 0;
}

/**
 * Wizard de registro de UNA sola pantalla (LOTE C · "sensación de onboarding"): un PAGER horizontal con los
 * 3 pasos (Datos · Vehículo · Identidad) en vez de 3 rutas separadas. El progress lineal arriba avanza con el
 * índice (ahora SÍ tiene sentido), el footer unificado (Atrás | Primary) gobierna el avance por ÍNDICE
 * respetando el gating de cada paso, y cada cambio de paso anima la transición.
 *
 * El "atrás" del HEADER (único control, sin ícono de apagar) hace SALIR del onboarding (cerrar sesión) — el
 * `Atrás` del footer es el que camina los pasos. Decisión del dueño.
 *
 * Migración INCREMENTAL: el paso 1 (Datos) ya renderiza su contenido REAL (`PersonalDataScreen` en modo
 * embebido: detecta el contexto del wizard, publica su footer y avanza con `goNext`). Los pasos 2 y 3 siguen
 * como STUB hasta migrarlos.
 */
export const RegistrationWizardScreen = (): React.JSX.Element => {
  const { t } = useTranslation();
  const setCurrentStep = useRegistrationStore((s) => s.setCurrentStep);
  // El índice inicial REANUDA donde quedó el conductor (paso persistido). `getState` (no selector): solo se
  // lee al montar; los cambios de página los maneja el estado local + `setCurrentStep`.
  const [index, setIndex] = useState(() => stepToIndex(useRegistrationStore.getState().currentStep));

  // Salida de emergencia (cerrar sesión): el back del header la dispara; el back de hardware también.
  const exit = useRegistrationExit();
  useRegistrationExitGuard(exit.handleHardwareBack);

  // Footers publicados por cada página (por índice). `useReducer` fuerza el re-render del host cuando una
  // página actualiza su gating, sin que el footer sea estado derivado frágil.
  const footers = useRef<(WizardPageFooter | null)[]>([null, null, null]);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const goToIndex = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(next, ORDERED_STEPS.length - 1));
      setIndex(clamped);
      const step = ORDERED_STEPS[clamped];
      if (step !== undefined) {
        setCurrentStep(step); // el wizard y el resume siguen al índice visible
      }
    },
    [setCurrentStep],
  );

  const goNext = useCallback(() => goToIndex(index + 1), [goToIndex, index]);
  const goBack = useCallback(() => goToIndex(index - 1), [goToIndex, index]);

  const registerFooter = useCallback((page: number, footer: WizardPageFooter | null) => {
    footers.current[page] = footer;
    bump();
  }, []);

  const ctx = useMemo<WizardContextValue>(
    () => ({ index, goNext, registerFooter }),
    [index, goNext, registerFooter],
  );

  const activeFooter = footers.current[index] ?? null;

  return (
    <RegistrationWizardContext.Provider value={ctx}>
      <SafeScreen
        padded={false}
        header={<RegistrationHeader showLogo onBack={() => exit.requestExit()} />}
        footer={
          <WizardFooter index={index} footer={activeFooter} onBack={goBack} backLabel={t('common.back')} />
        }
      >
        <View style={styles.progressWrap}>
          <RegistrationProgress current={index + 1} />
        </View>
        <WizardPager index={index}>
          {/* Los 3 pasos · contenido REAL (modo embebido). */}
          <PersonalDataScreen />
          <VehicleScreen />
          <IdentityVerificationScreen />
        </WizardPager>
      </SafeScreen>
      <RegistrationExitSheet exit={exit} />
    </RegistrationWizardContext.Provider>
  );
};

/** Footer unificado del wizard: hint opcional + `Atrás` (desde el paso 2) + el primary que publica la página activa. */
function WizardFooter({
  index,
  footer,
  onBack,
  backLabel,
}: {
  index: number;
  footer: WizardPageFooter | null;
  onBack: () => void;
  backLabel: string;
}): React.JSX.Element | null {
  if (!footer) {
    return null;
  }
  return (
    <View style={styles.footerWrap}>
      {footer.hint ? (
        <Text variant="footnote" color="inkMuted" align="center" style={styles.hint}>
          {footer.hint}
        </Text>
      ) : null}
      <View style={styles.footerRow}>
        {footer.secondaryLabel ? (
          // Acción secundaria de la página (p. ej. "Volver a tomar" del KYC): reemplaza al "Atrás" del paso.
          <Button
            label={footer.secondaryLabel}
            variant="secondary"
            onPress={footer.onSecondary}
            style={styles.backBtn}
          />
        ) : index > 0 ? (
          <Button
            label={backLabel}
            variant="secondary"
            onPress={onBack}
            disabled={footer.primaryLoading}
            style={styles.backBtn}
          />
        ) : null}
        {!footer.primaryHidden ? (
          <View style={styles.primaryWrap}>
            <Button
              label={footer.primaryLabel}
              variant="accent"
              fullWidth
              onPress={footer.onPrimary}
              disabled={footer.primaryDisabled}
              loading={footer.primaryLoading}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  progressWrap: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  footerWrap: { gap: 10, paddingHorizontal: 20 },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  hint: {},
  backBtn: { minWidth: 110 },
  primaryWrap: { flex: 1 },
});
