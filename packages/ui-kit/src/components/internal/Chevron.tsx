import { View } from 'react-native';

export type ChevronDirection = 'right' | 'left' | 'up' | 'down';

const rotation: Record<ChevronDirection, string> = {
  right: '45deg',
  left: '-135deg',
  up: '-45deg',
  down: '135deg',
};

/**
 * Chevron dibujado con bordes (sin dependencia de un set de iconos). Hereda color por token.
 */
export function Chevron({
  direction = 'right',
  color,
  size = 9,
}: {
  direction?: ChevronDirection;
  color: string;
  size?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderColor: color,
        borderTopWidth: 1.75,
        borderRightWidth: 1.75,
        transform: [{ rotate: rotation[direction] }],
      }}
    />
  );
}
