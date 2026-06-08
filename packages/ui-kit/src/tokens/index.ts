/**
 * Tokens del sistema de diseño móvil VEO.
 * Fuente única de color/tipografía/espaciado/radios/elevación/motion. Cero hex en componentes.
 */
export { spacing, TOUCH_TARGET, type Spacing, type SpacingToken } from './spacing';
export { radii, type Radii, type RadiusToken } from './radii';
export { motion, type Motion, type BezierPoints } from './motion';
export {
  typography,
  fontFamily,
  fontSize,
  fontWeight,
  textStyles,
  type Typography,
  type TextToken,
  type TextStyleToken,
} from './typography';
export {
  passengerTheme,
  driverTheme,
  themes,
  passengerMapRoute,
  driverMapRoute,
  type Theme,
  type ThemeName,
  type ThemeColors,
  type Elevation,
  type ElevationToken,
  type MapRouteTokens,
} from './themes';
