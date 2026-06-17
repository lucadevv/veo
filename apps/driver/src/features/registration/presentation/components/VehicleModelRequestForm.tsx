import React, {useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {Banner, Button, Text, TextField, useTheme} from '@veo/ui-kit';
import {toErrorMessage} from '../../../../shared/presentation/errors';
import {useRequestVehicleModel} from '../hooks/useRegistrationWizard';
import type {VehicleType} from '../../domain';

interface VehicleModelRequestFormProps {
  /** Tipo elegido en el selector: se envía con la solicitud (el form no lo re-pregunta). */
  vehicleType: VehicleType;
  /** Se llama al confirmarse la solicitud (queda en revisión). */
  onDone: () => void;
  onCancel: () => void;
}

const CURRENT_YEAR = new Date().getUTCFullYear();
const MIN_YEAR = 1990;

/**
 * Form para SOLICITAR un modelo que no está en el catálogo (B5-2.c). El conductor ingresa solo lo que
 * conoce (marca, modelo, rango de años, asientos); el operador completa la ficha técnica al aprobar. Al
 * enviarse, el modelo queda PENDING_REVIEW y NO se puede elegir aún — se le avisa con honestidad.
 */
export function VehicleModelRequestForm({
  vehicleType,
  onDone,
  onCancel,
}: VehicleModelRequestFormProps): React.JSX.Element {
  const {t} = useTranslation();
  const theme = useTheme();
  const request = useRequestVehicleModel();

  const [form, setForm] = useState({make: '', model: '', yearFrom: '', yearTo: '', seats: ''});
  const [error, setError] = useState<unknown>(null);
  const [submitted, setSubmitted] = useState(false);

  const yearFrom = Number(form.yearFrom);
  const yearTo = Number(form.yearTo);
  const seats = Number(form.seats);
  const valid =
    form.make.trim().length > 0 &&
    form.model.trim().length > 0 &&
    Number.isInteger(yearFrom) && yearFrom >= MIN_YEAR && yearFrom <= CURRENT_YEAR + 1 &&
    Number.isInteger(yearTo) && yearTo >= yearFrom && yearTo <= CURRENT_YEAR + 1 &&
    Number.isInteger(seats) && seats >= 1 && seats <= 20;

  const submit = async () => {
    if (!valid || request.isPending) {
      return;
    }
    setError(null);
    try {
      await request.mutateAsync({
        make: form.make.trim(),
        model: form.model.trim(),
        yearFrom,
        yearTo,
        vehicleType,
        seats,
      });
      setSubmitted(true);
    } catch (e) {
      setError(e);
    }
  };

  if (submitted) {
    return (
      <View style={[styles.body, styles.success, {gap: theme.spacing.md}]}>
        <Text variant="title3" align="center">
          {t('registration.vehicle.modelRequestSentTitle')}
        </Text>
        <Text variant="callout" color="inkMuted" align="center">
          {t('registration.vehicle.modelRequestSentBody')}
        </Text>
        <Button label={t('common.gotIt')} variant="accent" fullWidth onPress={onDone} />
      </View>
    );
  }

  const update = (patch: Partial<typeof form>) => setForm(f => ({...f, ...patch}));

  return (
    <View style={[styles.body, {gap: theme.spacing.md}]}>
      <Text variant="footnote" color="inkMuted">
        {t('registration.vehicle.modelRequestHint')}
      </Text>

      <TextField
        label={t('registration.vehicle.modelRequestMake')}
        value={form.make}
        onChangeText={text => update({make: text})}
        autoCapitalize="words"
        autoCorrect={false}
      />
      <TextField
        label={t('registration.vehicle.modelRequestModel')}
        value={form.model}
        onChangeText={text => update({model: text})}
        autoCorrect={false}
      />
      <View style={[styles.row, {gap: theme.spacing.md}]}>
        <View style={styles.flex}>
          <TextField
            label={t('registration.vehicle.modelRequestYearFrom')}
            value={form.yearFrom}
            onChangeText={text => update({yearFrom: text})}
            keyboardType="number-pad"
            maxLength={4}
          />
        </View>
        <View style={styles.flex}>
          <TextField
            label={t('registration.vehicle.modelRequestYearTo')}
            value={form.yearTo}
            onChangeText={text => update({yearTo: text})}
            keyboardType="number-pad"
            maxLength={4}
          />
        </View>
      </View>
      <TextField
        label={t('registration.vehicle.modelRequestSeats')}
        value={form.seats}
        onChangeText={text => update({seats: text})}
        keyboardType="number-pad"
        maxLength={2}
      />

      {error ? (
        <Banner tone="danger" title={t('errors.generic')} description={toErrorMessage(error, t)} />
      ) : null}

      <View style={[styles.actions, {gap: theme.spacing.md}]}>
        <Button label={t('common.cancel')} variant="secondary" onPress={onCancel} />
        <Button
          label={t('registration.vehicle.modelRequestSubmit')}
          variant="accent"
          loading={request.isPending}
          disabled={!valid}
          onPress={submit}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {paddingBottom: 8},
  success: {alignItems: 'center', paddingVertical: 24},
  row: {flexDirection: 'row'},
  flex: {flex: 1},
  actions: {flexDirection: 'row', justifyContent: 'flex-end'},
});
