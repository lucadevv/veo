import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Banner, Button, Card, Text, useTheme } from '@veo/ui-kit';
import type { WaypointProposedMsg } from '@veo/api-client';
import { formatPEN } from '../../../../shared/presentation/format';

export interface WaypointProposalCardProps {
  proposal: WaypointProposedMsg;
  isResponding: boolean;
  isError: boolean;
  onRespond: (accept: boolean) => void;
}

/**
 * Tarjeta de PARADA propuesta por el pasajero (Lote C4) que el conductor ve durante el viaje en curso.
 * Muestra el costo adicional + la tarifa nueva (calculados por el server, NUNCA por el cliente) y dos
 * acciones: aceptar (suma la parada + recalcula tarifa/ruta server-side) o rechazar (el viaje sigue
 * igual). El delta solo se muestra si es positivo (la tarifa nueva es la fuente de verdad de todos modos).
 */
export const WaypointProposalCard = ({
  proposal,
  isResponding,
  isError,
  onRespond,
}: WaypointProposalCardProps): React.JSX.Element => {
  const theme = useTheme();
  const { t } = useTranslation();

  return (
    <Card variant="elevated" padding="lg">
      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="bodyStrong">{t('trips.waypoint.proposedTitle')}</Text>
        <Text variant="footnote" color="inkMuted">
          {t('trips.waypoint.proposedBody')}
        </Text>

        {proposal.deltaFareCents > 0 ? (
          <View style={styles.row}>
            <Text variant="callout" color="inkMuted">
              {t('trips.waypoint.extraFare', { amount: formatPEN(proposal.deltaFareCents) })}
            </Text>
          </View>
        ) : null}
        <View style={styles.row}>
          <Text variant="callout" color="inkMuted">
            {t('trips.waypoint.newFare', { amount: formatPEN(proposal.newFareCents) })}
          </Text>
        </View>

        {isError ? <Banner tone="danger" title={t('trips.waypoint.error')} /> : null}

        <Button
          label={t('trips.waypoint.accept')}
          variant="safe"
          fullWidth
          loading={isResponding}
          disabled={isResponding}
          onPress={() => onRespond(true)}
        />
        <Button
          label={t('trips.waypoint.reject')}
          variant="ghost"
          fullWidth
          disabled={isResponding}
          onPress={() => onRespond(false)}
        />
      </View>
    </Card>
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
