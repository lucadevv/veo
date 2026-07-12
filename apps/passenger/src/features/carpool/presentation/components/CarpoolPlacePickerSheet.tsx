import type {PlaceSuggestion} from '@veo/api-client';
import {
  Banner,
  BottomSheet,
  ListItem,
  Skeleton,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {View} from 'react-native';
import {useAutocomplete} from '../../../../shared/presentation/hooks/useAutocomplete';
import {useCurrentLocation} from '../../../../core/location/useCurrentLocation';
import {LocationPermissionNotice} from '../../../../shared/presentation/components/LocationPermissionNotice';
import {IconPin} from '../../../trip/presentation/components/icons';

/** Punto elegido para la búsqueda de carpooling (coordenada + etiqueta que ve el pasajero). */
export interface CarpoolPlacePick {
  lat: number;
  lon: number;
  label: string;
}

export interface CarpoolPlacePickerSheetProps {
  visible: boolean;
  /** Extremo que se está editando (cambia el título del sheet). */
  kind: 'origin' | 'destination';
  onClose: () => void;
  onSelect: (pick: CarpoolPlacePick) => void;
}

/**
 * Selector de Origen/Destino del buscador de carpooling: bottom-sheet con el autocompletado REAL
 * (`useAutocomplete`, debounce + sesgo por ubicación) sobre un input LOCAL. A propósito NO usa el
 * `rideDraftStore` del flujo on-demand: la búsqueda de carpooling es un borrador independiente que
 * no debe pisar (ni ser pisado por) el trayecto del pedido inmediato.
 */
export function CarpoolPlacePickerSheet({
  visible,
  kind,
  onClose,
  onSelect,
}: CarpoolPlacePickerSheetProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const {
    point: myLocation,
    status: locationStatus,
    retry: retryLocation,
  } = useCurrentLocation();

  const [query, setQuery] = useState('');
  const {suggestions, loading, error, active} = useAutocomplete(
    query,
    // Sesgo por la ubicación actual (mismo criterio que el buscador on-demand); null sin fix GPS.
    myLocation ? {lat: myLocation.lat, lng: myLocation.lon} : null,
  );

  // Query limpia por apertura: elegir "Hasta" no debe arrancar con la búsqueda de "Desde".
  useEffect(() => {
    if (visible) {
      setQuery('');
    }
  }, [visible]);

  const pick = (suggestion: PlaceSuggestion): void => {
    onSelect({
      lat: suggestion.lat,
      lon: suggestion.lng,
      label: suggestion.title,
    });
    onClose();
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={
        kind === 'origin'
          ? t('carpool.pickerTitleOrigin')
          : t('carpool.pickerTitleDestination')
      }>
      <View style={{gap: theme.spacing.md}}>
        <TextField
          label={
            kind === 'origin' ? t('carpool.fromLabel') : t('carpool.toLabel')
          }
          value={query}
          onChangeText={setQuery}
          placeholder={t('carpool.pickerPlaceholder')}
          autoFocus
          autoCorrect={false}
        />

        {/* Permiso/GPS negado: sin él perdemos el sesgo por ubicación (la búsqueda por texto igual
            funciona). Aviso honesto en vez de silencio. */}
        <LocationPermissionNotice
          status={locationStatus}
          onRetry={retryLocation}
        />

        {error ? (
          <Banner tone="danger" title={t('carpool.pickerError')} />
        ) : null}

        {loading && suggestions.length === 0 ? (
          <View style={{gap: theme.spacing.sm}}>
            <Skeleton height={48} />
            <Skeleton height={48} />
            <Skeleton height={48} />
          </View>
        ) : null}

        {suggestions.map(suggestion => (
          <ListItem
            key={suggestion.id}
            title={suggestion.title}
            subtitle={suggestion.subtitle}
            leading={<IconPin color={theme.colors.inkSubtle} size={18} />}
            onPress={() => pick(suggestion)}
          />
        ))}

        {active && !loading && !error && suggestions.length === 0 ? (
          <Text variant="callout" color="inkMuted">
            {t('carpool.pickerEmpty')}
          </Text>
        ) : null}
      </View>
    </BottomSheet>
  );
}
