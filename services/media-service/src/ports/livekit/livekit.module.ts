/**
 * Wiring del puerto LiveKit: adapter `live` (servidor propio self-hosted) o `sandbox` (tests/dev).
 * Selección por `VEO_LIVEKIT_MODE`. Sin SaaS: el host viene de LIVEKIT_URL (self-hosted).
 */
import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken, EgressClient, EncodedFileOutput, S3Upload } from 'livekit-server-sdk';
import { ExternalServiceError } from '@veo/utils';
import { LIVEKIT_PORT, type LiveKitPort, type IssueTokenInput, type StartRecordingInput } from './livekit.port';
import type { Env } from '../../config/env.schema';

/** Convierte la URL ws(s):// de señalización en el host http(s):// de las APIs de servidor. */
function toHttpHost(url: string): string {
  return url.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
}

/**
 * Adapter LIVE: orquesta el LiveKit self-hosted real.
 * - Tokens: AccessToken (JWT firmado con la API key/secret del servidor propio).
 * - Grabación: EgressClient.startRoomCompositeEgress → EncodedFileOutput hacia S3/MinIO (forcePathStyle).
 */
class LiveKitLiveAdapter implements LiveKitPort {
  private readonly egress: EgressClient;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    httpHost: string,
    private readonly s3: {
      endpoint: string;
      region: string;
      accessKey: string;
      secretKey: string;
      bucket: string;
      forcePathStyle: boolean;
    },
  ) {
    this.egress = new EgressClient(httpHost, apiKey, apiSecret);
  }

  async issueAccessToken(input: IssueTokenInput): Promise<string> {
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: input.identity,
      name: input.name,
      ttl: input.ttlSeconds,
    });
    token.addGrant({
      room: input.roomName,
      roomJoin: true,
      canPublish: input.canPublish,
      canSubscribe: input.canSubscribe,
      canPublishData: input.canPublishData ?? true,
    });
    return token.toJwt();
  }

  async startRecording(input: StartRecordingInput): Promise<{ egressId: string }> {
    try {
      const output = new EncodedFileOutput({
        filepath: input.s3Key,
        output: {
          case: 's3',
          value: new S3Upload({
            accessKey: this.s3.accessKey,
            secret: this.s3.secretKey,
            region: this.s3.region,
            endpoint: this.s3.endpoint,
            bucket: this.s3.bucket,
            forcePathStyle: this.s3.forcePathStyle,
          }),
        },
      });
      const info = await this.egress.startRoomCompositeEgress(input.roomName, output);
      return { egressId: info.egressId };
    } catch (err) {
      throw new ExternalServiceError('No se pudo iniciar la grabación en LiveKit', {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async stopRecording(egressId: string): Promise<{ bytes: number }> {
    try {
      const info = await this.egress.stopEgress(egressId);
      const size = info.fileResults?.[0]?.size ?? 0n;
      return { bytes: Number(size) };
    } catch (err) {
      throw new ExternalServiceError('No se pudo detener la grabación en LiveKit', {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Adapter SANDBOX: determinista, sin red. Para tests y dev sin LiveKit levantado.
 * El token es opaco pero estable; el egress devuelve ids/bytes derivados de la entrada.
 */
export class LiveKitSandboxAdapter implements LiveKitPort {
  private readonly logger = new Logger('LiveKitSandbox');

  async issueAccessToken(input: IssueTokenInput): Promise<string> {
    return `sandbox-token:${input.roomName}:${input.identity}:${input.ttlSeconds}`;
  }

  async startRecording(input: StartRecordingInput): Promise<{ egressId: string }> {
    this.logger.warn(`[SANDBOX] startRecording room=${input.roomName} key=${input.s3Key}`);
    return { egressId: `sandbox-egress:${input.roomName}` };
  }

  async stopRecording(egressId: string): Promise<{ bytes: number }> {
    this.logger.warn(`[SANDBOX] stopRecording egress=${egressId}`);
    return { bytes: 1_048_576 };
  }
}

const livekitProvider: Provider = {
  provide: LIVEKIT_PORT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): LiveKitPort => {
    if (config.getOrThrow<string>('VEO_LIVEKIT_MODE') !== 'live') {
      return new LiveKitSandboxAdapter();
    }
    return new LiveKitLiveAdapter(
      config.getOrThrow<string>('LIVEKIT_API_KEY'),
      config.getOrThrow<string>('LIVEKIT_API_SECRET'),
      toHttpHost(config.getOrThrow<string>('LIVEKIT_URL')),
      {
        endpoint: config.getOrThrow<string>('S3_ENDPOINT'),
        region: config.getOrThrow<string>('S3_REGION'),
        accessKey: config.getOrThrow<string>('S3_ACCESS_KEY'),
        secretKey: config.getOrThrow<string>('S3_SECRET_KEY'),
        bucket: config.getOrThrow<string>('S3_BUCKET_VIDEO'),
        forcePathStyle: config.getOrThrow<boolean>('S3_FORCE_PATH_STYLE'),
      },
    );
  },
};

@Module({ providers: [livekitProvider], exports: [LIVEKIT_PORT] })
export class LiveKitModule {}
