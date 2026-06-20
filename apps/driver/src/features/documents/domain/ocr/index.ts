/**
 * Barrel del módulo de OCR de documentos: parsers PUROS por tipo + dispatcher tipado + tipos de
 * resultado. La presentación consume `parseDocument`/`isParsableDocumentType` (auto-llenado) y los
 * parsers individuales se exponen para tests y para flujos futuros (DNI).
 */
export * from './parsed-document';
export * from './license-category';
export * from './vehicle-category';
export * from './parse-dni';
export * from './parse-mrz-td1';
export * from './parse-license';
export * from './parse-soat';
export * from './parse-property-card';
export * from './parse-document';
export * from './extracted-data-mapper';
