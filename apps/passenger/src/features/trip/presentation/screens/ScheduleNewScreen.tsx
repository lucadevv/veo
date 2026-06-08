import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, Card, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRideDraftStore } from '../../../maps/presentation';
import type { RootStackParamList } from '../../../../navigation/types';
import { IconClock, IconPin, IconSearch } from '../components/icons';
import type { GlyphProps } from '../components/icons';

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
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();

  const reset = useRideDraftStore((s) => s.reset);
  const setEditing = useRideDraftStore((s) => s.setEditing);

  // Arranca un borrador limpio y abre el buscador en el destino. El origen se sembrará con la
  // ubicación actual (igual que el flujo inmediato). Tras elegir destino, la cotización ofrece
  // "Programar para después" con el selector de día/hora real y la tarifa estimada.
  const start = (): void => {
    reset();
    setEditing({ kind: 'destination' });
    // Flujo PROGRAMADO: usa el camino legacy (Search → RouteQuote). NO pasa `flow: 'sheet'` a
    // propósito — al fijar origen+destino, Search navega a RouteQuote, donde se elige día/hora real y
    // se confirma el viaje programado. El sheet unificado (RequestFlowScreen) NO interviene acá.
    navigation.navigate('Search', { flow: 'quote' });
  };

  return (
    <SafeScreen
      padded={false}
      footer={<Button label={t('scheduleNew.cta')} fullWidth onPress={start} />}
    >
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.xl, gap: theme.spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        <Text variant="callout" color="inkMuted">
          {t('scheduleNew.intro')}
        </Text>

        <Card variant="outlined" padding="lg">
          <View style={{ gap: theme.spacing.lg }}>
            <Step icon={IconSearch} title={t('scheduleNew.step1Title')} body={t('scheduleNew.step1Body')} />
            <Step icon={IconPin} title={t('scheduleNew.step2Title')} body={t('scheduleNew.step2Body')} />
            <Step icon={IconClock} title={t('scheduleNew.step3Title')} body={t('scheduleNew.step3Body')} />
          </View>
        </Card>

        <Card variant="filled" padding="md">
          <Text variant="footnote" color="inkMuted">
            {t('scheduleNew.note')}
          </Text>
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
function Step({ icon: Glyph, title, body }: StepProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.stepRow}>
      <View
        style={[
          styles.leadCircle,
          { backgroundColor: theme.colors.surfaceElevated, borderColor: theme.colors.border },
        ]}
      >
        <Glyph color={theme.colors.accent} size={18} />
      </View>
      <View style={styles.flex}>
        <Text variant="bodyStrong">{title}</Text>
        <Text variant="footnote" color="inkMuted" style={{ marginTop: theme.spacing.xs }}>
          {body}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stepRow: { flexDirection: 'row', gap: 13, alignItems: 'flex-start' },
  flex: { flex: 1 },
  leadCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
