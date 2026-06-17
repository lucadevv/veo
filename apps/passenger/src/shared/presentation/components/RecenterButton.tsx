import { IconButton, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

/** Glifo "locate" (mira de GPS): círculo + punto central + 4 ticks N/S/E/O. viewBox 24, trazo 2 (igual al set). */
function LocateGlyph({ color, size = 22 }: { color: string; size?: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={5} stroke={color} strokeWidth={2} />
      <Circle cx={12} cy={12} r={1.7} fill={color} />
      <Path
        d="M12 1.5v3.5M12 19v3.5M1.5 12h3.5M19 12h3.5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export interface RecenterButtonProps {
  onPress: () => void;
  /** Espacio (px) reservado abajo (sheet/overlay) para que el botón flote POR ENCIMA de él. */
  bottomInset?: number;
}

/**
 * Botón flotante "recentrarme" del mapa de mi ubicación (Home / OffersBoard). Se ancla abajo-derecha,
 * por encima del chrome inferior (`bottomInset`). No autoriza nada: solo mueve la cámara a mi posición
 * (vía `useIdleCamera.recenter`). Control estándar de toda app de mapas cuando la cámara es libre.
 */
export function RecenterButton({ onPress, bottomInset = 0 }: RecenterButtonProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View
      style={[styles.anchor, { bottom: bottomInset + theme.spacing.lg, right: theme.spacing.lg }]}
      pointerEvents="box-none"
    >
      <IconButton
        accessibilityLabel={t('home.recenter')}
        variant="surface"
        onPress={onPress}
        icon={<LocateGlyph color={theme.colors.ink} />}
        style={{ ...theme.elevation.level2 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute' },
});
