import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  Banner,
  BottomSheet,
  Button,
  ListGroup,
  ListItem,
  SafeScreen,
  Skeleton,
  StatusPill,
  Text,
  useTheme,
} from '@veo/ui-kit';
import { DriverStatus } from '@veo/shared-types';
import type { MainTabParamList, RootStackParamList } from '../../../../navigation/types';
import { useDriverTabBarHeight } from '../../../../navigation/DriverTabBar';
import { StateView } from '../../../../shared/presentation/components/StateView';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { formatPersonName, formatShortDate } from '../../../../shared/presentation/format';
import {
  IconAccount,
  IconBell,
  IconClock,
  IconDocument,
  IconFace,
  IconGift,
  IconLifebuoy,
  IconLogout,
  IconReceipt,
  IconTrash,
} from '../../../../shared/presentation/icons';
import { useProfile, useRequestAccountDeletion } from '../hooks/useProfile';
import { useLogout } from '../../../../core/session/useLogout';
import { BACKGROUND_CHECK_CLEARED, KYC_VERIFIED, enumLabel } from '../labels';
import { ProfileIdentityCard } from '../components/ProfileIdentityCard';
import { ScreenHero } from '../../../../shared/presentation/components/ScreenHero';
import { Reveal } from '../../../../shared/presentation/components/motion';

/**
 * `Cuenta` es una tab del navegador inferior, pero sus enlaces secundarios viven en el stack raíz
 * (BiometricEnroll) y en tabs hermanas (Ganancias, Viajes). El tipo compuesto habilita ambas
 * navegaciones de forma type-safe.
 */
type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, 'Cuenta'>,
  NativeStackScreenProps<RootStackParamList>
>;

