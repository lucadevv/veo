# DESIGN-MOBILE.md · Sistema de diseño móvil VEO

> Fuente de verdad de diseño para las apps **React Native** `veo-passenger-app` y `veo-driver-app`.
> Implementado en el paquete **`@veo/ui-kit`** (`packages/ui-kit/src`). Destilado de las skills
> `imagegen-frontend-mobile`, `emil-design-eng` y `ui-ux-pro-max`, y alineado con el sistema web
> (`docs/DESIGN.md` + tokens OKLCH de `@veo/shared-config`). **Léelo antes de escribir UI móvil.**
>
> Regla de oro: **cero estilos hardcodeados.** Todo color/espaciado/radio/sombra/tipografía/motion
> sale del tema (`useTheme()`), nunca de hex sueltos en los componentes.

---

## 0. Principios (no negociables)

1. **Misma marca, dos modos.** VEO es navy profundo + cian eléctrico de acento. Las dos apps comparten
   la identidad; cambia el contexto: **Passenger** cálido/claro (confianza y calma), **Driver** noche/denso
   (operación al volante).
2. **Tokens, no hex.** Los colores se portaron 1:1 desde los tokens **OKLCH** de la web a **hex sRGB**
   (RN no parsea `oklch()`). La derivación es reproducible: `packages/ui-kit/scripts/oklch-to-hex.mjs`.
3. **Accesibilidad primero.** Targets táctiles ≥44pt, labels accesibles (obligatorios en botones de sólo
   ícono), el color nunca es el único indicador (siempre texto/ícono), `reduce-motion` siempre respetado,
   contraste AA verificado en ambos temas.
4. **Movimiento intencional (emil).** Sólo `transform`/`opacity` (GPU). `ease-out` para entrar, exit más
   rápido que enter, UI < 300ms, `scale(0.97)` en press, nunca `scale(0)`. Animaciones interrumpibles
   (transición/spring, no keyframes que reinician).
5. **Anti-slop.** Nada de glassmorphism decorativo, gradientes morado-azul, side-stripes, ghost-cards,
   tarjetas anidadas, tarjetas sobre-redondeadas (24/28/32+), ni emojis como iconos.
6. **Soberanía.** El mapa lo provee la app (MapLibre/`react-native-maps` sobre tiles OSM propios);
   `MapShell` sólo lo enmarca. Sin SaaS de mapas de terceros.

---

## 1. Arquitectura del paquete

```
packages/ui-kit/src/
  tokens/        # color, tipografía, espaciado, radios, elevación, motion + 2 temas + tipo Theme
  theme/         # ThemeProvider, useTheme, useThemedStyles, useReducedMotion
  components/    # componentes RN tematizados y accesibles
    internal/    # helpers (press scale, alpha de color, chevron dibujado)
  index.ts       # API pública del paquete
```

- **`main`/`types`/`exports` → `dist`** (convención del monorepo, `FOUNDATION §1`): las apps consumen el
  paquete **compilado**. `build` = `tsc`. `jsx: react-jsx` (emite JS válido para Metro).
- **Peers** (los proveen las apps, versiones alineadas RN 0.75.4 / React 18.3.1):
  `react`, `react-native`, `react-native-reanimated` (≥3.15), `react-native-safe-area-context` (≥4.11).

### Montaje en una app

```tsx
import { ThemeProvider } from '@veo/ui-kit';

export default function App() {
  return (
    <ThemeProvider name="passenger">{/* o "driver" */}
      <RootNavigator />
    </ThemeProvider>
  );
}
```

---

## 2. Temas

Dos temas con **el mismo contrato de color** (`ThemeColors`), para que los componentes no ramifiquen por
app. Se eligen con `<ThemeProvider name="passenger" | "driver">` o pasando `theme={...}`.

### 2.1 Passenger — "Midnight Motion": noche, lima-eléctrico

App de seguridad personal sobre **modo noche**: fondo navy casi-negro, acento **lima-eléctrico** para
acciones/ruta/CTA, verde de confianza para seguridad (compartir viaje). Coherente con el handoff de diseño
(`docs/design-handoff/`, el clicable del pasajero). `scheme: 'dark'`, status bar `light-content`.

