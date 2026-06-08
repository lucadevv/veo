import type {Theme as NavigationTheme} from '@react-navigation/native';
import {driverTheme} from '@veo/ui-kit';

/**
 * Tema de React Navigation derivado del tema de diseño `driverTheme` (`@veo/ui-kit`).
 *
 * La fuente de verdad de color/espaciado/tipografía es el sistema de diseño (modo noche del
 * conductor, regla #6 de CLAUDE.md). Aquí solo proyectamos sus tokens al contrato que exige
 * React Navigation, para no duplicar paletas ni desincronizar la marca.
 */
const {colors} = driverTheme;

export const navigationTheme: NavigationTheme = {
  dark: true,
  colors: {
    primary: colors.accent,
    background: colors.bg,
    card: colors.surface,
    text: colors.ink,
    border: colors.border,
    notification: colors.danger,
  },
};
