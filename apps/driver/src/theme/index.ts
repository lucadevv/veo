import type { Theme as NavigationTheme } from '@react-navigation/native';
import { driverTheme } from '@veo/ui-kit';

/**
 * Tema de React Navigation derivado del tema de diseño `driverTheme` (`@veo/ui-kit`).
 *
 * La fuente de verdad de color/espaciado/tipografía es el sistema de diseño (Theme de Confianza
 * light del conductor tras la migración Trust 2026-07). Aquí solo proyectamos sus tokens al contrato
 * que exige React Navigation, para no duplicar paletas ni desincronizar la marca.
 */
const { colors } = driverTheme;

export const navigationTheme: NavigationTheme = {
  dark: false,
  colors: {
    primary: colors.accent,
    background: colors.bg,
    card: colors.surface,
    text: colors.ink,
    border: colors.border,
    notification: colors.danger,
  },
};
