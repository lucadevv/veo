/**
 * @veo/rpc — toolkit downstream para BFFs.
 * gRPC para lecturas (Get*), REST interno firmado HMAC para comandos.
 */
export { GrpcServiceClient, createGrpcClient } from './grpc-client.js';
export type { GrpcClientOptions } from './grpc-client.js';
export {
  buildGrpcServerCredentials,
  buildGrpcClientCredentials,
  grpcTlsPathsFromEnv,
  grpcTlsRequiredFromEnv,
} from './grpc-tls.js';
export type { GrpcTlsPaths, GrpcTlsMode, GrpcTlsLogger } from './grpc-tls.js';
export { InternalRestClient } from './internal-rest.js';
export type { InternalRestOptions, InternalRequest } from './internal-rest.js';
export { DownstreamError, normalizeError } from './error.js';
export type { ApiErrorLike } from './error.js';
export {
  BffExceptionsFilter,
  UPSTREAM_UNAVAILABLE_CODE,
  UPSTREAM_UNAVAILABLE_STATUS,
  UPSTREAM_UNAVAILABLE_MESSAGE,
} from './bff-exception-filter.js';
export type { BffExceptionFilterOptions } from './bff-exception-filter.js';
export {
  PROTO_DIR,
  SERVICE_PROTO,
  SERVICE_PACKAGE,
  SERVICE_RPC_NAME,
  protoPathFor,
} from './proto-paths.js';
export type { ServiceName } from './proto-paths.js';
export type * from './contracts/index.js';
