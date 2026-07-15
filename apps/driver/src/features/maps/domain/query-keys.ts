/**
 * Clave raíz del namespace de mapas en la caché de react-query. Vive en `domain` (no en
 * `presentation`) para que otras features (carpooling) armen su autocompletado sobre el MISMO
 * namespace con cache coherente SIN importar los hooks internos de `maps/presentation`
 * (feature-isolation).
 */
export const MAPS_QUERY_KEY = ['maps'] as const;
