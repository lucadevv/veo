import React from 'react';
import {ActivityIndicator, StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {Banner, Skeleton, Text, useTheme} from '@veo/ui-kit';
import {
  vehicleClassGlyph,
  vehicleClassLabelKey,
} from '../../../../shared/presentation/vehicle-class';
import {
  useActiveVehicle,
  useDriverVehicles,
  useSetActiveVehicle,
} from '../../../registration/presentation';
import {PressableScale} from './motion';

export interface VehicleTypeSelectorProps {
  /** Deshabilita el cambio (p. ej. yendo a recoger o con un viaje en curso). */
  disabled?: boolean;
}

/** El status `ACTIVE` (vehicle-rules de fleet) significa "verificado por el operador". */
const VERIFIED_STATUS = 'ACTIVE';

/**
 * Selector del VEHÍCULO ACTIVO del turno (el que el conductor opera). Server-authoritative: lista los
 * vehículos REALES del conductor (`GET /drivers/vehicles`), marca el activo (`GET /drivers/active-vehicle`)
 * y cambiarlo es una MUTACIÓN al servidor (`PATCH /drivers/active-vehicle`) — NO un toggle local. El
 * dispatch deriva el TIPO de ese vehículo, así que ya no se puede declarar un tipo sin tener el vehículo.
 *
 * Estados: cargando (skeleton) · sin vehículos (aviso honesto) · 1 vehículo (se muestra, sin elegir) ·
 * 2+ (segmentos seleccionables con su placa). El color nunca es el único indicador del activo: hay
 * relleno, borde, ícono y placa.
 */
export const VehicleTypeSelector = ({disabled = false}: VehicleTypeSelectorProps): React.JSX.Element => {
  const {t} = useTranslation();
  const theme = useTheme();
  const vehicles = useDriverVehicles();
  const active = useActiveVehicle();
  const select = useSetActiveVehicle();

  const list = vehicles.data ?? [];
  const activeId = active.data?.id;
  const loading = vehicles.isLoading || active.isLoading;
  const locked = disabled || select.isPending;

  const header = (
    <Text variant="footnote" color="inkMuted">
      {t('shift.vehicleType.label')}
    </Text>
  );

  if (loading) {
    return (
      <View>
        {header}
        <Skeleton height={48} radius={theme.radii.pill} style={styles.spaced} />
      </View>
    );
  }

  if (list.length === 0) {
    return (
      <View>
        {header}
        <Banner tone="warn" title={t('shift.vehicleType.none')} style={styles.spaced} />
      </View>
    );
  }

  return (
    <View>
      {header}
      <View
        accessibilityRole="radiogroup"
        style={[
          styles.track,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderRadius: theme.radii.pill,
            padding: theme.spacing.xxs,
            opacity: locked ? 0.6 : 1,
          },
        ]}>
        {list.map(vehicle => {
          const isActive = vehicle.id === activeId;
          const Icon = vehicleClassGlyph(vehicle.vehicleType);
          const labelColor = isActive ? theme.colors.onAccent : theme.colors.inkMuted;
          const pending = select.isPending && select.variables === vehicle.id;
          return (
            <PressableScale
              key={vehicle.id}
              accessibilityRole="radio"
              accessibilityState={{selected: isActive, disabled: locked}}
              accessibilityLabel={t(vehicleClassLabelKey(vehicle.vehicleType))}
              // Bloqueado durante un cambio en curso, en viaje (disabled), o si ya es el activo.
              disabled={locked || isActive}
              onPress={() => select.mutate(vehicle.id)}
              style={[
                styles.segment,
                {
                  borderRadius: theme.radii.pill,
                  backgroundColor: isActive ? theme.colors.accent : 'transparent',
                },
              ]}>
              {pending ? (
                <ActivityIndicator size="small" color={labelColor} />
              ) : (
                <Icon size={18} color={labelColor} />
              )}
              <View style={styles.segmentText}>
                <Text variant="subhead" style={{color: labelColor}} numberOfLines={1}>
                  {t(vehicleClassLabelKey(vehicle.vehicleType))}
                </Text>
                <Text variant="caption" style={{color: labelColor}} numberOfLines={1}>
                  {vehicle.plate}
                </Text>
              </View>
            </PressableScale>
          );
        })}
      </View>
      {/* Aviso honesto: el vehículo activo no está verificado por el operador todavía (opera igual: no
          hay workflow de aprobación aún), pero el conductor debe saberlo. */}
      {active.data && active.data.status !== VERIFIED_STATUS ? (
        <Text variant="caption" color="inkMuted" style={styles.spaced}>
          {t('shift.vehicleType.pendingReview')}
        </Text>
      ) : null}
      {select.isError ? (
        <Banner tone="danger" title={t('shift.vehicleType.changeError')} style={styles.spaced} />
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  track: {flexDirection: 'row', gap: 4, marginTop: 8},
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  segmentText: {alignItems: 'flex-start'},
  spaced: {marginTop: 8},
});