export const ProfileScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { data, isLoading, isError, error, refetch } = useProfile();
  const logout = useLogout();
  const tabBarHeight = useDriverTabBarHeight();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Derecho al olvido (Ley 29733): sheet de confirmación → POST /drivers/me/deletion → banner de
  // gracia + cierre de sesión (espejo del pasajero; el motor y la gracia viven en identity).
  const [deletionOpen, setDeletionOpen] = useState(false);
  const deletion = useRequestAccountDeletion();

  return (
    <SafeScreen scroll contentContainerStyle={{ paddingBottom: tabBarHeight }}>
      <ScreenHero title={t('profile.title')} subtitle={t('profile.subtitle')} />
      {isLoading ? (
        <View style={styles.section}>
          <Skeleton height={96} radius={theme.radii.lg} />
          <Skeleton height={120} radius={theme.radii.lg} />
          <Skeleton height={160} radius={theme.radii.lg} />
        </View>
      ) : isError || !data ? (
        <StateView
          title={t('errors.generic')}
          description={toErrorMessage(error, t)}
          action={{ label: t('common.retry'), onPress: () => refetch() }}
        />
      ) : (
        <View style={styles.section}>
          {/* Identidad premium: avatar grande, NOMBRE (no el teléfono — coherente con el saludo del Inicio)
              y chip de rating con datos reales. */}
          <Reveal delay={40}>
            <ProfileIdentityCard
              name={formatPersonName(data.fullName) ?? data.phone}
              photoUrl={data.photoUrl}
              verified={data.kycStatus === KYC_VERIFIED}
              online={data.currentStatus === DriverStatus.AVAILABLE}
              ratingValue={data.averageRating.toFixed(1)}
              ratingMeta={
                data.rating ? t('profile.ratingCount', { count: data.rating.count30d }) : undefined
              }
            />
          </Reveal>

          {/* Aviso de cumplimiento según el CICLO DE VIDA real de la documentación:
              faltan por subir (warn) → enviados, en revisión (info) → todos aprobados (success). */}
          {/* Status by exception: si TODO está aprobado no gritamos "al día" con un banner verde (era slop
              AI); mostramos banner SOLO cuando hay algo que atender (faltan docs → warn, en revisión → info). */}
          {data.compliance.missing.length > 0 ? (
            <Reveal delay={80}>
              <Banner
                tone="warn"
                title={t('profile.complianceMissing', {
                  items: data.compliance.missing.join(', '),
                })}
              />
            </Reveal>
          ) : !data.compliance.allApproved ? (
            <Reveal delay={80}>
              <Banner tone="info" title={t('profile.complianceInReview')} />
            </Reveal>
          ) : null}

          {/* Estados de verificación (KYC / antecedentes / estado actual) con StatusPill real,
              en grupo EDITORIAL (superficie + hairlines, sin cajón — mismo idioma que el
              "Tu cuenta" del passenger; des-encajonado 2026-07-15). */}
          <Reveal delay={120}>
            <Text variant="label" color="inkMuted" style={styles.sectionLabel}>
              {t('profile.kyc')}
            </Text>
            <ListGroup>
              <ListItem
                title={t('profile.currentStatus')}
                trailing={
                  <StatusPill
                    label={enumLabel(t, 'profile.driverStatus', data.currentStatus)}
                    tone="neutral"
                    dot
                  />
                }
              />
              <ListItem
                title={t('profile.kyc')}
                trailing={
                  <StatusPill
                    label={enumLabel(t, 'profile.kycStatus', data.kycStatus)}
                    tone={data.kycStatus === KYC_VERIFIED ? 'success' : 'warn'}
                    dot
                  />
                }
              />
              <ListItem
                title={t('profile.backgroundCheck')}
                trailing={
                  <StatusPill
                    label={enumLabel(t, 'profile.bgCheckStatus', data.backgroundCheckStatus)}
                    tone={
                      data.backgroundCheckStatus === BACKGROUND_CHECK_CLEARED ? 'success' : 'warn'
                    }
                    dot
                  />
                }
              />
            </ListGroup>
          </Reveal>

          {/* La LISTA de documentos vive en su pantalla dedicada (row "Documentos" abajo), fiel al frame
              C/Perfil: acá NO se expande inline. Eliminar la lista inline además cerró el bug de keys
              duplicadas (dos docs con el mismo `type`, p. ej. dos SOAT, colisionaban en `key={doc.type}`). */}

          {/* Accesos en SECCIONES con label (espejo del "Tu cuenta" del passenger, que es el patrón
              aprobado): antes era UN bloque monolítico de 8 filas sin jerarquía. Íconos en accent
              (mismo tratamiento que el passenger), filas ListItem canónicas del ui-kit. */}
          <Reveal delay={160}>
            <Text variant="label" color="inkMuted" style={styles.sectionLabel}>
              {t('profile.sectionAccount')}
            </Text>
            <ListGroup>
              <ListItem
                title={t('profile.edit.entry')}
                leading={<IconAccount size={20} color={theme.colors.accent} />}
                chevron
                onPress={() => navigation.navigate('EditProfile')}
              />
              {/* Avisos: el acceso vive acá (el header del Inicio ya no tiene campana, fiel al frame). */}
              <ListItem
                title={t('notifications.title')}
                leading={<IconBell size={20} color={theme.colors.accent} />}
                chevron
                onPress={() => navigation.navigate('Notifications')}
              />
              {/* Derecho al olvido (Ley 29733): SIEMPRE al final de la sección Cuenta, con el mismo
                  lenguaje que el pasajero (ícono danger + sheet de confirmación con la gracia). */}
              <ListItem
                title={t('profile.deletion.entry')}
                leading={<IconTrash size={20} color={theme.colors.danger} />}
                chevron
                onPress={() => setDeletionOpen(true)}
              />
            </ListGroup>
          </Reveal>

          <Reveal delay={200}>
            <Text variant="label" color="inkMuted" style={styles.sectionLabel}>
              {t('profile.sectionVerification')}
            </Text>
            <ListGroup>
              <ListItem
                title={t('documents.title')}
                leading={<IconDocument size={20} color={theme.colors.accent} />}
                chevron
                onPress={() => navigation.navigate('Documents')}
              />
              <ListItem
                title={t('shift.enrollAction')}
                leading={<IconFace size={20} color={theme.colors.accent} />}
                chevron
                onPress={() => navigation.navigate('BiometricEnroll')}
              />
            </ListGroup>
          </Reveal>

          <Reveal delay={240}>
            <Text variant="label" color="inkMuted" style={styles.sectionLabel}>
              {t('profile.sectionActivity')}
            </Text>
            <ListGroup>
              <ListItem
                title={t('earnings.title')}
                leading={<IconReceipt size={20} color={theme.colors.accent} />}
                chevron
                onPress={() => navigation.navigate('Ganancias')}
              />
              <ListItem
                title={t('ops.incentives.title')}
                leading={<IconGift size={20} color={theme.colors.accent} />}
                chevron
                onPress={() => navigation.navigate('Incentives')}
              />
              <ListItem
                title={t('trips.historyTitle')}
                leading={<IconClock size={20} color={theme.colors.accent} />}
                chevron
                onPress={() => navigation.navigate('Viajes')}
              />
            </ListGroup>
          </Reveal>

          <Reveal delay={280}>
            <Text variant="label" color="inkMuted" style={styles.sectionLabel}>
              {t('profile.sectionSupport')}
            </Text>
            <ListGroup>
              <ListItem
                title={t('support.title')}
                leading={<IconLifebuoy size={20} color={theme.colors.accent} />}
                chevron
                onPress={() => navigation.navigate('Support')}
              />
            </ListGroup>
          </Reveal>

          {/* Cerrar sesión: pill de ancho completo con TINTE danger (no un botón rojo sólido) — presencia
              serena para una acción destructiva-suave, fiel al frame C/Perfil. */}
          <Reveal delay={240}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('profile.logout')}
              disabled={logout.isPending}
              onPress={() => setConfirmOpen(true)}
              style={({ pressed }) => [
                styles.logout,
                {
                  backgroundColor: theme.colors.danger + '14',
                  borderRadius: theme.radii.md,
                },
                pressed && styles.logoutPressed,
                logout.isPending && styles.logoutDisabled,
              ]}
            >
              <IconLogout size={20} color={theme.colors.danger} strokeWidth={2} />
              <Text variant="bodyStrong" color="danger">
                {t('profile.logout')}
              </Text>
            </Pressable>
          </Reveal>
        </View>
      )}

      <BottomSheet
        visible={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t('profile.logoutConfirmTitle')}
        footer={
          <View style={styles.sheetFooter}>
            <Button
              label={t('common.cancel')}
              variant="secondary"
              onPress={() => setConfirmOpen(false)}
            />
            <Button
              label={t('profile.logout')}
              variant="danger"
              onPress={() => {
                setConfirmOpen(false);
                logout.mutate();
              }}
            />
          </View>
        }
      >
        <Text variant="callout" color="inkMuted">
          {t('profile.logoutConfirmBody')}
        </Text>
      </BottomSheet>

      {/* Derecho al olvido (Ley 29733). Confirmación → 202 con la gracia → banner de estado y cierre
          de sesión (la cuenta queda en gracia; se puede cancelar volviendo a ingresar antes de la fecha). */}
      <BottomSheet
        visible={deletionOpen}
        onClose={() => {
          setDeletionOpen(false);
          // Si la solicitud ya quedó registrada, cerrar el sheet también cierra la sesión: la app no
          // debe seguir operando como si nada sobre una cuenta camino al tombstone.
          if (deletion.isSuccess && !logout.isPending) {
            logout.mutate();
          }
        }}
        title={t('profile.deletion.title')}
        footer={
          deletion.isSuccess ? (
            <Button
              label={t('profile.deletion.logoutCta')}
              variant="primary"
              loading={logout.isPending}
              onPress={() => logout.mutate()}
            />
          ) : (
            <View style={styles.sheetFooter}>
              <Button
                label={t('profile.deletion.keep')}
                variant="secondary"
                onPress={() => setDeletionOpen(false)}
              />
              <Button
                label={t('profile.deletion.confirm')}
                variant="danger"
                loading={deletion.isPending}
                onPress={() => deletion.mutate()}
              />
            </View>
          )
        }
      >
        <View style={styles.deletionBody}>
          {deletion.isSuccess ? (
            <Banner
              tone="success"
              title={t('profile.deletion.requested')}
              description={t('profile.deletion.graceUntil', {
                date: formatShortDate(deletion.data.graceUntil),
              })}
            />
          ) : (
            <Text variant="callout" color="inkMuted">
              {t('profile.deletion.body')}
            </Text>
          )}
          {deletion.isError ? <Banner tone="danger" title={t('profile.deletion.error')} /> : null}
        </View>
      </BottomSheet>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  section: { gap: 16, paddingTop: 8 },
  sectionLabel: { marginBottom: 8 },
  sheetFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  deletionBody: { gap: 12 },
  logout: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 52,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  logoutPressed: { opacity: 0.7 },
  logoutDisabled: { opacity: 0.5 },
});
