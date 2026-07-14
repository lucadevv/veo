import {
  tripStatus,
  type TripActiveView,
  type TripStatus,
} from '@veo/api-client';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {
  Banner,
  BottomSheet,
  Button,
  Card,
  DriverCard,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {formatInt, formatPEN} from '../../../../shared/utils/format';
import type {WaypointProposalController} from '../hooks/useWaypointProposal';
import {IconCamera, IconChat, IconClose, IconRoute, IconShare} from './icons';
import {EnterView} from './motion';
import {TripPaymentConfirmation} from './TripPaymentConfirmation';

export interface ActiveTripBodyProps {
  tripId: string;
  trip: TripActiveView;
  /**
   * Estado efectivo (socket o REST). El ETA en vivo se muestra en la franja de estado, que ahora es el
   * HEADER colapsable del sheet (`ActiveTripSheetHeader`), no dentro de este cuerpo.
   */
  status: TripStatus | string;
  /** Abrir la cámara del habitáculo a pantalla completa (solo en curso). */
  onOpenCamera: () => void;
  /** Abrir el chat con el conductor (acción "Mensaje" del sheet — design/veo.pen fLKdk Actions). */
  onOpenChat: () => void;
  /**
   * Abrir la pantalla dedicada "Comparte tu viaje" (design/veo.pen zKyic). La acción "Compartir"
   * ya no dispara el Share nativo directo: el enlace, los canales y los contactos viven allá.
   */
  onOpenFamilyShare: () => void;
  /** Mensajes del conductor sin leer (badge sobre la acción "Mensaje"). */
  unreadCount: number;
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
  onOpenCamera,
  onOpenChat,
  onOpenFamilyShare,
  unreadCount,
  onCancelled,
  addStop,
}: ActiveTripBodyProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const queryClient = useQueryClient();
  const cancelTrip = useDependency(TOKENS.cancelTripUseCase);
  const history = useDependency(TOKENS.tripHistoryRepository);

  const [cancelOpen, setCancelOpen] = useState(false);
  // Motivo elegido (radio del pen AULzA) + detalle libre opcional. El contrato NO tiene enum de
  // motivos (cancelTripRequest.reason es string libre) → viajan compuestos como texto.
  const [reasonKey, setReasonKey] = useState<CancelReasonKey | null>(null);
  const [reasonDetail, setReasonDetail] = useState('');

  const isInProgress = status === tripStatus.enum.IN_PROGRESS;
  const hasDriver = Boolean(trip.driver);

  const cancelMutation = useMutation({
    mutationFn: () => {
      // "{motivo} — {detalle}" | solo motivo | solo detalle | undefined (todo sigue opcional).
      const motive = reasonKey ? t(`trip.cancelReasons.${reasonKey}`) : '';
      const detail = reasonDetail.trim();
      const reason =
        motive && detail ? `${motive} — ${detail}` : motive || detail;
      return cancelTrip.execute(tripId, reason || undefined);
    },
    onSuccess: cancelled => {
      history.record(cancelled);
      setCancelOpen(false);
      queryClient.invalidateQueries({queryKey: ['trip', tripId, 'active']});
      onCancelled();
    },
  });

  return (
    <View style={{gap: theme.spacing.md}}>
      {/* La franja de estado (conductor + ETA) subió al HEADER colapsable del sheet
          (`ActiveTripSheetHeader`): queda visible aun con el sheet plegado al mínimo. Este cuerpo abre
          directo con la tarjeta del conductor. */}
      {hasDriver ? (
        <EnterView>
          <DriverCard
            // SEGURIDAD: nombre real del conductor; "Conductor" genérico solo si el backend no lo tiene.
            name={trip.driver?.name ?? t('trip.driver')}
            // Sello VERIFICADO (pen DriverCard badge-check): derivado del background check REAL del
            // contrato — nunca se asume. El valor del backend (identity) es 'CLEARED' (su vocabulario para
            // "antecedentes aprobados"), NO 'APPROVED' — antes se comparaba mal y el sello no salía jamás.
            verified={trip.driver?.backgroundCheckStatus === 'CLEARED'}
            verifiedLabel={t('trip.verifiedDriver')}
            rating={trip.driver?.rating ?? undefined}
            // Línea de rating (pen z2MKq):
            //  · con rating y viajes (>0) → "4.9 · 1,890 viajes" (`tripCount` = viajes COMPLETED de por
            //    vida, del contrato — señal de confianza real, NO el conteo de 30 días); miles formateados;
            //  · con rating pero 0 viajes → solo "5.0" (undefined → la card cae a rating.toFixed);
            //  · SIN rating (conductor nuevo) → "Conductor nuevo" (sin estrellas), nunca en blanco.
            ratingText={
              trip.driver?.rating == null
                ? t('trip.driverNew')
                : (trip.driver.tripCount ?? 0) > 0
                  ? t('trip.driverRatingTrips', {
                      rating: trip.driver.rating.toFixed(1),
                      trips: formatInt(trip.driver.tripCount ?? 0),
                    })
                  : undefined
            }
            vehicle={
              trip.vehicle
                ? `${trip.vehicle.make} ${trip.vehicle.model} · ${trip.vehicle.color}`
                : undefined
            }
            plate={trip.vehicle?.plate}
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

      {/* Confirmación IN-APP del cobro automático (pre-pago digital, se cobra al INICIAR con Yape On-File):
          da la certeza DENTRO de la app sin depender del push (que no llega al sim iOS). Auto-gateado:
          solo EN CURSO y solo si hay un cobro digital capturado/en curso (efectivo/deuda → null). */}
      <TripPaymentConfirmation tripId={tripId} visible={isInProgress} />

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

          {/* Fila de 3 acciones con icono (design/veo.pen fLKdk Actions): Mensaje (chat + badge de
              no-leídos, mudado del chrome flotante) · Compartir · Cancelar. Tiles iguales, el peligro
              (cancelar) en tono danger. */}
          <View style={[styles.actionsRow, {gap: 10}]}>
            <ActionTile
              icon={<IconChat color={theme.colors.ink} size={20} />}
              label={t('trip.actionMessage')}
              badgeCount={unreadCount}
              onPress={onOpenChat}
            />
            <ActionTile
              icon={<IconShare color={theme.colors.ink} size={20} />}
              label={t('trip.actionShare')}
              // Navega a la pantalla dedicada (pen zKyic): enlace real + canales + contactos.
              onPress={onOpenFamilyShare}
            />
            <ActionTile
              icon={<IconClose color={theme.colors.danger} size={20} />}
              label={t('trip.actionCancel')}
              tone="danger"
              onPress={() => setCancelOpen(true)}
            />
          </View>
        </>
      )}

      {/* Cancelación con motivo (design/veo.pen AULzA): título + "Cuéntanos por qué" + 5 motivos en
          RADIO de selección única + detalle libre opcional + nota warn del posible cargo + botones
          "Sí, cancelar viaje" (danger) / "No, seguir en el viaje" (ghost). */}
      <BottomSheet
        visible={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={t('trip.cancelTitle')}
        footer={
          <View style={{gap: theme.spacing.sm}}>
            <Button
              label={t('trip.cancelConfirm')}
              variant="danger"
              fullWidth
              loading={cancelMutation.isPending}
              onPress={() => cancelMutation.mutate()}
            />
            <Button
              label={t('trip.keepInTrip')}
              variant="ghost"
              fullWidth
              onPress={() => setCancelOpen(false)}
            />
          </View>
        }>
        <View style={{gap: theme.spacing.md}}>
          <Text variant="callout" color="inkMuted">
            {t('trip.cancelSubtitle')}
          </Text>
          {cancelMutation.isError ? (
            <Banner tone="danger" title={t('states.errorBody')} />
          ) : null}
          <View style={{gap: theme.spacing.xs}}>
            {CANCEL_REASON_KEYS.map(key => (
              <CancelReasonRow
                key={key}
                label={t(`trip.cancelReasons.${key}`)}
                selected={reasonKey === key}
                onPress={() => setReasonKey(key)}
              />
            ))}
          </View>
          <TextField
            label={t('trip.cancelDetailLabel')}
            value={reasonDetail}
            onChangeText={setReasonDetail}
            multiline
          />
          {/* El monto real de la penalidad (S/ 3, BR-T03) es condicional server-side y NO viene en
              el contrato antes de cancelar → nota sin cifra (honesta), no el "S/ 3" fijo del pen. */}
          <Banner tone="warn" title={t('trip.cancelWarnNote')} />
        </View>
      </BottomSheet>
    </View>
  );
}

/** Motivos de cancelación del pen AULzA (claves i18n bajo `trip.cancelReasons.*`). */
const CANCEL_REASON_KEYS = [
  'driverNotMoving',
  'tooSlow',
  'changedPlans',
  'byMistake',
  'other',
] as const;
type CancelReasonKey = (typeof CANCEL_REASON_KEYS)[number];

interface CancelReasonRowProps {
  label: string;
  selected: boolean;
  onPress: () => void;
}

/**
 * Fila-radio de motivo (pen AULzA Reasons): superficie con el label a la izquierda y el círculo de
 * radio a la derecha; la seleccionada se marca con borde y punto en el acento de marca. Selección
 * única (el estado vive en el sheet); accesible como radio.
 */
function CancelReasonRow({
  label,
  selected,
  onPress,
}: CancelReasonRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{selected}}
      onPress={onPress}
      style={({pressed}) => [
        styles.reasonRow,
        {
          backgroundColor: pressed
            ? theme.colors.surfaceElevated
            : theme.colors.surface,
          borderColor: selected ? theme.colors.brand : theme.colors.surface,
          borderRadius: theme.radii.lg,
          paddingVertical: theme.spacing.md,
          paddingHorizontal: theme.spacing.lg,
          gap: theme.spacing.md,
        },
      ]}>
      <Text variant={selected ? 'bodyStrong' : 'body'} style={styles.flexText}>
        {label}
      </Text>
      <View
        style={[
          styles.radioOuter,
          {
            borderColor: selected
              ? theme.colors.brand
              : theme.colors.borderStrong,
          },
        ]}>
        {selected ? (
          <View
            style={[styles.radioDot, {backgroundColor: theme.colors.brand}]}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

interface ActionTileProps {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  /** Tinte del tile: default neutro; `danger` para la acción destructiva (Cancelar). */
  tone?: 'default' | 'danger';
  /** Contador de no-leídos sobre el icono (acción Mensaje). 0 = sin badge. */
  badgeCount?: number;
  /** Acción en vuelo (compartir generando el enlace): atenúa y bloquea el tile. */
  loading?: boolean;
}

/**
 * Tile de acción del viaje activo (design/veo.pen `Actions`): tile-icono CUADRADO 46×46 (relleno gris
 * recesado + borde) con la etiqueta DEBAJO, tres iguales en fila. El badge de no-leídos se posa sobre el
 * tile. El pressed tiñe SOLO el tile. `danger` (Cancelar) va con icono + label en rojo.
 */
function ActionTile({
  icon,
  label,
  onPress,
  tone = 'default',
  badgeCount = 0,
  loading = false,
}: ActionTileProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badgeCount > 0 ? `${label} (${badgeCount})` : label}
      disabled={loading}
      onPress={onPress}
      style={[styles.actionCol, {opacity: loading ? 0.55 : 1}]}>
      {({pressed}) => (
        <>
          <View
            style={[
              styles.actionBtn,
              {
                backgroundColor: pressed
                  ? theme.colors.surface
                  : theme.colors.surfaceMuted,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.sm,
              },
            ]}>
            {icon}
            {badgeCount > 0 ? (
              <View
                style={[
                  styles.actionBadge,
                  {
                    backgroundColor: theme.colors.accent,
                    borderColor: theme.colors.surface,
                  },
                ]}>
                <Text variant="caption" color="onAccent" tabular>
                  {badgeCount > 9 ? '9+' : badgeCount}
                </Text>
              </View>
            ) : null}
          </View>
          <Text
            variant="caption"
            color={tone === 'danger' ? 'danger' : 'inkMuted'}
            numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
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
function AddStopFlow({
  addStop,
}: {
  addStop: WaypointProposalController;
}): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const {phase, picking, pickedPoint, proposal, secondsLeft} = addStop;

  if (picking) {
    return (
      <View style={{gap: theme.spacing.sm}}>
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
        <Button
          label={t('trip.addStopCancel')}
          variant="ghost"
          fullWidth
          onPress={addStop.cancelPicking}
        />
      </View>
    );
  }

  if (phase === 'proposing') {
    return (
      <Button
        label={t('trip.addStopProposing')}
        variant="primary"
        fullWidth
        loading
        disabled
        onPress={() => undefined}
      />
    );
  }

  if (phase === 'waiting' && proposal) {
    return (
      <EnterView>
        <Card variant="outlined" padding="lg">
          <View style={{gap: theme.spacing.sm}}>
            <Text variant="bodyStrong">{t('trip.addStopWaitingTitle')}</Text>
            <Text variant="footnote" color="inkMuted">
              {t('trip.addStopWaitingBody')}
            </Text>
            {proposal.deltaFareCents > 0 ? (
              <View style={styles.fareRow}>
                <Text variant="callout" color="inkMuted">
                  {t('trip.addStopDelta', {
                    amount: formatPEN(proposal.deltaFareCents),
                  })}
                </Text>
              </View>
            ) : null}
            <View style={styles.fareRow}>
              <Text variant="callout" color="inkMuted">
                {t('trip.addStopNewFare', {
                  amount: formatPEN(proposal.newFareCents),
                })}
              </Text>
              {secondsLeft != null ? (
                <Text variant="bodyStrong" tabular>
                  {t('trip.addStopCountdown', {seconds: secondsLeft})}
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
    <View style={{gap: theme.spacing.sm}}>
      <Banner
        tone={terminal.tone}
        title={t(terminal.title)}
        description={t(terminal.body)}
      />
      <Button
        label={t('trip.addStopDismiss')}
        variant="ghost"
        fullWidth
        onPress={addStop.dismiss}
      />
    </View>
  );
}

/** Mapea la fase terminal a su banner (tono + claves i18n). Sin strings sueltos de UI. */
function resolveTerminalBanner(phase: WaypointProposalController['phase']): {
  tone: 'success' | 'warn' | 'danger';
  title: string;
  body: string;
} {
  if (phase === 'accepted') {
    return {
      tone: 'success',
      title: 'trip.addStopAcceptedTitle',
      body: 'trip.addStopAcceptedBody',
    };
  }
  if (phase === 'rejected') {
    return {
      tone: 'warn',
      title: 'trip.addStopRejectedTitle',
      body: 'trip.addStopRejectedBody',
    };
  }
  if (phase === 'expired') {
    return {
      tone: 'warn',
      title: 'trip.addStopExpiredTitle',
      body: 'trip.addStopExpiredBody',
    };
  }
  // error (POST falló)
  return {
    tone: 'danger',
    title: 'trip.addStopError',
    body: 'trip.addStopError',
  };
}

const styles = StyleSheet.create({
  fareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  actionsRow: {flexDirection: 'row', alignItems: 'flex-start'},
  // Fila-radio del motivo de cancelación (pen AULzA): label + círculo, borde de selección.
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
  },
  flexText: {flexShrink: 1},
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: {width: 9, height: 9, borderRadius: 4.5},
  // Columna de acción (pen `Actions`): tile 46×46 arriba + label debajo, centrada; 3 iguales (flex 1).
  actionCol: {flex: 1, alignItems: 'center', gap: 6},
  actionBtn: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  actionBadge: {
    position: 'absolute',
    top: -6,
    right: -6,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
