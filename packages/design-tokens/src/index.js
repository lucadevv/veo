/**
 * @veo/design-tokens · Identidad "Trust" de VEO — la ÚNICA fuente de color del sistema.
 *
 * TS puro y platform-agnostic (cero imports de RN/DOM/Node): lo consumen
 *   · `@veo/ui-kit` (React Native: passenger + driver) — `themes.ts` arma sus temas desde acá, y
 *   · `scripts/generate-css.mjs` — regenera `packages/shared-config/tailwind/tokens.css` (web).
 *
 * Canon = el `passengerColors` histórico de ui-kit ("Theme de Confianza" DÍA, acento teal #0075A9)
 * + 3 correcciones ratificadas por el dueño (2026-07-16), que dejan passenger ≡ driver:
 *   1. success/safe = #00C853 en TODO el sistema (muere el jade #17C08A del passenger);
 *      los montos celebratorios usan `accentStrong` #009624.
 *   2. `inkMuted` unificado en #647386 (muere el drift #6B7A8F del driver).
 *   3. `info` alineado a la familia #0097CE como el driver (el passenger mezclaba
 *      info #007FAE con infoDim rgba(0,151,206,·) — familias distintas en el mismo rol).
 *
 * Contraste WCAG 2.1 verificado (ratios reales):
 *   · ink #1A2332 sobre bg #F5F7FA → 13.9:1 (AAA)
 *   · inkMuted #647386 sobre bg #F5F7FA → 4.51:1 (pasa AA texto normal ≥4.5)
 *   · onBrand #FFFFFF sobre brand/accent #0075A9 → 4.7:1 (AA normal)
 *   · onDanger #FFFFFF sobre danger #D11216 → 5.0:1
 *   · onSafe #04160D sobre safe/success #00C853 → 7.7:1
 *   · onInfo #FFFFFF sobre info #0097CE → 3.3:1 (solo AA-large: info rellena badges/íconos,
 *     no texto de lectura; el texto informativo sobre blanco usa la tinta normal)
 *
 * NUNCA hardcodear hex en componentes ni en CSS de apps: consumir estos tokens
 * (en RN vía `theme.colors.*`, en web vía las vars CSS generadas).
 */
/**
 * Canon "Theme de Confianza" · DÍA (Trust light). Lienzo claro (canvas #F5F7FA, tarjetas blancas
 * delineadas por borde #DDE1E7 — estética Trust plana, sin sombras pesadas) y un único acento
 * TEAL de confianza #0075A9 de uso DISCIPLINADO; cuando rellena, el texto es BLANCO.
 * El POSITIVO es el verde de confianza #00C853 (board veo.pen), reservado a momentos positivos.
 */
export const trustColors = {
    bg: '#F5F7FA',
    surface: '#FFFFFF',
    surfaceElevated: '#FFFFFF',
    surfaceMuted: '#EEF1F5',
    ink: '#1A2332',
    inkMuted: '#647386',
    inkSubtle: '#B0BEC5',
    border: '#DDE1E7',
    borderStrong: '#C5CDD6',
    brand: '#0075A9',
    brandHover: '#005A82',
    onBrand: '#FFFFFF',
    accent: '#0075A9',
    accentHover: '#4A9BC7',
    onAccent: '#FFFFFF',
    safe: '#00C853',
    onSafe: '#04160D',
    success: '#00C853',
    onSuccess: '#04160D',
    successText: '#00873A',
    warn: '#FFA000',
    onWarn: '#3A2600',
    warnText: '#B26A00',
    danger: '#D11216',
    dangerHover: '#B10E12',
    onDanger: '#FFFFFF',
    info: '#0097CE',
    onInfo: '#FFFFFF',
    focus: '#0075A9',
    overlay: 'rgba(26,35,50,0.45)',
    skeleton: '#E8ECF1',
    skeletonHighlight: '#F5F7FA',
    brandDim: 'rgba(0,117,169,0.08)',
    brandDeep: '#00313C',
    successDim: 'rgba(0,200,83,0.10)',
    accentStrong: '#009624',
    warnDim: 'rgba(255,160,0,0.10)',
    dangerDim: 'rgba(209,18,22,0.08)',
    infoDim: 'rgba(0,151,206,0.10)',
    divider: '#E8ECF1',
};
//# sourceMappingURL=index.js.map