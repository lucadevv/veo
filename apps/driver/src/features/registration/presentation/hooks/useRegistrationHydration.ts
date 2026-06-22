import { useEffect, useRef } from 'react';
import {
  applyRegistrationHydration,
  buildRegistrationHydrationPlan,
} from '../../domain';
import { useRegistrationStore } from '../state/registrationStore';
import { useRegistrationDocuments } from './useRegistrationDocuments';

/**
 * HIDRATA el store del alta desde el SERVIDOR al reanudar (`GET /drivers/me/documents`).
 *
 * EL BUG QUE ARREGLA: antes, cada paso decidía "ya lo mandé" de forma INCOHERENTE — la licencia/SOAT/foto
 * miraban el SERVIDOR (`serverHasAcceptableDoc`), pero el DNI miraba SOLO el estado LOCAL de sesión
 * (`personal.dni`, que al reanudar está vacío) → re-pedía el DNI pero no la licencia. La FUENTE DE VERDAD
 * de "qué ya mandé" es el SERVIDOR; este hook reconstruye el avance local desde ahí para que TODOS los
 * pasos document-backed deriven "hecho" de la misma fuente, de forma coherente.
 *
 * Corre UNA VEZ cuando los documentos del servidor resuelven (no en cada render): un `ref` sella la
 * hidratación tras el primer plan no vacío aplicado. La aplicación es NO DESTRUCTIVA (solo llena campos
 * locales vacíos) e IDEMPOTENTE (no re-marca lo ya marcado), así que no pisa lo que el conductor está
 * escribiendo en esta sesión ni provoca loops.
 *
 * Mantenerlo como hook FINO sobre un usecase PURO (`buildRegistrationHydrationPlan` /
 * `applyRegistrationHydration`) deja la lógica testeable sin React.
 */
export function useRegistrationHydration(): void {
  const serverDocs = useRegistrationDocuments();
  const setPersonal = useRegistrationStore((s) => s.setPersonal);
  const setDocumentStatus = useRegistrationStore((s) => s.setDocumentStatus);
  const hydrated = useRef(false);

  const docs = serverDocs.data;

  useEffect(() => {
    // Solo cuando el servidor RESOLVIÓ el listado (éxito) y aún no hidratamos en esta sesión. Una lista
    // VACÍA (`[]`, conductor nuevo pre-upload) NO sella: un refetch posterior con docs reales debe poder
    // hidratar (el sello es "tras el primer plan NO VACÍO aplicado", como dice el contrato de este hook).
    if (hydrated.current || !docs || docs.length === 0) {
      return;
    }
    const plan = buildRegistrationHydrationPlan(docs);
    // Lee el estado ACTUAL del store en el momento de aplicar (no congela una copia stale del render).
    const state = useRegistrationStore.getState();
    applyRegistrationHydration(plan, {
      personal: state.personal,
      documents: state.documents,
      setPersonal,
      setDocumentStatus,
    });
    // Sella la hidratación: el server ya resolvió y derivamos el avance; a partir de acá manda el
    // estado de sesión (lo que el conductor escriba/capture), no re-hidratamos sobre él.
    hydrated.current = true;
  }, [docs, setPersonal, setDocumentStatus]);
}
