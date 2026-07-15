import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StatusPill, Text, useTheme, type StatusTone } from '@veo/ui-kit';
import { vehicleClassGlyph } from '../../../../shared/presentation/vehicle-class';
import type { VehicleView } from '../../domain';
import { hexAlpha } from '../../../../shared/presentation/color';

interface VehicleStatusCardProps {
  vehicle: VehicleView;
}

/** Mapea el estado de revisión (`status`/`docStatus`) a un tono de píldora (color nunca es único indicador). */
function statusTone(status: string): StatusTone {
  switch (status.toUpperCase()) {
    case 'ACTIVE':
    case 'APPROVED':
    case 'VALID':
      return 'success';
    case 'PENDING_REVIEW':
    case 'PENDING':
    case 'EXPIRING_SOON':
      return 'warn';
    case 'REJECTED':
    case 'EXPIRED':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** Traduce un estado conocido del backend a español; si no se conoce, devuelve el crudo legible. */
function statusLabel(status: string, t: ReturnType<typeof useTranslation>['t']): string {
  const key = `registration.vehicle.status.${status.toUpperCase()}`;
  const label = t(key);
  return label === key ? status : label;
}

/**
 * Tarjeta del vehículo ya registrado: muestra placa, marca/modelo/año y el estado de revisión
 * (`status` + `docStatus`) con píldoras. Mientras el vehículo está en revisión (PENDING_REVIEW)
 * entra inactivo: el formulario de alta no se muestra y el conductor solo puede continuar.
 */
export function VehicleStatusCard({ vehicle }: VehicleStatusCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  const Icon = vehicleClassGlyph(vehicle.vehicleType);

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.lg,
          gap: theme.spacing.md,
        },
      ]}
    >
      <View style={[styles.header, { gap: theme.spacing.md }]}>
        <View
          style={[
            styles.iconWrap,
            { backgroundColor: hexAlpha(theme.colors.accent, 0.14), borderRadius: theme.radii.md },
          ]}
        >
          <Icon size={28} color={theme.colors.accent} strokeWidth={1.8} />
        </View>
        <View style={styles.flex}>
          <Text variant="title3" tabular>
            {vehicle.plate}
          </Text>
          <Text variant="callout" color="inkMuted">
            {`${vehicle.make} ${vehicle.model} · ${vehicle.year}`}
          </Text>
        </View>
      </View>

      <View style={[styles.pills, { gap: theme.spacing.sm }]}>
        <StatusPill tone={statusTone(vehicle.status)} dot label={statusLabel(vehicle.status, t)} />
        <Text variant="footnote" color="inkSubtle">
          {t('registration.vehicle.docStatusLabel', { status: statusLabel(vehicle.docStatus, t) })}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', borderWidth: 1 },
  header: { flexDirection: 'row', alignItems: 'center' },
  iconWrap: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, gap: 2 },
  pills: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
});
