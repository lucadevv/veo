import type { DocumentType, YapeAffiliationView } from '@veo/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banner, BottomSheet, Button, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import {
  AffiliationDocumentMissingError,
  AffiliationProfileIncompleteError,
  AffiliationUnsupportedError,
  AffiliationUpstreamUnavailableError,
  AffiliationValidationError,
} from '../../domain/affiliationUsecases';
import { openExternalUrl } from '../../../../shared/utils/linking';
import { usePaymentPrefsStore } from '../stores/paymentPrefsStore';
import { YAPE_AFFILIATION_QUERY_KEY, useYapeAffiliation } from '../hooks/useYapeAffiliation';
import { DocumentField } from './DocumentField';
import { EnterView, SuccessCheck } from './motion';

/** Cadencia del poll mientras esperamos la aprobación en la app Yape (deepLink → ACTIVE vía proveedor). */
const POLL_INTERVAL_MS = 4500;
/**
 * Tope del poll ACTIVO (~2 min). La ventana REAL del deepLink es 15 min, pero la app no se queda
 * encuestando todo ese rato: tras ~2 min mostramos "seguimos esperando, vuelve cuando confirmes" y el
 * GET de la pantalla (al reabrir) resuelve el estado final.
 */
const POLL_TIMEOUT_MS = 120_000;
/** Espera antes del reintento automático tras un 502 transitorio del gateway (Cloudflare del sandbox). */
const UPSTREAM_RETRY_DELAY_MS = 1500;

/** Argumento del alta: `null` = UN TAP (body vacío); objeto = primera vez (documento que se persiste). */
type LinkArg = { documentType: DocumentType; document: string } | null;

export interface YapeLinkSheetProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * SHEET de vinculación de Yape de UN TAP (la joya · patrón PedidosYa · ProntoPaga: documento en PERFIL,
 * no en checkout). Al abrir consulta el PERFIL:
 *
 *  - Perfil con `document` + `name` → CERO campos: título, 2 líneas de copy (cobro automático al
 *    terminar + desactivable) y un botón único "Abrir Yape" → POST `{}` (el server arma todo del perfil)
 *    → `deepLink` → poll (~4.5s) hasta ACTIVE/EXPIRED o el tope (~2 min).
 *  - Falta `document` (o el POST `{}` devuelve 422 `PROFILE_DOCUMENT_MISSING`) → UN campo de documento +
 *    segmento DN/CE/PP + nota "se guardará en tu perfil" → POST `{documentType, document}` (el server lo
 *    PERSISTE → la próxima vez es un tap).
 *  - 422 `PROFILE_NAME_MISSING` → mensaje + CTA "Completar perfil" (navega a CompleteProfile).
 *  - 502 `UPSTREAM_UNAVAILABLE` → reintento automático 1 vez (1.5s); si persiste, mensaje honesto
 *    ("el servicio de Yape está ocupado, probá en un momento"), nunca un error críptico.
 *
 * ACTIVE → feedback sutil (check) + PREGUNTAMOS si lo quiere como predeterminado (TASK 1: NO seteamos
 * solos; el vínculo "automático" y el "predeterminado" son conceptos DISTINTOS). Solo si elige "Sí" →
 * setDefault('YAPE'); si "Ahora no", el vínculo queda pero su preferencia no se toca.
 */
