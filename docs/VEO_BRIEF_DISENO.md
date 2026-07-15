# VEO_BRIEF_DISENO.md · Brief maestro de diseño VEO

> **Qué es esto.** La **fuente de verdad de diseño** de todo VEO: paleta, principios y dirección
> por superficie. Los 4 specs de pantalla (`../specs/VEO_SPEC_PASAJERO.md`, `…_CONDUCTOR.md`,
> `…_ADMIN.md`, `…_FAMILIA.md`) lo citan como `./VEO_BRIEF_DISENO.md` y definen el **CÓMO visual**
> sobre el **QUÉ/PORQUÉ** que vive acá. Si hay conflicto, manda este documento.
>
> **Relación con el código.** La marca NO se inventa en los docs: la **FUENTE ÚNICA** de los tokens es
> `veo-monorepo/packages/ui-kit/src/tokens/themes.ts` (hex sRGB del Brand Book). La web los **deriva** a
> OKLCH en `packages/shared-config/tailwind/tokens.css` (RN no parsea `oklch()`, la web sí). Este brief
> **transcribe** esos valores y describe la intención; el token vive en el código. Si la marca cambia, se
> cambia en `themes.ts` y se re-deriva, **nunca al revés**.
>
> **Cómo leerlo.** §3 es la paleta (tokens canónicos + roles + contrastes). §9 son los principios. §3.1–§3.3
> son la dirección por superficie. Destila `docs/DESIGN.md` (web) + `docs/DESIGN-MOBILE.md` (móvil) +
> las skills `impeccable`, `emil-design-eng`, `ui-ux-pro-max`. Léelo antes de escribir cualquier UI.

---

## 1. La marca en una frase

VEO es **movilidad segura** (Lima → Perú → Ecuador). La identidad es **oscuro premium minimalista**: un
lienzo casi-negro azulado, alto contraste, y **un solo acento disciplinado** que se gana su lugar. Ese
acento es el **azul eléctrico `#2D7FF9`** (azul "Tesla"), con **texto blanco encima**. Las 4 superficies
(pasajero, conductor, familia, admin) son **una sola marca**: comparten paleta, tipografía y motion. Lo que
cambia entre ellas es el **uso** (densidad, modo, plataforma), nunca el color de marca.

> **Decisión del dueño (2026-06-22):** la marca VEO global = azul `#2D7FF9`. Reemplaza por completo a los
> acentos previos. Quedan **DEPRECADOS** (no usar): cyan `#00E5FF` ("VEO Cyan"), cian lavado `#39BCDF`,
> lima `#C8F230` ("Midnight Motion"), el "navy" como marca, y el negro puro `#000` como lienzo.

---

## 2. Estrategia de color (impeccable)

**Restrained.** Neutros tintados hacia el azul de marca + **un acento ≤ 10% de la superficie**. El lienzo
es oscuro y casi-neutro; el azul aparece sólo donde hay una **acción**, **lo vivo** o **un foco**. Si todo es
azul, nada es azul. Esta es la disciplina que separa a VEO del slop "neón sobre negro".

