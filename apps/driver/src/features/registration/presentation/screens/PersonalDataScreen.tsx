import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { IconDocument } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import type { RegistrationStackParamList } from '../../../../navigation/types';
import {
  DocumentUploadStatus,
  RegistrationStep,
  registrationDocTypeToBackend,
  serverHasAcceptableDoc,
  type RegistrationDocumentServerStatus,
  type RegistrationDocumentType,
} from '../../domain';
import {
  deriveDocumentPhase,
  useRegistrationStore,
  type DocumentSendPhase,
} from '../state/registrationStore';
import { usePersonalDataContinue, type DeferredDocument } from '../hooks/usePersonalDataContinue';
import { useDniSubmit } from '../hooks/useDniSubmit';
import { useLicenseSubmit } from '../hooks/useLicenseSubmit';
import { DriverExistence, useDriverExists } from '../hooks/useDriverExists';
import { useRegistrationExit } from '../hooks/useRegistrationExit';
import { useRegistrationExitGuard } from '../hooks/useRegistrationExitGuard';
import { useRegistrationDocuments } from '../hooks/useRegistrationDocuments';
import { ORDERED_STEPS } from '../../../../navigation/registrationStackRoutes';
import { useRegistrationWizardPageOptional } from './RegistrationWizardContext';
import {
  DocumentUploadCard,
  firstMissingRequirement,
  RegistrationExitSheet,
  RegistrationHeader,
  RegistrationProgress,
  ScanDniSheet,
  ScanLicenseSheet,
  type DocumentCardTone,
  type StepRequirement,
} from '../components';

// `Partial`: en modo EMBEBIDO (wizard) la pantalla se renderiza SIN `navigation`/`route` (no es una ruta). En
// modo STANDALONE (tests, o si volviera a rutearse) llegan normales. La navegación solo se usa standalone.
type Props = Partial<NativeStackScreenProps<RegistrationStackParamList, 'PersonalData'>>;

/** Etiqueta del wizard de la LICENCIA de conducir (documento del CONDUCTOR; mapea a LICENSE_A1). */
const LICENSE_DOC_TYPE: RegistrationDocumentType = 'LICENSE';

/** Etiqueta del wizard del DNI (documento del CONDUCTOR; mapea a DNI). */
const DNI_DOC_TYPE: RegistrationDocumentType = 'DNI';

/**
 * Mapea el documento DIFERIDO que falló (`DeferredDocument`, discriminador tipado del continue) a su
 * etiqueta del wizard, para revertir su flag LOCAL al estado real cuando la subida falla (sub-fix #F: el
 * chip no debe mentir "Subido" si el server no lo tiene). Sin string mágico: el mapa es exhaustivo.
 */
const DEFERRED_DOC_TO_WIZARD_TYPE: Record<DeferredDocument, RegistrationDocumentType> = {
  dni: DNI_DOC_TYPE,
  license: LICENSE_DOC_TYPE,
};

/** Tono del chip según el `simpleStatus` real del documento (espeja el dominio de documentos). */
function serverStatusTone(status: RegistrationDocumentServerStatus): DocumentCardTone {
  switch (status) {
    case 'vigente':
      return 'success';
    case 'por_vencer':
      return 'warn';
    case 'vencido':
    case 'rechazado':
      return 'danger';
    case 'en_revision':
    default:
      return 'neutral';
  }
}

/**
 * Paso 1 del alta · CONDUCTOR (LOTE B · reagrupación por dueño del documento). Reúne los documentos del
 * CONDUCTOR: el DNI (scan-first, onboarding SIN formularios · Lote 1) Y la LICENCIA de conducir (bajada
 * desde el viejo paso "Documentos"). El conductor ESCANEA el DNI (OCR lee nombre/DNI/nacimiento → tarjeta
 * "Capturado ✓" READ-ONLY) y ESCANEA la licencia (reusa el componente CANÓNICO `RegistrationDocumentSheet`
 * + el parser `parseLicense` calibrado en Lote A). Al continuar: `PATCH /drivers/me/personal` + subida
 * DIFERIDA del DNI Y de la LICENCIA (escanear solo GUARDA en `pendingLicense`; la subida + el
 * `POST /drivers/onboard` ocurren en el "Continuar", tras el PATCH que crea el driver — espejo del DNI,
 * porque para un conductor nuevo el presign de la licencia da 404 si se sube en el escaneo). El gating del
 * "Continuar" exige DNI leído + licencia capturada (pendiente de subir, subida local, o ya en el servidor).
 */