export function YapeLinkSheet({ visible, onClose }: YapeLinkSheetProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation();
  const queryClient = useQueryClient();

  const createAffiliation = useDependency(TOKENS.createYapeAffiliationUseCase);
  const getProfile = useDependency(TOKENS.getProfileUseCase);
  const setDefault = usePaymentPrefsStore((s) => s.setDefault);
  const affiliationQuery = useYapeAffiliation();

  // Perfil del usuario (misma queryKey que ProfileScreen → una sola fuente). Decide el modo del sheet:
  // con documento → UN TAP; sin documento → pedir el campo (y persistirlo en el perfil).
  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile.execute(),
    // Solo lo necesitamos cuando el sheet está abierto.
    enabled: visible,
  });

  const [documentType, setDocumentType] = React.useState<DocumentType>('DN');
  const [document, setDocument] = React.useState('');
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  // El usuario debe cargar su documento (perfil sin documento o 422 PROFILE_DOCUMENT_MISSING).
  const [needsDocument, setNeedsDocument] = React.useState(false);

  // Fases del sheet: form → waiting (poll tras el deepLink) → askDefault (ACTIVE: ¿predeterminado?) →
  // done (cierre con feedback) o timeout. El paso `askDefault` (TASK 1) reemplaza el auto-setDefault.
  const [phase, setPhase] = React.useState<
    'form' | 'waiting' | 'timeout' | 'askDefault' | 'done'
  >('form');
  // Resolución del paso askDefault: 'set' (eligió Yape como predeterminado) | 'kept' (lo dejó igual).
  // Decide el copy del feedback final en la fase `done`.
  const [defaultChoice, setDefaultChoice] = React.useState<'set' | 'kept'>('kept');
  const waitStartedAtRef = React.useRef<number>(0);
  // Reintento automático del 502 (Cloudflare transitorio): 'none' (sin 502 aún) → 'retrying' (502 visto,
  // reintento programado, sin error visible) → 'exhausted' (el reintento también falló → mensaje honesto).
  const [upstreamRetry, setUpstreamRetry] = React.useState<'none' | 'retrying' | 'exhausted'>(
    'none',
  );
  // No se pudo ABRIR Yape para aprobar la afiliación (openURL rechazó: app no instalada / esquema
  // desconocido). Aviso honesto en la fase de espera, sin error crudo (la promesa nunca queda sin catch).
  const [openFailed, setOpenFailed] = React.useState(false);

  // Reinicia el estado interno cada vez que el sheet se abre (sin arrastrar una sesión anterior).
  React.useEffect(() => {
    if (visible) {
      setPhase('form');
      setFieldError(null);
      setNeedsDocument(false);
      setDocument('');
      setDocumentType('DN');
      setUpstreamRetry('none');
      setOpenFailed(false);
      setDefaultChoice('kept');
      createMutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // En cuanto el perfil carga, si NO tiene documento revelamos el campo (modo primera vez). Si lo tiene,
  // el botón "Abrir Yape" dispara el flujo de UN TAP (POST {}).
  React.useEffect(() => {
    if (profileQuery.data && !profileQuery.data.document) {
      setNeedsDocument(true);
    }
  }, [profileQuery.data]);

  const setAffiliationCache = React.useCallback(
    (view: YapeAffiliationView) => {
      queryClient.setQueryData(YAPE_AFFILIATION_QUERY_KEY, view);
    },
    [queryClient],
  );

  const createMutation = useMutation<YapeAffiliationView, Error, LinkArg>({
    // El usecase valida (throw `AffiliationValidationError`) ANTES de tocar la red; react-query enruta
    // ese throw a `onError`. `arg === null` ⇒ UN TAP (body vacío, el server lo resuelve del perfil).
    mutationFn: (arg) =>
      Promise.resolve().then(() =>
        createAffiliation.execute(arg ?? undefined),
      ),
    onError: (err, arg) => {
      if (err instanceof AffiliationValidationError) {
        setFieldError(err.message);
        return;
      }
      // 422 PROFILE_DOCUMENT_MISSING en el flujo de UN TAP → revelamos el campo de documento.
      if (err instanceof AffiliationDocumentMissingError) {
        setNeedsDocument(true);
        return;
      }
      // 502 transitorio del gateway → reintento automático UNA vez (mismo arg) tras un respiro. Mientras
      // tanto NO mostramos error (estado 'retrying'); si el reintento también falla, pasa a 'exhausted'.
      if (err instanceof AffiliationUpstreamUnavailableError && upstreamRetry !== 'exhausted') {
        if (upstreamRetry === 'none') {
          setUpstreamRetry('retrying');
          setTimeout(() => createMutation.mutate(arg), UPSTREAM_RETRY_DELAY_MS);
        } else {
          // Ya estábamos reintentando y volvió a caer: agotado → mensaje honesto.
          setUpstreamRetry('exhausted');
        }
        return;
      }
      // PROFILE_NAME_MISSING / unsupported / genérico se leen del `error` abajo.
    },
    onSuccess: (view) => {
      setAffiliationCache(view);
      if (view.deepLink) {
        // Captura el rechazo de openURL (Yape no instalada / esquema desconocido): sin catch, subía como
        // unhandled rejection. Si no abre, lo reflejamos en la fase de espera ("no pudimos abrir Yape").
        void openExternalUrl(view.deepLink).then((ok) => setOpenFailed(!ok));
      }
      if (view.status.toUpperCase() === 'ACTIVE') {
        onActive();
        return;
      }
      waitStartedAtRef.current = Date.now();
      setPhase('waiting');
    },
  });

  // ── ACTIVE: el cobro queda automático. TASK 1: NO seteamos el predeterminado solos — PREGUNTAMOS.
  // El vínculo "automático" (On-File) y el "predeterminado" (con qué pagas siempre) son conceptos
  // DISTINTOS; mezclarlos confunde. Pasamos al paso `askDefault` para que el usuario decida.
  const onActive = React.useCallback(() => {
    setPhase('askDefault');
  }, []);

  // "Sí, usar Yape" → recién acá tocamos la preferencia (setDefault) y mostramos el feedback de cierre.
  const onChooseDefault = React.useCallback(() => {
    setDefault('YAPE');
    setDefaultChoice('set');
    setPhase('done');
    setTimeout(onClose, 1300);
  }, [setDefault, onClose]);

  // "Ahora no" → el vínculo queda, la preferencia NO se toca. Feedback honesto y cierre.
  const onKeepDefault = React.useCallback(() => {
    setDefaultChoice('kept');
    setPhase('done');
    setTimeout(onClose, 1300);
  }, [onClose]);

  // ── Poll de la espera: refresca el GET hasta ACTIVE/EXPIRED o el tope (~2 min → "seguimos esperando") ─
  // Solo mientras el sheet está VISIBLE: al cerrarlo paramos de encuestar (el GET de la pantalla, al
  // reabrir, resuelve el estado final) y liberamos el interval.
  React.useEffect(() => {
    if (!visible || phase !== 'waiting') {
      return;
    }
    const id = setInterval(() => {
      if (Date.now() - waitStartedAtRef.current > POLL_TIMEOUT_MS) {
        setPhase('timeout');
        return;
      }
      void affiliationQuery.refetch().then((res) => {
        const status = res.data?.status?.toUpperCase();
        if (status === 'ACTIVE') {
          onActive();
        } else if (status === 'EXPIRED' || status === 'REVOKED') {
          setPhase('timeout');
        }
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [visible, phase, affiliationQuery, onActive]);

  const isUnsupported = createMutation.error instanceof AffiliationUnsupportedError;
  const isProfileIncomplete = createMutation.error instanceof AffiliationProfileIncompleteError;
  const isValidationError = createMutation.error instanceof AffiliationValidationError;
  // 502 persistente: ya reintentamos automáticamente y volvió a fallar (estado 'exhausted').
  const isUpstreamUnavailable = upstreamRetry === 'exhausted';
  const isDocMissing = createMutation.error instanceof AffiliationDocumentMissingError;
  const isGenericError =
    createMutation.isError &&
    !isUnsupported &&
    !isProfileIncomplete &&
    !isValidationError &&
    !(createMutation.error instanceof AffiliationUpstreamUnavailableError) &&
    !isDocMissing;

  const deepLink = affiliationQuery.data?.deepLink;
  // 'retrying' = el respiro antes del reintento automático: lo tratamos como "abriendo" (sin error).
  const busy = createMutation.isPending || upstreamRetry === 'retrying';

  function onSubmit(): void {
    setFieldError(null);
    setUpstreamRetry('none');
    // Modo primera vez: mandamos el documento (el server lo persiste). Modo UN TAP: body vacío.
    createMutation.mutate(needsDocument ? { documentType, document } : null);
  }

  function goToProfile(): void {
    onClose();
    // `CompleteProfile` SOLO existe en el stack PRE-Main; este sheet vive en Main, así que navegar a
    // esa ruta tiraba un error de navegación. El destino correcto en Main es el tab Perfil: allí la
    // franja de completitud invita a "Agregá tu nombre" y abre la edición (descubribilidad real).
    navigation.navigate('Main', { screen: 'Profile' });
  }

  // ── Render por fase ────────────────────────────────────────────────────────────────────────────
  let body: React.ReactNode;

  if (phase === 'askDefault') {
    // TASK 1 · El vínculo quedó ACTIVE. Preguntamos (no seteamos solos) si lo quiere de predeterminado.
    // Distinción léxica clara: "vinculado" (automático) vs "predeterminado" (con qué pagas siempre).
    body = (
      <View style={{ gap: theme.spacing.md, paddingVertical: theme.spacing.sm }}>
        <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
          <SuccessCheck />
          <Text variant="title3" style={styles.center}>
            {t('payments.auto.askDefaultTitle')}
          </Text>
        </View>
        <Text variant="callout" color="inkMuted" style={styles.center}>
          {t('payments.auto.askDefaultBody')}
        </Text>
        <View style={{ gap: theme.spacing.sm }}>
          <Button
            label={t('payments.auto.askDefaultYes')}
            variant="accent"
            fullWidth
            onPress={onChooseDefault}
          />
          <Button
            label={t('payments.auto.askDefaultNo')}
            variant="ghost"
            fullWidth
            onPress={onKeepDefault}
          />
        </View>
      </View>
    );
  } else if (phase === 'done') {
    // El copy del feedback final depende de si eligió usar Yape de predeterminado o lo dejó igual.
    const setDefaulted = defaultChoice === 'set';
    body = (
      <View style={{ alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing.lg }}>
        <SuccessCheck />
        <Text variant="title3" style={styles.center}>
          {t(setDefaulted ? 'payments.auto.askDefaultDoneTitle' : 'payments.auto.askDefaultKeptTitle')}
        </Text>
        <Text variant="callout" color="inkMuted" style={styles.center}>
          {t(setDefaulted ? 'payments.auto.askDefaultDoneBody' : 'payments.auto.askDefaultKeptBody')}
        </Text>
      </View>
    );
  } else if (phase === 'waiting' || phase === 'timeout') {
    const timedOut = phase === 'timeout';
    body = (
      <View style={{ gap: theme.spacing.md }}>
        <Banner
          tone={timedOut ? 'info' : 'warn'}
          title={t(timedOut ? 'payments.auto.waitingTimeoutTitle' : 'payments.auto.waitingTitle')}
          description={t(timedOut ? 'payments.auto.waitingTimeoutBody' : 'payments.auto.waitingBody')}
        />
        {/* Yape no abrió (app no instalada / esquema desconocido): aviso honesto, no error crudo. */}
        {openFailed ? (
          <Banner
            tone="warn"
            title={t('payments.auto.openFailedTitle')}
            description={t('payments.auto.openFailedBody')}
          />
        ) : null}
        {deepLink ? (
          <Button
            label={t('payments.auto.openYape')}
            variant="secondary"
            fullWidth
            onPress={() => {
              void openExternalUrl(deepLink).then((ok) => setOpenFailed(!ok));
            }}
          />
        ) : null}
        <Button label={t('payments.auto.close')} variant="ghost" fullWidth onPress={onClose} />
      </View>
    );
  } else if (profileQuery.isLoading) {
    // El perfil decide el modo (un tap vs pedir documento): mientras carga, un respiro sutil.
    body = (
      <View style={{ alignItems: 'center', paddingVertical: theme.spacing.xl }}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  } else if (isProfileIncomplete) {
    // 422 PROFILE_NAME_MISSING: el perfil no tiene nombre → CTA al perfil (no error de campo).
    body = (
      <View style={{ gap: theme.spacing.lg }}>
        <View style={{ gap: theme.spacing.sm }}>
          <Banner
            tone="info"
            title={t('payments.auto.profileIncompleteTitle')}
            description={t('payments.auto.profileIncompleteBody')}
          />
          <Button
            label={t('payments.auto.goToProfile')}
            variant="primary"
            fullWidth
            onPress={goToProfile}
          />
        </View>
      </View>
    );
  } else if (isUnsupported) {
    // Capacidad no habilitada en el comercio (422 GATEWAY_CAPABILITY_UNAVAILABLE): NO es error ni
    // transitorio. Banner INFO honesto y calmo, SIN el CTA "Abrir Yape" (no hay nada que abrir: la
    // afiliación no andará hasta que el proveedor habilite el producto). Nada de "reintenta".
    body = (
      <Banner
        tone="info"
        title={t('payments.auto.unsupportedTitle')}
        description={t('payments.auto.unsupportedBody')}
      />
    );
  } else {
    // phase === 'form' (un tap o primera vez con documento).
    body = (
      <View style={{ gap: theme.spacing.lg }}>
        {/* Explicación de 2 líneas: el consentimiento del cargo automático va INTEGRADO al copy. */}
        <View style={{ gap: 4 }}>
          <Text variant="callout" color="inkMuted">
            {t('payments.auto.linkIntro1')}
          </Text>
          <Text variant="callout" color="inkMuted">
            {t('payments.auto.linkIntro2')}
          </Text>
        </View>

        {/* Solo la PRIMERA vez (perfil sin documento o 422): el campo que se persiste en el perfil. */}
        {needsDocument ? (
          <DocumentField
            documentType={documentType}
            onChangeDocumentType={setDocumentType}
            document={document}
            onChangeDocument={setDocument}
            error={fieldError ?? undefined}
            note={t('payments.auto.documentSavedNote')}
          />
        ) : null}

        {isUpstreamUnavailable ? (
          <Banner tone="warn" title={t('payments.auto.upstreamBusy')} />
        ) : null}
        {isGenericError ? <Banner tone="danger" title={t('payments.auto.error')} /> : null}

        <Button
          label={busy ? t('payments.auto.submitting') : t('payments.auto.openYape')}
          variant="accent"
          fullWidth
          loading={busy}
          onPress={onSubmit}
        />
      </View>
    );
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('payments.auto.linkTitle')}>
      <EnterView offsetY={6}>{body}</EnterView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  center: { textAlign: 'center' },
});
