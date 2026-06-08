import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@veo/ui-kit';
import { hexAlpha } from './color';
import { IconCheck, IconPerson } from './icons';

/**
 * Ilustraciones de marca del onboarding, compuestas con Views (sin `react-native-svg`, ausente en
 * la app del pasajero). Capturan la esencia de los mockups con motivos geométricos premium y la
 * línea de ruta lima, evitando line-art "dibujado a mano". Todas son decorativas.
 */

/** Punto de destino tipo pin de mapa (círculo lima con cola). */
function MapPin({ size = 22, color }: { size?: number; color: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.center}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: size * 0.34,
            height: size * 0.34,
            borderRadius: size * 0.17,
            backgroundColor: theme.colors.bg,
          }}
        />
      </View>
      <View
        style={{
          width: 0,
          height: 0,
          marginTop: -size * 0.12,
          borderLeftWidth: size * 0.22,
          borderRightWidth: size * 0.22,
          borderTopWidth: size * 0.34,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderTopColor: color,
        }}
      />
    </View>
  );
}

/** Origen anular hueco. */
function OriginRing({ size = 16, color }: { size?: number; color: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: Math.max(3, size * 0.22),
        borderColor: color,
        backgroundColor: theme.colors.bg,
      }}
    />
  );
}

interface Pt {
  x: number;
  y: number;
}

/** Segmento de polilínea entre dos puntos (rotado sobre su centro). */
function Segment({
  from,
  to,
  color,
  width = 4,
}: {
  from: Pt;
  to: Pt;
  color: string;
  width?: number;
}): React.JSX.Element {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return (
    <View
      style={{
        position: 'absolute',
        left: (from.x + to.x) / 2 - len / 2,
        top: (from.y + to.y) / 2 - width / 2,
        width: len,
        height: width,
        borderRadius: width / 2,
        backgroundColor: color,
        transform: [{ rotate: `${angle}deg` }],
      }}
    />
  );
}

/** Polilínea de ruta a partir de waypoints absolutos. */
function Polyline({
  points,
  color,
  width = 4,
}: {
  points: Pt[];
  color: string;
  width?: number;
}): React.JSX.Element {
  return (
    <>
      {points.slice(1).map((p, i) => {
        const from = points[i];
        if (!from) {
          return null;
        }
        return <Segment key={i} from={from} to={p} color={color} width={width} />;
      })}
    </>
  );
}

export interface ArtProps {
  /** Ancho disponible para la ilustración. */
  width: number;
  /** Alto de la ilustración. */
  height: number;
}

/**
 * Emblema de seguridad: insignia lima con halo, silueta de persona y un check de verificación,
 * con una traza de ruta hacia un pin de destino. Hero del slide "Viaja con quien debe ser".
 */
