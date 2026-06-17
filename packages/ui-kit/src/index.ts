/**
 * @veo/ui-kit · Sistema de diseño móvil VEO
 *
 * Tokens + dos temas (passenger cálido/claro · driver noche) + ThemeProvider/useTheme +
 * componentes React Native accesibles y tematizados. Consumido por passenger y driver apps.
 * Documentación: docs/DESIGN-MOBILE.md
 */

// Tokens y temas
export * from './tokens';

// Utilidad de color de tokens: aplica alpha a un hex (#RRGGBB -> #RRGGBBAA)
export { hexAlpha } from './components/internal/color';

// Tema en runtime: provider, hook y utilidades de a11y/estilos
export * from './theme';

// Componentes
export * from './components';
