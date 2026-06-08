import { useNavigation } from '@react-navigation/native';
import { Banner, Button, SafeScreen, StatusPill, Text, TextField, useTheme } from '@veo/ui-kit';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch, View } from 'react-native';
import { isValidChildCode } from '../../domain/entities';
import { useChildModeStore } from '../stores/childModeStore';

/**
 * Configura el Modo Niño que viaja en `POST /trips` (`childMode`/`childCode`). El código (4-6
 * dígitos) se guarda solo en memoria (nunca en disco ni visible al conductor: el bff valida un hash).
 * Al guardar, el estado queda disponible para la próxima solicitud de viaje en Home.
 */
export function ChildModeScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation();
  const store = useChildModeStore();

  const [enabled, setEnabled] = useState(store.enabled);
  const [code, setCode] = useState(store.code);
  const [touched, setTouched] = useState(false);

  const codeValid = isValidChildCode(code);
  const canSave = !enabled || codeValid;

  const save = () => {
    if (enabled && !codeValid) {
      setTouched(true);
      return;
    }
    store.setEnabled(enabled);
    store.setCode(enabled ? code : '');
    navigation.goBack();
  };

  return (
    <SafeScreen
      footer={<Button label={t('actions.save')} fullWidth disabled={!canSave} onPress={save} />}
    >
      <Text variant="callout" color="inkMuted" style={{ marginBottom: theme.spacing.lg }}>
        {t('childMode.subtitle')}
      </Text>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: theme.spacing.lg }}>
        <Text variant="bodyStrong">{t('childMode.enable')}</Text>
        <Switch
          value={enabled}
          onValueChange={setEnabled}
          trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
          thumbColor={theme.colors.surface}
        />
      </View>

      <View style={{ marginBottom: theme.spacing.lg }}>
        <StatusPill
          label={enabled ? t('childMode.active') : t('childMode.inactive')}
          tone={enabled ? 'safe' : 'neutral'}
          dot
        />
      </View>

      {enabled ? (
        <TextField
          label={t('childMode.codeLabel')}
          helperText={t('childMode.codeHelper')}
          keyboardType="number-pad"
          secureTextEntry
          value={code}
          onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))}
          maxLength={6}
          error={touched && !codeValid ? t('childMode.invalidCode') : undefined}
        />
      ) : null}

      <Banner tone="info" title={t('childMode.explanation')} style={{ marginTop: theme.spacing.xl }} />
    </SafeScreen>
  );
}
