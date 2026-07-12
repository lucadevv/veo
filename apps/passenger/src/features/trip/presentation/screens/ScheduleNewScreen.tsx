import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {Button, Card, SafeScreen, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, StyleSheet, View} from 'react-native';
import {useRideDraftStore} from '../../../maps/presentation';
import type {RootStackParamList} from '../../../../navigation/types';
import {ScreenHeader} from '../../../../shared/presentation/components/ScreenHeader';
import {IconClock, IconPin, IconSearch} from '../components/icons';
import type {GlyphProps} from '../components/icons';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * "Programar viaje" (design-handoff "ScheduleNew"), accesible desde el botón "+" de "Mis viajes
 * programados".
 *
 * BACKEND REAL: la creación de un viaje programado YA existe (POST /trips con `scheduledFor`, validado
 * en dominio en la ventana [≥15min, ≤7días]). Para no duplicar esa lógica, esta pantalla es el punto de
 * entrada que arranca el flujo REAL de programación: elegir destino (buscador) → elegir día/hora y
 * confirmar (en la cotización, con la tarifa estimada real). No simula tarifas ni crea viajes falsos.
 */
export function ScheduleNewScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();

  const reset = useRideDraftStore(s => s.reset);
  const setEditing = useRideDraftStore(s => s.setEditing);

  // Arranca un borrador limpio y lleva al SHEET UNIFICADO (Home). El origen se sembrará con la
  // ubicación actual (igual que el flujo inmediato). El pasajero elige destino en el buscador del
  // sheet → cae en la cotización (`QuotingBody`), donde el botón "Programar para después" abre el
  // selector de día/hora real y la tarifa estimada, y confirma el viaje programado.
  const start = (): void => {
    reset();
    // Deja el destino como punto en edición (el buscador in-sheet lo re-fija de todos modos; es el
    // default del store tras `reset`, se explicita por intención). El flujo programado ya NO tiene
    // pantalla propia: vive ENTERO en el sheet de `RequestFlowScreen` como el flujo inmediato — la
    // ÚNICA diferencia es tocar "Programar para después" en la cotización antes de confirmar.
    setEditing({kind: 'destination'});
    // `navigate('Home')` resuelve al tab Home anidado en `Main` y descarta esta pantalla (y el
    // listado de programados) del stack: el pasajero aterriza en el Home idle listo para pedir.
    navigation.navigate('Home');
  };

  return (
    <SafeScreen
      padded={false}
      footer={
        <Button label={t('scheduleNew.cta')} fullWidth onPress={start} />
      }>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing.lg,
        }}
        showsVerticalScrollIndicator={false}>
        {/* Header in-body (patrón ScreenHeader del pen): back pill + título display + intro. */}
        <ScreenHeader
          title={t('screens.scheduleNew')}
          subtitle={t('scheduleNew.intro')}
        />

        <Card variant="outlined" padding="lg">
          <View style={{gap: theme.spacing.lg}}>
            <Step
              icon={IconSearch}
              title={t('scheduleNew.step1Title')}
              body={t('scheduleNew.step1Body')}
            />
            <Step
              icon={IconPin}
              title={t('scheduleNew.step2Title')}
              body={t('scheduleNew.step2Body')}
            />
            <Step
              icon={IconClock}
              title={t('scheduleNew.step3Title')}
              body={t('scheduleNew.step3Body')}
            />
          </View>
        </Card>

        <Card variant="filled" padding="md">
          <Text variant="footnote" color="inkMuted">
            {t('scheduleNew.note')}
          </Text>
        </Card>

        {/* Carpooling (ADR-014): entrada SECUNDARIA al marketplace de asientos publicados entre
            ciudades. No toca el flujo de programación on-demand de arriba: es otro producto. */}
        <Card variant="outlined" padding="lg">
          <View style={{gap: theme.spacing.md}}>
            <View style={{gap: theme.spacing.xs}}>
              <Text variant="bodyStrong">{t('carpool.entryTitle')}</Text>
              <Text variant="footnote" color="inkMuted">
                {t('carpool.entryBody')}
              </Text>
            </View>
            <Button
              label={t('carpool.entryCta')}
              variant="secondary"
              size="sm"
              onPress={() => navigation.navigate('CarpoolSearch')}
            />
          </View>
        </Card>
      </ScrollView>
    </SafeScreen>
  );
}

interface StepProps {
  icon: (props: GlyphProps) => React.JSX.Element;
  title: string;
  body: string;
}

/** Paso del flujo de programación: círculo con ícono del set + título y descripción. */
function Step({icon: Glyph, title, body}: StepProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.stepRow}>
      <View
        style={[
          styles.leadCircle,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderColor: theme.colors.border,
          },
        ]}>
        <Glyph color={theme.colors.accent} size={18} />
      </View>
      <View style={styles.flex}>
        <Text variant="bodyStrong">{title}</Text>
        <Text
          variant="footnote"
          color="inkMuted"
          style={{marginTop: theme.spacing.xs}}>
          {body}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stepRow: {flexDirection: 'row', gap: 13, alignItems: 'flex-start'},
  flex: {flex: 1},
  leadCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
