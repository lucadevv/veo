import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {SafeScreen, Text} from '@veo/ui-kit';
import {TripsEmptyState} from '../components/TripsEmptyState';

/** Encabezado simple de la pestaña Viajes (sin retroceso: es un tab, no una pila). */
function TripsHeader({title}: {title: string}): React.JSX.Element {
  return (
    <View style={styles.header}>
      <Text variant="title1" numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
}

/**
 * Historial de viajes del conductor.
 *
 * HUECO DE CONTRATO (sin cambios): el driver-bff aún no expone un endpoint de historial
 * (no hay `GET /trips`). No inventamos datos ni viajes de ejemplo: se muestra un estado vacío
 * premium y honesto hasta que el backend lo provea.
 *
 * El titular es un texto literal porque el contrato de i18n no incluye una clave equivalente y
 * el alcance del rediseño no permite editar los recursos compartidos de traducción; la
 * descripción sí reutiliza la clave honesta `trips.historyUnavailable`.
 */
export const TripHistoryScreen = (): React.JSX.Element => {
  const {t} = useTranslation();
  return (
    <SafeScreen header={<TripsHeader title={t('trips.historyTitle')} />}>
      <TripsEmptyState
        title="Aún no hay viajes para mostrar"
        description={t('trips.historyUnavailable')}
      />
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  header: {paddingTop: 8, paddingBottom: 12},
});
