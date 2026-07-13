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
        {/* Header in-body: back pill + título display (sin intro descriptivo — el flujo se explica solo). */}
        <ScreenHeader title={t('screens.scheduleNew')} />

        {/* Los 3 pasos como estructura escaneable (icono + título), sin la prosa descriptiva de cada uno. */}
        <Card variant="outlined" padding="lg">
          <View style={{gap: theme.spacing.lg}}>
            <Step icon={IconSearch} title={t('scheduleNew.step1Title')} />
            <Step icon={IconPin} title={t('scheduleNew.step2Title')} />
            <Step icon={IconClock} title={t('scheduleNew.step3Title')} />
          </View>
        </Card>

        {/* Carpooling (ADR-014): entrada SECUNDARIA al marketplace de asientos entre ciudades (otro
            producto). Título + CTA, sin la prosa de apoyo. */}
        <Card variant="outlined" padding="lg">
          <View style={{gap: theme.spacing.md}}>
            <Text variant="bodyStrong">{t('carpool.entryTitle')}</Text>
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
  /** Descripción opcional; hoy los pasos van solo con título (sin prosa descriptiva). */
  body?: string;
}

/** Paso del flujo de programación: círculo con ícono del set + título (+ descripción opcional). */
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
        {body ? (
          <Text
            variant="footnote"
            color="inkMuted"
            style={{marginTop: theme.spacing.xs}}>
            {body}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stepRow: {flexDirection: 'row', gap: 13, alignItems: 'center'},
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
