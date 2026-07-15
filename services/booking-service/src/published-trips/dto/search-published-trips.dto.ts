/**
 * DTO de la BÚSQUEDA de viajes publicados (GET /published-trips/search). VEO_MODELO_HIBRIDO §6.2-6.3 /
 * ADR-014 §8 · public-rail ANÓNIMO (el pasajero no necesita estar logueado para buscar). Endurece el BORDE
 * (class-validator): la RUTA (origen A → destino B) y la fecha son REQUERIDAS; la geo en rango; asientos
 * Int ≥ 1. Los query params llegan como string → `@Type(() => Number)` los coacciona antes de validar.
 *
 * El `driverId` / cualquier identidad del pasajero NO entra acá: la búsqueda es anónima por construcción
 * (no se scopea a un usuario). El cursor keyset codifica (fechaHoraSalida, id) de la última fila de la
 * página previa — opaco para el cliente, lo materializa el service.
 */
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Órdenes soportados por la búsqueda: `salida` (fechaHoraSalida ASC — el default, comportamiento histórico)
 * o `precio` (precioBase ASC). Fuente única de la unión: el DTO la valida en el borde (@IsIn) y el repo la
 * consume tipada (import type) para elegir el orderBy + la tupla keyset — un solo lugar define los valores.
 */
export const SEARCH_ORDER_VALUES = ['salida', 'precio'] as const;
export type SearchOrder = (typeof SEARCH_ORDER_VALUES)[number];

/**
 * Fecha-calendario PURA `YYYY-MM-DD` (FIX 2·F2): sin hora, sin offset, sin 'T'. La búsqueda razona en DÍAS
 * de calendario LIMA (UTC-5) — NO en instantes. Si el cliente pudiera mandar un datetime con offset, podría
 * MANIPULAR los componentes que `limaDayRange` toma (correr la ventana del día). El borde exige el día CRUDO
 * y el service le aplica la zona Lima. Constante tipada (cero regex mágicas sueltas): un único punto la define.
 */
const CALENDAR_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Hora-de-pared PURA `HH:mm` (24h, cero-padded) para la ventana horaria de salida DENTRO del día pedido, en
 * hora LIMA. Estricta a propósito: rechaza `25:00` (hora inexistente), `9:5` (sin padding — ambigua) y
 * cualquier datetime/segundos/offset (la zona la pone el service, igual que con `fecha`; el cliente no
 * manda instantes). Constante tipada, un único punto la define (misma regla que CALENDAR_DATE_REGEX).
 */
const LIMA_WALL_TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export class SearchPublishedTripsDto {
  // ── RUTA A→B (requerida): origen + destino del viaje que busca el pasajero. ──
  @Type(() => Number)
  @IsLatitude()
  originLat!: number;

  @Type(() => Number)
  @IsLongitude()
  originLon!: number;

  @Type(() => Number)
  @IsLatitude()
  destLat!: number;

  @Type(() => Number)
  @IsLongitude()
  destLon!: number;

  // Día de salida pedido como FECHA-CALENDARIO PURA `YYYY-MM-DD` (FIX 2·F2 · sin hora ni offset). El service
  // la interpreta en hora Lima (UTC-5, `limaDayRange`) y exige que la salida sea > now() (no se ofertan viajes
  // pasados ni del día pero ya partidos). El borde RECHAZA datetime/offset: `@Matches` corta cualquier 'T'/hora/
  // 'Z'/±hh:mm (no manipulable), y `@IsISO8601({ strict:true })` exige que sea una fecha de calendario REAL
  // (rechaza 2026-13-40). Ambos juntos: solo un día calendario bien formado pasa.
  @Matches(CALENDAR_DATE_REGEX, {
    message: 'fecha debe ser una fecha-calendario YYYY-MM-DD (sin hora ni offset)',
  })
  @IsISO8601({ strict: true })
  fecha!: string;

  // Asientos que el pasajero necesita: la oferta debe tener asientosDisponibles >= este valor. Int ≥ 1.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  asientos!: number;

  // Tamaño de página. Default 20 en el service; @Max 50 (techo duro: el cliente no vuelca el set completo).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  // Orden de la página: `salida` (default — salida más próxima primero, comportamiento histórico) o `precio`
  // (más barato primero). OPCIONAL para no romper el contrato existente; el service aplica el default.
  @IsOptional()
  @IsIn(SEARCH_ORDER_VALUES)
  orden?: SearchOrder;

  // Precio máximo por asiento en CÉNTIMOS PEN (filtro `precioBase <= precioMaxCents`). Int ≥ 1 (0 no tiene
  // sentido como tope: ningún viaje es gratis). Query param string → coaccionado antes de validar.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  precioMaxCents?: number;

  // ── Ventana horaria de salida DENTRO del día pedido, en hora-de-pared LIMA (`HH:mm`). ──
  // `salidaDesde` = cota inferior inclusive; `salidaHasta` = cota superior INCLUSIVE a nivel minuto (una
  // salida a las 10:00 en punto entra si salidaHasta=10:00). El service las convierte a instantes partiendo
  // de la medianoche Lima del día (UTC-5 fijo, sin DST) y recorta [desde, hasta) del día. Ambas opcionales
  // e independientes (solo-desde o solo-hasta valen). Ventana vacía (desde > hasta) → página vacía honesta.
  @IsOptional()
  @Matches(LIMA_WALL_TIME_REGEX, {
    message: 'salidaDesde debe ser una hora-de-pared HH:mm (24h, sin segundos ni offset)',
  })
  salidaDesde?: string;

  @IsOptional()
  @Matches(LIMA_WALL_TIME_REGEX, {
    message: 'salidaHasta debe ser una hora-de-pared HH:mm (24h, sin segundos ni offset)',
  })
  salidaHasta?: string;

  // Cursor keyset OPACO (base64 de `<tagOrden>|<valor>|<id>` de la última fila de la página previa: tag `s` +
  // fechaHoraSalida ISO con orden=salida, tag `p` + precioBase con orden=precio). La siguiente página arranca
  // DESPUÉS de esa fila por el orden activo. Sin cursor → primera página. Se valida solo como string (su forma
  // interna la valida/parsea el service, tolerante; un tag que no matchea el `orden` pedido se IGNORA).
  @IsOptional()
  @IsString()
  cursor?: string;
}