export const PersonalDataScreen = ({ navigation }: Props = {}): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  // Modo dual: si hay contexto del wizard, la pantalla está EMBEBIDA en el pager (publica su footer y avanza
  // con `goNext`); si es `null`, corre STANDALONE (chrome propio). El índice de su página sale del orden tipado.
  const wizard = useRegistrationWizardPageOptional();
  const pageIndex = ORDERED_STEPS.indexOf(RegistrationStep.PERSONAL_DATA);
  const personal = useRegistrationStore((s) => s.personal);
  // Las caras del DNI escaneado (anverso = miniatura de la tarjeta "DNI capturado ✓"). Es la fuente de
  // verdad de "se capturó un DNI" INDEPENDIENTE del OCR: la imagen viaja aunque el texto no se lea.
  const pendingDni = useRegistrationStore((s) => s.pendingDni);
  const setCurrentStep = useRegistrationStore((s) => s.setCurrentStep);
  // Orquesta el continue: PATCH /personal (crea el driver) → subida DIFERIDA del DNI escaneado (con su
  // `extractedData`). La subida NO puede pasar antes del PATCH (el presign exige que el driver exista).
  const personalContinue = usePersonalDataContinue();
  // Lote 1: subida EAGER del DNI en su propio sheet (checkDni → PATCH → subir DNI con fase por cara). Se
  // dispara al CONFIRMAR el DNI (`onDniConfirmed`), no al Continuar; el continue ya no re-sube el DNI.
  const dniSubmit = useDniSubmit();
  // Lote 3: subida EAGER de la licencia en su propio sheet (subir por cara + onboard). Se dispara al
  // CONFIRMAR la licencia; requiere que el driver EXISTA (lo crea el DNI) — si no, devuelve `needs-dni`.
  const licenseSubmit = useLicenseSubmit();

  // Salida de emergencia del onboarding: paso 1 es una pantalla RAÍZ (sin back de navegación).
  const exit = useRegistrationExit();
  // Embebido en el wizard: el guard de hardware-back lo monta el HOST. Solo standalone registra el suyo.
  useRegistrationExitGuard(exit.handleHardwareBack, !wizard);

  // LICENCIA (doc del conductor · LOTE B). La subida + onboarding se DIFIEREN al "Continuar" (espejo del
  // DNI): para un conductor NUEVO el driver no existe hasta el PATCH /personal, así que subir en el escaneo
  // daba 404 "no existe perfil". Acá el escaneo solo GUARDA la captura en `pendingLicense`; el chip de estado
  // de servidor y el 409-como-éxito viven en el continue (`usePersonalDataContinue`).
  const documents = useRegistrationStore((s) => s.documents);
  const setDocumentStatus = useRegistrationStore((s) => s.setDocumentStatus);
  const pendingLicense = useRegistrationStore((s) => s.pendingLicense);
  const setPendingLicense = useRegistrationStore((s) => s.setPendingLicense);
  // Fase de ENVÍO visible de cada documento (pen: "Subiendo… / Enviado / Error al enviar"). La escribe
  // `usePersonalDataContinue` alrededor de cada subida; acá alimenta los chips y el sheet del DNI.
  const sendPhases = useRegistrationStore((s) => s.sendPhases);
  // Fase DERIVADA por documento (a partir de las fases POR CARA): 'sent' solo si todas las caras no-idle
  // están enviadas. Es la señal escalar que consumen los chips, subtítulos y el gating (sin strings sueltos).
  const dniPhase = deriveDocumentPhase(sendPhases.dni);
  const licensePhase = deriveDocumentPhase(sendPhases.license);
  const serverDocs = useRegistrationDocuments();
  // ¿El SERVIDOR ya tiene al conductor? Señal TIPADA derivada de `GET /drivers/me` (comparte el cache del
  // gate). Unifica la fuente de verdad del continue: en RESUME (driver existe) NO se re-PATCHea (los datos
  // personales ya están server-side y el `personal` local vacío rompía la validación); en alta FRESCA el
  // PATCH crea el driver. Es la pieza que mata el dead-end "los datos leídos no son válidos".
  const driverExistence = useDriverExists();

  const [serverError, setServerError] = useState<unknown>(null);
  // El PATCH /personal creó el driver, pero una subida DIFERIDA (DNI o licencia) falló. NO perdemos la
  // captura (sigue en `pendingDni`/`pendingLicense`): aviso + reintento al volver a tocar Continuar (PATCH
  // idempotente). `null` = sin fallo; si no, el documento que falló (para pintar el aviso correcto).
  const [uploadFailedDoc, setUploadFailedDoc] = useState<DeferredDocument | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  // Bloqueo por DNI duplicado (resultado `dni-taken` de `useDniSubmit`, del pre-check `check-dni`): el sheet
  // del DNI lo pinta en rojo. Se limpia al reabrir el sheet y al reescanear otro documento.
  const [dniTaken, setDniTaken] = useState(false);
  // Fallo del pre-check/PATCH en la subida EAGER del DNI (red/servidor, NO duplicado): el sheet lo muestra +
  // ofrece reintento (honestidad — sin esto el sheet quedaba mudo tras un fallo de verificación).
  const [dniSubmitError, setDniSubmitError] = useState(false);
  // Lote 3: la licencia se intentó ANTES que el DNI (driver aún no creado) → el sheet avisa "primero el DNI".
  const [licenseNeedsDni, setLicenseNeedsDni] = useState(false);

  // Apertura del sheet EAGER de la licencia (`ScanLicenseSheet`): escanea → sube por cara → onboard. El
  // estado de envío vive en las fases por-cara del store (`sendPhases.license`); acá solo su visibilidad.
  const [licenseSheetOpen, setLicenseSheetOpen] = useState(false);

  /** ¿El servidor YA tiene el DNI en un estado aceptable? (conductor que vuelve/reinstala). */
  const serverHasDni = serverHasAcceptableDoc(serverDocs.data, 'DNI');
  // El DNI cuenta como "hecho" si el número está poblado (tipeado/escaneado/HIDRATADO desde el server) O
  // el servidor YA lo tiene válido — MISMO criterio server-aware que la licencia. Antes solo miraba el
  // estado LOCAL de sesión (`personal.dni`, vacío al reanudar) y por eso re-pedía el DNI aunque ya estuviera
  // enviado, mientras la licencia (server-aware) NO se re-pedía: esa era la incoherencia del resume.
  const hasReadDni = personal.dni.trim().length > 0 || serverHasDni;
  // ¿Se capturó un DNI? La señal es la IMAGEN del anverso en `pendingDni`, NO los campos OCR: la foto del
  // documento viaja aunque el OCR no extraiga texto (p. ej. binario nativo sin la capa OCR). Así NUNCA se
  // muestra una tarjeta "vacía" que parece OK ni se oculta el fallback honesto cuando el OCR no leyó nada.
  const hasCapture = pendingDni != null;
  // Honestidad de estado (espejo de la licencia): el DOCUMENTO del DNI está "listo" SOLO si hay una captura
  // LOCAL viva (`pendingDni`, la imagen que se va a subir), el envío de ESTA sesión ya lo dejó en el server
  // (fase `sent` — inmune a la latencia del refetch de `serverDocs`), O el servidor YA lo tiene.
  // `hasReadDni` (número leído, puede venir de `personal.dni` persistido) NO alcanza: tras un reload el número
  // sobrevive pero la IMAGEN no → diría "listo" sin nada que subir (DNI fantasma). El número se exige aparte.
  const dniDocReady = pendingDni != null || serverHasDni || dniPhase === 'sent';
  // Lote 4 · gating por CHECK: la card del DNI está "en check" SOLO cuando el envío de ESTA sesión la dejó
  // `sent` (o el server ya la tiene, en resume). Captura/subiendo/error (`pending`) NO cuentan — Continuar se
  // activa recién con el check verde, no con la captura, y una subida FALLIDA (pending vivo) no habilita el
  // avance. Es la MISMA condición que pinta el check de la card (`sent` prop), no una regla paralela.
  const dniSent = dniPhase === 'sent' || serverHasDni;

  const dniBackendType = registrationDocTypeToBackend('DNI');
  // Estado de SERVIDOR del DNI para el chip "ya enviado" (mismo patrón que la licencia): al reanudar SIN
  // captura local pero CON el DNI ya en el servidor, mostramos su estado real en vez de re-pedirlo.
  const dniServerState = (() => {
    const match = serverDocs.data?.find((doc) => doc.type === dniBackendType);
    if (!match) {
      return undefined;
    }
    return {
      label: t(`documents.status.${match.simpleStatus}`),
      tone: serverStatusTone(match.simpleStatus),
    };
  })();

  // Opción A · RESUME: URL prefirmada del ANVERSO del DNI ya subido, para previsualizarlo SIN captura local
  // (el backend ordena FRONT=0 → la 1ª imagen es el anverso). `null` si no hay imagen o el presign falló.
  const dniServerImageUri =
    serverDocs.data?.find((doc) => doc.type === dniBackendType)?.images[0]?.url ?? null;

  /**
   * Chip de FASE de envío (pen): mientras hay un envío vivo en esta sesión, la fase manda sobre el estado
   * del servidor (que puede venir con lag de refetch). Exhaustivo por switch — sin strings mágicos sueltos.
   */
  const phaseChip = (
    phase: DocumentSendPhase,
  ): { label: string; tone: DocumentCardTone } | undefined => {
    switch (phase) {
      case 'sending':
        return { label: t('registration.documents.state.sending'), tone: 'accent' };
      case 'sent':
        return { label: t('registration.documents.state.sent'), tone: 'success' };
      case 'error':
        return { label: t('registration.documents.state.sendError'), tone: 'danger' };
      case 'idle':
        return undefined;
    }
  };

  /**
   * Subtítulo de ESTADO de la card (frame Cards del pen): "Subiendo…" (azul) mientras sube, "Enviado"
   * (verde) cuando ya está. Sin subtítulo en pendiente/listo — el chip lo comunica.
   */
  const cardSubtitle = (
    phase: DocumentSendPhase,
    isSent: boolean,
  ): { subtitle?: string; subtitleTone: 'accent' | 'success' } => {
    if (isSent) {
      return { subtitle: t('registration.documents.state.sent'), subtitleTone: 'success' };
    }
    if (phase === 'sending') {
      return { subtitle: t('registration.documents.state.sending'), subtitleTone: 'accent' };
    }
    return { subtitleTone: 'accent' };
  };

  const licenseBackendType = registrationDocTypeToBackend(LICENSE_DOC_TYPE);

  /** ¿El servidor YA tiene la licencia en un estado aceptable? (conductor que vuelve/reinstala). */
  const serverHasLicense = serverHasAcceptableDoc(serverDocs.data, LICENSE_DOC_TYPE);

  // La licencia cuenta como "lista para avanzar" si: hay una captura DIFERIDA pendiente de subir en el
  // continue (`pendingLicense`), O el avance local la marca `uploaded` (resume/hidratación), O el servidor
  // ya la tiene válida. El `pendingLicense` es la señal del flujo nuevo (escaneo → guarda → sube en Continuar).
  // Honestidad de estado (mata la "licencia fantasma"): "lista para avanzar" SOLO si hay una captura LOCAL
  // viva pendiente de subir (`pendingLicense`), O el servidor YA la tiene (`serverHasLicense`). Se DESCARTA el
  // flag local `documents.UPLOADED`: se seteaba OPTIMISTA en el escaneo y SOBREVIVÍA al reload sin su captura
  // (el array `documents` se persiste, la captura no) → mentía "subida" sin que el server la tuviera. Un fallo
  // de subida conserva `pendingLicense` (sigue "lista para enviar/reintentar") y el banner de fallo lo dice.
  const licenseUploaded = pendingLicense != null || serverHasLicense || licensePhase === 'sent';
  // Lote 4 · el check de la licencia (espejo del DNI): `sent` de esta sesión o el server ya la tiene.
  const licenseSent = licensePhase === 'sent' || serverHasLicense;

  // Estado de SERVIDOR de la licencia para el chip (si existe en `GET /drivers/me/documents`).
  const licenseServerState = (() => {
    const match = serverDocs.data?.find((doc) => doc.type === licenseBackendType);
    if (!match) {
      return undefined;
    }
    return {
      label: t(`documents.status.${match.simpleStatus}`),
      tone: serverStatusTone(match.simpleStatus),
    };
  })();

  // Opción A · RESUME: URL prefirmada de la licencia ya subida (para previsualizarla SIN captura local).
  const licenseServerImageUri =
    serverDocs.data?.find((doc) => doc.type === licenseBackendType)?.images[0]?.url ?? null;

  // Gating del paso CONDUCTOR (Lote 4 · "ambas cards en check → Continuar"): avanza SOLO cuando el DNI y la
  // licencia están EN CHECK (`sent` de esta sesión o ya en el server), con el número del DNI leído para el
  // PATCH. La captura o una subida en curso/fallida (`pending`) NO habilitan — el avance espera el check
  // verde de las dos, espejando lo que ve el conductor: recién con los dos ✓ se prende Continuar.
  const canContinue = hasReadDni && dniSent && licenseSent;

  // U3 · CTA que dice QUÉ falta: derivado del MISMO gating (no se duplica la lógica). El orden refleja la
  // SECUENCIA de pasos (1 · DNI, 2 · Licencia): se muestra el PRIMER requisito incumplido, pegado al CTA.
  const personalRequirements: readonly StepRequirement[] = [
    { satisfied: hasReadDni && dniSent, missingKey: 'registration.personal.missing.dni' },
    { satisfied: licenseSent, missingKey: 'registration.personal.missing.license' },
  ];
  const missingKey = firstMissingRequirement(personalRequirements);

  const onContinue = async (): Promise<void> => {
    if (personalContinue.isPending) {
      return;
    }
    // Guarda defensiva además del `disabled`: jamás avanzar sin DNI leído + licencia subida.
    if (!canContinue) {
      return;
    }
    setServerError(null);
    setUploadFailedDoc(null);

    // El hook orquesta el continue según la FUENTE DE VERDAD del server: en RESUME (driver existe) salta el
    // PATCH y solo corre las subidas diferidas (en resume puro no hay pendientes → solo navega); en alta
    // FRESCA hace el PATCH (crea el driver) → subidas. El `unknown` (server sin resolver) degrada a alta
    // fresca (intenta el PATCH): nunca asumimos que el driver existe sin confirmación. El resultado
    // discriminado dice exactamente qué pintar (sin strings mágicos) y si se avanza.
    const result = await personalContinue.submit({
      personal,
      driverExists: driverExistence === DriverExistence.Exists,
    });
    switch (result.status) {
      case 'ok':
        // Embebido: avanza el pager (el host fija el `currentStep`). Standalone: navega a la ruta del paso 2.
        if (wizard) {
          wizard.goNext();
        } else {
          setCurrentStep(RegistrationStep.VEHICLE);
          navigation?.navigate('Vehicle');
        }
        return;
      case 'field-errors':
        // Sin formulario editable no debería ocurrir (el OCR alimenta los campos), pero si el backend
        // valida algo, lo surfaceamos como error de servidor para no dejar al conductor sin feedback.
        setServerError(new Error(t('registration.personal.scanDni.invalidData')));
        return;
      case 'server-error':
        setServerError(result.error);
        return;
      case 'document-upload-failed':
        // El driver YA existe (PATCH OK) pero la subida diferida del DNI o la licencia falló. Conservamos la
        // captura y mostramos el aviso del documento que falló; reintento al volver a tocar Continuar.
        // Sub-fix #F (chip que miente): `markLicenseCaptured` marcó el doc local UPLOADED en el ESCANEO
        // (optimista, antes de subir). Si la subida diferida falló, ese flag seguiría diciendo "Subido"
        // aunque el server NO lo tenga. Revertimos el flag local del doc que falló a PENDING para que el
        // chip refleje la verdad (el `pendingDni`/`pendingLicense` se conserva para reintentar).
        setDocumentStatus(
          DEFERRED_DOC_TO_WIZARD_TYPE[result.document],
          DocumentUploadStatus.PENDING,
        );
        setUploadFailedDoc(result.document);
        return;
    }
  };

  // LOTE B · subida INMEDIATA (igual que el vehículo): apenas el escaneo dejó los datos personales COMPLETOS
  // (lo que el PATCH exige) y hay una captura para subir (DNI o licencia), corre el MISMO `submit()` del
  // Continuar (PATCH idempotente crea el driver → sube DNI → sube licencia + onboard, todo 409-como-éxito).
  // Así el conductor + sus documentos quedan en el SERVER al escanear, no diferidos al Continuar: el resume
  // sabe siempre qué se subió (los chips ya reflejan el `serverState`). Reusa 100% la lógica testeada; es una
  // optimización SILENCIOSA — NO navega ni pinta error (eso lo gobierna el Continuar explícito): si algo
  // falla, la captura se conserva y degrada al flujo de siempre (subir/reintentar en el Continuar).
  const eagerSyncKey = useRef<string | null>(null);

  /** Corre el `submit()` eager. `submit()` nunca lanza (mapea todo a un resultado discriminado que acá se ignora a propósito). */
  const runEagerSync = async (): Promise<void> => {
    await personalContinue.submit({
      personal,
      driverExists: driverExistence === DriverExistence.Exists,
    });
  };

  /**
   * Confirmación del DNI EN el sheet (pen: "carga ahí mismo, sale el proceso de que se envía"): dispara la
   * subida INMEDIATA sin esperar a cerrar el sheet — el sheet queda abierto pintando la fase (sending→
   * sent/error) y ofrece "Continuar en segundo plano". Sella `eagerSyncKey` para que el efecto de abajo no
   * re-dispare el mismo lote al cerrar.
   */
  const onDniConfirmed = (): void => {
    const fresh = useRegistrationStore.getState();
    // Sella la combinación de capturas para que el efecto eager de abajo NO re-dispare el mismo lote al cerrar.
    eagerSyncKey.current = `${fresh.pendingDni?.front.uri ?? '-'}|${fresh.pendingLicense?.file.uri ?? '-'}`;
    // Lote 1: la subida EAGER del DNI corre AHÍ MISMO (checkDni → PATCH → subir DNI con fase POR CARA); el
    // sheet queda abierto pintando la fase por cara y el resultado (dni-taken / ok / error). `submit` nunca
    // lanza (mapea todo a un resultado discriminado); la UI lee la fase del store + `pendingDni`, así que
    // el resultado se ignora acá a propósito. El continue ya NO re-sube el DNI (lo saltea si está `sent`).
    // Nuevo intento: limpia el bloqueo previo; el resultado `dni-taken` lo vuelve a encender (el resto de
    // los estados los lee la UI de la fase POR CARA del store + `pendingDni`).
    setDniTaken(false);
    setDniSubmitError(false);
    void dniSubmit
      .submit({
        personal: fresh.personal,
        driverExists: driverExistence === DriverExistence.Exists,
      })
      .then((result) => {
        if (result.status === 'dni-taken') {
          setDniTaken(true);
        } else if (result.status === 'error') {
          // El checkDni o el PATCH fallaron (red/servidor): lo surface el sheet (banner + reintento). La
          // captura se conserva (`pendingDni`); el fallo de la SUBIDA por cara ya lo pinta la fase por cara.
          setDniSubmitError(true);
        }
      });
  };

  /**
   * Confirma la LICENCIA capturada y dispara su subida EAGER (subir por cara + onboard). La licencia se
   * registra DESPUÉS del DNI (que crea el driver), así que `driverExists` es true si el server ya lo tiene
   * o el DNI ya se envió en esta sesión; si no, `useLicenseSubmit` devuelve `needs-dni` y el sheet avisa.
   */
  const onLicenseConfirmed = (): void => {
    setLicenseNeedsDni(false);
    const fresh = useRegistrationStore.getState();
    // Sella la combinación de capturas ANTES de la subida eager para que el efecto de abajo NO re-dispare el
    // mismo lote al cerrar el sheet (simetría con `onDniConfirmed`): sin este sello, el `key` del efecto
    // (`dni|licencia`) no coincidía con el sello viejo (`dni|-`) → segunda subida CONCURRENTE de la licencia.
    eagerSyncKey.current = `${fresh.pendingDni?.front.uri ?? '-'}|${fresh.pendingLicense?.file.uri ?? '-'}`;
    const driverReady = driverExistence === DriverExistence.Exists || dniPhase === 'sent';
    void licenseSubmit.submit({ driverExists: driverReady }).then((result) => {
      if (result.status === 'needs-dni') {
        setLicenseNeedsDni(true);
      }
    });
  };

  useEffect(() => {
    // Espera a que los sheets de captura estén CERRADOS (el usuario confirmó): un re-escaneo DENTRO del sheet
    // no debe disparar una subida prematura que un 409 no podría reemplazar después.
    if (scanOpen || licenseSheetOpen) {
      return;
    }
    // El PATCH exige nombre + DNI + nacimiento. Sin eso (OCR incompleto) esperamos el tipeo manual.
    const personalComplete =
      personal.fullName.trim().length > 0 &&
      personal.dni.trim().length > 0 &&
      personal.birthdate.trim().length > 0;
    if (!personalComplete || (!pendingDni && !pendingLicense) || personalContinue.isPending) {
      return;
    }
    // Una sola vez por combinación de capturas (evita re-disparos en cada render). Un re-escaneo (uri distinta)
    // rearma. Si la subida falla, la captura se conserva y el reintento es el Continuar explícito.
    const key = `${pendingDni?.front.uri ?? '-'}|${pendingLicense?.file.uri ?? '-'}`;
    if (eagerSyncKey.current === key) {
      return;
    }
    eagerSyncKey.current = key;
    void runEagerSync();
    // `runEagerSync` toma el estado actual en cada corrida; las deps de abajo regobiernan el disparo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scanOpen,
    licenseSheetOpen,
    personal,
    pendingDni,
    pendingLicense,
    personalContinue.isPending,
  ]);

  // EMBEBIDO (wizard): publica el footer del paso al host — "Continuar" + el hint "Te falta: …". `onContinueRef`
  // evita re-registrar en cada render (el footer solo cambia cuando cambia el gating). Standalone: no hace nada
  // (el CTA lo pinta el footer propio de la pantalla).
  const onContinueRef = useRef(onContinue);
  onContinueRef.current = onContinue;
  useEffect(() => {
    if (!wizard) {
      return;
    }
    wizard.registerFooter(pageIndex, {
      primaryLabel: t('common.continue'),
      onPrimary: () => void onContinueRef.current(),
      primaryDisabled: !canContinue,
      primaryLoading: personalContinue.isPending,
      hint: missingKey
        ? t('registration.personal.missing.label', { detail: t(missingKey) })
        : undefined,
    });
    return () => wizard.registerFooter(pageIndex, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizard, pageIndex, canContinue, personalContinue.isPending, missingKey]);

  // El CUERPO del paso (compartido por ambos modos). El chrome cambia según el modo (embebido vs standalone).
  const stepBody = (
    <View style={[styles.body, { gap: theme.spacing['2xl'] }]}>
      {/* La BARRA de progreso (animada) se mantiene como única señal visual del avance: el caption
              textual "Paso N de M" (`registration.stepOf`) se ELIMINÓ — era redundante con la barra y
              empujaba el contenido, invirtiendo la jerarquía. Ahora el TÍTULO display manda. */}
      {wizard ? null : (
        <Reveal>
          <RegistrationProgress current={1} />
        </Reveal>
      )}

      {/* Bloque héroe alineado a la IZQUIERDA con aire generoso (estándar Tesla: Onboarding/Login):
              título `display` que domina + subtítulo `callout` muted. Sin "Paso N de M" encima. */}
      <Reveal delay={80} style={styles.intro}>
        <Text variant="title1">{t('registration.personal.title')}</Text>
        <Text variant="callout" color="inkMuted">
          {t('registration.personal.scanSubtitle')}
        </Text>
      </Reveal>

      {/* PASO 1 · DNI (U3 · jerarquía 1-2-3). El "Escanear DNI" YA NO es un botón accent que compite con el
              CTA del footer: es una CARD DE PASO NUMERADA "1 · DNI" — MISMO patrón visual que la licencia
              (`DocumentUploadCard` con estado + acción) — para comunicar "primero esto, después esto". Toda la
              card es presionable y abre el sheet de escaneo (acción DENTRO de la card). El estado del chip
              refleja la verdad: "Listo para enviar" si hay DNI leído/server, o el estado real del servidor; si
              no, "Pendiente". U2 · dedup (DUP #2): una sola affordance de re-escaneo por estado se mantiene —
              la card ES esa única entrada (ya no hay Button suelto con el mismo `setScanOpen`). */}
      <Reveal delay={100} from="scale">
        <DocumentUploadCard
          icon={<IconDocument size={26} color={theme.colors.accent} strokeWidth={1.8} />}
          stepNumber={1}
          label={t('registration.documents.dni')}
          status={dniDocReady ? DocumentUploadStatus.UPLOADED : DocumentUploadStatus.PENDING}
          uploadedLabel={t('registration.documents.state.ready')}
          pendingLabel={t('registration.documents.pending')}
          serverState={phaseChip(dniPhase) ?? dniServerState}
          sending={dniPhase === 'sending'}
          sent={dniSent}
          thumbUri={pendingDni?.front.uri ?? dniServerImageUri ?? undefined}
          {...cardSubtitle(dniPhase, dniSent)}
          accessibilityLabel={
            hasCapture || hasReadDni
              ? t('registration.actions.rescan')
              : t('registration.personal.scanDni.cta')
          }
          onPress={() => {
            setDniTaken(false);
            setDniSubmitError(false);
            setScanOpen(true);
          }}
        />
        <Text variant="footnote" color="inkSubtle" align="center" style={styles.scanHint}>
          {t('registration.personal.scanDni.hint')}
        </Text>
      </Reveal>

      {serverError ? (
        <Reveal>
          <Banner
            tone="danger"
            title={t('errors.generic')}
            description={toErrorMessage(serverError, t)}
          />
        </Reveal>
      ) : null}

      {uploadFailedDoc ? (
        <Reveal>
          <Banner
            tone="danger"
            title={
              uploadFailedDoc === 'license'
                ? t('registration.documents.licenseUploadFailed')
                : t('registration.personal.scanDni.uploadFailed')
            }
            description={
              uploadFailedDoc === 'license'
                ? t('registration.documents.licenseUploadRetryHint')
                : t('registration.personal.scanDni.uploadRetryHint')
            }
          />
        </Reveal>
      ) : null}

      {/* Fallback HONESTO del campo CRÍTICO: se capturó la foto del DNI pero el OCR NO leyó el número →
              reescaneo (NO un formulario, NO una tarjeta vacía que finge éxito). Se gatilla por la IMAGEN
              capturada (no por los campos OCR), así un OCR que no leyó NADA igual cae acá en vez de quedar
              mudo. Sin el número no se puede registrar el documento ni avanzar. */}
      {hasCapture && !hasReadDni ? (
        <Reveal>
          <Banner
            tone="warn"
            title={t('registration.personal.scanDni.criticalMissingTitle')}
            description={t('registration.personal.scanDni.criticalMissingBody')}
          />
        </Reveal>
      ) : null}

      {serverDocs.isError ? (
        <Reveal>
          <Banner
            tone="warn"
            title={t('errors.generic')}
            description={toErrorMessage(serverDocs.error, t)}
          />
        </Reveal>
      ) : null}

      {/* LICENCIA de conducir (LOTE B · doc del CONDUCTOR, bajada del viejo paso Documentos). Reusa el
              componente CANÓNICO `RegistrationDocumentSheet` + el parser `parseLicense` (Lote A). Requerida
              para avanzar (gating: DNI + licencia). */}
      <Reveal delay={160}>
        <DocumentUploadCard
          icon={<IconDocument size={26} color={theme.colors.accent} strokeWidth={1.8} />}
          stepNumber={2}
          label={t('registration.documents.license')}
          status={licenseUploaded ? DocumentUploadStatus.UPLOADED : DocumentUploadStatus.PENDING}
          uploadedLabel={t('registration.documents.state.ready')}
          pendingLabel={t('registration.documents.pending')}
          serverState={phaseChip(licensePhase) ?? licenseServerState}
          sending={licensePhase === 'sending'}
          sent={licenseSent}
          thumbUri={pendingLicense?.file?.uri ?? licenseServerImageUri ?? undefined}
          {...cardSubtitle(licensePhase, licenseSent)}
          busy={personalContinue.isPending}
          accessibilityLabel={t('registration.documents.uploadAccessibility', {
            document: t('registration.documents.license'),
          })}
          onPress={() => {
            setLicenseNeedsDni(false);
            setLicenseSheetOpen(true);
          }}
        />
      </Reveal>
    </View>
  );

  const licenseSheet = licenseSheetOpen ? (
    <ScanLicenseSheet
      visible
      onClose={() => setLicenseSheetOpen(false)}
      facePhases={sendPhases.license}
      needsDni={licenseNeedsDni}
      onConfirm={onLicenseConfirmed}
      onRescan={() => setLicenseNeedsDni(false)}
    />
  ) : null;
  const scanSheet = (
    <ScanDniSheet
      visible={scanOpen}
      onClose={() => setScanOpen(false)}
      facePhases={sendPhases.dni}
      dniTaken={dniTaken}
      submitting={dniSubmit.isPending}
      submitError={dniSubmitError}
      onConfirm={onDniConfirmed}
      onRescan={() => {
        setDniTaken(false);
        setDniSubmitError(false);
      }}
    />
  );

  // Modo EMBEBIDO (wizard): solo el cuerpo en un scroll propio + los sheets. El host pone el chrome
  // (header/footer/progress/exit) y pinta el CTA unificado (publicado vía `registerFooter`).
  if (wizard) {
    return (
      <>
        <ScrollView
          contentContainerStyle={styles.embeddedScroll}
          showsVerticalScrollIndicator={false}
        >
          {stepBody}
        </ScrollView>
        {licenseSheet}
        {scanSheet}
      </>
    );
  }

  // Modo STANDALONE (fuera del wizard, p. ej. tests): chrome propio + el CTA "Continuar" en el footer.
  return (
    <>
      <SafeScreen
        scroll
        header={<RegistrationHeader showLogo peru onExit={exit.requestExit} />}
        footer={
          <View style={styles.footer}>
            {/* U3 · feedback PEGADO al CTA: cuando "Continuar" está disabled, decimos QUÉ falta (el primer
                requisito incumplido del gating), no un banner lejano. */}
            {missingKey ? (
              <Text variant="footnote" color="inkMuted" align="center" style={styles.missingHint}>
                {t('registration.personal.missing.label', { detail: t(missingKey) })}
              </Text>
            ) : null}
            <Button
              label={t('common.continue')}
              variant="accent"
              fullWidth
              loading={personalContinue.isPending}
              disabled={!canContinue}
              onPress={() => {
                void onContinue();
              }}
            />
          </View>
        }
      >
        {stepBody}
        {licenseSheet}
      </SafeScreen>
      <RegistrationExitSheet exit={exit} />
      {scanSheet}
    </>
  );
};

const styles = StyleSheet.create({
  // Embebido: el host del wizard es `padded={false}`, así que el scroll de la página pone su propio padding.
  embeddedScroll: { paddingHorizontal: 20, paddingBottom: 32 },
  body: { paddingTop: 20 },
  // Aire Tesla bajo la barra de progreso: el bloque héroe respira (marginTop generoso) y el
  // título+subtítulo quedan juntos por su propio gap.
  intro: { gap: 10, marginTop: 12 },
  footer: { gap: 10 },
  missingHint: {},
  scanHint: { marginTop: 6 },
});
