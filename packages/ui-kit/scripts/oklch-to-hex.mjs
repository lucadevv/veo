// Conversión OKLCH -> sRGB hex (para portar los tokens web OKLCH a RN, que no parsea oklch).
// Algoritmo estándar: OKLCH -> OKLab -> LMS -> linear sRGB -> gamma sRGB.
function oklchToHex(L, C, hDeg, alpha = 1) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  let r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  let bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const toGamma = (x) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, v));
  };
  r = toGamma(r);
  g = toGamma(g);
  bl = toGamma(bl);

  const hex = (x) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0');
  const base = `#${hex(r)}${hex(g)}${hex(bl)}`;
  if (alpha >= 1) return base.toUpperCase();
  return `${base}${hex(alpha)}`.toUpperCase();
}

const tokens = {
  light: {
    bg: [0.985, 0.003, 255],
    surface: [1, 0, 0],
    surface2: [0.965, 0.005, 255],
    ink: [0.26, 0.03, 264],
    inkMuted: [0.47, 0.02, 264],
    inkSubtle: [0.6, 0.015, 264],
    border: [0.9, 0.008, 264],
    borderStrong: [0.82, 0.012, 264],
    brand: [0.32, 0.08, 264],
    brandHover: [0.28, 0.085, 264],
    onBrand: [0.99, 0.005, 255],
    accent: [0.6, 0.12, 230],
    accentHover: [0.54, 0.13, 230],
    onAccent: [0.99, 0.01, 230],
    success: [0.62, 0.14, 162],
    onSuccess: [0.99, 0.01, 162],
    warn: [0.72, 0.15, 75],
    onWarn: [0.26, 0.05, 75],
    danger: [0.58, 0.2, 22],
    dangerHover: [0.52, 0.21, 22],
    onDanger: [0.99, 0.01, 22],
    focus: [0.6, 0.12, 230],
  },
  dark: {
    bg: [0.21, 0.025, 264],
    surface: [0.25, 0.03, 264],
    surface2: [0.29, 0.032, 264],
    ink: [0.96, 0.006, 255],
    inkMuted: [0.78, 0.012, 264],
    inkSubtle: [0.64, 0.015, 264],
    border: [0.36, 0.02, 264],
    borderStrong: [0.46, 0.025, 264],
    brand: [0.7, 0.1, 230],
    brandHover: [0.76, 0.1, 230],
    onBrand: [0.18, 0.03, 264],
    accent: [0.74, 0.12, 220],
    accentHover: [0.8, 0.12, 220],
    onAccent: [0.18, 0.03, 264],
    success: [0.72, 0.14, 162],
    onSuccess: [0.18, 0.03, 162],
    warn: [0.8, 0.14, 75],
    onWarn: [0.2, 0.04, 75],
    danger: [0.68, 0.18, 22],
    dangerHover: [0.74, 0.18, 22],
    onDanger: [0.16, 0.03, 22],
    focus: [0.74, 0.12, 220],
  },
};

// Variante "passenger" cálida: mismos navy/cian de marca, pero neutros con leve tinte cálido
// (giro de hue hacia ~70 en bg/surface/ink) para una sensación segura y acogedora.
const warm = {
  bg: [0.988, 0.004, 70],
  surface: [1, 0, 0],
  surface2: [0.972, 0.006, 70],
  ink: [0.26, 0.028, 280],
  inkMuted: [0.47, 0.02, 280],
  inkSubtle: [0.6, 0.016, 280],
  border: [0.9, 0.01, 70],
  borderStrong: [0.82, 0.014, 70],
  brand: [0.32, 0.08, 264],
  brandHover: [0.28, 0.085, 264],
  onBrand: [0.99, 0.005, 255],
  accent: [0.6, 0.12, 230],
  accentHover: [0.54, 0.13, 230],
  onAccent: [0.99, 0.01, 230],
  // acento cálido "seguro" para confianza (no en el body, solo realces)
  safe: [0.64, 0.13, 162],
  onSafe: [0.99, 0.01, 162],
  warm: [0.74, 0.13, 60],
  onWarm: [0.26, 0.05, 60],
  success: [0.62, 0.14, 162],
  onSuccess: [0.99, 0.01, 162],
  warn: [0.72, 0.15, 75],
  onWarn: [0.26, 0.05, 75],
  danger: [0.58, 0.2, 22],
  dangerHover: [0.52, 0.21, 22],
  onDanger: [0.99, 0.01, 22],
  focus: [0.6, 0.12, 230],
};

function convertSet(set) {
  const out = {};
  for (const [k, v] of Object.entries(set)) out[k] = oklchToHex(v[0], v[1], v[2]);
  return out;
}

console.log(JSON.stringify({
  warmPassenger: convertSet(warm),
  light: convertSet(tokens.light),
  dark: convertSet(tokens.dark),
}, null, 2));
