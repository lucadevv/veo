/**
 * DTO del BROWSE del marketplace de carpool (GET /published-trips/browse · public-rail ANÓNIMO). El feed
 * lista TODOS los viajes publicados FUTUROS — sin ruta ni fecha requeridas (a diferencia del search, que
 * exige A→B + día): por eso TODOS los params son opcionales. Filtro geográfico por REGIÓN del catálogo
 * compartido (@veo/utils REGIONS_PE): el id viaja por el wire y el borde lo valida contra el catálogo
 * (@IsIn con los ids reales → región desconocida = 400 con la lista, no un filtro silenciosamente vacío).
 *
 * REUSA del search (fuente única, sin duplicar): SEARCH_ORDER_VALUES/SearchOrder (el orden y su unión) y
 * el MISMO codec de cursor keyset tagueado (`s`/`p`) — un cursor emitido por browse/search bajo otro orden
 * se descarta a página 1 (sort-aware, lo materializa el service).
 *
 * ALCANCE v1 (decisión documentada): la ventana horaria `salidaDesde`/`salidaHasta` del search NO entra al
 * browse. En el search la franja vive DENTRO de un día concreto (instantes computables → filtro indexado);
 * en el browse el universo es "todo lo futuro", así que la franja sería hora-del-día de CADA viaje →
 * `EXTRACT(hour ...)` no indexado + keyset reescrito en SQL crudo. Costo/beneficio no cierra para v1:
 * browse filtra por región + precio + orden; la franja fina se resuelve pasando al search del día elegido.
 */
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { REGIONS_PE } from '@veo/utils';
import { SEARCH_ORDER_VALUES, type SearchOrder } from './search-published-trips.dto';

/**
 * Ids de región válidos, derivados del catálogo compartido (cero listas paralelas: agregar una región a
 * REGIONS_PE la habilita acá sola). El mensaje del 400 enumera los ids reales para que el error sea accionable.
 */
const REGION_IDS = REGIONS_PE.map((r) => r.id);

export class BrowsePublishedTripsDto {
  // Región del feed (id kebab-case del catálogo @veo/utils). Opcional: sin ella el feed es nacional.
  @IsOptional()
  @IsIn(REGION_IDS, {
    message: `region debe ser una del catálogo: ${REGION_IDS.join(', ')}`,
  })
  region?: string;

  // Orden de la página: `salida` (default — salida más próxima primero) o `precio` (más barato primero).
  @IsOptional()
  @IsIn(SEARCH_ORDER_VALUES)
  orden?: SearchOrder;

  // Precio máximo por asiento en céntimos PEN (`precioBase <= tope`). Int ≥ 1 (0 no es un tope: nada es gratis).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  precioMaxCents?: number;

  // Tamaño de página. Default 20 en el service; @Max 50 (techo duro: el cliente no vuelca el set completo).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  // Cursor keyset OPACO (MISMO codec tagueado `s`/`p` del search — ver search-published-trips.dto). Se valida
  // solo como string; su forma interna la parsea el service, tolerante (tag que no matchea el orden → página 1).
  @IsOptional()
  @IsString()
  cursor?: string;
}
