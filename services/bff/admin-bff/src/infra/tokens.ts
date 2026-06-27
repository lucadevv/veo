/**
 * Tokens de inyección para infraestructura compartida (Redis, clientes downstream gRPC/REST).
 * Mantener los símbolos centralizados evita acoplar los módulos de dominio a strings mágicos.
 */
export const REDIS = Symbol('VEO_ADMIN_BFF_REDIS');

/** Clientes gRPC de LECTURA (uno por servicio). */
export const GRPC_IDENTITY = Symbol('VEO_GRPC_IDENTITY');
export const GRPC_TRIP = Symbol('VEO_GRPC_TRIP');
export const GRPC_PANIC = Symbol('VEO_GRPC_PANIC');
export const GRPC_PAYMENT = Symbol('VEO_GRPC_PAYMENT');
export const GRPC_MEDIA = Symbol('VEO_GRPC_MEDIA');
export const GRPC_AUDIT = Symbol('VEO_GRPC_AUDIT');
export const GRPC_RATING = Symbol('VEO_GRPC_RATING');
export const GRPC_FLEET = Symbol('VEO_GRPC_FLEET');

/** Clientes REST internos firmados de COMANDO (uno por servicio). */
export const REST_IDENTITY = Symbol('VEO_REST_IDENTITY');
export const REST_TRIP = Symbol('VEO_REST_TRIP');
export const REST_PANIC = Symbol('VEO_REST_PANIC');
export const REST_PAYMENT = Symbol('VEO_REST_PAYMENT');
export const REST_MEDIA = Symbol('VEO_REST_MEDIA');
export const REST_AUDIT = Symbol('VEO_REST_AUDIT');
export const REST_FLEET = Symbol('VEO_REST_FLEET');
export const REST_DISPATCH = Symbol('VEO_REST_DISPATCH');
export const REST_BOOKING = Symbol('VEO_REST_BOOKING');
