# DESIGN.md · Sistema de diseño VEO (web)

> Fuente de verdad de diseño para `admin-web` y `family-web` (Ola 3). Destilado de las skills
> `ui-ux-pro-max`, `impeccable` y `emil-design-eng`. **Léelo antes de escribir cualquier UI.**
> Tokens vivos en `@veo/shared-config/tailwind/preset.cjs` + `tokens.css` (OKLCH). No hardcodear color/spacing.
>
> **Fuente ÚNICA de marca:** `packages/ui-kit/src/tokens/themes.ts` (hex sRGB del VEO Brand Book).
> `tokens.css` DERIVA esos valores a OKLCH para la web. Si la marca cambia, se cambia en `themes.ts`
> y se re-deriva, nunca al revés.

---

## 0. Principios (no negociables)

1. **Anti-slop.** Si alguien puede mirar la UI y decir "esto lo hizo una IA", está mal. Evitar los tells de la sección §7.
2. **Tokens, no hex.** Todo color/espaciado/sombra/radio sale de tokens semánticos. Cero hex crudo en componentes.
3. **Contraste real.** Texto cuerpo ≥ 4.5:1, texto grande ≥ 3:1. Nada de gris claro "elegante" ilegible.
4. **Accesibilidad primero.** Focus visible, labels en inputs, navegación por teclado, `aria-*`, color nunca es el único indicador, `prefers-reduced-motion` siempre respetado.
5. **Movimiento intencional.** Cada animación responde a una causa. Curvas ease-out custom, `transform`/`opacity`, exit más rápido que enter. Nunca `scale(0)`; arrancar en `scale(0.96)`.
6. **Soberanía.** Mapas con **MapLibre GL + tiles OSM propios** (jamás Mapbox/Google). Fuentes self-hosted (no Google Fonts CDN en prod: `next/font` con archivos locales).

---

## 1. Color (OKLCH, tokens semánticos)

Marca VEO: **lienzo oscuro azulado** (`--bg` = `#0A0B0F`) + **azul de marca `#2D7FF9`** de acento (igual que
las apps móviles, coherencia total con el Brand Book). **Estrategia de color: Restrained** para producto
(neutros tintados hacia el azul + 1 acento ≤10% de la superficie). El azul nunca rellena áreas grandes;
cuando lo hace (botón primario) el texto encima es **BLANCO** (`--on-brand`/`--on-accent` = `#FFFFFF`).

> **Por qué el lienzo es oscuro:** el azul de marca `#2D7FF9` rinde con alto contraste sobre el lienzo
> casi-negro azulado (texto `ink` ~17:1) y funciona como botón sólido con **texto blanco** encima
> (a diferencia del cyan anterior, deprecado, que sobre claro daba ~1.5:1 y exigía texto negro).
> El lienzo es **casi-negro azulado `#0A0B0F`**, no negro puro `#000`.

Tokens semánticos (definidos como CSS vars OKLCH en `tokens.css`, derivados del Brand Book — los hex de
referencia son los del `themes.ts`; ver `./VEO_BRIEF_DISENO.md` §3):

| Token                                               | Rol                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `--bg` / `--surface` / `--surface-2`                | lienzo azulado / tarjetas / capas elevadas (`#0A0B0F` · `#14161C` · `#1E212A`) |
| `--ink` / `--ink-muted` / `--ink-subtle`            | texto primario / secundario / terciario (`#F5F7FA` · `#C4CBD6` · `#8A929E`)    |
| `--border` / `--border-strong`                      | divisores y bordes (`#1C1F27` · `#2B2F3A`)                                      |
| `--brand` / `--on-brand`                            | azul de marca `#2D7FF9` + texto BLANCO sobre marca                             |
| `--accent` / `--on-accent`                          | azul de acción `#2D7FF9` + texto BLANCO sobre acento                           |
| `--success` / `--warn` / `--danger` / `--on-danger` | semánticos de estado (`#34D399` · `#F2AF48` · `#FF4D6A`)                        |
| `--focus`                                           | anillo de foco azul `#2D7FF9` (3px, offset 2px)                                |

