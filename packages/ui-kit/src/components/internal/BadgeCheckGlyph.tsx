import Svg, { Path } from 'react-native-svg';

/**
 * Sello de verificación (badge-check) para el nombre del conductor en `DriverCard`
 * (design/veo.pen fLKdk · NameRow). Dibujado con `react-native-svg` como los demás glyphs
 * internos (StarGlyph): viewBox 24×24, colores por prop (el consumidor pasa tokens del tema —
 * el sello en `success`, la señal positiva del DS; el check "calado" en el color de la
 * superficie donde vive). Decorativo: el contenedor aporta la etiqueta accesible.
 */
export function BadgeCheckGlyph({
  color,
  checkColor,
  size = 15,
}: {
  /** Color del sello (token del tema, p. ej. `success`). */
  color: string;
  /** Color del check calado (token de la superficie de fondo, p. ej. `surface`). */
  checkColor: string;
  /** Lado del recuadro en px. */
  size?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Rosetón de 8 puntas simplificado (badge) + check al centro. */}
      <Path
        d="M12 2.5l2.1 1.7 2.7-.3 1 2.5 2.5 1-.3 2.7L21.5 12l-1.5 2 .3 2.7-2.5 1-1 2.5-2.7-.3-2.1 1.6-2.1-1.6-2.7.3-1-2.5-2.5-1 .3-2.7L2.5 12 4 10.1l-.3-2.7 2.5-1 1-2.5 2.7.3z"
        fill={color}
      />
      <Path
        d="M8.8 12.2l2.2 2.2 4.2-4.6"
        stroke={checkColor}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
