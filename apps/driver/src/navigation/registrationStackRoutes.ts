import { RegistrationStep } from '../features/registration/domain';
import type { RegistrationStackParamList } from './types';

/**
 * Mapa paso→pantalla y helpers de RECONSTRUCCIÓN de la pila del wizard de registro. Vive en su PROPIO
 * módulo (sin tocar el barrel de presentation ni montar el navigator) para que tanto el
 * `RegistrationNavigator` como el hook `useRegistrationStepBack` deriven las rutas de la MISMA fuente
 * tipada (`RegistrationStep`) sin strings mágicos y sin ciclo de imports.
 */

/**
 * Pantalla del wizard que corresponde a cada paso (1..3). Indexado por el valor TIPADO de
 * `RegistrationStep` (no números mágicos): el orden de `ORDERED_STEPS` ES el orden de los pasos.
 * LOTE B: el paso DOCUMENTS desapareció (los docs se reagrupan por dueño: licencia→Conductor, SOAT→Vehículo).
 */
export const STEP_ROUTES: Record<RegistrationStep, keyof RegistrationStackParamList> = {
  [RegistrationStep.PERSONAL_DATA]: 'PersonalData',
  [RegistrationStep.VEHICLE]: 'Vehicle',
  [RegistrationStep.IDENTITY_VERIFICATION]: 'IdentityVerification',
};

/** Pasos del wizard en ORDEN (1..3), derivados del enum tipado: la fuente de verdad de la pila. */
export const ORDERED_STEPS: readonly RegistrationStep[] = [
  RegistrationStep.PERSONAL_DATA,
  RegistrationStep.VEHICLE,
  RegistrationStep.IDENTITY_VERIFICATION,
];

/** ¿`step` es un paso válido del wizard (1..3)? Narrowing del `number` del store al enum tipado. */
export function isRegistrationStep(step: number): step is RegistrationStep {
  return (ORDERED_STEPS as readonly number[]).includes(step);
}

/**
 * Resuelve la pantalla inicial del wizard a partir del avance persistido (`currentStep`). Así el
 * conductor REANUDA donde quedó (p. ej. cierra la app en Documentos y vuelve a Documentos) en vez de
 * arrancar siempre en `PersonalData`. Para `rejected`, enrutamos también al paso donde quedó su
 * avance (tiene datos previos que debe corregir); si no hay paso válido, caemos a `PersonalData`.
 */
export function resolveInitialRoute(currentStep: number): keyof RegistrationStackParamList {
  return isRegistrationStep(currentStep) ? STEP_ROUTES[currentStep] : 'PersonalData';
}

/** Pila reconstruida al reanudar: rutas `[PersonalData … pasoN]` + índice del paso de destino. */
export interface RegistrationResumeStack {
  index: number;
  routes: { name: keyof RegistrationStackParamList }[];
}

/**
 * Construye la pila `[PersonalData … pasoN]` a sembrar al REANUDAR en un paso > 1. Deriva las rutas y
 * su orden de `ORDERED_STEPS`/`STEP_ROUTES` (enum tipado, sin strings mágicos). El índice de destino
 * es el último de la pila (paso N): así "atrás" camina por los pasos completados y, desde el paso 1,
 * cae en el exit-guard de raíz (Lote 1). Para `currentStep` 1 o inválido devuelve `null`: no hay nada
 * que reconstruir (un único paso, sin pila debajo).
 */
export function buildResumeRoutes(currentStep: number): RegistrationResumeStack | null {
  if (!isRegistrationStep(currentStep) || currentStep <= RegistrationStep.PERSONAL_DATA) {
    return null;
  }
  const routes = ORDERED_STEPS.filter((step) => step <= currentStep).map((step) => ({
    name: STEP_ROUTES[step],
  }));
  return { index: routes.length - 1, routes };
}
