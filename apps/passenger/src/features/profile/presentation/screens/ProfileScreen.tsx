import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {DocumentType} from '@veo/api-client';
import {useMutation, useQuery} from '@tanstack/react-query';
import {
  Avatar,
  Banner,
  BottomSheet,
  Button,
  Card,
  ListGroup,
  ListItem,
  SafeScreen,
  StatusPill,
  Switch,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, ScrollView, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {uuidv7} from '../../../../shared/utils/uuid';
import {useSessionStore} from '../../../../core/session/sessionStore';
import {
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import {formatShortDate} from '../../../../shared/utils/format';
import {
  setPromotionsSubscription,
  unregisterMessaging,
} from '../../../../services/messaging';
import {isKycVerified} from '../../../kyc/domain/entities';
import type {RootStackParamList} from '../../../../navigation/types';
import {DocumentField} from '../../../payments/presentation';
import {isDocumentValid} from '../../../payments/domain/affiliationUsecases';
import {maskDocument} from '../../../../shared/utils/format';
import {EnterView} from '../components/motion';
import {PhoneVerificationSheet} from '../components/PhoneVerificationSheet';
import {usePushPermission} from '../../../../core/notifications/usePushPermission';
import {
  IconAccessibility,
  IconBadgeCheck,
  IconBell,
  IconCamera,
  IconCard,
  IconChild,
  IconFaceScan,
  IconFileText,
  IconGift,
  IconGlobe,
  IconHelp,
  IconPin,
  IconPower,
  IconReceipt,
  IconShare,
  IconShield,
  IconTrash,
  IconUsers,
} from '../components/icons';
import {IconPencil} from '../../../auth/presentation/components/icons';
import {IconStarFilled} from '../../../trip/presentation/components/icons';
import {useMyAggregateRating} from '../hooks/useMyAggregateRating';

type Nav = NativeStackNavigationProp<RootStackParamList>;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Items del diseño cuyo destino aún no tiene pantalla con backend: degradación honesta. */
type ComingSoon =
  | 'cameraControl'
  | 'shareTrip'
  | 'accessibility'
  | 'language'
  | 'terms';

const COMING_SOON_COPY: Record<ComingSoon, string> = {
  cameraControl: 'profile.comingSoonCameraControl',
  shareTrip: 'profile.comingSoonShareTrip',
  // DEUDA: (app) falta pantalla de Accesibilidad (tamaño de texto, alto contraste, reduce-motion). Hoy comingSoon, sin destino.
  accessibility: 'profile.comingSoonAccessibility',
  // DEUDA: (backend+i18n) soporte multi-locale (es-ES/en-US) + persistir preferencia de idioma/región del usuario. Hoy solo es-PE; el selector es comingSoon.
  // Idioma y región (pen c4cChO): la app hoy SOLO existe en es-PE — no fingimos un selector.
  language: 'profile.comingSoonLanguage',
  // DEUDA: (config) falta URL legal (Términos + Privacidad Ley 29733) en config/env para linkear desde el Perfil. Hoy no hay URL → comingSoon.
  // Términos y privacidad (pen c4cChO): no hay URL legal en config/env (gap) — sheet honesto.
  terms: 'profile.comingSoonTerms',
};

/** Un paso faltante de la franja de completitud (chip tappeable que abre el campo correspondiente). */
type CompletionStep = 'name' | 'phone' | 'document';

/**
 * Perfil del pasajero (`GET /users/me`) rediseñado con voz de autor:
 *
 *  - CABECERA con descubribilidad real: botón "Editar perfil" EXPLÍCITO (ghost, visible). El nombre
 *    faltante ES la invitación ("Agregá tu nombre" como CTA, no un misterio). Identidad confirmada =
 *    check fino junto al nombre (microcopy), NO una pill gritona. El tap en la cabecera sigue abriendo
 *    la edición (gesto pro), pero la affordance visible manda.
 *  - FRANJA DE COMPLETITUD (guía, no castigo): si falta nombre/celular/documento, chips tappeables que
 *    abren directo el campo/sheet correspondiente. Cuando está completo NO se muestra nada (el premio
 *    es el silencio).
 *  - VERIFICACIÓN con momento propio (sin verificar): card "Confirmá que sos vos" → KycCamera.
 *  - Secciones Seguridad / Preferencias / Cuenta con ListItems del set de íconos.
 *
 * Edición vía `PATCH /users/me` (nombre obligatorio; correo/documento opcionales). Celular faltante →
 * `PhoneVerificationSheet`. Derecho al olvido (`POST /users/me/deletion`) y logout.
 */
export function ProfileScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  // Permiso de push (estado real del SO + activar). El toggle de notificaciones lo refleja y gestiona.
  const push = usePushPermission();

  const getProfile = useDependency(TOKENS.getProfileUseCase);
  const updateProfile = useDependency(TOKENS.updateProfileUseCase);
  const requestDeletion = useDependency(TOKENS.requestAccountDeletionUseCase);
  const logout = useDependency(TOKENS.logoutUseCase);
  const history = useDependency(TOKENS.tripHistoryRepository);
  const panicSecretStore = useDependency(TOKENS.panicSecretStore);
  const getConsent = useDependency(TOKENS.getConsentUseCase);
  const recordConsent = useDependency(TOKENS.recordConsentUseCase);
  const syncPendingConsent = useDependency(TOKENS.syncPendingConsentUseCase);

  // Consentimiento VIGENTE (Ley 29733) → estado del toggle de promociones.
  const consentQuery = useQuery({
    queryKey: ['consent'],
    queryFn: () => getConsent.execute(),
  });

  // Reconcilia la COLA DURABLE contra el consent vigente del server cada vez que el GET trae dato
  // fresco (equivalente al `onSuccess` que React Query v5 ya no expone en `useQuery`): si el server ya
  // tiene la misma versión de política que lo encolado, la aceptación llegó → se vacía la cola y no se
  // reintenta de más. No-op si la cola está vacía.
  useEffect(() => {
    if (consentQuery.data !== undefined) {
      syncPendingConsent.reconcileWith(consentQuery.data);
    }
  }, [consentQuery.data, syncPendingConsent]);
  // Feedback optimista: el Switch refleja el cambio al instante; si la mutación falla, revierte al refetch.
  const [pendingMarketing, setPendingMarketing] = useState<boolean | null>(
    null,
  );
  const marketingOn = pendingMarketing ?? consentQuery.data?.marketing ?? false;

  /**
   * Cambiar el opt-in de marketing es append-only: re-registra el consent COMPLETO (preservando los
   * otros flags vigentes) + suscribe/desuscribe del topic FCM `promos`. Best-effort en ambos lados.
   */
  const marketingMutation = useMutation({
    mutationFn: async (next: boolean) => {
      const c = consentQuery.data;
      // dedupKey propio para ESTE toggle: el POST de consent ahora propaga el error (la durabilidad
      // vive en la cola, no en el use case), así que un reintento manual del usuario reusaría la
      // idempotencia del server sin duplicar el row append-only.
      await recordConsent.execute(
        {
          dataProcessing: c?.dataProcessing ?? true,
          inCabinCamera: c?.inCabinCamera ?? false,
          location: c?.location ?? false,
          marketing: next,
        },
        uuidv7(),
      );
      await setPromotionsSubscription(next);
    },
    onSettled: () => {
      setPendingMarketing(null);
      void consentQuery.refetch();
    },
  });

  const onToggleMarketing = (next: boolean): void => {
    setPendingMarketing(next);
    marketingMutation.mutate(next);
  };

  const refreshToken = useSessionStore(s => s.refreshToken);
  const clearSession = useSessionStore(s => s.clearSession);

  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile.execute(),
  });

  // Calificación RECIBIDA por el pasajero (agregado rolling 30d). El hook se llama incondicionalmente
  // (reglas de hooks); `enabled` interno corta la llamada si todavía no tenemos `profile.id`.
  const aggregateQuery = useMyAggregateRating(profileQuery.data?.id ?? '');

  const [editOpen, setEditOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [documentType, setDocumentType] = useState<DocumentType>('DN');
  const [document, setDocument] = useState('');
  const [touched, setTouched] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [comingSoon, setComingSoon] = useState<ComingSoon | null>(null);

  const updateMutation = useMutation({
    mutationFn: () => {
      const trimmedName = name.trim();
      const trimmedEmail = email.trim();
      const trimmedDoc = document.trim();
      // `updatePassengerProfile` acepta campos opcionales: enviamos solo los que aplican. El documento
      // se persiste vía PATCH /users/me (queda disponible para la vinculación de Yape de UN TAP).
      return updateProfile.execute({
        name: trimmedName,
        ...(trimmedEmail ? {email: trimmedEmail} : {}),
        ...(trimmedDoc ? {documentType, document: trimmedDoc} : {}),
      });
    },
    onSuccess: () => {
      setEditOpen(false);
      profileQuery.refetch();
    },
  });

  const deletionMutation = useMutation({
    mutationFn: () => requestDeletion.execute(),
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      // Baja del token de push y borrado del secreto HMAC antes de revocar la sesión (best-effort).
      await unregisterMessaging();
      await panicSecretStore.clearSecret();
      await logout.execute(refreshToken);
    },
    onSuccess: () => {
      history.clear();
      clearSession();
    },
  });

  if (profileQuery.isLoading) {
    return (
      <SafeScreen>
        <LoadingState />
      </SafeScreen>
    );
  }

  if (profileQuery.isError || !profileQuery.data) {
    return (
      <SafeScreen>
        <ErrorState onRetry={() => profileQuery.refetch()} />
      </SafeScreen>
    );
  }

  const profile = profileQuery.data;
  const hasName =
    typeof profile.name === 'string' && profile.name.trim().length > 0;
  // Nombre visible: el nombre real; si falta, el correo/teléfono como identificador temporal.
  const displayName = hasName
    ? profile.name!
    : (profile.email ?? profile.phone ?? '');
  // Línea de identidad ÚNICA bajo el nombre: teléfono o, si no hay, el correo.
  const contact = profile.phone ?? profile.email ?? null;
  const verified = isKycVerified(profile.kycStatus);
  const trimmedName = name.trim();
  const nameValid = trimmedName.length >= 2 && trimmedName.length <= 80;
  const trimmedEmail = email.trim();
  const emailValid =
    trimmedEmail.length === 0 || EMAIL_PATTERN.test(trimmedEmail);
  const trimmedDoc = document.trim();
  // Documento OPCIONAL: válido si está vacío (no se toca) o si pasa la validación local del tipo.
  const documentValid =
    trimmedDoc.length === 0 || isDocumentValid(documentType, trimmedDoc);
  const canSaveEdit = nameValid && emailValid && documentValid;
  // Documento enmascarado para la cabecera (privacidad): "12345678" → "DNI ••••5678".
  const maskedDocument = profile.document
    ? maskDocument(profile.document)
    : null;

  // CALIFICACIÓN RECIBIDA · 4 estados (sin layout shift brusco; el perfil no se rompe nunca):
  //  - loading  → no pintamos nada (placeholder sutil opcional, evitado a propósito).
  //  - error    → silencioso (otro fallo que no sea 404): no mostramos el bloque.
  //  - vacío    → data === null (404 = sin agregado) o count30d === 0 → microcopy honesto, SIN rating falso.
  //  - ok       → count30d > 0 → score (1 decimal) + estrella + cantidad de viajes.
  const aggregate = aggregateQuery.data;
  const hasRating = aggregate != null && aggregate.count30d > 0;
  const ratingScore = hasRating ? aggregate!.rollingAvg30d.toFixed(1) : null;
  // Distinguimos "vacío legítimo" (query resuelta sin rating) de "todavía cargando / falló": solo el
  // vacío legítimo muestra el microcopy; loading y error quedan en silencio.
  const ratingEmpty = aggregateQuery.isSuccess && !hasRating;

  // Pasos faltantes de la completitud (guía, no castigo). Cuando no falta nada → franja en silencio.
  const missingSteps: CompletionStep[] = [];
  if (!hasName) missingSteps.push('name');
  if (!profile.phone) missingSteps.push('phone');
  if (!profile.document) missingSteps.push('document');

  const openEdit = (): void => {
    setName(profile.name ?? '');
    setEmail(profile.email ?? '');
    setDocumentType(profile.documentType ?? 'DN');
    setDocument(profile.document ?? '');
    setTouched(false);
    setEditOpen(true);
  };

  // Cada chip de la franja abre directo el lugar que resuelve ese dato (descubribilidad real).
  const openStep = (step: CompletionStep): void => {
    if (step === 'phone') {
      setPhoneOpen(true);
    } else {
      // name / document viven en el mismo sheet de edición.
      openEdit();
    }
  };

  const stepLabel: Record<CompletionStep, string> = {
    name: t('profile.completionChipName'),
    phone: t('profile.completionChipPhone'),
    document: t('profile.completionChipDocument'),
  };

  // Tamaño de glyph homogéneo para los leading de las filas (set `I` del diseño).
  const glyph = 22;
  const accent = theme.colors.accent;
  const danger = theme.colors.danger;
  const success = theme.colors.success;

  const sectionLabel = (text: string): React.JSX.Element => (
    <Text
      variant="label"
      color="inkMuted"
      style={{marginBottom: theme.spacing.sm, marginLeft: theme.spacing.xs}}>
      {text}
    </Text>
  );

  return (
    <SafeScreen padded={false}>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing.lg,
        }}>
        {/* Header del hub · hero editorial IZQUIERDA (display + subtítulo), MISMO tratamiento que el
            ScreenHero del conductor — coherencia de identidad entre apps (anti-centrado). */}
        <View style={{gap: theme.spacing.xxs}}>
          <Text variant="display">{t('profile.title')}</Text>
          <Text variant="callout" color="inkMuted">
            {t('profile.subtitle')}
          </Text>
        </View>

        {/* CABECERA · identidad en CARD a la izquierda (avatar + nombre/badge + rating + contacto),
            espejo del `ProfileIdentityCard` del conductor. El editar queda como affordance explícito
            (ghost, visible) debajo de la card — el .pen del passenger exige descubribilidad real. */}
        <EnterView index={0}>
          <View style={{gap: theme.spacing.sm}}>
            <Card variant="filled">
              <View style={styles.identityRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('profile.editProfile')}
                  onPress={openEdit}>
                  <Avatar
                    uri={profile.photoUrl ?? undefined}
                    name={hasName ? displayName : undefined}
                    size="xl"
                  />
                </Pressable>

                <View style={styles.identityInfo}>
                  {hasName ? (
                    <View style={styles.nameRow}>
                      <Text variant="title3" numberOfLines={1} style={styles.nameText}>
                        {displayName}
                      </Text>
                      {/* Verificado KYC (pen c4cChO): badge-check en success junto al nombre — verificación
                          sutil, un solo acento (espejo del ProfileIdentityCard del conductor). */}
                      {verified ? (
                        <View accessibilityLabel={t('profile.identityConfirmed')}>
                          <IconBadgeCheck color={success} size={16} />
                        </View>
                      ) : null}
                    </View>
                  ) : (
                    // El dato faltante ES la invitación: CTA explícito, no un misterio.
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('profile.addName')}
                      onPress={openEdit}
                      style={styles.addNameCta}>
                      <Text variant="title3" color="accent">
                        {t('profile.addName')}
                      </Text>
                    </Pressable>
                  )}

                  {/* CALIFICACIÓN RECIBIDA · estrella accent + score + viajes. Vacío honesto si no tiene. */}
                  {hasRating ? (
                    <View
                      accessible
                      accessibilityLabel={`${ratingScore} · ${
                        aggregate!.count30d === 1
                          ? t('profile.ratingCountOne')
                          : t('profile.ratingCountMany', {count: aggregate!.count30d})
                      }`}
                      style={styles.ratingRow}>
                      <IconStarFilled color={accent} size={16} />
                      <Text variant="bodyStrong" color="ink" tabular>
                        {ratingScore}
                      </Text>
                      <Text variant="footnote" color="inkMuted">
                        {'· '}
                        {aggregate!.count30d === 1
                          ? t('profile.ratingCountOne')
                          : t('profile.ratingCountMany', {
                              count: aggregate!.count30d,
                            })}
                      </Text>
                    </View>
                  ) : ratingEmpty ? (
                    <Text variant="footnote" color="inkSubtle">
                      {t('profile.ratingNone')}
                    </Text>
                  ) : null}

                  {/* Contacto + documento en UNA línea muted (identidad secundaria). */}
                  {contact ? (
                    <Text variant="footnote" color="inkMuted" numberOfLines={1} tabular>
                      {contact}
                      {maskedDocument
                        ? ` · ${t(`profile.docType.${profile.documentType ?? 'DN'}`)} ${maskedDocument}`
                        : ''}
                    </Text>
                  ) : maskedDocument ? (
                    <Text variant="footnote" color="inkSubtle" tabular>
                      {t(`profile.docType.${profile.documentType ?? 'DN'}`)} {maskedDocument}
                    </Text>
                  ) : null}
                </View>
              </View>
            </Card>

            {/* Affordance VISIBLE de edición (ghost chico, IZQUIERDA) — no escondida tras el avatar. */}
            <Button
              label={t('profile.editProfile')}
              variant="ghost"
              size="sm"
              leftIcon={<IconPencil color={accent} size={16} />}
              onPress={openEdit}
              style={styles.editBtn}
            />
          </View>
        </EnterView>

        {/* FRANJA DE COMPLETITUD · solo si falta algo (completo = silencio). Guía, no castigo. */}
        {missingSteps.length > 0 ? (
          <EnterView index={1}>
            <Card variant="elevated" padding="md">
              <View style={{gap: theme.spacing.sm}}>
                <View style={{gap: 2}}>
                  <Text variant="headline">{t('profile.completionTitle')}</Text>
                  <Text variant="footnote" color="inkMuted">
                    {t('profile.completionSubtitle')}
                  </Text>
                </View>
                <View style={styles.chipRow}>
                  {missingSteps.map(step => (
                    <Pressable
                      key={step}
                      accessibilityRole="button"
                      accessibilityLabel={stepLabel[step]}
                      onPress={() => openStep(step)}
                      style={[
                        styles.chip,
                        {
                          borderColor: theme.colors.border,
                          backgroundColor: theme.colors.surfaceElevated,
                        },
                      ]}>
                      <View
                        style={[styles.chipDot, {backgroundColor: accent}]}
                      />
                      <Text variant="footnote" color="ink">
                        {stepLabel[step]}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </Card>
          </EnterView>
        ) : null}

        {/* VERIFICACIÓN con voz propia · card de invitación SOLO si no está verificado. Sin verificar
            no es un error: es un momento diseñado ("Confirmá que sos vos"). */}
        {!verified ? (
          <EnterView index={2}>
            <Card variant="elevated" padding="md">
              <View style={styles.verifyCard}>
                <View
                  style={[
                    styles.verifyIconWrap,
                    {backgroundColor: theme.colors.surfaceElevated},
                  ]}>
                  <IconShield color={accent} size={22} />
                </View>
                <View style={styles.verifyCopy}>
                  <Text variant="headline">{t('profile.verifyCardTitle')}</Text>
                  <Text variant="footnote" color="inkMuted">
                    {t('profile.verifyCardBody')}
                  </Text>
                </View>
              </View>
              <Button
                label={t('profile.verifyCardCta')}
                variant="accent"
                fullWidth
                size="sm"
                onPress={() => navigation.navigate('KycCamera')}
                style={{marginTop: theme.spacing.sm}}
              />
            </Card>
          </EnterView>
        ) : null}

        {/* Seguridad */}
        <EnterView index={3}>
          <View>
            {sectionLabel(t('profile.sectionSecurity'))}
            <ListGroup>
              <ListItem
                title={t('profile.faceVerification')}
                subtitle={t('profile.faceVerificationSub')}
                leading={<IconFaceScan color={accent} size={glyph} />}
                trailing={
                  verified ? (
                    <StatusPill
                      label={t('profile.verifiedPill')}
                      tone="success"
                      dot
                    />
                  ) : undefined
                }
                chevron={!verified}
                onPress={() => navigation.navigate('KycCamera')}
              />
              <ListItem
                title={t('profile.trustedContacts')}
                subtitle={t('profile.trustedContactsSub')}
                leading={<IconUsers color={accent} size={glyph} />}
                chevron
                onPress={() => navigation.navigate('TrustedContacts')}
              />
              <ListItem
                title={t('profile.childMode')}
                subtitle={t('profile.childModeSub')}
                leading={<IconChild color={accent} size={glyph} />}
                chevron
                onPress={() => navigation.navigate('ChildMode')}
              />
              <ListItem
                title={t('profile.cameraControl')}
                subtitle={t('profile.cameraControlSub')}
                leading={<IconCamera color={accent} size={glyph} />}
                trailing={
                  <StatusPill
                    label={t('profile.comingSoonTitle')}
                    tone="neutral"
                  />
                }
                onPress={() => setComingSoon('cameraControl')}
              />
              {/* "Compartir viaje" NO es "próximamente" — es REAL y vive en la pantalla del viaje activo.
                  Acá es una fila INFORMATIVA honesta (educación de la feature de seguridad), sin pill falsa. */}
              <ListItem
                title={t('profile.shareTrip')}
                subtitle={t('profile.shareTripSub')}
                leading={<IconShare color={accent} size={glyph} />}
              />
            </ListGroup>
          </View>
        </EnterView>

        {/* Preferencias */}
        <EnterView index={4}>
          <View>
            {sectionLabel(t('profile.sectionPreferences'))}
            <ListGroup>
              {/* "Mis viajes": tras quitar el bottom tab, el historial se alcanza desde acá (decisión de
                  producto). Navega a la pantalla `TripHistory` del stack. */}
              <ListItem
                title={t('profile.tripHistory')}
                leading={<IconReceipt color={accent} size={glyph} />}
                chevron
                onPress={() => navigation.navigate('TripHistory')}
              />
              <ListItem
                title={t('profile.paymentMethods')}
                leading={<IconCard color={accent} size={glyph} />}
                chevron
                onPress={() => navigation.navigate('PaymentMethods')}
              />
              <ListItem
                title={t('profile.savedPlaces')}
                leading={<IconPin color={accent} size={glyph} />}
                chevron
                onPress={() => navigation.navigate('SavedPlaces')}
              />
              {/* "Viajes programados" se quitó: los programados viven en el tab Viajes>Próximos
                  del bottom nav (consolidación — la pantalla aparte se eliminó). */}
              <ListItem
                title={t('profile.referrals')}
                leading={<IconGift color={accent} size={glyph} />}
                chevron
                onPress={() => navigation.navigate('Referrals')}
              />
              {/* Notificaciones (per pen Profile · bell = PREFERENCIAS): navega a NotificationPrefs.
                  El subtítulo sigue reflejando el estado REAL del permiso del SO (honesto); la acción
                  de activar/ir a Ajustes ahora vive DENTRO de la pantalla de preferencias (banner). */}
              <ListItem
                title={t('profile.notifications')}
                subtitle={
                  push.status === 'granted'
                    ? t('profile.notificationsOn')
                    : push.status === 'denied'
                      ? t('profile.notificationsDenied')
                      : push.status === 'loading'
                        ? '…'
                        : t('profile.notificationsOff')
                }
                leading={<IconBell color={accent} size={glyph} />}
                chevron
                onPress={() => navigation.navigate('NotificationPrefs')}
              />
              {/* Avisos: el FEED (pantalla 'Notifications') no pierde su acceso al mover la campana
                  del pen a preferencias. */}
              <ListItem
                title={t('profile.notificationsFeed')}
                leading={<IconBell color={accent} size={glyph} />}
                chevron
                onPress={() => navigation.navigate('Notifications')}
              />
              {/* Idioma y región (pen c4cChO, icono globe). Sin selector real todavía: sheet honesto
                  que dice la verdad ("la app está en español (Perú)"), patrón cameraControl. */}
              <ListItem
                title={t('profile.languageRegion')}
                leading={<IconGlobe color={accent} size={glyph} />}
                trailing={
                  <StatusPill
                    label={t('profile.comingSoonTitle')}
                    tone="neutral"
                  />
                }
                onPress={() => setComingSoon('language')}
              />
            </ListGroup>
          </View>
        </EnterView>

        {/* Promociones (opt-in marketing · Ley 29733 + topic FCM `promos`) */}
        <EnterView index={5}>
          <View>
            {sectionLabel(t('profile.sectionPromotions'))}
            <ListGroup>
              <ListItem
                title={t('profile.promotions')}
                subtitle={t('profile.promotionsSub')}
                leading={<IconGift color={accent} size={glyph} />}
                trailing={
                  <Switch
                    value={marketingOn}
                    onValueChange={onToggleMarketing}
                    disabled={
                      consentQuery.isLoading || marketingMutation.isPending
                    }
                    accessibilityLabel={t('profile.promotions')}
                  />
                }
              />
            </ListGroup>
          </View>
        </EnterView>

        {/* Cuenta */}
        <EnterView index={6}>
          <View>
            {sectionLabel(t('profile.sectionAccount'))}
            <ListGroup>
              <ListItem
                title={t('profile.accessibility')}
                leading={<IconAccessibility color={accent} size={glyph} />}
                trailing={
                  <StatusPill
                    label={t('profile.comingSoonTitle')}
                    tone="neutral"
                  />
                }
                onPress={() => setComingSoon('accessibility')}
              />
              <ListItem
                title={t('profile.help')}
                leading={<IconHelp color={accent} size={glyph} />}
                chevron
                onPress={() => navigation.navigate('Help')}
              />
              {/* Términos y privacidad (pen c4cChO, icono file-text), ANTES de eliminar cuenta.
                  No existe URL de términos/política en config/env (gap reportado): mientras no la
                  haya, sheet coming-soon honesto en vez de un Linking.openURL a la nada. */}
              <ListItem
                title={t('profile.termsPrivacy')}
                leading={<IconFileText color={accent} size={glyph} />}
                trailing={
                  <StatusPill
                    label={t('profile.comingSoonTitle')}
                    tone="neutral"
                  />
                }
                onPress={() => setComingSoon('terms')}
              />
              <ListItem
                title={t('profile.deletion')}
                leading={<IconTrash color={danger} size={glyph} />}
                chevron
                onPress={() => setDeletionOpen(true)}
              />
              <ListItem
                title={t('profile.logout')}
                leading={<IconPower color={danger} size={glyph} />}
                onPress={() => setLogoutOpen(true)}
              />
            </ListGroup>
          </View>
        </EnterView>
      </ScrollView>

      {/* Editar perfil (botón explícito o tap en cabecera) */}
      <BottomSheet
        visible={editOpen}
        onClose={() => setEditOpen(false)}
        title={t('profile.editTitle')}
        footer={
          <Button
            label={t('actions.save')}
            fullWidth
            loading={updateMutation.isPending}
            disabled={!canSaveEdit}
            onPress={() => {
              if (!canSaveEdit) {
                setTouched(true);
                return;
              }
              updateMutation.mutate();
            }}
          />
        }>
        <View style={{gap: theme.spacing.md}}>
          {updateMutation.isError ? (
            <Banner tone="danger" title={t('profile.saveError')} />
          ) : null}
          <TextField
            label={t('profile.nameLabel')}
            placeholder={t('profile.namePlaceholder')}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            value={name}
            onChangeText={setName}
            error={touched && !nameValid ? t('profile.invalidName') : undefined}
          />
          <TextField
            label={t('profile.emailLabel')}
            placeholder={t('profile.emailPlaceholder')}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            textContentType="emailAddress"
            value={email}
            onChangeText={setEmail}
            error={
              touched && !emailValid ? t('profile.invalidEmail') : undefined
            }
          />
          {/* Documento de identidad (para la vinculación de Yape de UN TAP). Opcional: si lo cargás,
              se persiste vía PATCH /users/me y vinculas Yape con un solo toque. */}
          <DocumentField
            documentType={documentType}
            onChangeDocumentType={setDocumentType}
            document={document}
            onChangeDocument={setDocument}
            error={
              touched && !documentValid
                ? t('profile.invalidDocument')
                : undefined
            }
            note={t('profile.documentNote')}
          />
        </View>
      </BottomSheet>

      {/* Verificación de celular (altas por correo/Google/Apple sin teléfono). */}
      <PhoneVerificationSheet
        visible={phoneOpen}
        onClose={() => setPhoneOpen(false)}
      />

      {/* Derecho al olvido */}
      <BottomSheet
        visible={deletionOpen}
        onClose={() => setDeletionOpen(false)}
        title={t('profile.deletionTitle')}
        footer={
          deletionMutation.isSuccess ? (
            <Button
              label={t('actions.close')}
              fullWidth
              onPress={() => setDeletionOpen(false)}
            />
          ) : (
            <Button
              label={t('profile.requestDeletion')}
              variant="danger"
              fullWidth
              loading={deletionMutation.isPending}
              onPress={() => deletionMutation.mutate()}
            />
          )
        }>
        <View style={{gap: theme.spacing.md}}>
          {deletionMutation.isSuccess ? (
            <Banner
              tone="success"
              title={t('profile.deletionRequested')}
              description={t('profile.graceUntil', {
                date: formatShortDate(deletionMutation.data.graceUntil),
              })}
            />
          ) : (
            <Text variant="callout" color="inkMuted">
              {t('profile.deletionBody')}
            </Text>
          )}
          {deletionMutation.isError ? (
            <Banner tone="danger" title={t('states.errorBody')} />
          ) : null}
        </View>
      </BottomSheet>

      {/* Cerrar sesión */}
      <BottomSheet
        visible={logoutOpen}
        onClose={() => setLogoutOpen(false)}
        title={t('profile.logoutTitle')}
        footer={
          <View style={{gap: theme.spacing.sm}}>
            <Button
              label={t('profile.logout')}
              variant="danger"
              fullWidth
              loading={logoutMutation.isPending}
              onPress={() => logoutMutation.mutate()}
            />
            <Button
              label={t('actions.cancel')}
              variant="ghost"
              fullWidth
              onPress={() => setLogoutOpen(false)}
            />
          </View>
        }>
        <Text variant="callout" color="inkMuted">
          {t('profile.logoutBody')}
        </Text>
      </BottomSheet>

      {/* Degradación honesta: items del diseño sin pantalla con backend todavía. */}
      <BottomSheet
        visible={comingSoon !== null}
        onClose={() => setComingSoon(null)}
        title={t('profile.comingSoonTitle')}
        footer={
          <Button
            label={t('actions.close')}
            fullWidth
            onPress={() => setComingSoon(null)}
          />
        }>
        <Text variant="callout" color="inkMuted">
          {comingSoon ? t(COMING_SOON_COPY[comingSoon]) : ''}
        </Text>
      </BottomSheet>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  // Identidad en card left-aligned (espejo del ProfileIdentityCard del conductor): avatar + info column.
  identityRow: {flexDirection: 'row', alignItems: 'center', gap: 16},
  identityInfo: {flex: 1, gap: 6},
  nameText: {flexShrink: 1},
  editBtn: {alignSelf: 'flex-start'},
  nameRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  ratingRow: {flexDirection: 'row', alignItems: 'center', gap: 4},
  addNameCta: {paddingVertical: 2},
  chipRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipDot: {width: 6, height: 6, borderRadius: 3},
  verifyCard: {flexDirection: 'row', alignItems: 'center', gap: 12},
  verifyIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verifyCopy: {flex: 1, gap: 2},
});
