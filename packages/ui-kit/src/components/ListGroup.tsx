import { Children, Fragment, type ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

export interface ListGroupProps {
  children: ReactNode;
  style?: ViewStyle;
}

/**
 * Grupo EDITORIAL de filas (settings, herramientas, temas): superficie con elevación sutil y
 * divisores hairline entre filas — SIN borde. Es el mismo lenguaje de las cards de viaje
 * (superficie + elevación level1) aplicado a listas: reemplaza al combo `Card variant="outlined"`
 * + ListItems que encajonaba cada sección en un marco duro (el "todo son cuadros" — feedback del
 * dueño 2026-07-15; regla DESIGN-MOBILE: borde O sombra, nunca ambos, y acá manda la sombra).
 *
 * Los null/false entre hijos se ignoran (filas condicionales no dejan divisores huérfanos).
 */
export function ListGroup({ children, style }: ListGroupProps) {
  const theme = useTheme();
  const rows = Children.toArray(children).filter(Boolean);

  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.lg,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.xs,
          ...theme.elevation.level1,
        },
        styles.group,
        style,
      ]}
    >
      {rows.map((row, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <View
              style={[styles.divider, { backgroundColor: theme.colors.border }]}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
          ) : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
});
