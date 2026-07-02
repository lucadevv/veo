import {Avatar, Text, useTheme} from '@veo/ui-kit';
import React, {useCallback} from 'react';
import {useTranslation} from 'react-i18next';
import {Linking, Pressable, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {LocationStatus} from '../hooks/useCurrentLocation';
import {IconPin} from './icons';

export interface HomeTopBarProps {
  /** Estado del fix de ubicación: cada estado no-feliz da un mensaje + CTA accionable. */
  locationStatus: LocationStatus;
  /** Reintenta el fix de ubicación (CTA del estado `error`). */
  onRetryLocation: () => void;
  /** Etiqueta del origen del borrador (si ya está sembrado). */
  originTitle: string | null;
  /** Etiqueta del geocoding inverso de la ubicación actual (fallback del pill). */
  reverseTitle: string | null;
  profileName: string | null;
  profilePhotoUrl: string | null;
  /** Reservado: el design/veo.pen NO muestra campana en el TopRow — notificaciones se re-aloja (follow-up). */
  onOpenNotifications: () => void;
  onOpenProfile: () => void;
}

/**
 * Chrome superior del HOME sobre el mapa, fiel a `design/veo.pen` P/Home (TopRow): pill de ubicación
 * (pin de marca + "Ubicación actual" + la dirección real; CTA accionable si el fix no es feliz:
 * Ajustes para permiso/GPS, Reintentar para fix fallido) + avatar. SIN campana (el .pen no la tiene
 * en el TopRow; el acceso a notificaciones se re-aloja en un lote posterior). Oculto durante el viaje
 * activo (ahí manda el `TripTopBar`).
 */
export function HomeTopBar({
  locationStatus,
  onRetryLocation,
  originTitle,
  reverseTitle,
  profileName,
  profilePhotoUrl,
  onOpenProfile,
}: HomeTopBarProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const insets = useSafeAreaInsets();

  const locationActionable =
    locationStatus === 'denied' ||
    locationStatus === 'servicesOff' ||
    locationStatus === 'error';
  const userLabel =
    locationStatus === 'denied'
      ? t('home.locationDenied')
      : locationStatus === 'servicesOff'
        ? t('home.locationServicesOff')
        : locationStatus === 'error'
          ? t('home.locationUnavailable')
          : (originTitle ??
            reverseTitle ??
            (locationStatus === 'locating'
              ? t('home.locating')
              : t('home.yourLocation')));
  const locationActionLabel =
    locationStatus === 'error'
      ? t('home.locationActionRetry')
      : locationActionable
        ? t('home.locationActionSettings')
        : null;
  const onLocationAction = useCallback(() => {
    if (locationStatus === 'error') {
      onRetryLocation();
    } else if (
      locationStatus === 'denied' ||
      locationStatus === 'servicesOff'
    ) {
      void Linking.openSettings();
    }
  }, [locationStatus, onRetryLocation]);

  const pinColor = locationActionable
    ? theme.colors.warn
    : theme.colors.accent;

  return (
    <View
      style={[styles.topRow, {top: insets.top + theme.spacing.sm}]}
      pointerEvents="box-none">
      <Pressable
        accessibilityRole={locationActionable ? 'button' : undefined}
        accessibilityLabel={
          locationActionable
            ? `${userLabel}. ${locationActionLabel ?? ''}`
            : userLabel
        }
        onPress={locationActionable ? onLocationAction : undefined}
        disabled={!locationActionable}
        style={[
          styles.locationPill,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderColor: locationActionable
              ? theme.colors.warn
              : theme.colors.borderStrong,
            borderRadius: theme.radii.pill,
            ...theme.elevation.level2,
          },
        ]}>
        <IconPin color={pinColor} size={16} />
        <View style={styles.pillTexts}>
          <Text variant="caption" color="inkSubtle" style={styles.kicker}>
            {t('home.locationKicker')}
          </Text>
          <Text
            variant="subhead"
            numberOfLines={1}
            style={styles.locationValue}>
            {userLabel}
          </Text>
          {locationActionLabel ? (
            <Text variant="footnote" color="accent" numberOfLines={1}>
              {locationActionLabel}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('screens.profile')}
        onPress={onOpenProfile}>
        <Avatar
          uri={profilePhotoUrl ?? undefined}
          name={profileName ?? t('appName')}
          size="md"
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  topRow: {
    position: 'absolute',
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  locationPill: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
  },
  pillTexts: {flexShrink: 1, gap: 1},
  kicker: {fontSize: 10, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.4},
  locationValue: {fontWeight: '600'},
});
