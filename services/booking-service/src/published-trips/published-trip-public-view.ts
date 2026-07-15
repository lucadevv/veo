/**
 * VISTA PÚBLICA del PublishedTrip (F2 · FIX 1 · minimización H8 aplicada al agregado de carpooling).
 *
 * El search y el detalle son public-rail ANÓNIMO: NUNCA deben devolver la entidad Prisma cruda. La fila
 * `PublishedTrip` porta campos INTERNOS que el pasajero no necesita y que NO se exponen a un anónimo:
 *  - `dedupKey`  → idempotency interna del publish (namespaceada por driverId). JAMÁS sale por el wire.
 *  - `driverId`  → id interno del conductor; el pasajero ve al conductor por su vista PÚBLICA (name/rating),
 *                  no por su id. Se OMITE del view.
 *  - `vehicleId` → id interno del vehículo; el pasajero ve el vehículo público (modelo/placa) en el detalle.
 *                  Se OMITE del view.
 *  - `originH3` / `destH3` → celdas índice internas de la búsqueda geo. Se OMITEN.
 *  - timestamps internos de auditoría (`createdAt`/`updatedAt`) → se OMITEN.
 *
 * El view es un ALLOW-LIST tipado: el mapper nombra EXPLÍCITAMENTE cada campo que sale. Agregar una columna
 * interna nueva al schema NO la filtra (no aparece hasta que alguien la agregue acá a propósito). Las coords
 * de origen/destino/stopovers SÍ salen: son meeting points públicos (lo que el pasajero necesita para decidir).
 */
import type { ModoReserva, PricingMode, PublishedTripState, Prisma } from '../generated/prisma';

/**
 * Forma PÚBLICA de un viaje publicado tal como la ve un pasajero anónimo. SIN `dedupKey`, SIN `driverId`/
 * `vehicleId` internos, SIN celdas H3. Solo lo que la UI de búsqueda/detalle consume.
 */
export interface PublishedTripPublicView {
  id: string;
  origenLat: number;
  origenLon: number;
  destinoLat: number;
  destinoLon: number;
  /** Paradas intermedias (meeting points públicos): el JSON persistido, tal cual (es público). */
  stopovers: Prisma.JsonValue;
  fechaHoraSalida: Date;
  asientosTotales: number;
  asientosDisponibles: number;
  pricingMode: PricingMode;
  precioBase: number;
  /** Precio por tramo (JSON público): qué cuesta cada segmento de la ruta. */
  precioPorTramo: Prisma.JsonValue;
  modoReserva: ModoReserva;
  /** Reglas del viaje (texto libre del conductor); null si no puso ninguna. */
  reglas: string | null;
  pais: string;
  moneda: string;
  estado: PublishedTripState;
}

/**
 * Subconjunto MÍNIMO de columnas de `PublishedTrip` que el mapper necesita para construir el view público.
 * Tipar la ENTRADA así (en vez de la entidad completa) deja claro que el mapper NO depende de `dedupKey` ni de
 * otros internos: ni siquiera los recibe. La entidad Prisma completa satisface este shape estructuralmente.
 */
export type PublishedTripPublicSource = Pick<
  PublishedTripPublicView,
  | 'id'
  | 'origenLat'
  | 'origenLon'
  | 'destinoLat'
  | 'destinoLon'
  | 'stopovers'
  | 'fechaHoraSalida'
  | 'asientosTotales'
  | 'asientosDisponibles'
  | 'pricingMode'
  | 'precioBase'
  | 'precioPorTramo'
  | 'modoReserva'
  | 'reglas'
  | 'pais'
  | 'moneda'
  | 'estado'
>;

/**
 * Mapea la entidad PublishedTrip (o cualquier source con sus columnas públicas) → su VISTA PÚBLICA. ALLOW-LIST
 * explícita: solo los campos nombrados salen. `dedupKey`/`driverId`/`vehicleId`/`originH3`/`destH3` NUNCA se
 * copian — no aparecen en el objeto de retorno por construcción.
 */
export function toPublishedTripPublicView(
  trip: PublishedTripPublicSource,
): PublishedTripPublicView {
  return {
    id: trip.id,
    origenLat: trip.origenLat,
    origenLon: trip.origenLon,
    destinoLat: trip.destinoLat,
    destinoLon: trip.destinoLon,
    stopovers: trip.stopovers,
    fechaHoraSalida: trip.fechaHoraSalida,
    asientosTotales: trip.asientosTotales,
    asientosDisponibles: trip.asientosDisponibles,
    pricingMode: trip.pricingMode,
    precioBase: trip.precioBase,
    precioPorTramo: trip.precioPorTramo,
    modoReserva: trip.modoReserva,
    reglas: trip.reglas,
    pais: trip.pais,
    moneda: trip.moneda,
    estado: trip.estado,
  };
}