En Tailwind se consumen como `bg-surface`, `text-ink`, `text-ink-muted`, `border-border`, `bg-brand`, `text-accent`, etc.
**Prohibido** `text-gray-400` sobre el lienzo oscuro; usar `text-ink-muted` (calibrado para contraste ≥4.5:1).

- El lienzo es **casi-negro azulado** de marca (`#0A0B0F`), no negro puro `#000`, ni navy, ni gris. Las
  superficies se separan por elevación (`surface` → `surface-2`) y sombras negras tenues, no por color.
- La marca ES oscura: la clase `.dark` existe como alias de coherencia (admin puede alternarla) pero hereda
  el mismo sistema azulado + azul de marca; no reintroduce navy ni cyan. Contraste verificado AA.

---

## 2. Tipografía

- **Familias (máx 3):** títulos/display en **Clash Display Bold** (Fontshare) + interfaz/cuerpo en **Outfit**
  (Google Fonts OFL, pesos Regular/Medium/SemiBold/Bold), ambas self-hosted vía `next/font/local`, + `mono`
  tabular para datos/precios/IDs. Mismas familias que las apps móviles (`packages/ui-kit`, ver DESIGN-MOBILE §3).
- Escala: `12 · 14 · 16 · 18 · 20 · 24 · 30 · 36 · 48`. Contraste de peso ≥ 1.25 entre niveles. Cuerpo base 16px (mín en mobile 16px).
- `line-height` cuerpo 1.5–1.7; longitud de línea 65–75ch.
- Headings: `text-wrap: balance`. Prosa larga: `text-wrap: pretty`.
- Hero/display: clamp máx ≤ 6rem; `letter-spacing` ≥ -0.04em (no apretar más).
- Sin ALL-CAPS en cuerpo. Mayúsculas solo en labels ≤4 palabras o badges (con moderación).
- **Números tabulares** (`font-variant-numeric: tabular-nums`) en tablas, montos (céntimos PEN → S/), timers, contadores.

---

## 3. Layout & espaciado

- Escala 4/8px. Ritmo vertical por jerarquía: `16 / 24 / 32 / 48`.
- Flexbox para 1D, Grid para 2D. Grids responsivas sin breakpoints: `repeat(auto-fit, minmax(280px,1fr))`.
- **Las tarjetas son la respuesta perezosa.** Úsalas solo cuando son el mejor affordance. **Tarjetas anidadas: nunca.**
- Radios: tarjetas/inputs **12–16px** (no 24/28/32+). Pill solo en tags/botones.
- Escala z-index semántica: `dropdown(10) → sticky(20) → backdrop(30) → modal(40) → toast(50) → tooltip(60)`. Nunca 999/9999.
- `max-w` consistente en desktop (`max-w-7xl`). Mobile-first; breakpoints 375 / 768 / 1024 / 1440. Sin scroll horizontal.

---

## 4. Componentes (base, en cada app `src/components/ui`)

Primitivas con **Radix UI** (Dialog, DropdownMenu, Tabs, Toast, Tooltip) + `class-variance-authority` + `tailwind-merge` (`cn()`).
Iconos: **lucide-react** (un solo set, stroke 1.5–2, tamaños token `icon-sm 16 / icon-md 20 / icon-lg 24`). **Nunca emojis como iconos.**

- **Button**: variantes `primary | secondary | ghost | danger`, tamaños `sm | md | lg`. `:active` → `scale(0.97)`, transición `transform 160ms ease-out`. Estado loading deshabilita + spinner. `cursor-pointer`. Target ≥44px.
- **Input/Field**: label visible (no placeholder-only), helper text persistente, error debajo del campo con `role="alert"`, validación on-blur. `inputmode`/`type` semánticos.
- **Card**: borde 1px `border-border` **o** sombra ≤8px, **nunca ambos** (anti ghost-card). Radio 12–16px.
- **Table**: `@tanstack/react-table`, números tabulares, orden con `aria-sort`, sticky header, estado vacío y skeleton de carga.
- **Modal/Sheet**: scrim 40–60%, `transform-origin: center` (modal) / origen del trigger (popover). Cerrar con Esc + botón. Confirmar antes de descartar con cambios.
- **Toast**: `aria-live="polite"`, auto-dismiss 3–5s, no roba foco.
- **EmptyState / ErrorState / Skeleton**: obligatorios para listas, tablas, mapas y gráficas.