- **Theme = oscuro, por escena concreta** (no "oscuro porque las apps de tech molan). Pasajero: alguien
  revisando de noche que su viaje va seguro, pantalla en la mano, contraste alto. Conductor: socio al volante,
  muchas horas, de reojo entre semáforos y bajo sol directo → OLED-friendly, glanceable. Admin y familia
  soportan **claro y dark** porque se ven de día en oficina/casa; el azul de marca aguanta ambos.
- **OKLCH en web.** Los neutros se tintan levísimamente hacia el hue de marca (chroma 0.005–0.01); nada de
  `#000`/`#fff` planos. La derivación OKLCH↔hex se verifica con `packages/ui-kit/scripts/oklch-to-hex.mjs`.
- **Por qué azul y no el cyan anterior.** El cyan `#00E5FF` sobre claro daba ~1.5:1 (ilegible) y exigía
  **texto negro** cuando rellenaba. El azul `#2D7FF9` tiene **profundidad suficiente para texto BLANCO**
  (`onAccent` = `#FFFFFF`), funciona como botón sólido, y mantiene contraste AA sobre el lienzo oscuro.

---

## 3. Paleta — tokens canónicos

Una sola paleta para las 4 superficies. Los hex son los del `driverTheme`/Brand Book (la web los deriva a
OKLCH); **se referencian por NOMBRE de token, nunca por hex suelto** en componentes.

### 3.0 Tabla de tokens

| Token                           | Hex (sRGB)     | Rol semántico                                        | Contraste de referencia                      |
| ------------------------------- | -------------- | ---------------------------------------------------- | -------------------------------------------- |
| `bg`                            | `#0A0B0F`      | Lienzo base (casi-negro azulado, no negro puro)      | —                                            |
| `surface`                       | `#14161C`      | Tarjetas, filas, sheets base                         | —                                            |
| `surfaceElevated`               | `#1E212A`      | Capas elevadas: inputs, modales, sheets              | —                                            |
| `ink`                           | `#F5F7FA`      | Texto primario                                       | ~17:1 sobre `bg` (AAA)                       |
| `inkMuted`                      | `#C4CBD6`      | Texto secundario                                     | ~10:1 sobre `bg` (AAA)                       |
| `inkSubtle`                     | `#8A929E`      | Texto terciario, metadatos                           | ~4.7:1 sobre `bg` (AA)                       |
| `border`                        | `#1C1F27`      | Divisores y bordes sutiles                           | —                                            |
| `borderStrong`                  | `#2B2F3A`      | Bordes de énfasis, foco no-accent                    | —                                            |
| `brand` = `accent` = `focus`    | **`#2D7FF9`**  | Marca, acción primaria, anillo de foco, ruta en mapa | ~5.2:1 sobre `bg` (AA texto grande / UI)     |
| `onBrand` = `onAccent`          | **`#FFFFFF`**  | Texto/ícono SOBRE el azul (siempre **blanco**)       | ~3.6:1 blanco sobre `#2D7FF9` (AA grande/UI) |
| `success` = `safe`              | `#34D399`      | OK, a bordo, vigente, "viaje seguro"                 | AA sobre `bg`                                |
| `warn`                          | `#F2AF48`      | Por vencer, atención                                 | AA sobre `bg`                                |
| `danger`                        | `#FF4D6A`      | Error, vencido, cancelado, pánico-como-cancelación   | AA sobre `bg`                                |
| `overlay`                       | scrim 40–60%   | Atenuar mapa de fondo, scrim de modal/sheet          | —                                            |
| `routeColor` / `routeGlowColor` | `brand` + halo | Dibujo de ruta en el mapa (azul + glow)              | —                                            |

> **`brand` = `accent` = `focus` son el mismo azul `#2D7FF9`.** Son roles distintos (marca / acción / foco)
> que coinciden en valor. El acento ocupa ≤10% de cualquier pantalla.

### 3.1 Superficie · PASAJERO (móvil, "Noche")

App de seguridad personal sobre **lienzo oscuro** (`bg #0A0B0F`). **Tema único: oscuro**, no hay modo claro.
El azul de marca (`accent`/`brand`) es **escaso y caro**: se reserva para **1 acción primaria por pantalla**,
el dibujo de **ruta** en el mapa (`routeColor` + halo `routeGlowColor`) y micro-acentos de marca. El verde
`success`/`safe` es el color de la **confianza** (compartir viaje, "en camino seguro"). Cuando el azul
rellena (botón primario, badge de marca), el texto encima es **blanco** (`onAccent`). Status bar `light-content`.

Diferencia con conductor: **uso**, no color. Pasajero es app de consumo (puede tener un punto de deleite en
onboarding/share); densidad media; un acento por pantalla.

### 3.2 Superficie · CONDUCTOR (móvil, "Noche")

Mismo sistema de marca exacto. Es una **herramienta de trabajo**, no app de consumo: densa pero **glanceable**
(estado de turno, oferta entrante, próxima maniobra se leen en < 1 s), legible al sol y de noche, targets
**≥ 48 pt** en acciones que se tocan manejando. Lienzo `bg #0A0B0F` (OLED-friendly para turnos largos), acento
azul `#2D7FF9` con texto blanco. Animación **funcional**, nunca decorativa. El conductor **NO se diferencia por
color** del pasajero — se diferencia por el app icon y el lockup "VEO | Conductores". `scheme: 'dark'`.

> **Regla de seguridad que manda sobre el color:** la cancelación por pánico se ve **idéntica** a cualquier
> otra cancelación (`danger` normal). PROHIBIDA cualquier UI roja especial que delate a la víctima. Ver
> `VEO_SPEC_CONDUCTOR.md` §5. El `driverTheme` de `themes.ts` es el **ejemplo canónico** de esta paleta.

### 3.3 Superficie · ADMIN y FAMILIA (web, claro + dark)

Web Next.js, tokens en **OKLCH** (`tokens.css`), derivados del mismo Brand Book. Soportan **light y dark**
(siguen el tema del sistema; admin puede alternarlo). Misma marca azul `#2D7FF9`:

- **admin-web** — dashboard de operación/seguridad, **sobrio y data-first**. El azul (`--accent`) ≤10% de la
  UI: acción primaria, enlaces, foco, serie principal de gráficas, ítem de navegación activo. La **estructura**
  (marca, sidebar) es neutra; el azul no es relleno. El **pánico** destaca por `danger` + ícono + texto/cifra
  juntos, nunca sólo por color. Modo oscuro de primera clase (es un centro de control).
- **family-web** — página pública por **link firmado** (`/t/[token]`), sin login, mobile-first, cálida y
  tranquilizadora. El azul (`--accent`) = **lo vivo y lo accionable**: ruta del mapa, marcador del conductor
  (halo que late), reloj de la ETA, ícono del botón de ayuda. La **marca** (`--brand`, el wordmark con el ícono
  del ojo) también es el azul. Todo lo demás en tinta neutra; tono calmado, mucho aire, cero alarma.

> El "navy + cian" que estos specs describían antes era el sistema viejo. Ahora **marca y acento son el mismo
> azul de marca `#2D7FF9`**; la jerarquía marca-vs-acento se resuelve por **peso, tamaño y contexto**, no por
> dos colores distintos.

---

## 4. Tipografía

- **Familias (máx 3):** `display` → **Clash Display Bold** (Fontshare) para títulos/héroe; `text*` → **Outfit**
  (Google Fonts OFL: Regular/Medium/SemiBold/Bold) para interfaz/cuerpo; `mono` tabular para datos. Mismas
  familias en web (`next/font/local`, **self-hosted**, sin CDN en prod) y móvil (bundleadas en `@veo/ui-kit`).
  Nombres PostScript: `ClashDisplay-Bold`, `Outfit-{Regular…Bold}`.
- **Escala:** `12 · 14 · 16 · 18 · 20 · 24 · 30 · 36 · 48`. Contraste de peso ≥ 1.25 entre niveles (jerarquía
  por **escala + peso**, no por color). Cuerpo base 16px (mín. 16px en móvil para evitar auto-zoom iOS).
- **Roles (`textStyles`):** `display, title1, title2, title3, headline, body, bodyStrong, callout, subhead,
footnote, caption, label/overline`. Los componentes consumen **roles**, no tamaños sueltos.
- `line-height` cuerpo 1.5–1.7; longitud de línea 65–75ch. Headings `text-wrap: balance`, prosa `pretty`.
  Hero/display clamp ≤ 6rem, `letter-spacing` ≥ -0.04em. Sin ALL-CAPS en cuerpo (sólo labels ≤4 palabras).
- **Números tabulares** (`font-variant-numeric: tabular-nums` / `<Text tabular>`) en montos (céntimos PEN → `S/`),
  ETAs, timers, placas, IDs, OTP. No negociable: los dígitos bailan si no.

---

## 5. Layout, espaciado, radios, elevación

- **Espaciado base 4/8px:** `none 0 · xxs 2 · xs 4 · sm 8 · md 12 · lg 16 · xl 20 · 2xl 24 · 3xl 32 · 4xl 40 ·
5xl 48 · 6xl 64`. Ritmo vertical por jerarquía: `16 / 24 / 32 / 48`. Variar el espaciado da ritmo; el mismo
  padding en todo es monotonía. `TOUCH_TARGET = 44` (mínimo absoluto; subir a 48–56 al volante).
- **Radios:** `sm 8 · md 12 · lg 16 · xl 20 · 2xl 28 · pill 999`. Tarjetas/inputs **12–16px**; `pill` sólo en
  botones/tags. Nada de tarjetas sobre-redondeadas (24/28/32+).
- **Elevación (`level0..level3`):** en dark, la elevación se expresa por **superficie** (`surface` →
  `surfaceElevated`) + sombras negras tenues, no por color ni sombras fuertes. `level1` tarjetas, `level2`
  flotantes, `level3` modales/sheets.
- **Las tarjetas son la respuesta perezosa.** Úsalas sólo cuando son el mejor affordance; **tarjetas anidadas:
  nunca**. No envolver todo en un contenedor. Flexbox 1D, Grid 2D; grids responsivas sin breakpoints
  (`repeat(auto-fit, minmax(280px,1fr))`).
- **z-index semántico (web):** `dropdown(10) → sticky(20) → backdrop(30) → modal(40) → toast(50) →
tooltip(60)`. Nunca 999/9999. `max-w-7xl` en desktop. Mobile-first; breakpoints 375 / 768 / 1024 / 1440.

---

## 6. Motion (emil-design-eng)

- **Curvas custom** (en `tokens.css` y `motion` de `@veo/ui-kit`):
  `standard / ease-out [0.23, 1, 0.32, 1]` · `inOut [0.77, 0, 0.175, 1]` · `drawer [0.32, 0.72, 0, 1]`.
- **¿Debe animar?** Acción repetida 100+/día → **sin animación**. Ocasional (modal, sheet, toast) → estándar.
  Rara (onboarding, share) → puede haber deleite. Nunca animar acciones de teclado repetidas.
- **Duraciones:** press 100–160ms · tooltip 125–200ms · dropdown 150–250ms · modal/drawer 200–420ms. **UI < 300ms.**
  `ease-out` para entrar (feedback inmediato); **nunca `ease-in` en UI**. Exit ~60–70% del enter.
- **Sólo `transform`/`opacity`** (GPU). `scale(0.97)` en press; **nunca `scale(0)`** (arrancar en `scale(0.96)`
  - opacity). Stagger de listas 30–60ms. Animar 1–2 elementos clave por vista. Animaciones **interrumpibles**
    (transición/spring, no keyframes que reinician). `prefers-reduced-motion` → crossfade/instant, sin movimiento.

---

## 7. Componentes base (compartidos)

Móvil: `@veo/ui-kit` (`useTheme()`, cero hex hardcodeado). Web: Radix UI + CVA + `tailwind-merge` (`cn()`).
Iconos: **lucide / lucide-react** (un set, stroke 1.5–2, tamaños `icon-sm 16 / icon-md 20 / icon-lg 24`).
**Nunca emojis como iconos.**

- **Button** — `accent | primary | secondary | ghost | danger | safe`, `sm|md|lg`. Press `scale(0.97)` ease-out
  interrumpible; loading deshabilita + spinner; target ≥44. Sobre `accent`, texto `onAccent` (blanco).
- **Card** — `elevated | outlined | filled`. Anti ghost-card: **borde 1px O sombra, nunca ambos**. Radio 16; sin anidar.
- **TextField** — label visible (no placeholder-only), helper persistente, error debajo con `role="alert"`,
  validación on-blur, anillo `focus` (azul) al enfocar, teclado/`inputmode` semántico, toggle de contraseña.
- **StatusPill / Banner** — fondo tintado por tono (`neutral|brand|accent|safe|success|warn|danger`), sin
  side-stripe; `danger` se anuncia como alerta; `live` = punto pulsante (respeta reduce-motion).
- **BottomSheet / Modal** — scrim 40–60%, `transform-origin: center` (modal) / origen del trigger (popover),
  cerrar con Esc/back + botón, confirmar antes de descartar con cambios.
- **MapShell / SafeScreen** — mapa como héroe enmarcado + slots superpuestos + estados; safe areas y footer
  con inset inferior seguro. **EmptyState / ErrorState / Skeleton** obligatorios en toda vista con datos remotos.

---

## 8. Soberanía de mapas y fuentes

- **Mapas:** MapLibre GL (web) / `react-native-maps` o MapLibre (móvil) sobre **tiles OSM propios**. Jamás
  Mapbox/Google ni SaaS de mapas de terceros. `MapShell` sólo enmarca; el mapa lo provee la app. La **ruta** se
  pinta en `routeColor` (azul de marca) con halo `routeGlowColor`.
- **Fuentes:** self-hosted siempre (sin Google Fonts CDN en prod). Web `next/font/local`; móvil bundleadas.

---

## 9. Principios (no negociables)

1. **Anti-slop.** Si alguien puede mirar la UI y decir, sin dudar, "esto lo hizo una IA", está mal. El test:
   ¿se adivina tema+paleta sólo por la categoría ("movilidad → azul oscuro")? Entonces es el reflejo de
   entrenamiento; el azul disciplinado ≤10% + el lienzo casi-neutro + la tipografía son lo que lo salva del
   genérico. Evitar los bans de §10.
2. **Tokens, no hex.** Todo color/espaciado/sombra/radio/tipografía/motion sale de **tokens semánticos**. Cero
   hex crudo en componentes. La marca cambia en `themes.ts`, no en una pantalla.
3. **Contraste real (AA).** Texto cuerpo ≥ 4.5:1, texto grande/UI ≥ 3:1. Nada de gris-sobre-gris "elegante"
   ilegible. Verificado en claro **y** dark donde aplique.
4. **Accesibilidad primero.** Focus visible (anillo `focus` azul), labels en inputs, navegación por teclado,
   `aria-*` / `accessibilityLabel` (obligatorio en botones de sólo ícono), **el color nunca es el único
   indicador** (siempre texto/ícono), Dynamic Type, `prefers-reduced-motion` siempre respetado.
5. **Movimiento intencional.** Cada animación responde a una causa (estado, atención, continuidad espacial).
   Curvas ease-out custom, `transform`/`opacity`, exit más rápido que enter, nunca `scale(0)`.
6. **Soberanía.** Mapas OSM propios (MapLibre), fuentes self-hosted. Sin terceros (§8).
7. **Un acento disciplinado.** El azul `#2D7FF9` ≤ 10% de cualquier superficie. Es la acción, lo vivo, el
   foco. La jerarquía se construye con escala/peso/espaciado/superficie, no inundando de color.
8. **Una marca, cuatro superficies.** Pasajero, conductor, familia y admin cuentan la **misma historia** de
   color. Lo que cambia es el uso (densidad, modo, plataforma), no el color de marca.

---

## 10. Bans absolutos (match-and-refuse)

Si vas a escribir algo de esto, reescribe el elemento con otra estructura:

- **Side-stripe borders** (`border-left/right` de color > 1px en cards/alerts). Usar borde completo, tinte de
  fondo, número/ícono al frente, o nada.
- **Texto con gradiente** (`background-clip: text` + gradiente). Color sólido; énfasis por peso/tamaño.
- **Glassmorphism / blur decorativo** por defecto. Raro y con propósito (scrim de dismissal), o nada.
- **Plantilla hero-metric** (número gigante + label + stats + acento gradiente). Cliché SaaS.
- **Grids de tarjetas idénticas** (icon + heading + texto repetido sin fin).
- **Ghost-card** (`border:1px` + `box-shadow` blur ≥16px en el mismo elemento). Elegir uno.
- **Tarjetas anidadas** y **tarjetas sobre-redondeadas** (24/28/32px+).
- **Eyebrow mayúscula tracking** sobre cada sección / marcadores numerados `01·02·03` como scaffolding.
- **Emojis como iconos**, ilustraciones SVG "doodle", fondos de rayas `repeating-linear-gradient`.
- **Em dashes en copy** (usar comas, dos puntos, paréntesis). Sin buzzwords de marketing.
- **Reintroducir colores deprecados**: cyan `#00E5FF`, cian `#39BCDF`, lima `#C8F230`, navy-como-marca, `#000`
  puro como lienzo. Sólo el sistema de §3.

---

## 11. Checklist pre-entrega (por pantalla)

- [ ] Contraste verificado claro **y** dark donde aplique (cuerpo ≥4.5:1, secundario ≥3:1).
- [ ] El azul de marca ocupa ≤10% de la superficie; el texto sobre el azul es **blanco** (`onAccent`).
- [ ] Focus visible en todo interactivo; orden de tab = orden visual; labels descriptivos; `IconButton` con label.
- [ ] Targets ≥44pt (≥48 al volante en conductor); feedback de press <150ms; hover tras `@media (hover:hover)`.
- [ ] `prefers-reduced-motion` probado; sin layout shift por animación (CLS<0.1); sólo `transform`/`opacity`.
- [ ] Estados loading / empty / error en toda vista con datos remotos. Safe areas respetadas.
- [ ] El color nunca es el único indicador (texto/ícono presentes). Sin tokens hardcodeados; sin ban de §10.
- [ ] Sin colores deprecados (cyan/cian/lima/navy/`#000`); todo por nombre de token. Probado en 375px.
