import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  Banner,
  BottomSheet,
  Button,
  Card,
  ListItem,
  SafeScreen,
  Skeleton,
  StatusPill,
  Text,
  useTheme,
} from '@veo/ui-kit';
import { DriverStatus } from '@veo/shared-types';
import type { MainTabParamList, RootStackParamList } from '../../../../navigation/types';
import { StateView } from '../../../../shared/presentation/components/StateView';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { formatPersonName } from '../../../../shared/presentation/format';
import {
  IconClock,
  IconDocument,
  IconGift,
  IconLifebuoy,
  IconReceipt,
  IconShield,
} from '../../../../shared/presentation/icons';
import { useLogout, useProfile } from '../hooks/useProfile';
import { BACKGROUND_CHECK_CLEARED, KYC_VERIFIED, enumLabel } from '../labels';
import { ProfileIdentityCard } from '../components/ProfileIdentityCard';
import { ProfileLinkRow } from '../components/ProfileLinkRow';
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
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <SafeScreen scroll>
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

          {/* Estados de verificación (KYC / antecedentes / estado actual) con StatusPill real. */}
          <Reveal delay={120}>
            <Text variant="subhead" color="inkMuted" style={styles.sectionLabel}>
              {t('profile.kyc')}
            </Text>
            <Card>
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
            </Card>
          </Reveal>

          {/* Documentos como lista. */}
          <Reveal delay={160}>
            <Text variant="subhead" color="inkMuted" style={styles.sectionLabel}>
              {t('profile.documentsTitle')}
            </Text>
            <Card>
              {data.documents.length === 0 ? (
                <Text variant="callout" color="inkMuted">
                  {t('profile.noDocuments')}
                </Text>
              ) : (
                data.documents.map((doc) => (
                  <ListItem
                    key={doc.type}
                    title={enumLabel(t, 'profile.docType', doc.type)}
                    subtitle={enumLabel(t, 'profile.docStatus', doc.status)}
                    trailing={
                      <StatusPill
                        label={doc.ok ? t('profile.documentValid') : t('profile.documentInvalid')}
                        tone={doc.ok ? 'success' : 'danger'}
                        dot
                      />
                    }
                  />
                ))
              )}
            </Card>
          </Reveal>

          {/* Accesos rápidos: documentos + biometría (stack) + tabs Ganancias/Viajes. */}
          <Reveal delay={200}>
            <Card padding="sm">
              <ProfileLinkRow
                icon={<IconDocument size={20} color={theme.colors.accent} />}
                label={t('documents.title')}
                onPress={() => navigation.navigate('Documents')}
                showDivider
              />
              <ProfileLinkRow
                icon={<IconShield size={20} color={theme.colors.accent} />}
                label={t('shift.enrollAction')}
                onPress={() => navigation.navigate('BiometricEnroll')}
                showDivider
              />
              <ProfileLinkRow
                icon={<IconReceipt size={20} color={theme.colors.accent} />}
                label={t('earnings.title')}
                onPress={() => navigation.navigate('Ganancias')}
                showDivider
              />
              <ProfileLinkRow
                icon={<IconGift size={20} color={theme.colors.accent} />}
                label={t('ops.incentives.title')}
                onPress={() => navigation.navigate('Incentives')}
                showDivider
              />
              <ProfileLinkRow
                icon={<IconClock size={20} color={theme.colors.accent} />}
                label={t('trips.historyTitle')}
                onPress={() => navigation.navigate('Viajes')}
                showDivider
              />
              <ProfileLinkRow
                icon={<IconLifebuoy size={20} color={theme.colors.accent} />}
                label={t('support.title')}
                onPress={() => navigation.navigate('Support')}
              />
            </Card>
          </Reveal>

          <Reveal delay={240}>
            <Button
              label={t('profile.logout')}
              variant="danger"
              fullWidth
              loading={logout.isPending}
              onPress={() => setConfirmOpen(true)}
            />
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
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  section: { gap: 16, paddingTop: 8 },
  sectionLabel: { marginBottom: 8 },
  sheetFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
});
