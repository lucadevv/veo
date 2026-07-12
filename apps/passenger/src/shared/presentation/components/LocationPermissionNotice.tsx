import {Banner} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {Linking} from 'react-native';
import type {LocationStatus} from '../../../core/location/useCurrentLocation';

/**
 * Aviso HONESTO del estado de permiso/GPS de ubicación cuando NO se pudo ubicar al usuario
 * (`denied` / `servicesOff` / `error`). Los estados felices (`locating` / `ready`) → `null`.
 *
 * Mismo patrón que el banner de permiso de CÁMARA del KYC (`Banner tone="warn"` + acción a Ajustes):
 * los consumidores de `useCurrentLocation` (SearchScreen / MapPickScreen / CarpoolPlacePickerSheet)
 * solo leían `{point}`, así que un permiso NEGADO quedaba invisible (sin distancia, sin "usar mi
 * ubicación", sin sesgo) y el usuario no sabía por qué. No BLOQUEA la pantalla (la búsqueda por texto
 * y el picking manual siguen funcionando): es una franja no-modal que explica y ofrece la salida.
 */
export function LocationPermissionNotice({
  status,
  onRetry,
}: {
  status: LocationStatus;
  onRetry: () => void;
}): React.JSX.Element | null {
  const {t} = useTranslation();

  if (status === 'locating' || status === 'ready') {
    return null;
  }

  // Permiso negado/sin decidir → derivar a Ajustes de la app.
  if (status === 'denied') {
    return (
      <Banner
        tone="warn"
        title={t('maps.locationDeniedTitle')}
        description={t('maps.locationDeniedBody')}
        action={{
          label: t('maps.openSettings'),
          onPress: () => void Linking.openSettings(),
        }}
      />
    );
  }

  // Permiso ok pero GPS del dispositivo apagado → derivar a Ajustes de ubicación.
  if (status === 'servicesOff') {
    return (
      <Banner
        tone="warn"
        title={t('maps.locationServicesOffTitle')}
        description={t('maps.locationServicesOffBody')}
        action={{
          label: t('maps.openSettings'),
          onPress: () => void Linking.openSettings(),
        }}
      />
    );
  }

  // `error`: fix transitorio fallido (sin señal / indoor / puerto no disponible) → reintentar.
  return (
    <Banner
      tone="warn"
      title={t('maps.locationErrorTitle')}
      description={t('maps.locationErrorBody')}
      action={{label: t('actions.retry'), onPress: onRetry}}
    />
  );
}
