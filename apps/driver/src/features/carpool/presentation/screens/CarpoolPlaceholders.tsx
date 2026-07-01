import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeScreen, Text, useTheme } from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { IconCarpool } from '../../../../shared/presentation/icons';

/**
 * Placeholders HONESTOS (foundation del tab Compartir). El formulario de publicar (ruta + fecha + asientos +
 * precio con tope anti-lucro) y la gestión de solicitudes (aprobar/rechazar) son los próximos lotes de taste.
 * Degradación honesta: NO fingimos un form que no existe — anunciamos "en construcción".
 */
function ComingSoon({
  title,
  body,
  onBack,
}: {
  title: string;
  body: string;
  onBack: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <SafeScreen scroll header={<TopBar title={title} onBack={onBack} />}>
      <Reveal style={styles.wrap}>
        <View style={[styles.icon, { backgroundColor: theme.colors.surface }]}>
          <IconCarpool size={38} color={theme.colors.accent} strokeWidth={1.8} />
        </View>
        <Text variant="title3" align="center">
          {title}
        </Text>
        <Text variant="callout" color="inkMuted" align="center">
          {body}
        </Text>
      </Reveal>
    </SafeScreen>
  );
}

export const CarpoolTripBookingsScreen = ({
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'CarpoolTripBookings'>): React.JSX.Element => {
  const { t } = useTranslation();
  return (
    <ComingSoon
      title={t('carpool.requestsTitle')}
      body={t('carpool.comingSoonBody')}
      onBack={navigation.goBack}
    />
  );
};

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 10, paddingTop: 48 },
  icon: {
    width: 76,
    height: 76,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
});