> **Valores canónicos: `@veo/ui-kit` → `src/tokens/themes.ts` (`passengerTheme`).** No se duplican los hex
> acá para evitar el drift (este doc describe la intención; el token vive en el código). Claves:
> `bg #0E1014` · `accent`/`brand` lima `#C8F230` · `onAccent`/`onBrand #0E1014` · `ink #F4F6F8` ·
> `focus #C8F230`. Contraste verificado (ink/bg ~16:1, onAccent/lima ~15:1).

### 2.2 Driver — noche por defecto, denso, alto contraste

Los conductores trabajan horas en poca luz: arranca en **modo noche**. Jerarquía operativa, números
grandes y tabulares (ganancias, ETAs), legible al volante. `scheme: 'dark'`, status bar `light-content`.

| Token | Hex | Rol |
|---|---|---|
| `bg` | `#121824` | fondo (navy casi negro) |
| `surface` | `#1A2230` | tarjetas |
| `surfaceElevated` | `#232B3C` | capa elevada |
| `ink` / `inkMuted` / `inkSubtle` | `#EFF2F6` / `#B3B7BF` / `#878C96` | texto 1°/2°/3° |
| `border` / `borderStrong` | `#383D48` / `#515866` | divisores / énfasis |
| `brand` / `onBrand` | `#54AAD1` / `#0B111F` | navy de marca aclarado para dark |
| `accent` / `accentHover` / `onAccent` | `#39BCDF` / `#52CFF3` / `#0B111F` | cian de acción |
| `safe` / `success` | `#39BF89` | confianza / éxito |
| `warn` / `danger` | `#F2AF48` / `#F36164` | estados |
| `focus` | `#39BCDF` | anillo de foco |
| `overlay` | `rgba(4,7,13,0.6)` | scrim de sheets/modales |

> En dark, la elevación se expresa con la **superficie** (no con sombras fuertes): `level1..3` usan
> sombras tenues; los planos se separan por `surface` → `surfaceElevated`.

---

## 3. Tokens compartidos (estructura, no marca)

### Tipografía (`typography`)
- **Familias:** `display`/`text` sans humanista de sistema por defecto (las apps registran Inter/Geist y
  sobre-escriben), `mono` tabular para datos. Escala alineada a la web: `12 14 16 18 20 24 30 36 48`.
- **Roles (`textStyles`)** — los componentes consumen roles, no tamaños sueltos:
  `display, title1, title2, title3, headline, body, bodyStrong, callout, subhead, footnote, caption, label`.
- **Números tabulares:** `<Text tabular>` para tarifas (céntimos PEN → S/), ETAs, timers, placas, IDs.

### Espaciado (`spacing`) — base 4pt
`none 0 · xxs 2 · xs 4 · sm 8 · md 12 · lg 16 · xl 20 · 2xl 24 · 3xl 32 · 4xl 40 · 5xl 48 · 6xl 64`.
Constante `TOUCH_TARGET = 44`.

### Radios (`radii`)
`sm 8 · md 12 · lg 16 · xl 20 · 2xl 28 · pill 999`. Tarjetas/inputs 12–16; `pill` sólo botones/tags.

### Elevación (`elevation`) — `level0..level3`
Token RN completo (`shadowColor/Offset/Opacity/Radius` + `elevation` Android). `level1` tarjetas,
`level2` flotantes, `level3` modales/sheets.

### Motion (`motion`) — alineado a Reanimated
- **Duraciones:** `fast 120 · base 200 · slow 320 · slower 420`; **exit** `fast 90 · base 140 · slow 200`.
- **Curvas** (mismas que la web `tokens.css`): `standard [0.23,1,0.32,1]` (ease-out), `inOut [0.77,0,0.175,1]`,
  `drawer [0.32,0.72,0,1]`. Se usan con `Easing.bezier(...theme.motion.easing.standard)`.
- **Spring:** `default` (sin rebote), `bouncy` (gestos). **Press scale:** `0.97` / `0.95`.

---

## 4. Inventario de componentes (API)

Todos accesibles, tematizados y con targets ≥44pt. Importar desde `@veo/ui-kit`.

