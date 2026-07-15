/**
 * PolicyModule — wiring NestJS del cliente runtime de políticas (ADR-024 Fase 1). Un servicio de enforcement
 * lo importa (`PolicyModule.forRoot(...)` o `forRootAsync(...)`) y obtiene:
 *   • `KafkaCachedPolicyReader` — cache en memoria (carga inicial fail-safe + frescura por Kafka);
 *   • bajo DOS tokens que apuntan a la MISMA instancia:
 *       - `POLICY_READER` (`@veo/policy`, async · para servicios/sweepers),
 *       - `POLICY_READER_PORT` (`@veo/auth`, sync · para el `StepUpMfaGuard` y otros guards);
 *   • `PolicyUpdatedConsumer` — suscribe `policy.updated` y refresca el cache.
 *
 * Vive en el SUBPATH `@veo/policy/nest` (NO en el barrel liviano) para que quien importe solo el contrato
 * (`@veo/policy`) no arrastre las deps de Kafka/rpc. Config runtime (brokers, URL de identity, secreto HMAC)
 * la pasa el servicio desde SU `ConfigService` — el paquete no asume ningún schema de Env.
 */
import {
  Module,
  type DynamicModule,
  type Provider,
  type FactoryProvider,
} from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import { InternalAudience, POLICY_READER_PORT } from '@veo/auth';
import { POLICY_READER } from '../tokens.js';
import { InternalRestPolicyRegistry, type PolicyRegistryPort } from './registry.js';
import { KafkaCachedPolicyReader } from './kafka-cached-policy-reader.js';
import { PolicyUpdatedConsumer } from './policy-updated.consumer.js';
import { PermissionOverrideUpdatedConsumer } from './permission-override-updated.consumer.js';

/** Config runtime que el servicio pasa para cablear el cliente de políticas. */
export interface PolicyRuntimeConfig {
  /** clientId Kafka + base del groupId (nombre del servicio, ej. 'media-service'). */
  serviceName: string;
  /** Brokers Kafka (KAFKA_BROKERS ya parseado a array). */
  kafkaBrokers: string[];
  /** Base URL de identity-service (incluye el prefijo, ej. http://identity:3001/api/v1). */
  identityBaseUrl: string;
  /** Secreto HMAC interno compartido (VEO_INTERNAL_IDENTITY_SECRET). */
  internalSecret: string;
  /** Riel con el que se firma la identidad de sistema. Default admin-rail (lo exige `/internal/policies`). */
  audience?: InternalAudience;
  /** groupId del consumer de políticas. Default `${serviceName}-policy` (aislado de los demás consumers). */
  groupId?: string;
  /** groupId del consumer de overrides (overlay · ADR-025). Default `${serviceName}-permission-override`. */
  overrideGroupId?: string;
  /** Consumir desde el principio del topic. Default false. */
  fromBeginning?: boolean;
}

/** Token interno del objeto de config (no se exporta: es detalle de wiring del módulo). */
const POLICY_RUNTIME_CONFIG = Symbol('VEO_POLICY_RUNTIME_CONFIG');

/** Providers comunes a forRoot/forRootAsync: registro REST → reader → tokens → consumer. */
function runtimeProviders(): Provider[] {
  return [
    {
      provide: InternalRestPolicyRegistry,
      inject: [POLICY_RUNTIME_CONFIG],
      useFactory: (cfg: PolicyRuntimeConfig): PolicyRegistryPort =>
        new InternalRestPolicyRegistry(
          new InternalRestClient({
            baseUrl: cfg.identityBaseUrl,
            secret: cfg.internalSecret,
            audience: cfg.audience ?? InternalAudience.ADMIN_RAIL,
          }),
        ),
    },
    {
      provide: KafkaCachedPolicyReader,
      inject: [InternalRestPolicyRegistry],
      useFactory: (registry: PolicyRegistryPort): KafkaCachedPolicyReader =>
        new KafkaCachedPolicyReader(registry),
    },
    // Un solo cliente cacheado bajo AMBOS tokens (async para servicios, sync para guards).
    { provide: POLICY_READER, useExisting: KafkaCachedPolicyReader },
    { provide: POLICY_READER_PORT, useExisting: KafkaCachedPolicyReader },
    {
      provide: PolicyUpdatedConsumer,
      inject: [KafkaCachedPolicyReader, POLICY_RUNTIME_CONFIG],
      useFactory: (
        reader: KafkaCachedPolicyReader,
        cfg: PolicyRuntimeConfig,
      ): PolicyUpdatedConsumer =>
        new PolicyUpdatedConsumer(reader, {
          clientId: cfg.serviceName,
          brokers: cfg.kafkaBrokers,
          groupId: cfg.groupId ?? `${cfg.serviceName}-policy`,
          fromBeginning: cfg.fromBeginning,
        }),
    },
    {
      // OVERLAY (ADR-025): consumer hermano con SU propio groupId (aislado del de políticas), mismo reader.
      provide: PermissionOverrideUpdatedConsumer,
      inject: [KafkaCachedPolicyReader, POLICY_RUNTIME_CONFIG],
      useFactory: (
        reader: KafkaCachedPolicyReader,
        cfg: PolicyRuntimeConfig,
      ): PermissionOverrideUpdatedConsumer =>
        new PermissionOverrideUpdatedConsumer(reader, {
          clientId: cfg.serviceName,
          brokers: cfg.kafkaBrokers,
          groupId: cfg.overrideGroupId ?? `${cfg.serviceName}-permission-override`,
          fromBeginning: cfg.fromBeginning,
        }),
    },
  ];
}

/** Lo que el módulo EXPORTA: el cliente (async) y los dos tokens de inyección. */
const RUNTIME_EXPORTS = [KafkaCachedPolicyReader, POLICY_READER, POLICY_READER_PORT];

@Module({})
export class PolicyModule {
  /** Config estática (valores ya resueltos). */
  static forRoot(config: PolicyRuntimeConfig): DynamicModule {
    return {
      // GLOBAL: el reader cacheado es un SINGLETON del servicio (una carga inicial, un consumer Kafka) y lo
      // consumen tanto los guards de bajo nivel (StepUpMfaGuard, en módulos globales) como los servicios/
      // sweepers de cualquier módulo. Global evita re-importar el módulo en cada feature (lo que duplicaría el
      // cache y el consumer). Los tokens que expone son de SOLO LECTURA → sin riesgo por la visibilidad global.
      global: true,
      module: PolicyModule,
      providers: [{ provide: POLICY_RUNTIME_CONFIG, useValue: config }, ...runtimeProviders()],
      exports: RUNTIME_EXPORTS,
    };
  }

  /** Config diferida (ej. leída del `ConfigService` del servicio por DI). */
  static forRootAsync(opts: {
    imports?: DynamicModule['imports'];
    inject?: FactoryProvider['inject'];
    useFactory: (...args: never[]) => PolicyRuntimeConfig | Promise<PolicyRuntimeConfig>;
  }): DynamicModule {
    const configProvider: Provider = {
      provide: POLICY_RUNTIME_CONFIG,
      inject: opts.inject ?? [],
      useFactory: opts.useFactory as FactoryProvider['useFactory'],
    };
    return {
      // GLOBAL — mismo motivo que forRoot: singleton (cache + consumer) compartido por guards y servicios.
      global: true,
      module: PolicyModule,
      imports: opts.imports ?? [],
      providers: [configProvider, ...runtimeProviders()],
      exports: RUNTIME_EXPORTS,
    };
  }
}
