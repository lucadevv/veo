import {SafeScreen, spacing, Text} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';

/**
 * Hub de Seguridad (tab del bottom nav, fuente: design/veo.pen P/Seguridad). STUB del Lote 1: la
 * pantalla completa (pánico, contactos de confianza, modo niño, KYC) se migra en un lote posterior.
 * Degradación honesta: anuncia lo que viene, no muestra data falsa.
 */
export function SeguridadScreen(): React.JSX.Element {
  const {t} = useTranslation();
  return (
    <SafeScreen>
      <View style={styles.wrap}>
        <Text variant="title1">{t('tabs.seguridad')}</Text>
        <Text variant="body" color="inkMuted" style={styles.note}>
          {t('security.hubComingSoon')}
        </Text>
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, paddingTop: spacing['3xl'], gap: spacing.sm},
  note: {},
});
