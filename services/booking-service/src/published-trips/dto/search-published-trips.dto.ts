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
 * Fecha-calendario PURA `YYYY-MM-DD` (FIX 2·F2): sin hora, sin offset, sin 'T'. La búsqueda razona en DÍAS
 * de calendario LIMA (UTC-5) — NO en instantes. Si el cliente pudiera mandar un datetime con offset, podría
 * MANIPULAR los componentes que `limaDayRange` toma (correr la ventana del día). El borde exige el día CRUDO
 * y el service le aplica la zona Lima. Constante tipada (cero regex mágicas sueltas): un único punto la define.
 */
const CALENDAR_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

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

  // Cursor keyset OPACO (base64 de `${fechaHoraSalidaISO}|${id}` de la última fila de la página previa). La
  // siguiente página arranca DESPUÉS de esa fila por el orden (fechaHoraSalida ASC, id ASC). Sin cursor →
  // primera página. Se valida solo como string (su forma interna la valida/parsea el service, tolerante).
  @IsOptional()
  @IsString()
  cursor?: string;
}
