import { IconButton, RoutePin, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { IconSwapVertical } from './icons';
import { Animated, usePressScale } from './motion';

export interface OriginDestinationCardProps {
  /** Dirección REAL del origen (calle del geocoding inverso). Tiene prioridad sobre el subtítulo. */
  originTitle?: string;
  /** Subtítulo legible de la ubicación actual (fallback si aún no hay calle resuelta). */
  originSubtitle?: string;
  /** Destino ya elegido (si lo hay): se muestra en la fila de destino en vez del placeholder. */
  destinationValue?: string;
  /** Editar el ORIGEN: abre la búsqueda dedicada con `editing = origin` (igual que la cotización). */
  onEditOrigin: () => void;
  /** Permuta origen ↔ destino (botón circular entre las filas). */
  onSwapRoute: () => void;
  /** Tocar la fila de destino abre la búsqueda (mismo gesto que el viejo SearchField). */
  onEnterSearch: () => void;
}

/** Diámetro del riel donde se centra el pin/cuadro de cada fila (alinea con el botón swap). */
const RAIL = 28;

/** Carril derecho reservado para el botón swap (su diámetro `sm` ≈ 36 + aire) — geometría, como `RAIL`. */
const SWAP_GUTTER = 44;

/**
 * Tarjeta de RUTA del Home idle (origen → destino), fiel a la referencia: card ELEVADA con dos filas
 * unidas por un conector vertical y un botón SWAP circular flotando entre ellas. A diferencia del
 * `OriginDestinationField` plano anterior, AMBAS filas son accionables:
 *
 *  - ORIGEN: muestra la dirección REAL (calle del geocoding inverso); tappable → `onEditOrigin` abre la
 *    búsqueda con el origen en edición (ya NO es un display de solo lectura).
 *  - SWAP: botón circular tinted entre las filas → `onSwapRoute` (permuta origen/destino).
 *  - DESTINO: "¿A dónde vamos?" (o el destino ya elegido) → `onEnterSearch`.
 *
 * Premium por tokens: superficie elevada, radio `xl`, borde sutil y sombra `level2` del tema (no un
 * rectángulo plano). Sin hex/px sueltos: todo sale de `theme` salvo el riel geométrico de alineación.
 */
export function OriginDestinationCard({
  originTitle,
  originSubtitle,
  destinationValue,
  onEditOrigin,
  onSwapRoute,
  onEnterSearch,
}: OriginDestinationCardProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  // Feedback de press por fila (escala 0.97 interrumpible, reduce-motion safe). Cada fila tiene su propio
  // valor para que tocar origen no encoja la fila de destino.
  const originPress = usePressScale();
  const destinationPress = usePressScale();

  const originValue = originTitle ?? originSubtitle;
  const hasOrigin = Boolean(originValue);
  const hasDestination = Boolean(destinationValue);

  return (
    <View
      style={[
        styles.card,
        theme.elevation.level2,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.xl,
          paddingVertical: theme.spacing.xs,
          paddingHorizontal: theme.spacing.lg,
        },
      ]}
    >
      {/* Conector vertical entre el pin de origen y el cuadro de destino (lenguaje de ruta de la app). */}
      <View
        pointerEvents="none"
        style={[
          styles.connector,
          { left: theme.spacing.lg + RAIL / 2 - 1, backgroundColor: theme.colors.borderStrong },
        ]}
      />

      {/* Columna de filas (origen / destino) a la IZQUIERDA; el swap ocupa su propia columna a la derecha. */}
      <View style={[styles.rows, { paddingRight: SWAP_GUTTER }]}>
        <Animated.View style={originPress.animatedStyle}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('home.origin')}
            onPress={onEditOrigin}
            onPressIn={originPress.onPressIn}
            onPressOut={originPress.onPressOut}
            style={({ pressed }) => [
              styles.row,
              { borderRadius: theme.radii.md },
              pressed ? { backgroundColor: theme.colors.surface } : null,
            ]}
          >
            <View style={[styles.rail, { width: RAIL }]}>
              <RoutePin variant="origin" size={14} />
            </View>
            <View style={styles.body}>
              <Text variant="caption" color="inkSubtle">
                {t('home.pickupLabel')}
              </Text>
              <Text variant="bodyStrong" color={hasOrigin ? 'ink' : 'inkSubtle'} numberOfLines={1}>
                {hasOrigin ? originValue : t('home.definePickup')}
              </Text>
            </View>
          </Pressable>
        </Animated.View>

        <View
          style={[styles.line, { backgroundColor: theme.colors.border, marginLeft: RAIL + theme.spacing.md }]}
        />

        <Animated.View style={destinationPress.animatedStyle}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('home.whereTo')}
            onPress={onEnterSearch}
            onPressIn={destinationPress.onPressIn}
            onPressOut={destinationPress.onPressOut}
            style={({ pressed }) => [
              styles.row,
              { borderRadius: theme.radii.md },
              pressed ? { backgroundColor: theme.colors.surface } : null,
            ]}
          >
            <View style={[styles.rail, { width: RAIL }]}>
              <RoutePin variant="destination" size={14} />
            </View>
            <View style={styles.body}>
              <Text variant="caption" color="inkSubtle">
                {t('home.destination')}
              </Text>
              <Text variant="bodyStrong" color={hasDestination ? 'ink' : 'inkSubtle'} numberOfLines={1}>
                {hasDestination ? destinationValue : t('home.whereTo')}
              </Text>
            </View>
          </Pressable>
        </Animated.View>
      </View>

      {/* SWAP circular DENTRO de la card, a la derecha y centrado verticalmente entre las dos filas
          (modelo de la referencia img2): integrado a la card, sin colgar del margen. La superficie
          `surfaceElevated` lo recorta del divisor para que se lea "sobre" la línea, no flotando. */}
      <View
        pointerEvents="box-none"
        style={[
          styles.swapColumn,
          { right: theme.spacing.lg, backgroundColor: theme.colors.surfaceElevated },
        ]}
      >
        <IconButton
          accessibilityLabel={t('home.swapRoute')}
          variant="tinted"
          size="sm"
          onPress={onSwapRoute}
          icon={<IconSwapVertical color={theme.colors.accent} size={18} />}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', borderWidth: 1, position: 'relative', justifyContent: 'center' },
  // La columna de las dos filas deja sitio a la derecha para el swap (no se solapa con el texto).
  rows: {},
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  rail: { alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  body: { flex: 1, justifyContent: 'center' },
  line: { height: StyleSheet.hairlineWidth },
  // Swap centrado vertical sobre el eje de la card, anclado al borde derecho interno (padding `lg`).
  swapColumn: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center' },
  connector: { position: 'absolute', top: 28, bottom: 28, width: 2, borderRadius: 1 },
});
