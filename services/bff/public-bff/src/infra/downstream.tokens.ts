/**
 * Tokens de inyección para los clientes downstream (gRPC lecturas + REST interno comandos)
 * y la fachada de mapas. Cada servicio del backend tiene su propio cliente reutilizable.
 */

/** Clientes gRPC (lecturas Get*). */
export const GRPC_IDENTITY = Symbol('GRPC_IDENTITY');
export const GRPC_TRIP = Symbol('GRPC_TRIP');
export const GRPC_DISPATCH = Symbol('GRPC_DISPATCH');
export const GRPC_PAYMENT = Symbol('GRPC_PAYMENT');
export const GRPC_PANIC = Symbol('GRPC_PANIC');
export const GRPC_RATING = Symbol('GRPC_RATING');
export const GRPC_SHARE = Symbol('GRPC_SHARE');
export const GRPC_FLEET = Symbol('GRPC_FLEET');
/** places-service (Lote B): lugares guardados del pasajero (Casa/Trabajo/favoritos). CRUD gRPC. */
export const GRPC_PLACES = Symbol('GRPC_PLACES');

/** Clientes REST interno firmado (comandos). */
export const REST_IDENTITY = Symbol('REST_IDENTITY');
export const REST_TRIP = Symbol('REST_TRIP');
/** dispatch-service: comandos REST de la PUJA (ofertas del board: listar/aceptar/cancelar). */
export const REST_DISPATCH = Symbol('REST_DISPATCH');
export const REST_PAYMENT = Symbol('REST_PAYMENT');
export const REST_PANIC = Symbol('REST_PANIC');
export const REST_SHARE = Symbol('REST_SHARE');
export const REST_RATING = Symbol('REST_RATING');
export const REST_NOTIFICATION = Symbol('REST_NOTIFICATION');
/** chat-service (Ola 2A): historial + persistencia de mensajes del viaje. */
export const REST_CHAT = Symbol('REST_CHAT');
/** media-service: presign de subida del avatar del pasajero (PUT directo a S3/MinIO). */
export const REST_MEDIA = Symbol('REST_MEDIA');
/** booking-service (ADR-014 · carpooling): búsqueda/detalle de viajes publicados + reservas del pasajero. */
export const REST_BOOKING = Symbol('REST_BOOKING');

/** Fachada de mapas OSM (routing/ETA). */
export const MAPS = Symbol('MAPS');

/** Configuración de LiveKit self-hosted (video del habitáculo). */
export const LIVEKIT = Symbol('LIVEKIT');