### Provider y hooks
| Export | API | Notas |
|---|---|---|
| `ThemeProvider` | `{ children, name?: 'passenger'\|'driver', theme?: Theme }` | Monta el tema (default passenger). |
| `useTheme()` | `() => Theme` | Tema activo. |
| `useThemedStyles(factory)` | `(t: Theme) => Styles` → `Styles` | `StyleSheet.create` memoizado por tema. |
| `useReducedMotion()` | `() => boolean` | A11y: degradar movimiento. |

### Componentes
| Componente | Props clave | Comportamiento |
|---|---|---|
| **`Text`** | `variant` (rol), `color` (token), `align`, `tabular` | Toda la tipografía pasa por aquí; soporta Dynamic Type. |
| **`Button`** | `label`, `variant` (`primary\|accent\|secondary\|ghost\|danger\|safe`), `size` (`sm\|md\|lg`), `fullWidth`, `loading`, `disabled`, `leftIcon`, `rightIcon`, `onPress` | Press `scale(0.97)` ease-out interrumpible; loading deshabilita + spinner; pill; target ≥44. |
| **`IconButton`** | `icon`, **`accessibilityLabel` (obligatorio)**, `variant` (`plain\|surface\|tinted\|danger`), `size`, `disabled` | Sólo-ícono accesible; área táctil ≥44 (+hitSlop). |
| **`Card`** | `variant` (`elevated\|outlined\|filled`), `padding` (token), `onPress?` | Anti ghost-card: **borde O sombra, nunca ambos**; radio 16; sin anidar. |
| **`StatusPill`** | `label`, `tone` (`neutral\|brand\|accent\|safe\|success\|warn\|danger`), `dot`, `live` | Fondo tintado + texto del tono; `live` = punto pulsante (respeta reduce-motion). |
| **`Avatar`** | `uri?`, `name?`, `size` (`sm\|md\|lg\|xl`), `online` | Fallback a iniciales; anillo de estado. |
| **`Banner`** | `title`, `description?`, `tone` (`info\|success\|safe\|warn\|danger`), `icon?`, `action?` | Aviso inline tintado (sin side-stripe); `danger` se anuncia como alerta. |
| **`ListItem`** | `title`, `subtitle?`, `leading?`, `trailing?`, `chevron?`, `onPress?`, `disabled?` | Feedback por cambio de fondo (sin scale: filas frecuentes); target ≥44. |
| **`Skeleton`** | `width?`, `height?`, `variant` (`rect\|circle\|text`), `radius?` | Shimmer (pulso de color); reserva espacio (anti-CLS); respeta reduce-motion. |
| **`TextField`** | `label` (visible), `helperText?`, `error?`, `required?`, `leftIcon?`, `rightIcon?`, `secureTextEntry?`, + `TextInputProps` | Label visible (no placeholder-only), foco tematizado, error debajo (`role=alert`), toggle de contraseña, teclado semántico. |
| **`BottomSheet`** | `visible`, `onClose`, `children`, `title?`, `showHandle?`, `dismissOnBackdrop?`, `footer?` | Modal slide + fade (curva drawer), arrastre para descartar (umbral distancia/velocidad), scrim 45–60%, back de Android cierra; respeta reduce-motion. |
| **`MapShell`** | `children` (el mapa), `loading?`, `live?`, `topOverlay?`, `bottomOverlay?`, `rounded?` | Enmarca el mapa (héroe) + slots superpuestos + estado de carga; combinar con `SafeScreen`. |
| **`SafeScreen`** | `children`, `scroll?`, `padded?`, `header?`, `footer?`, `backgroundColor?` | Scaffold con safe areas, status bar por tema y footer con inset inferior seguro. |

### Ejemplo (viaje activo · passenger)

```tsx
import { SafeScreen, MapShell, Card, Avatar, StatusPill, Text, Button } from '@veo/ui-kit';

<SafeScreen padded={false}>
  <MapShell live bottomOverlay={
    <Card variant="elevated">
      <Avatar name="Jorge M." uri={driver.photo} online />
      <Text variant="title3">Jorge M.</Text>
      <StatusPill label="En camino" tone="safe" />
      <Text tabular>Llegas en 12 min</Text>
      <Button label="Botón de pánico" variant="danger" fullWidth onPress={panic} />
    </Card>
  }>
    <LiveMap /> {/* react-native-maps / MapLibre */}
  </MapShell>
</SafeScreen>
```

