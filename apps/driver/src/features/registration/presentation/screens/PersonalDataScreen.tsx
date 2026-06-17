import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { IconAccount, IconCalendar, IconDocument } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import type { RegistrationStackParamList } from '../../../../navigation/types';
import { PersonalDataValidationError, type PersonalDataErrors } from '../../domain';
import { useRegistrationStore } from '../state/registrationStore';
import { useUpdatePersonalData } from '../hooks/useRegistrationWizard';
import { RegistrationField, RegistrationHeader, RegistrationProgress } from '../components';

type Props = NativeStackScreenProps<RegistrationStackParamList, 'PersonalData'>;

/** Paso 1 del alta: datos personales como aparecen en el DNI (drv-04). PATCH /drivers/me/personal. */
export const PersonalDataScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const personal = useRegistrationStore((s) => s.personal);
  const setPersonal = useRegistrationStore((s) => s.setPersonal);
  const setCurrentStep = useRegistrationStore((s) => s.setCurrentStep);
  const updatePersonalData = useUpdatePersonalData();

  // Errores de validación por campo (códigos del dominio → mensajes) y error de servidor.
  const [errors, setErrors] = useState<PersonalDataErrors>({});
  const [serverError, setServerError] = useState<unknown>(null);

  const canContinue =
    personal.fullName.trim().length > 0 &&
    personal.dni.trim().length > 0 &&
    personal.birthdate.trim().length > 0;

  /** Actualiza un campo y limpia su error (validación inline al editar). */
  const update = (patch: Partial<typeof personal>, field: keyof PersonalDataErrors) => {
    setPersonal(patch);
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  const onContinue = async () => {
    if (updatePersonalData.isPending) {
      return;
    }
    setErrors({});
    setServerError(null);
    try {
      await updatePersonalData.mutateAsync(personal);
      setCurrentStep(2);
      navigation.navigate('Vehicle');
    } catch (e) {
      // Errores de validación de cliente → junto a cada campo; el resto → banner de servidor.
      if (e instanceof PersonalDataValidationError) {
        setErrors(e.errors);
      } else {
        setServerError(e);
      }
    }
  };

  /** Traduce un código de error de campo a su mensaje (o `undefined` si no hay error). */
  const fieldError = (field: keyof PersonalDataErrors): string | undefined => {
    const code = errors[field];
    return code ? t(`registration.personal.errors.${code}`) : undefined;
  };

  return (
    <SafeScreen
      scroll
      header={<RegistrationHeader showLogo wings peru />}
      footer={
        <Button
          label={t('common.continue')}
          variant="accent"
          fullWidth
          loading={updatePersonalData.isPending}
          disabled={!canContinue}
          onPress={onContinue}
        />
      }
    >
      <View style={[styles.body, { gap: theme.spacing.xl }]}>
        <Reveal>
          <RegistrationProgress current={1} />
        </Reveal>

        <Reveal delay={40}>
          <Text variant="caption" color="inkMuted" align="center">
            {t('registration.stepOf', { current: 1, total: 4 })}
          </Text>
        </Reveal>

        <Reveal delay={80} style={styles.intro}>
          <Text variant="title1">{t('registration.personal.title')}</Text>
          <Text variant="callout" color="inkMuted">
            {t('registration.personal.subtitle')}
          </Text>
        </Reveal>

        {serverError ? (
          <Reveal>
            <Banner
              tone="danger"
              title={t('errors.generic')}
              description={toErrorMessage(serverError, t)}
            />
          </Reveal>
        ) : null}

        <View style={[styles.form, { gap: theme.spacing.lg }]}>
          <Reveal delay={120} from="scale">
            <RegistrationField
              label={t('registration.personal.nameLabel')}
              placeholder={t('registration.personal.namePlaceholder')}
              value={personal.fullName}
              onChangeText={(text) => update({ fullName: text }, 'fullName')}
              autoCapitalize="words"
              textContentType="name"
              error={fieldError('fullName')}
              rightIcon={<IconAccount size={24} color={theme.colors.accent} strokeWidth={1.8} />}
            />
          </Reveal>

          <Reveal delay={160} from="scale">
            <RegistrationField
              label={t('registration.personal.dniLabel')}
              placeholder={t('registration.personal.dniPlaceholder')}
              value={personal.dni}
              onChangeText={(text) => update({ dni: text }, 'dni')}
              keyboardType="number-pad"
              maxLength={11}
              error={fieldError('dni')}
              rightIcon={<IconDocument size={24} color={theme.colors.accent} strokeWidth={1.8} />}
            />
          </Reveal>

          <Reveal delay={200} from="scale">
            <RegistrationField
              label={t('registration.personal.birthdateLabel')}
              placeholder={t('registration.personal.birthdatePlaceholder')}
              value={personal.birthdate}
              onChangeText={(text) => update({ birthdate: text }, 'birthdate')}
              keyboardType="number-pad"
              maxLength={14}
              error={fieldError('birthdate')}
              rightIcon={<IconCalendar size={24} color={theme.colors.accent} strokeWidth={1.8} />}
            />
          </Reveal>
        </View>
      </View>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  body: { paddingTop: 12 },
  intro: { gap: 6 },
  form: {},
});
