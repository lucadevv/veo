# @veo/ui-kit

Sistema de diseño **móvil** de VEO: tokens + dos temas + componentes **React Native** accesibles,
compartidos por `veo-passenger-app` y `veo-driver-app`.

> Documentación completa del sistema (principios, tokens, ambos temas, inventario de componentes con
> su API, motion/a11y, anti-patrones y referencias visuales): **[`docs/DESIGN-MOBILE.md`](../../docs/DESIGN-MOBILE.md)**.

## Uso

```tsx
import { ThemeProvider, SafeScreen, Button } from '@veo/ui-kit';

export default function App() {
  return (
    <ThemeProvider name="passenger">
      {' '}
      {/* o "driver" (modo noche) */}
      <SafeScreen>
        <Button label="Confirmar recogida" variant="primary" onPress={confirm} />
      </SafeScreen>
    </ThemeProvider>
  );
}
```

## Estructura

```
src/
  tokens/      # color, tipografía, espaciado, radios, elevación, motion + passengerTheme/driverTheme
  theme/       # ThemeProvider, useTheme, useThemedStyles, useReducedMotion
  components/  # Button, Card, BottomSheet, TextField, StatusPill, Avatar, IconButton,
               # Banner, ListItem, Skeleton, MapShell, SafeScreen, Text
  index.ts
scripts/
  oklch-to-hex.mjs  # deriva la paleta hex sRGB desde los tokens OKLCH de la web (reproducible)
```

## Peers

Los proveen las apps (versiones alineadas a RN 0.75.4 / React 18.3.1): `react`, `react-native`,
`react-native-reanimated`, `react-native-safe-area-context`.

## Scripts

`pnpm --filter @veo/ui-kit typecheck | lint | build` (build = `tsc` → `dist`, consumo vía dist).

## Quién depende de este paquete

`veo-passenger-app` y `veo-driver-app` (`pnpm why @veo/ui-kit` desde la raíz).
