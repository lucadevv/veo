import React from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button, SafeScreen } from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { NoticeHero } from '../../../../shared/presentation/components/NoticeHero';
import { IconMapPinOff } from '../../../../shared/presentation/icons';

type Props = NativeStackScreenProps<RootStackParamList, 'LocationPermission'>;

/**
 * Pantalla dedicada de permiso de ubicación (frame `C/Permiso-Ubicacion`): se presenta cuando el
 * conductor intenta conectarse con el permiso de GPS denegado. Sin ubicación, el dispatch no lo ve
 * ni puede asignarle viajes. "Abrir Ajustes" lleva al SO (único lugar donde se re-otorga el permiso
 * si el usuario lo negó de forma permanente); "Ahora no" vuelve al dashboard.
 */
export const LocationPermissionScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();

  return (
    <SafeScreen
      footer={
        <View style={styles.footer}>
          <Button
            label={t('shift.locationPermission.openSettings')}
            variant="primary"
            fullWidth
            onPress={() => {
              Linking.openSettings().catch(() => undefined);
            }}
          />
          <Button
            label={t('shift.locationPermission.notNow')}
            variant="ghost"
            fullWidth
            onPress={() => navigation.goBack()}
          />
        </View>
      }
    >
      <NoticeHero
        tone="warn"
        icon={({ size, color }) => <IconMapPinOff size={size} color={color} strokeWidth={2} />}
        title={t('shift.locationPermission.title')}
        description={t('shift.locationPermission.body')}
      />
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  footer: { gap: 8 },
});
