import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, Switch, Text, TextField, useTheme } from '@veo/ui-kit';
import { carpoolModoReserva, type PlaceSuggestion } from '@veo/api-client';
import type { RootStackParamList } from '../../../../navigation/types';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { DateTimeField } from '../../../../shared/presentation/components/DateTimeField';
import { Stepper } from '../../../../shared/presentation/components/Stepper';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { useActiveVehicle } from '../hooks/useActiveVehicle';
import { usePublishTrip } from '../hooks/useCarpool';
import { PlaceAutocompleteField } from '../components/PlaceAutocompleteField';

type Props = NativeStackScreenProps<RootStackParamList, 'CarpoolPublish'>;

/**
 * Form de PUBLICAR un viaje compartido (carpooling, BlaBlaCar-style). Arma el `PublishTripRequest` y llama a
 * `usePublishTrip()`. El precio va en céntimos server-authoritative; el TOPE anti-lucro lo valida el server
 * (post-and-reject: si excede, el 400 vuelve con el máximo → lo mostramos en un Banner). Chrome jade/editorial.
 */
export const CarpoolPublishScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const activeVehicle = useActiveVehicle();
  const publish = usePublishTrip();

  const [origin, setOrigin] = useState<PlaceSuggestion | null>(null);
  const [dest, setDest] = useState<PlaceSuggestion | null>(null);
  const [when, setWhen] = useState('');
  const [seats, setSeats] = useState(2);
  const [price, setPrice] = useState('');
  // true = el conductor revisa cada solicitud; false = reserva instantánea (auto-aprobada).
  const [revisar, setRevisar] = useState(true);
  const [reglas, setReglas] = useState('');

  const vehicleId = activeVehicle.data?.id ?? null;
  const priceCents = Math.round(Number(price.replace(',', '.')) * 100);
  const canSubmit =
    !!origin &&
    !!dest &&
    !!when &&
    !!vehicleId &&
    seats >= 1 &&
    Number.isFinite(priceCents) &&
    priceCents > 0;

  const onPublish = (): void => {
    if (!origin || !dest || !vehicleId) {
      return;
    }
    publish.mutate(
      {
        vehicleId,
        origenLat: origin.lat,
        origenLon: origin.lng,
        destinoLat: dest.lat,
        destinoLon: dest.lng,
        stopovers: [],
        fechaHoraSalida: when,
        asientosTotales: seats,
        precioBase: priceCents,
        precioPorTramo: [],
        modoReserva: revisar
          ? carpoolModoReserva.enum.REVISION_CADA_SOLICITUD
          : carpoolModoReserva.enum.INSTANT_BOOKING,
        reglas: reglas.trim() || undefined,
      },
      { onSuccess: () => navigation.goBack() },
    );
  };

  return (
    <SafeScreen
      scroll
      header={<TopBar title={t('carpool.publishTitle')} onBack={navigation.goBack} />}
      footer={
        <Button
          label={t('carpool.publishSubmit')}
          variant="accent"
          fullWidth
          disabled={!canSubmit}
          loading={publish.isPending}
          onPress={onPublish}
        />
      }
    >
      <View style={styles.body}>
        {publish.isError ? (
          <Reveal>
            <Banner
              tone="danger"
              title={t('carpool.publishError')}
              description={toErrorMessage(publish.error, t)}
            />
          </Reveal>
        ) : null}

        {/* Ruta */}
        <Reveal delay={20} style={styles.group}>
          <Text variant="subhead" color="inkMuted">
            {t('carpool.routeSection')}
          </Text>
          <PlaceAutocompleteField
            label={t('carpool.origin')}
            placeholder={t('carpool.originPlaceholder')}
            onSelect={setOrigin}
          />
          <PlaceAutocompleteField
            label={t('carpool.destination')}
            placeholder={t('carpool.destinationPlaceholder')}
            onSelect={setDest}
          />
        </Reveal>

        {/* Cuándo + capacidad */}
        <Reveal delay={60} style={styles.group}>
          <Text variant="subhead" color="inkMuted">
            {t('carpool.whenSection')}
          </Text>
          <DateTimeField
            label={t('carpool.departure')}
            placeholder={t('carpool.departurePlaceholder')}
            value={when}
            onChange={setWhen}
            minimumDate={new Date()}
          />
          <View
            style={[
              styles.card,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
            ]}
          >
            <Stepper label={t('carpool.seats')} value={seats} onChange={setSeats} min={1} max={8} />
          </View>
        </Reveal>

        {/* Precio */}
        <Reveal delay={100} style={styles.group}>
          <Text variant="subhead" color="inkMuted">
            {t('carpool.priceSection')}
          </Text>
          <TextField
            label={t('carpool.pricePerSeat')}
            placeholder="S/ 0"
            value={price}
            onChangeText={setPrice}
            keyboardType="number-pad"
            inputMode="numeric"
            helperText={t('carpool.priceHint')}
          />
        </Reveal>

        {/* Modo de reserva + reglas */}
        <Reveal delay={140} style={styles.group}>
          <View
            style={[
              styles.card,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
            ]}
          >
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text variant="body">{t('carpool.reviewEach')}</Text>
                <Text variant="footnote" color="inkMuted">
                  {revisar ? t('carpool.reviewEachOn') : t('carpool.reviewEachOff')}
                </Text>
              </View>
              <Switch value={revisar} onValueChange={setRevisar} />
            </View>
          </View>
          <TextField
            label={t('carpool.rules')}
            placeholder={t('carpool.rulesPlaceholder')}
            value={reglas}
            onChangeText={setReglas}
            multiline
          />
        </Reveal>
      </View>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  body: { gap: 24, paddingTop: 8, paddingBottom: 16 },
  group: { gap: 12 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 16 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  switchText: { flex: 1, gap: 2 },
});