export function SafetyArt({ width, height }: ArtProps): React.JSX.Element {
  const theme = useTheme();
  const emblem = Math.min(width * 0.42, height * 0.74, 168);

  const start: Pt = { x: emblem * 0.78, y: height * 0.74 };
  const dest: Pt = { x: width * 0.9, y: height * 0.3 };
  const route: Pt[] = [
    start,
    { x: width * 0.6, y: height * 0.5 },
    { x: width * 0.78, y: height * 0.58 },
    dest,
  ];

  return (
    <View style={[styles.canvas, { width, height }]} pointerEvents="none">
      <Polyline points={route} color={hexAlpha(theme.colors.brand, 0.55)} />
      <View style={{ position: 'absolute', left: start.x - 8, top: start.y - 8 }}>
        <OriginRing color={theme.colors.brand} />
      </View>
      <View style={{ position: 'absolute', left: dest.x - 11, top: dest.y - 26 }}>
        <MapPin color={theme.colors.brand} />
      </View>

      {/* Insignia central. */}
      <View style={styles.center}>
        <View
          style={{
            width: emblem,
            height: emblem,
            borderRadius: emblem * 0.32,
            borderWidth: 2,
            borderColor: theme.colors.brand,
            backgroundColor: hexAlpha(theme.colors.brand, theme.scheme === 'dark' ? 0.1 : 0.06),
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <IconPerson color={theme.colors.brand} size={emblem * 0.5} />
          {/* Check de verificación en la esquina inferior. */}
          <View
            style={{
              position: 'absolute',
              right: emblem * 0.16,
              bottom: emblem * 0.16,
              width: emblem * 0.26,
              height: emblem * 0.26,
              borderRadius: emblem * 0.13,
              backgroundColor: theme.colors.brand,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <IconCheck color={theme.colors.onBrand} size={emblem * 0.16} />
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * Mini-mapa estilizado con cuadrícula tenue y ruta lima entre origen y destino. Hero del slide
 * "Precio claro antes de subir".
 */
export function PriceMapArt({ width, height }: ArtProps): React.JSX.Element {
  const theme = useTheme();
  const gridColor = hexAlpha(theme.colors.inkSubtle, 0.16);

  const verticals = [0.22, 0.46, 0.7];
  const horizontals = [0.3, 0.62];

  const origin: Pt = { x: width * 0.16, y: height * 0.5 };
  const dest: Pt = { x: width * 0.84, y: height * 0.34 };
  const route: Pt[] = [
    origin,
    { x: width * 0.34, y: height * 0.5 },
    { x: width * 0.46, y: height * 0.66 },
    { x: width * 0.62, y: height * 0.66 },
    { x: width * 0.7, y: height * 0.34 },
    dest,
  ];

  return (
    <View
      style={[
        styles.map,
        { width, height, borderRadius: theme.radii.lg, backgroundColor: theme.colors.surface },
      ]}
      pointerEvents="none"
    >
      {verticals.map((v, i) => (
        <View
          key={`v${i}`}
          style={{ position: 'absolute', left: width * v, top: 0, bottom: 0, width: 1, backgroundColor: gridColor }}
        />
      ))}
      {horizontals.map((h, i) => (
        <View
          key={`h${i}`}
          style={{ position: 'absolute', top: height * h, left: 0, right: 0, height: 1, backgroundColor: gridColor }}
        />
      ))}

      <Polyline points={route} color={theme.colors.brand} width={5} />
      <View style={{ position: 'absolute', left: origin.x - 8, top: origin.y - 8 }}>
        <OriginRing color={theme.colors.brand} />
      </View>
      <View style={{ position: 'absolute', left: dest.x - 11, top: dest.y - 26 }}>
        <MapPin color={theme.colors.brand} />
      </View>
    </View>
  );
}

/**
 * Emblema de privacidad: insignia de seguridad central flanqueada por un candado y un vehículo,
 * unidos por trazas de energía. Hero del slide de consentimientos.
 */
export function ConsentArt({ width, height }: ArtProps): React.JSX.Element {
  const theme = useTheme();
  const emblem = Math.min(height * 0.82, 120);
  const sideY = height * 0.5;

  return (
    <View style={[styles.canvas, { width, height }]} pointerEvents="none">
      {/* Trazas laterales. */}
      <View
        style={{
          position: 'absolute',
          left: width * 0.2,
          top: sideY,
          width: width * 0.18,
          height: 2,
          backgroundColor: hexAlpha(theme.colors.brand, 0.4),
        }}
      />
      <View
        style={{
          position: 'absolute',
          right: width * 0.2,
          top: sideY,
          width: width * 0.18,
          height: 2,
          backgroundColor: hexAlpha(theme.colors.brand, 0.4),
        }}
      />

      {/* Candado (izquierda). */}
      <View style={{ position: 'absolute', left: width * 0.1, top: sideY - 16 }}>
        <View
          style={{
            width: 18,
            height: 14,
            borderTopLeftRadius: 9,
            borderTopRightRadius: 9,
            borderWidth: 2,
            borderBottomWidth: 0,
            borderColor: theme.colors.inkMuted,
          }}
        />
        <View
          style={{
            width: 26,
            height: 20,
            borderRadius: 5,
            marginLeft: -4,
            backgroundColor: theme.colors.inkMuted,
          }}
        />
      </View>

      {/* Vehículo (derecha). */}
      <View style={{ position: 'absolute', right: width * 0.1, top: sideY - 8 }}>
        <View
          style={{
            width: 34,
            height: 16,
            borderTopLeftRadius: 10,
            borderTopRightRadius: 6,
            borderBottomLeftRadius: 4,
            borderBottomRightRadius: 4,
            backgroundColor: theme.colors.inkMuted,
          }}
        />
        <View style={styles.carWheels}>
          <View style={[styles.wheel, { backgroundColor: theme.colors.bg }]} />
          <View style={[styles.wheel, { backgroundColor: theme.colors.bg }]} />
        </View>
      </View>

      {/* Insignia central de seguridad. */}
      <View style={styles.center}>
        <View
          style={{
            width: emblem,
            height: emblem,
            borderRadius: emblem * 0.32,
            backgroundColor: theme.colors.brand,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <IconPerson color={theme.colors.onBrand} size={emblem * 0.52} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { position: 'relative' },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  map: { overflow: 'hidden' },
  carWheels: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4, marginTop: -3 },
  wheel: { width: 6, height: 6, borderRadius: 3 },
});