---

## 5. Motion y accesibilidad

- **Decisión de animar (emil):** acciones repetidas 100+/día → sin animación; ocasionales (modales,
  sheets, toasts) → estándar; raras → puede haber deleite. Press feedback 100–160ms.
- **Curvas/duración:** `ease-out` para entrar, exit ~60–70% del enter, UI < 300ms, nunca `ease-in`.
- **`reduce-motion`:** `usePressScale`, `StatusPill` (pulso), `Skeleton` (shimmer) y `BottomSheet` (slide)
  degradan a estático/instantáneo. Sin layout shift por animación (sólo `transform`/`opacity`).
- **A11y:** `accessibilityRole`/`accessibilityLabel` en todo interactivo, `IconButton` exige label,
  errores con `role=alert` + `aria-live`, color acompañado de texto/ícono, Dynamic Type soportado.

---

## 6. Anti-patrones prohibidos (match-and-refuse)

Si vas a escribir algo de esto, reescribe el elemento:
- Hex/medidas hardcodeadas en componentes (usa tokens del tema).
- Glassmorphism/blur decorativo; gradientes morado-azul; neón "premium" falso.
- Side-stripe borders; **ghost-card** (borde 1px + sombra grande a la vez); tarjetas **anidadas**.
- Radios sobre-redondeados (24/28/32+) en tarjetas/inputs.
- **Emojis como iconos** (usa `react-native-svg`/sets vectoriales o el chevron dibujado del kit).
- Texto diminuto/decorativo; placeholder como única etiqueta de campo.
- `scale(0)` de entrada; `ease-in` en UI; animar `width/height/top/left`; animación en acciones de teclado.
- Spam de tarjetas-stat o gráficas falsas; pantallas tipo "web dentro del teléfono".
- Mapas de SaaS de terceros (sólo OSM propio vía la app).

---

## 7. Referencia visual — el handoff de diseño (fuente única)

> **La fuente de verdad visual de TODO el proyecto es el handoff de Claude Design**, preservado en
> **`docs/design-handoff/`**. Reemplaza a los mockups sueltos anteriores (eliminados por contradecir el
> modelo real). Es un prototipo **clicable** HTML/CSS/JS de los 4 actores, con el flujo completo.

Estructura (`docs/design-handoff/`):

| Ruta | Qué es |
|---|---|
| `README.md` | instrucciones del handoff (leer primero) |
| `chats/chat1.md` | la conversación con la intención del producto (el "por qué") |
| `project/pasajero/` | `VEO Pasajero - App.html` (clicable) · `- Flujo.html` (lienzo) · `screens-pass.jsx` (fuente) |
| `project/conductor/` | ídem conductor (oferta/contraoferta, gate biométrico, pánico indistinguible) |
| `project/familia/` | ídem web de familia (link firmado, cámara en vivo) |
| `project/admin/` | ídem panel admin (pánicos, video doble-auth, finanzas, auditoría) |

**Modelo de producto (confirmado en el handoff):** VEO es **regateo inverso (puja)** — el pasajero
**ofrece su tarifa** (stepper, mínimo por zona), los conductores **aceptan o contraofertan**, y el pasajero
elige por precio/rating/ETA. Implementar **a fidelidad** del clicable, con los componentes de `@veo/ui-kit`.

---

## 8. Checklist pre-entrega (por pantalla)

- [ ] Sin hex/medidas hardcodeadas; todo desde `useTheme()`.
- [ ] Contraste AA en el tema usado (cuerpo ≥4.5:1, secundario ≥3:1).
- [ ] Targets ≥44pt; feedback de press <150ms; `IconButton` con label.
- [ ] `reduce-motion` probado; sin layout shift por animación.
- [ ] Estados loading (`Skeleton`) / vacío / error en toda vista con datos remotos.
- [ ] Safe areas respetadas (header/footer/CTA); nada bajo notch/home indicator.
- [ ] El color nunca es el único indicador (texto/ícono presentes).
- [ ] Sin anti-patrones de §6; sin emojis-icono.
```
