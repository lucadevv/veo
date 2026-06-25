import { createContext, useContext } from 'react';

/**
 * Contrato del FOOTER que cada página del wizard publica al host: el host pinta UN footer unificado
 * (Atrás | Primary) y el primary se ADAPTA al paso activo (Continuar / Registrar / Tomar foto…). Tipado, sin
 * strings mágicos: la página declara su acción, su label, su gating y un hint opcional ("Te falta: …").
 */
export interface WizardPageFooter {
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  /** El paso 3 (KYC) tiene estados sin acción primaria (enrolando/éxito): oculta el botón sin romper el footer. */
  primaryHidden?: boolean;
  /** Feedback PEGADO al CTA ("Te falta: escanear tu DNI"). Se muestra arriba de los botones cuando el primary está bloqueado. */
  hint?: string;
  /**
   * Acción SECUNDARIA (botón ghost a la izquierda del primary). Cuando está, REEMPLAZA al "Atrás" del paso —
   * p. ej. en el preview de la selfie del KYC: "Volver a tomar" (secundaria) + "Confirmar" (primary), donde
   * el "Atrás" del paso no aplica. Sin secundaria, la izquierda la ocupa el "Atrás" (desde el paso 2).
   */
  secondaryLabel?: string;
  onSecondary?: () => void;
}

export interface WizardContextValue {
  /** Índice de la página activa (0-based). Una página sabe si está activa comparando con su propio índice. */
  index: number;
  /** Avanza al paso siguiente (lo llama el primary de la página al COMPLETAR su acción con éxito). */
  goNext: () => void;
  /** Publica/limpia el footer de una página (por índice). El host pinta el de la página activa. */
  registerFooter: (page: number, footer: WizardPageFooter | null) => void;
}

/** Contexto del wizard de registro. `null` fuera del host (una pantalla renderizada standalone, p. ej. en tests). */
export const RegistrationWizardContext = createContext<WizardContextValue | null>(null);

/** Acceso al contrato del wizard desde una página EMBEBIDA. Lanza si se usa fuera del host (cableado claro). */
export function useRegistrationWizardPage(): WizardContextValue {
  const ctx = useContext(RegistrationWizardContext);
  if (!ctx) {
    throw new Error('useRegistrationWizardPage debe usarse dentro de <RegistrationWizardScreen>');
  }
  return ctx;
}

/**
 * Acceso NULL-SAFE al wizard: devuelve el contexto si la pantalla está embebida en el pager, o `null` si corre
 * STANDALONE (tests, o un uso fuera del wizard). Habilita el "modo dual" de las pantallas de paso sin duplicar
 * su lógica: con contexto → publican su footer y avanzan con `goNext`; sin contexto → su chrome propio.
 */
export function useRegistrationWizardPageOptional(): WizardContextValue | null {
  return useContext(RegistrationWizardContext);
}
