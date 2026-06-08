import {useNavigation} from '@react-navigation/native';
import type {CompositeNavigationProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BottomTabNavigationProp} from '@react-navigation/bottom-tabs';
import type {MainTabParamList, RootStackParamList} from './types';

/**
 * Navegación compuesta del conductor: combina el bottom tab navigator (`MainTabParamList`) con el
 * stack raíz (`RootStackParamList`). Las pantallas montadas como tabs pueden así navegar tanto a
 * otras tabs (Ganancias/Viajes/Cuenta) como a pantallas full-screen del stack (ShiftStart,
 * TripActive, etc.) con tipado correcto, sin recurrir a `any`.
 */
export type AppNavigation = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

/** Hook de navegación tipado para pantallas del conductor (tabs + stack). */
export function useAppNavigation(): AppNavigation {
  return useNavigation<AppNavigation>();
}
