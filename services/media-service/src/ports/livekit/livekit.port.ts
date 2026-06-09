/**
 * Puerto LiveKit (FOUNDATION §9). Servidor de video propio (self-hosted) tras un puerto
 * intercambiable. El dominio depende de esta abstracción, no de `livekit-server-sdk` (regla D de SOLID).
 *
 * - `live`: orquesta el LiveKit real (AccessToken + EgressClient hacia S3/MinIO).
 * - `sandbox`: adapter determinista para tests (sin red).
 */
export const LIVEKIT_PORT = Symbol('LIVEKIT_PORT');

export interface IssueTokenInput {
  roomName: string;
  /** Identidad del participante en la room (userId del passenger/driver). */
  identity: string;
  /** Nombre visible del participante. */
  name?: string;
  canPublish: boolean;
  canSubscribe: boolean;
  /** Permite enviar mensajes de datos a la room. Default true (cámara conductor/pasajero); el viewer
   *  de vigilancia (admin) lo pone en false para ser espectador PURO (no inyecta data en la cabina). */
  canPublishData?: boolean;
  ttlSeconds: number;
}

export interface StartRecordingInput {
  roomName: string;
  /** Clave de destino en el bucket de video de S3/MinIO. */
  s3Key: string;
}

export interface StartRecordingResult {
  egressId: string;
}

export interface StopRecordingResult {
  /** Bytes del objeto archivado (0 si aún no determinable). */
  bytes: number;
}

export interface LiveKitPort {
  /** Emite un JWT de acceso a la room para un participante (BR-S01 cámara). */
  issueAccessToken(input: IssueTokenInput): Promise<string>;
  /** Inicia el egress de grabación de la room hacia S3/MinIO (BR-S01). */
  startRecording(input: StartRecordingInput): Promise<StartRecordingResult>;
  /** Detiene el egress de grabación y devuelve el tamaño archivado. */
  stopRecording(egressId: string): Promise<StopRecordingResult>;
}
