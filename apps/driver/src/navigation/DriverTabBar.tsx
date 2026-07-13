import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { hexAlpha, Text, useTheme } from '@veo/ui-kit';

/** Alto del pill flotante (fila del item + padding del pill), sin el inset inferior. */
const PILL_HEIGHT = 66;
/** Padding superior del wrap (aire entre el contenido y el pill). */
const WRAP_TOP = 8;

/**
 * Alto TOTAL que ocupa el tab bar flotante (pill + aire + home-indicator). El tab bar es `absolute`
 * (flota SOBRE el mapa a pantalla completa, fiel al frame), así que NO reserva espacio: las pantallas
 * con lista deben paddear su fondo con esto, y el dock del Inicio debe elevarse por encima.
 */
export function useDriverTabBarHeight(): number {
  const insets = useSafeAreaInsets();
  return WRAP_TOP + PILL_HEIGHT + Math.max(insets.bottom, 12);
}

/**
 * Tab bar del conductor: PILL FLOTANTE de vidrio (frame `C/TabBarCond`), no la barra plana por defecto
 * de React Navigation. Inset de los bordes, translúcido (~90% surfaceElevated → frosted sobre el mapa,
 * sin BlurView), esquinas pill, sombra; el item ACTIVO va en un chip `brand-dim` con icono/label en
 * brand. Reemplaza al tab bar estándar vía la prop `tabBar` del Navigator.
 */
export function DriverTabBar({
  state,
  descriptors,
  navigation,
}: BottomTabBarProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, 12) }]}
      pointerEvents="box-none"
    >
      <View
        style={[
          styles.pill,
          // Pill frosted CLARO sobre el mapa (~92% surfaceElevated) — MISMO tratamiento que el passenger
          // (AppTabBar): superficie de confianza sobre el mapa, no un vidrio translúcido que ensucia.
          {
            backgroundColor: hexAlpha(theme.colors.surfaceElevated, 0.92),
            borderColor: theme.colors.borderStrong,
          },
        ]}
      >
        {state.routes.map((route, index) => {
          const descriptor = descriptors[route.key];
          if (!descriptor) {
            return null;
          }
          const { options } = descriptor;
          const focused = state.index === index;
          const label =
            typeof options.tabBarLabel === 'string' ? options.tabBarLabel : route.name;
          const color = focused ? theme.colors.brand : theme.colors.inkSubtle;
          const icon = options.tabBarIcon?.({ focused, color, size: 22 });

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          return (
            <Pressable
              key={route.key}
              accessibilityRole="button"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={label}
              onPress={onPress}
              style={[styles.item, focused ? { backgroundColor: theme.colors.brandDim } : null]}
            >
              {icon}
              <Text variant="caption" color={focused ? 'brand' : 'inkSubtle'} numberOfLines={1}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // ABSOLUTE: el tab bar flota SOBRE el mapa a pantalla completa (fiel al frame — el mapa llega hasta el
  // borde inferior, sin banda negra detrás del pill). Como no reserva alto, las pantallas con lista
  // paddean su fondo con `useDriverTabBarHeight()` y el dock del Inicio se eleva por encima.
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 18,
    paddingTop: WRAP_TOP,
    alignItems: 'stretch',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 999,
    borderWidth: 1,
    padding: 6,
    shadowColor: '#1A2332',
    shadowOpacity: 0.14,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 16,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 8,
    borderRadius: 999,
  },
});
