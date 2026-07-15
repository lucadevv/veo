/**
 * RE-EXPORT del mapper canónico de categoría MTC → `VehicleType`. La definición vive en `@veo/shared-types`
 * (`catalog/vehicle-category.ts`) para que la TARJETA DE PROPIEDAD sea la fuente de verdad del tipo TANTO en
 * el cliente (prellenado del alta) COMO en el backend (derivación server-authoritative en fleet-service).
 *
 * Este archivo se mantiene como punto de re-export para NO romper los imports existentes del feature de OCR
 * (`extracted-data-mapper`, `index` del barrel, `useScanPropertyCard`); los consumidores nuevos pueden importar
 * directo de `@veo/shared-types`. El mapeo (M1→CAR, L*→MOTO, resto→null) NO se duplica acá.
 */
export { mapMtcCategoryToVehicleType } from '@veo/shared-types';
