import React from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useTheme } from '@veo/ui-kit';

/**
 * Velo superior del mapa (frame `Dim` del `.pen`): gradiente `bg` opaco→transparente en la franja de
 * arriba para que el chrome flotante (saludo, avatar, pill de estado) se lea SIEMPRE sobre el mapa, sin
 * importar qué haya debajo (labels de calles, zonas claras). Fiel al frame C/Dashboard-Offline, donde el
 * saludo va directo sobre el mapa apoyado en este velo — no en una card sólida.
 */
export function MapTopScrim({ height = 220 }: { height?: number }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <LinearGradient id="mapTopScrim" x1="0" y1="0" x2="0" y2="1">
          {/* `bg` (light) 80% opaco arriba → transparente al pie: velo claro sobre el mapa Daylight Trust. */}
          <Stop offset="0" stopColor={theme.colors.bg} stopOpacity={0.8} />
          <Stop offset="1" stopColor={theme.colors.bg} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height={height} fill="url(#mapTopScrim)" />
    </Svg>
  );
}
