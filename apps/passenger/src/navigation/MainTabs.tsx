import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import React from 'react';
import {ProfileScreen} from '../features/profile/presentation';
import {SeguridadScreen} from '../features/security/presentation/screens/SeguridadScreen';
import {RequestFlowScreen, TripHistoryScreen} from '../features/trip/presentation';
import {AppTabBar} from './components/AppTabBar';
import type {MainTabsParamList} from './types';

const Tab = createBottomTabNavigator<MainTabsParamList>();

/**
 * Bottom nav autenticado del pasajero (fuente: design/veo.pen C/TabBar) — reintroduce las 4 tabs:
 * Inicio (Home/RequestFlow) · Viajes (historial) · Seguridad (hub) · Cuenta (perfil). La barra la
 * pinta `AppTabBar` (píldora flotante). Las pantallas modales/de viaje viven en el Stack, ENCIMA de
 * estas tabs (ver RootNavigator).
 */
export function MainTabs(): React.JSX.Element {
  return (
    <Tab.Navigator
      tabBar={props => <AppTabBar {...props} />}
      screenOptions={{headerShown: false}}>
      <Tab.Screen name="Home" component={RequestFlowScreen} />
      <Tab.Screen name="TripHistory" component={TripHistoryScreen} />
      <Tab.Screen name="Seguridad" component={SeguridadScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}
