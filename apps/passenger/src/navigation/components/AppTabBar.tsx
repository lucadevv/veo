import type {BottomTabBarProps} from '@react-navigation/bottom-tabs';
import {
  hexAlpha,
  TabGlyphAccount,
  TabGlyphCarpool,
  TabGlyphHome,
  TabGlyphSecurity,
  TabGlyphTrips,
  type TabGlyphProps,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

type IconCmp = (props: TabGlyphProps) => React.JSX.Element;

/**
 * Config por route.name: glifo compartido (`@veo/ui-kit`, MISMA identidad que el driver) + key i18n del
 * label (fuente: design/veo.pen C/TabBar). Inicio/Viajes/Cuenta usan el glifo idéntico al del conductor.
 */
const TABS: Record<string, {icon: IconCmp; label: string}> = {
  Home: {icon: TabGlyphHome, label: 'tabs.inicio'},
  Compartir: {icon: TabGlyphCarpool, label: 'tabs.compartir'},
  TripHistory: {icon: TabGlyphTrips, label: 'tabs.viajes'},
  Seguridad: {icon: TabGlyphSecurity, label: 'tabs.seguridad'},
  Profile: {icon: TabGlyphAccount, label: 'tabs.cuenta'},
};

/** Alto de la píldora (padding 6×2 + item: 8+glifo 22+gap 4+label ~13+8). */
const PILL_HEIGHT = 68;

/**
 * Alto TOTAL que ocupa el tab bar flotante (píldora + aire + home-indicator) — espejo de
 * `useDriverTabBarHeight` del conductor. La barra es `absolute` (flota sobre el contenido), así que
 * NO reserva espacio: las pantallas de tab con contenido/CTA al fondo deben paddear con esto.
 */
export function useAppTabBarHeight(): number {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return insets.bottom + theme.spacing.sm + PILL_HEIGHT + theme.spacing.md;
}

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
            // Pill frosted (~92% surfaceElevated) — MISMO tratamiento que el driver (DriverTabBar):
            // superficie de confianza sobre el mapa, no un vidrio translúcido que ensucia el contenido.
            backgroundColor: hexAlpha(theme.colors.surfaceElevated, 0.92),
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
                  // Chip activo `brandDim` (token, MISMO que el driver) en vez de un alpha suelto.
                  backgroundColor: focused ? theme.colors.brandDim : 'transparent',
                },
              ]}>
              <Icon active={focused} color={tint} size={22} />
              {/* Label 10/500 con gap 4 (pen C/TabItem) — caption (12) quedaba grande. */}
              <Text
                variant="caption"
                style={{color: tint, marginTop: 4, fontSize: 10}}>
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
