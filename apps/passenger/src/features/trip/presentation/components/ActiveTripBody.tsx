import { tripStatus, type TripActiveView, type TripStatus } from '@veo/api-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Banner, BottomSheet, Button, Card, DriverCard, Text, TextField, useTheme } from '@veo/ui-kit';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, StyleSheet, View } from 'react-native';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import { formatDurationMinutes, formatPEN } from '../../../../shared/utils/format';
import type { WaypointProposalController } from '../hooks/useWaypointProposal';
import { TripStatusStrip } from './TripStatusStrip';
import { IconCamera, IconRoute } from './icons';
import { EnterView } from './motion';

export interface ActiveTripBodyProps {
  tripId: string;
  trip: TripActiveView;
  /** Estado efectivo (socket o REST) + ETA en vivo. */
  status: TripStatus | string;
  etaSeconds: number | null;
  /** Abrir la cámara del habitáculo a pantalla completa (solo en curso). */
  onOpenCamera: () => void;
  /** El viaje terminó por cancelación del pasajero (→ el screen limpia y vuelve al home). */
  onCancelled: () => void;
  /**
   * Controlador de la PARADA negociada mid-trip (Lote C3). Lo posee la pantalla unificada (dueña del
   * mapa, que captura el tap del picking); acá solo se renderiza su estado y se invocan sus acciones.
   */
  addStop: WaypointProposalController;
}

/**
 * Cuerpo del VIAJE ACTIVO (fases enRoute/arrived/inProgress) del sheet unificado: tarjeta del conductor
 * real, ETA, tarifa, panel de cámara del habitáculo, y acciones (compartir con la familia / cancelar con
 * motivo). SIN mapa ni chrome flotante (SOS/chat/pill los aporta la pantalla unificada sobre el mapa).
 */
