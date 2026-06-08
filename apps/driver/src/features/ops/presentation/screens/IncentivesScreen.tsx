import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {Banner, SafeScreen, Skeleton, Text, useTheme} from '@veo/ui-kit';
import type {RootStackParamList} from '../../../../navigation/types';
import {StateView} from '../../../../shared/presentation/components/StateView';
import {TopBar} from '../../../../shared/presentation/components/TopBar';
import {toErrorMessage} from '../../../../shared/presentation/errors';
import {useIncentives} from '../hooks/useOps';
import {IncentiveCard} from '../components/IncentiveCard';
import {Appear} from '../components/motion';

type Props = NativeStackScreenProps<RootStackParamList, 'Incentives'>;

/**
 * Pantalla de Incentivos: lista los incentivos activos del conductor (ya ordenados activo →
 * completado → vencido en el caso de uso) con su progreso/recompensa/vigencia. Diseño motivador
 * pero sobrio (modo noche). Accesible desde Perfil y desde el Dashboard.
 */
export const IncentivesScreen = ({navigation}: Props): React.JSX.Element => {
  const {t} = useTranslation();
  const theme = useTheme();
  const {data, isLoading, isError, error, refetch} = useIncentives();

  const header = <TopBar title={t('ops.incentives.title')} onBack={navigation.goBack} />;

  if (isLoading) {
    return (
      <SafeScreen header={header}>
        <View style={[styles.list, {gap: theme.spacing.lg}]}>
          <Skeleton height={180} radius={theme.radii.xl} />
          <Skeleton height={180} radius={theme.radii.xl} />
        </View>
      </SafeScreen>
    );
  }

  if (isError || !data) {
    return (
      <SafeScreen header={header}>
        <StateView
          title={t('errors.generic')}
          description={toErrorMessage(error, t)}
          action={{label: t('common.retry'), onPress: () => refetch()}}
        />
      </SafeScreen>
    );
  }

  if (data.length === 0) {
    return (
      <SafeScreen header={header}>
        <StateView title={t('ops.incentives.emptyTitle')} description={t('ops.incentives.emptyBody')} />
      </SafeScreen>
    );
  }

  return (
    <SafeScreen scroll header={header}>
      <View style={[styles.list, {gap: theme.spacing.lg, paddingBottom: theme.spacing['3xl']}]}>
        <Banner tone="info" title={t('ops.incentives.intro')} />
        <Text variant="footnote" color="inkSubtle">
          {t('ops.incentives.activeCount', {count: data.length})}
        </Text>
        {data.map((incentive, index) => (
          <Appear key={incentive.id} delay={index * 70}>
            <IncentiveCard incentive={incentive} />
          </Appear>
        ))}
      </View>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  list: {paddingTop: 8},
});
