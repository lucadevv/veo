import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError } from '@veo/utils';
import {
  PUSH_SENDER,
  PushMode,
  PushOutcome,
  PushPlatform,
  PushTargetKind,
  PushTransportKey,
  type PushMessage,
  type PushResult,
  type PushSender,
  type PushTransport,
} from './push.port';
import { FcmClient } from './fcm-client';
import { ApnsClient } from './apns-client';
import type { PushTarget } from './push.port';
import type { Env } from '../../config/env.schema';

/** Descripción legible del destino (para logs sandbox). Switch exhaustivo, no ternario anidado. */
function describeTarget(target: PushTarget): string {
  switch (target.kind) {
    case PushTargetKind.Token:
      return `${target.platform}:${target.token}`;
    case PushTargetKind.Topic:
      return `topic:${target.topic}`;
    case PushTargetKind.Condition:
      return `condition:${target.condition}`;
  }
}

/** Sandbox: imprime el push (determinista) en consola y lo da por aceptado. */
export class PushSandboxSender implements PushSender {
  private readonly logger = new Logger('PushSandbox');
  async send(msg: PushMessage): Promise<PushResult> {
    this.logger.warn(`[SANDBOX PUSH] → ${describeTarget(msg.target)}: ${msg.title} — ${msg.body}`);
    return { outcome: PushOutcome.Accepted };
  }
}

/**
 * Live: resuelve el riel por un REGISTRY (`Map` transportKey→transport) + un ROUTING (`Record`
 * platform→transportKey). El ruteo vive en DATOS, no en control de flujo: cero if/switch. Agregar un
 * riel nuevo (p. ej. web push) = registrar una entrada en el Map y una ruta en el Record (OCP).
 */
export class PushLiveSender implements PushSender {
  constructor(
    private readonly transports: ReadonlyMap<PushTransportKey, PushTransport>,
    private readonly routing: Readonly<Record<PushPlatform, PushTransportKey>>,
  ) {}

  async send(msg: PushMessage): Promise<PushResult> {
    // Token → riel por plataforma (Record). Topic/Condition (broadcast) → SIEMPRE FCM (APNs no tiene topics).
    const transportKey =
      msg.target.kind === PushTargetKind.Token
        ? this.routing[msg.target.platform]
        : PushTransportKey.Fcm;
    const transport = this.transports.get(transportKey);
    if (!transport) {
      return {
        outcome: PushOutcome.Transient,
        reason: `PUSH live: riel '${transportKey}' no configurado`,
      };
    }
    return transport.send(msg);
  }
}

const pushProvider: Provider = {
  provide: PUSH_SENDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): PushSender => {
    if (config.getOrThrow<PushMode>('VEO_PUSH_MODE') !== PushMode.Live)
      return new PushSandboxSender();

    // Registry de transportes: cada riel se registra SOLO si tiene credenciales (presencia, no ruteo).
    const transports = new Map<PushTransportKey, PushTransport>();

    const projectId = config.get<string>('FCM_PROJECT_ID');
    if (projectId) {
      transports.set(
        PushTransportKey.Fcm,
        new FcmClient({
          projectId,
          serviceAccountJson: config.get<string>('FCM_SERVICE_ACCOUNT_JSON'),
        }),
      );
    }

    const keyP8 = config.get<string>('APNS_KEY_P8');
    const keyId = config.get<string>('APNS_KEY_ID');
    const teamId = config.get<string>('APNS_TEAM_ID');
    const bundleId = config.get<string>('APNS_BUNDLE_ID');
    if (keyP8 && keyId && teamId && bundleId) {
      transports.set(
        PushTransportKey.Apns,
        new ApnsClient({
          keyP8,
          keyId,
          teamId,
          bundleId,
          host: config.getOrThrow<string>('APNS_HOST'),
        }),
      );
    }

    // Ruteo platform→riel como DATOS. iOS conmutable por PUSH_IOS_TRANSPORT; Android siempre FCM.
    const routing: Record<PushPlatform, PushTransportKey> = {
      [PushPlatform.Ios]: config.getOrThrow<PushTransportKey>('PUSH_IOS_TRANSPORT'),
      [PushPlatform.Android]: PushTransportKey.Fcm,
    };

    // Guard de coherencia al boot (degradación honesta): cada riel referenciado por el routing DEBE
    // tener credenciales registradas. Recorre los rieles usados (sin enumerarlos a mano).
    for (const key of new Set(Object.values(routing))) {
      if (!transports.has(key)) {
        throw new ExternalServiceError(
          `PUSH live: el routing usa el riel '${key}' pero faltan sus credenciales`,
        );
      }
    }

    return new PushLiveSender(transports, routing);
  },
};

@Module({ providers: [pushProvider], exports: [PUSH_SENDER] })
export class PushModule {}
