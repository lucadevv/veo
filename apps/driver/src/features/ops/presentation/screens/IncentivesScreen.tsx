import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  BottomSheet,
  hexAlpha,
  IconButton,
  SafeScreen,
  Skeleton,
  Text,
  useTheme,
} from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { StateView } from '../../../../shared/presentation/components/StateView';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { IconMore } from '../../../../shared/presentation/icons';
import { formatPEN } from '../../../../shared/presentation/format';
import { incentiveState, isMultiplierIncentive } from '../../domain';
import { useIncentives } from '../hooks/useOps';
import { IncentiveCard } from '../components/IncentiveCard';
import { Reveal } from '../../../../shared/presentation/components/motion';

type Props = NativeStackScreenProps<RootStackParamList, 'Incentives'>;

/**
 * Pantalla de Incentivos (frame `C/Incentivos`): hero con el total extra por completar los retos +
 * la lista de incentivos activos (cards compactas). El ⋯ abre "¿Cómo funcionan?". Cuatro estados
 * (carga/error/vacío/lista). Datos server-authoritative de `/incentives` (seam del driver-bff).
 */
export const IncentivesScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { data, isLoading, isError, error, refetch } = useIncentives();
  const [howOpen, setHowOpen] = useState(false);

  const header = (
    <TopBar
      title={t('ops.incentives.title')}
      onBack={navigation.goBack}
      trailing={
        <IconButton
          accessibilityLabel={t('ops.incentives.howTitle')}
          variant="surface"
          icon={<IconMore size={20} color={theme.colors.ink} />}
          onPress={() => setHowOpen(true)}
        />
      }
    />
  );

  const howSheet = (
    <BottomSheet
      visible={howOpen}
      onClose={() => setHowOpen(false)}
      title={t('ops.incentives.howTitle')}
    >
      <Text variant="callout" color="inkMuted">
        {t('ops.incentives.howBody')}
      </Text>
    </BottomSheet>
  );

  if (isLoading) {
    return (
      <SafeScreen header={header}>
        <View style={[styles.list, { gap: theme.spacing.lg }]}>
          <Skeleton height={72} radius={theme.radii.lg} />
          <Skeleton height={110} radius={theme.radii.lg} />
          <Skeleton height={110} radius={theme.radii.lg} />
        </View>
        {howSheet}
      </SafeScreen>
    );
  }

  if (isError || !data) {
    return (
      <SafeScreen header={header}>
        <StateView
          title={t('errors.generic')}
          description={toErrorMessage(error, t)}
          action={{ label: t('common.retry'), onPress: () => refetch() }}
        />
        {howSheet}
      </SafeScreen>
    );
  }

  if (data.length === 0) {
    return (
      <SafeScreen header={header}>
        <StateView
          title={t('ops.incentives.emptyTitle')}
          description={t('ops.incentives.emptyBody')}
        />
        {howSheet}
      </SafeScreen>
    );
  }

  // Total potencial: suma de bonos en soles de los META_VIAJES no vencidos (el multiplicador no es
  // un monto fijo, así que no entra al total).
  const totalCents = data
    .filter((incentive) => !isMultiplierIncentive(incentive.type) && incentiveState(incentive) !== 'expired')
    .reduce((sum, incentive) => sum + incentive.rewardCents, 0);

  return (
    <SafeScreen scroll header={header}>
      <View style={[styles.list, { gap: theme.spacing.lg, paddingBottom: theme.spacing['3xl'] }]}>
        {/* Hero: total extra por completar los retos activos (frame C/Incentivos). */}
        <Reveal
          style={[
            styles.hero,
            {
              backgroundColor: hexAlpha(theme.colors.accent, 0.12),
              borderColor: hexAlpha(theme.colors.accent, 0.4),
              borderRadius: theme.radii.xl,
              padding: theme.spacing.xl,
              gap: theme.spacing.xs,
            },
          ]}
        >
          <Text variant="title3">
            {t('ops.incentives.heroTitle', { amount: formatPEN(totalCents) })}
          </Text>
          <Text variant="footnote" color="inkMuted">
            {t('ops.incentives.heroBody')}
          </Text>
        </Reveal>

        {data.map((incentive, index) => (
          <Reveal key={incentive.id} delay={index * 70}>
            <IncentiveCard incentive={incentive} />
          </Reveal>
        ))}
      </View>
      {howSheet}
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  list: { paddingTop: 8 },
  hero: { alignSelf: 'stretch', borderWidth: StyleSheet.hairlineWidth },
});
