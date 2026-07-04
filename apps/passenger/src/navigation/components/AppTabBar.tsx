import type {BottomTabBarProps} from '@react-navigation/bottom-tabs';
import {Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  IconTabHome,
  IconTabRides,
  IconTabSecurity,
  IconTabUser,
  type TabIconProps,
} from './TabBarIcons';

type IconCmp = (props: TabIconProps) => React.JSX.Element;

/** Config por route.name: ícono + key i18n del label (fuente: design/veo.pen C/TabBar). */
const TABS: Record<string, {icon: IconCmp; label: string}> = {
  Home: {icon: IconTabHome, label: 'tabs.inicio'},
  TripHistory: {icon: IconTabRides, label: 'tabs.viajes'},
  Seguridad: {icon: IconTabSecurity, label: 'tabs.seguridad'},
  Profile: {icon: IconTabUser, label: 'tabs.cuenta'},
};

/**
 * Bottom nav flotante del pasajero, fiel a `design/veo.pen` (C/TabBar): píldora elevada con 4 tabs
 * (Inicio · Viajes · Seguridad · Cuenta). El tab activo se rellena en azul de marca con fondo
 * `brand` tenue; los inactivos quedan en `inkSubtle`. No decide navegación por sí solo: emite
 * `tabPress` y delega en el navigator (la UI no autoriza).
 */
export function AppTabBar({
  state,
  descriptors,
  navigation,
}: BottomTabBarProps): React.JSX.Element | null {
  const theme = useTheme();
  const {t} = useTranslation();
  const insets = useSafeAreaInsets();

  // Ocultamiento POR PANTALLA (patrón estándar de tab bar custom): la ruta enfocada puede pedir
  // `tabBarStyle: {display: 'none'}`. Lo usa el Home fuera de idle (cotización/puja/viaje): el pen
  // no dibuja la TabBar en esas fases y la píldora tapaba el CTA del sheet ("Confirmar VEO").
  const focusedOptions = descriptors[state.routes[state.index]!.key]?.options;
  const tabBarStyle = focusedOptions?.tabBarStyle;
  if (
    tabBarStyle != null &&
    typeof tabBarStyle === 'object' &&
    'display' in tabBarStyle &&
    tabBarStyle.display === 'none'
  ) {
    return null;
  }

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, {paddingBottom: insets.bottom + theme.spacing.sm}]}>
      <View
        style={[
          styles.pill,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderColor: theme.colors.borderStrong,
            borderRadius: theme.radii.pill,
          },
          theme.elevation.level3,
        ]}>
        {state.routes.map((route, index) => {
          const cfg = TABS[route.name];
          if (!cfg) {
            return null;
          }
          const focused = state.index === index;
          const Icon = cfg.icon;
          const tint = focused ? theme.colors.brand : theme.colors.inkSubtle;
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
              accessibilityState={{selected: focused}}
              accessibilityLabel={t(cfg.label)}
              onPress={onPress}
              style={[
                styles.item,
                {
                  borderRadius: theme.radii.pill,
                  backgroundColor: focused
                    ? `${theme.colors.brand}26`
                    : 'transparent',
                },
              ]}>
              <Icon active={focused} color={tint} size={22} />
              <Text variant="caption" style={{color: tint, marginTop: 3}}>
                {t(cfg.label)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  pill: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    justifyContent: 'space-between',
    padding: 6,
    borderWidth: 1,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
});
