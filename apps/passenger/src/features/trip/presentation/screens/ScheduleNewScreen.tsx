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
        // `padded={false}` deja el footer sin padding horizontal → el CTA iba borde a borde. Lo
        // envolvemos con el padding estándar para que respire a los costados como el contenido.
        <View style={{paddingHorizontal: theme.spacing.xl}}>
          <Button label={t('scheduleNew.cta')} fullWidth onPress={start} />
        </View>
      }>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing.lg,
        }}
        showsVerticalScrollIndicator={false}>
        {/* Header in-body: back pill + título display (sin intro descriptivo — el flujo se explica solo). */}
        <ScreenHeader title={t('screens.scheduleNew')} />

        {/* Los 3 pasos como TIMELINE editorial: círculos conectados por un riel continuo (el mismo motivo
            origen→destino de las cards de viaje), en superficie elevada sin borde. */}
        <Card variant="elevated" padding="lg">
          <View style={styles.timeline}>
            {/* Riel continuo detrás, del centro del 1er círculo al del último (los círculos opacos lo tapan
                por dentro → se ve como conector entre pasos). */}
            <View style={[styles.timelineLine, {backgroundColor: theme.colors.border}]} />
            <StepRow icon={IconSearch} title={t('scheduleNew.step1Title')} />
            <StepRow icon={IconPin} title={t('scheduleNew.step2Title')} />
            <StepRow icon={IconClock} title={t('scheduleNew.step3Title')} last />
          </View>
        </Card>

        {/* Carpooling (ADR-014): entrada SECUNDARIA al marketplace de asientos entre ciudades (otro
            producto). Título + CTA, sin la prosa de apoyo. Misma superficie elevada. */}
        <Card variant="elevated" padding="lg">
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

interface StepRowProps {
  icon: (props: GlyphProps) => React.JSX.Element;
  title: string;
  /** Último paso: sin margen inferior (no hay siguiente círculo que conectar). */
  last?: boolean;
}

/**
 * Paso del timeline: círculo con ícono del set (opaco, tapa el riel por dentro) + título. El `marginBottom`
 * separa cada paso del siguiente; el riel continuo lo dibuja el contenedor detrás.
 */
function StepRow({icon: Glyph, title, last = false}: StepRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.stepRow, last ? null : {marginBottom: theme.spacing.lg}]}>
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
      <Text variant="bodyStrong" style={styles.flex}>
        {title}
      </Text>
    </View>
  );
}

const CIRCLE = 40;

const styles = StyleSheet.create({
  timeline: {position: 'relative'},
  // Riel continuo: del centro del 1er círculo (top: CIRCLE/2) al del último (bottom: CIRCLE/2). Va PRIMERO
  // en el árbol → los círculos (hermanos posteriores, opacos) quedan encima y lo tapan por dentro.
  timelineLine: {
    position: 'absolute',
    left: CIRCLE / 2 - 1,
    top: CIRCLE / 2,
    bottom: CIRCLE / 2,
    width: 2,
  },
  stepRow: {flexDirection: 'row', gap: 14, alignItems: 'center'},
  flex: {flex: 1},
  leadCircle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
