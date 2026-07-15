import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useQuery} from '@tanstack/react-query';
import {
  hexAlpha,
  ListGroup,
  ListItem,
  SafeScreen,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, StyleSheet, View} from 'react-native';
import Svg, {Defs, LinearGradient, Rect, Stop} from 'react-native-svg';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import type {RootStackParamList} from '../../../../navigation/types';
import {useChildModeStore} from '../../../childMode/presentation/stores/childModeStore';
import {mapKycStatus} from '../../../kyc/domain/entities';
import {IconShieldCheck} from '../../../panic/presentation/components/icons';
import {
  IconChild,
  IconFaceScan,
  IconShare,
  IconUsers,
} from '../../../profile/presentation/components/icons';
import {useActiveTripStore} from '../../../trip/presentation/stores/activeTripStore';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * Hub de Seguridad (tab del bottom nav) — design/veo.pen P/Seguridad (rUe5b):
 *
 *  - HERO "Vas protegido": gradiente sutil de superficie + emblema shield-check. Comunica que las
 *    protecciones (pánico, cámara, familia) están activas en cada viaje, sin pedir nada.
 *  - HERRAMIENTAS: 4 filas navegables (patrón Card+ListItem del ProfileScreen) cuyos subtítulos son
 *    ESTADO REAL del contrato, nunca inventado: conteo de contactos verificados (bff `/contacts`),
 *    on/off del modo niño (childModeStore), estado KYC del perfil (`GET /users/me` → mapKycStatus).
 *  - "Compartir viaje" SOLO tiene sentido con un viaje en curso (el enlace firmado se crea sobre un
 *    trip IN_PROGRESS): sin viaje activo la fila queda deshabilitada con subtítulo honesto — el pen
 *    la lista sin ese matiz, pero mostrarla activa sería prometer algo que no se puede hacer.
 */
export function SeguridadScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();

  const listContacts = useDependency(TOKENS.listContactsUseCase);
  const getProfile = useDependency(TOKENS.getProfileUseCase);

  // Mismas queryKeys que TrustedContactsScreen/ProfileScreen: comparten caché e invalidaciones
  // (verificar un contacto o aprobar el KYC refresca este hub sin plumbing extra).
  const contactsQuery = useQuery({
    queryKey: ['contacts'],
    queryFn: () => listContacts.execute(),
  });
  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile.execute(),
  });

  const childModeEnabled = useChildModeStore(s => s.enabled);
  const activeTripId = useActiveTripStore(s => s.activeTripId);

  // Subtítulo de contactos: conteo REAL de verificados; error → honesto (antes "…" para siempre); carga → neutro.
  const verifiedCount = contactsQuery.data?.filter(c => c.verified).length;
  const contactsSubtitle = contactsQuery.isError
    ? t('security.loadError')
    : verifiedCount === undefined
      ? '…'
      : verifiedCount === 0
        ? t('security.contactsNone')
        : verifiedCount === 1
          ? t('security.contactsVerifiedOne')
          : t('security.contactsVerifiedMany', {count: verifiedCount});

  // Estado KYC real (misma fuente que ProfileScreen: profile.kycStatus normalizado por el dominio).
  const kycStatus = profileQuery.data
    ? mapKycStatus(profileQuery.data.kycStatus)
    : null;
  const kycSubtitle = profileQuery.isError
    ? t('security.loadError')
    : kycStatus === null
      ? '…'
      : kycStatus === 'approved'
        ? t('security.kycVerified')
        : kycStatus === 'pending'
          ? t('security.kycPending')
          : t('security.kycUnverified');

  const glyph = 22;
  const accent = theme.colors.accent;
  const hasActiveTrip = activeTripId !== null;

  return (
    <SafeScreen padded={false}>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing.lg,
        }}>
        {/* Título del hub, in-body (mismo patrón que ProfileScreen). */}
        <Text variant="title1">{t('tabs.seguridad')}</Text>

        {/* HERO "Vas protegido" (pen): gradiente entre tokens de superficie + emblema shield-check. */}
        <View
          style={[
            styles.hero,
            {
              borderRadius: theme.radii.lg,
              padding: theme.spacing.lg,
              gap: theme.spacing.md,
              // Superficie EDITORIAL: elevación en vez de borde duro (coherente con las cards de viaje).
              ...theme.elevation.level1,
            },
          ]}>
          <Svg style={StyleSheet.absoluteFill}>
            <Defs>
              {/* El pen pinta un gradiente vertical sutil; se emula con los tokens de superficie
                  (surfaceElevated → surface) porque el kit no tiene primitivo de gradiente. */}
              <LinearGradient id="securityHero" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={theme.colors.surfaceElevated} />
                <Stop offset="1" stopColor={theme.colors.surface} />
              </LinearGradient>
            </Defs>
            <Rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              fill="url(#securityHero)"
            />
          </Svg>
          <View
            style={[
              styles.heroEmblem,
              {
                backgroundColor: hexAlpha(theme.colors.success, 0.14),
                borderRadius: theme.radii.pill,
              },
            ]}>
            <IconShieldCheck color={theme.colors.success} size={26} />
          </View>
          <View style={styles.heroTexts}>
            <Text variant="headline">{t('security.heroTitle')}</Text>
            <Text variant="footnote" color="inkMuted">
              {t('security.heroSubtitle')}
            </Text>
          </View>
        </View>

        {/* HERRAMIENTAS: filas navegables con estado real, en grupo EDITORIAL (superficie +
            elevación, divisores hairline — sin el cajón con borde del patrón viejo). */}
        <View>
          <Text
            variant="label"
            color="inkMuted"
            style={{
              marginBottom: theme.spacing.sm,
              marginLeft: theme.spacing.xs,
            }}>
            {t('security.toolsLabel')}
          </Text>
          <ListGroup>
            <ListItem
              title={t('security.contactsTitle')}
              subtitle={contactsSubtitle}
              leading={<IconUsers color={accent} size={glyph} />}
              chevron
              onPress={() => navigation.navigate('TrustedContacts')}
            />
            <ListItem
              title={t('security.childModeTitle')}
              subtitle={
                childModeEnabled
                  ? t('security.childModeOn')
                  : t('security.childModeOff')
              }
              leading={<IconChild color={accent} size={glyph} />}
              chevron
              onPress={() => navigation.navigate('ChildMode')}
            />
            <ListItem
              title={t('security.kycTitle')}
              subtitle={kycSubtitle}
              leading={<IconFaceScan color={accent} size={glyph} />}
              chevron
              onPress={() => navigation.navigate('KycCamera')}
            />
            {/* Compartir con familia: el enlace firmado vive en el flujo del viaje activo (Home).
                Sin viaje en curso se deshabilita con subtítulo honesto (no hay nada que compartir). */}
            <ListItem
              title={t('security.shareTitle')}
              subtitle={
                hasActiveTrip
                  ? t('security.shareActive')
                  : t('security.shareUnavailable')
              }
              leading={<IconShare color={accent} size={glyph} />}
              chevron={hasActiveTrip}
              disabled={!hasActiveTrip}
              onPress={() => navigation.navigate('Home')}
            />
          </ListGroup>
        </View>
      </ScrollView>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
  },
  heroEmblem: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTexts: {flex: 1, gap: 2},
});