export function ActiveTripBody({
  tripId,
  trip,
  status,
  etaSeconds,
  onOpenCamera,
  onCancelled,
  addStop,
}: ActiveTripBodyProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const cancelTrip = useDependency(TOKENS.cancelTripUseCase);
  const shareTrip = useDependency(TOKENS.shareTripUseCase);
  const history = useDependency(TOKENS.tripHistoryRepository);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');

  const isInProgress = status === tripStatus.enum.IN_PROGRESS;
  const etaMinutes = etaSeconds != null ? formatDurationMinutes(etaSeconds) : null;
  const hasDriver = Boolean(trip.driver);

  const cancelMutation = useMutation({
    mutationFn: () => cancelTrip.execute(tripId, reason.trim() || undefined),
    onSuccess: (cancelled) => {
      history.record(cancelled);
      setCancelOpen(false);
      queryClient.invalidateQueries({ queryKey: ['trip', tripId, 'active'] });
      onCancelled();
    },
  });

  const shareMutation = useMutation({
    mutationFn: async () => {
      const link = await shareTrip.execute(tripId);
      await Share.share({
        title: t('trip.shareTitle'),
        message: t('trip.shareMessage', { url: link.url }),
        url: link.url,
      });
    },
  });

  return (
    <View style={{ gap: theme.spacing.md }}>
      {/* Franja de estado canónica: línea sutil de extremo a extremo con el vehículo del trip animado
          (se desliza → cuando el viaje está en movimiento; quieto con pulso al llegar) + etiqueta de
          estado. El ETA en vivo sigue en la DriverCard (no se duplica acá). */}
      <TripStatusStrip status={status} />

      {hasDriver ? (
        <EnterView>
          <DriverCard
            // SEGURIDAD: nombre real del conductor; "Conductor" genérico solo si el backend no lo tiene.
            name={trip.driver?.name ?? t('trip.driver')}
            rating={trip.driver?.rating ?? undefined}
            vehicle={
              trip.vehicle ? `${trip.vehicle.make} ${trip.vehicle.model} · ${trip.vehicle.color}` : undefined
            }
            plate={trip.vehicle?.plate}
            eta={etaMinutes != null ? t('trip.etaMinutes', { minutes: etaMinutes }) : undefined}
          />
        </EnterView>
      ) : (
        <EnterView>
          <Card variant="outlined" padding="lg">
            <Text variant="bodyStrong">{t('trip.searchingTitle')}</Text>
            <Text variant="footnote" color="inkMuted">
              {t('trip.searchingBody')}
            </Text>
          </Card>
        </EnterView>
      )}

      <Card variant="outlined" padding="lg">
        <View style={styles.fareRow}>
          <Text variant="callout" color="inkMuted">
            {t('home.fare')}
          </Text>
          <Text variant="title3" tabular>
            {formatPEN(trip.fareCents)}
          </Text>
        </View>
      </Card>

      {/* Cámara del habitáculo: durante el viaje en curso, un botón que abre la cámara en vivo a
          pantalla completa (más limpio que embeber el viewer WebRTC dentro del sheet). */}
      {isInProgress ? (
        <Button
          label={t('cameraLive.openFullscreen')}
          variant="secondary"
          fullWidth
          leftIcon={<IconCamera color={theme.colors.ink} size={18} />}
          onPress={onOpenCamera}
        />
      ) : null}

      {/* PARADA negociada (Lote C3): solo en curso. Cuando hay un flujo de parada activo (picking o una
          propuesta en vuelo/resuelta), TOMA el foco del sheet; en idle es un botón más entre las acciones. */}
      {isInProgress && (addStop.picking || addStop.phase !== 'idle') ? (
        <AddStopFlow addStop={addStop} />
      ) : (
        <>
          {isInProgress ? (
            <Button
              label={t('trip.addStop')}
              variant="secondary"
              fullWidth
              leftIcon={<IconRoute color={theme.colors.ink} size={18} />}
              onPress={addStop.startPicking}
            />
          ) : null}

          <Button
            label={t('trip.share')}
            variant="secondary"
            fullWidth
            loading={shareMutation.isPending}
            disabled={shareMutation.isPending}
            onPress={() => shareMutation.mutate()}
          />
          {shareMutation.isError ? <Banner tone="danger" title={t('trip.shareError')} /> : null}

          <Button label={t('trip.cancel')} variant="ghost" fullWidth onPress={() => setCancelOpen(true)} />
        </>
      )}

      <BottomSheet
        visible={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={t('trip.cancelTitle')}
        footer={
          <View style={{ gap: theme.spacing.sm }}>
            <Button
              label={t('trip.cancel')}
              variant="danger"
              fullWidth
              loading={cancelMutation.isPending}
              onPress={() => cancelMutation.mutate()}
            />
            <Button label={t('trip.keepTrip')} variant="ghost" fullWidth onPress={() => setCancelOpen(false)} />
          </View>
        }
      >
        <View style={{ gap: theme.spacing.md }}>
          <Text variant="callout" color="inkMuted">
            {t('trip.cancelBody')}
          </Text>
          {cancelMutation.isError ? <Banner tone="danger" title={t('states.errorBody')} /> : null}
          <TextField label={t('trip.cancelReasonLabel')} value={reason} onChangeText={setReason} multiline />
        </View>
      </BottomSheet>
    </View>
  );
}

/**
 * Sub-flujo de la PARADA negociada (Lote C3). Renderiza el estado del controlador:
 *  - picking          → instrucción de tocar el mapa + Confirmar (habilitado al tener punto) / Cancelar.
 *  - proposing        → cargando (POST en vuelo).
 *  - waiting          → esperando al conductor: cuenta regresiva + costo adicional + tarifa nueva.
 *  - accepted/rejected/expired/error → banner del desenlace + "Entendido" (vuelve a idle).
 * El cálculo del precio es del SERVIDOR (la vista solo lo muestra; nunca lo computa).
 */
function AddStopFlow({ addStop }: { addStop: WaypointProposalController }): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const { phase, picking, pickedPoint, proposal, secondsLeft } = addStop;

  if (picking) {
    return (
      <View style={{ gap: theme.spacing.sm }}>
        <Banner
          tone="info"
          title={t('trip.addStopPickTitle')}
          description={t('trip.addStopPickBody')}
        />
        <Button
          label={t('trip.addStopConfirm')}
          variant="primary"
          fullWidth
          disabled={!pickedPoint}
          onPress={addStop.confirm}
        />
        <Button label={t('trip.addStopCancel')} variant="ghost" fullWidth onPress={addStop.cancelPicking} />
      </View>
    );
  }

  if (phase === 'proposing') {
    return (
      <Button label={t('trip.addStopProposing')} variant="primary" fullWidth loading disabled onPress={() => undefined} />
    );
  }

  if (phase === 'waiting' && proposal) {
    return (
      <EnterView>
        <Card variant="outlined" padding="lg">
          <View style={{ gap: theme.spacing.sm }}>
            <Text variant="bodyStrong">{t('trip.addStopWaitingTitle')}</Text>
            <Text variant="footnote" color="inkMuted">
              {t('trip.addStopWaitingBody')}
            </Text>
            {proposal.deltaFareCents > 0 ? (
              <View style={styles.fareRow}>
                <Text variant="callout" color="inkMuted">
                  {t('trip.addStopDelta', { amount: formatPEN(proposal.deltaFareCents) })}
                </Text>
              </View>
            ) : null}
            <View style={styles.fareRow}>
              <Text variant="callout" color="inkMuted">
                {t('trip.addStopNewFare', { amount: formatPEN(proposal.newFareCents) })}
              </Text>
              {secondsLeft != null ? (
                <Text variant="bodyStrong" tabular>
                  {t('trip.addStopCountdown', { seconds: secondsLeft })}
                </Text>
              ) : null}
            </View>
          </View>
        </Card>
      </EnterView>
    );
  }

  // Desenlaces terminales: banner + "Entendido" (cierra y reabilita "Agregar parada").
  const terminal = resolveTerminalBanner(phase);
  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Banner tone={terminal.tone} title={t(terminal.title)} description={t(terminal.body)} />
      <Button label={t('trip.addStopDismiss')} variant="ghost" fullWidth onPress={addStop.dismiss} />
    </View>
  );
}

/** Mapea la fase terminal a su banner (tono + claves i18n). Sin strings sueltos de UI. */
function resolveTerminalBanner(
  phase: WaypointProposalController['phase'],
): { tone: 'success' | 'warn' | 'danger'; title: string; body: string } {
  if (phase === 'accepted') {
    return { tone: 'success', title: 'trip.addStopAcceptedTitle', body: 'trip.addStopAcceptedBody' };
  }
  if (phase === 'rejected') {
    return { tone: 'warn', title: 'trip.addStopRejectedTitle', body: 'trip.addStopRejectedBody' };
  }
  if (phase === 'expired') {
    return { tone: 'warn', title: 'trip.addStopExpiredTitle', body: 'trip.addStopExpiredBody' };
  }
  // error (POST falló)
  return { tone: 'danger', title: 'trip.addStopError', body: 'trip.addStopError' };
}

const styles = StyleSheet.create({
  fareRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
