import { prefsStore, type KeyValueStore } from '../../../../core/storage/mmkv';
import { PrefKey } from '../../../../core/storage/keys';

/**
 * Persistencia del reloj de turno LOCAL. El backend no expone `startedAt` en el estado de turno, así
 * que el cliente sella la marca de inicio (`recordShiftStart`) al abrir turno y la CONSUME al cerrarlo
 * (`consumeShiftStartedAt`, que además la borra). Vive en MMKV preferencias (no sensible, sobrevive a
 * recargas/cold-start): así el resumen de cierre calcula "cuánto estuviste en la calle hoy".
 *
 * El store es inyectable para poder testear sin MMKV real.
 */

/** Sella el inicio del turno actual (epoch ms) en preferencias. Llamar al confirmarse `POST /shift/start`. */
export function recordShiftStart(store: KeyValueStore = prefsStore, nowMs: number = Date.now()): void {
  store.setString(PrefKey.ShiftStartedAt, String(nowMs));
}

/**
 * Lee y BORRA la marca de inicio del turno. Devuelve el epoch ms si hay una marca válida, o `null` si no
 * existe / es ilegible (turno iniciado antes de esta feature, o marca perdida): el consumidor degrada la
 * duración a "—" en ese caso, sin inventar un valor.
 */
export function consumeShiftStartedAt(store: KeyValueStore = prefsStore): number | null {
  const raw = store.getString(PrefKey.ShiftStartedAt);
  store.remove(PrefKey.ShiftStartedAt);
  if (raw === undefined) {
    return null;
  }
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