---

## 5. Motion (emil-design-eng)

Curvas custom (en `tokens.css`):

```
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
```

- Duraciones: press 100–160ms · tooltip 125–200ms · dropdown 150–250ms · modal/drawer 200–400ms. **UI < 300ms.**
- `ease-out` para entrar (feedback inmediato); nunca `ease-in` en UI. Exit ~60–70% del enter.
- Solo `transform`/`opacity`. Stagger de listas 30–60ms. Animar 1–2 elementos clave por vista.
- **Nada de animación en acciones de teclado repetidas.** `@media (prefers-reduced-motion: reduce)` → crossfade/instant, sin movimiento.
- El reveal debe realzar contenido ya visible; nunca ocultar contenido tras una clase de transición (rompe en SSR/headless).

---

## 6. Direcciones por app

### admin-web — Dashboard de operación/seguridad (sobrio, data-first)

- Densidad de información alta pero ordenada: sidebar de navegación (≥1024px), top bar con contexto + búsqueda + estado de sesión.
- Jerarquía por tipografía/peso/espaciado, no por color. Acento azul de marca solo en estados activos, acciones primarias y alertas.
- Tablas densas con tabular-nums, filtros persistentes, drill-down con breadcrumb. Gráficas `recharts` con leyenda, tooltip, estado vacío, colores accesibles (no solo rojo/verde).
- Mapa de operación en vivo (MapLibre) con conductores/viajes/pánicos; el **pánico** debe destacar (color danger + icono + texto, nunca solo color).
- Modo oscuro de primera clase (centro de control). Sobriedad: cero gradientes decorativos, cero glassmorphism.

### family-web — Página pública (cálida, tranquilizadora, sin login)

- Acceso por **link firmado** (`/t/[token]`), sin login, sin app. Mobile-first (la familia abre desde el móvil).
- Foco emocional: "tu familiar está seguro y en camino". Mapa en vivo grande + estado del viaje claro + datos del conductor/vehículo + botón de ayuda/llamar visible.
- Acento azul de marca reservado a **lo vivo y lo accionable** (ETA, ruta, marcador del conductor, botón de ayuda), no en el body; tono calmado, tipografía generosa y legible, mucho aire. Indicador "EN VIVO" sutil pero presente.
- Estados explícitos: link expirado/revocado, viaje finalizado, sin conexión. Nada de jerga; copy humano y directo.

---

## 7. Bans absolutos (match-and-refuse)

Si vas a escribir algo de esto, reescribe el elemento:

- Side-stripe borders (border-left/right de color >1px en cards/alerts).
- Texto con gradiente (`background-clip: text`).
- Glassmorphism por defecto / blur decorativo.
- Plantilla hero-metric (número gigante + label + stats + acento gradiente).
- Grids de tarjetas idénticas (icon + heading + texto repetido).
- Eyebrow mayúscula tracking sobre cada sección / marcadores numerados 01·02·03 como scaffolding.
- Ghost-card: `border:1px` + `box-shadow` con blur ≥16px en el mismo elemento. Elegir uno.
- Cards sobre-redondeadas (24/28/32px+).
- Em dashes en copy (usar comas, dos puntos, paréntesis). Sin buzzwords de marketing.
- Ilustraciones SVG "sketch"/doodle; fondos de rayas `repeating-linear-gradient`.

---

## 8. Checklist pre-entrega (por pantalla)

- [ ] Contraste verificado claro **y** oscuro (cuerpo ≥4.5:1, secundario ≥3:1).
- [ ] Focus visible en todo interactivo; orden de tab = orden visual; labels descriptivos.
- [ ] Targets ≥44px; feedback de press <150ms; estados hover tras `@media (hover:hover)`.
- [ ] `prefers-reduced-motion` probado; sin layout shift por animación (CLS<0.1).
- [ ] Estados loading / empty / error en toda vista con datos remotos.
- [ ] Sin tokens hardcodeados; sin ban de §7; sin emojis-icono.
- [ ] Probado en 375px y desktop; sin scroll horizontal.
