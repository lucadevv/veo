import {Avatar, IconButton, Text, useTheme} from '@veo/ui-kit';
import React, {useCallback} from 'react';
import {useTranslation} from 'react-i18next';
import {Linking, Pressable, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {LocationStatus} from '../hooks/useCurrentLocation';
import {IconBell} from './icons';

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
  onOpenNotifications: () => void;
  onOpenProfile: () => void;
}

/**
 * Chrome superior del HOME sobre el mapa: pill de ubicación (con CTA accionable si el fix no es feliz:
 * Ajustes para permiso/GPS apagado, Reintentar para fix fallido) + campana de notificaciones + avatar.
 * Oculto durante el viaje activo (ahí manda el `TripTopBar`).
 */
export function HomeTopBar({
  locationStatus,
  onRetryLocation,
  originTitle,
  reverseTitle,
  profileName,
  profilePhotoUrl,
  onOpenNotifications,
  onOpenProfile,
}: HomeTopBarProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const insets = useSafeAreaInsets();

  // Estado de la pastilla de ubicación: cada estado no-feliz da un mensaje + CTA accionable
  // (Ajustes para permiso/GPS, Reintentar para fix fallido), en vez de un genérico mudo.
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
  // La acción del pill: permiso/GPS → abrir Ajustes del sistema; fix fallido → reintentar en el acto.
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
            backgroundColor: theme.colors.surface,
            borderColor: locationActionable
              ? theme.colors.warn
              : theme.colors.border,
            borderRadius: theme.radii.pill,
            ...theme.elevation.level2,
          },
        ]}>
        <View
          style={[
            styles.locationDot,
            {
              backgroundColor: locationActionable
                ? theme.colors.warn
                : theme.colors.accent,
            },
          ]}
        />
        <Text variant="subhead" numberOfLines={1} style={styles.locationLabel}>
          {userLabel}
        </Text>
        {locationActionLabel ? (
          <Text
            variant="subhead"
            color="accent"
            numberOfLines={1}
            style={styles.locationAction}>
            {locationActionLabel}
          </Text>
        ) : null}
      </Pressable>
      <View style={styles.topActions} pointerEvents="box-none">
        <IconButton
          accessibilityLabel={t('home.notifications')}
          variant="surface"
          onPress={onOpenNotifications}
          icon={<IconBell color={theme.colors.ink} size={20} />}
          style={{...theme.elevation.level2}}
        />
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
    </View>
  );
}

const styles = StyleSheet.create({
  topRow: {
    position: 'absolute',
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  topActions: {flexDirection: 'row', alignItems: 'center', gap: 10},
  locationPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
  },
  locationDot: {width: 7, height: 7, borderRadius: 999},
  locationLabel: {flexShrink: 1},
  locationAction: {fontWeight: '600', flexShrink: 0},
});
