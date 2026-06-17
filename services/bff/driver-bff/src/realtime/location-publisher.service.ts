/**
 * Publicador del GPS del conductor a Kafka (soberanía: GPS por Socket.IO, NO MQTT).
 * Envuelve el KafkaEventProducer de @veo/events y publica `driver.location_updated` en el topic
 * `driver`. El payload se valida en el productor contra el registro de @veo/events; aquí calculamos
 * la celda H3 (resolución de dispatch) con @veo/utils, igual que el resto de productores del sistema.
 */
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaEventProducer, createEnvelope, createKafka, type EventPayload } from '@veo/events';
import { toH3 } from '@veo/utils';
import { createLogger, type Logger } from '@veo/observability';
import type { DriverLocationReport } from '@veo/api-client';
import type { FleetDocumentType, VehicleClass, VehicleSegment } from '@veo/shared-types';
import type { Env } from '../config/env.schema';

/**
 * Reporte con la clase de vehículo YA SELLADA server-authoritative (el gateway la resuelve contra
 * fleet ANTES de publicar). Exigirla acá por tipo (ADR 013 · Lote D) elimina el viejo `?? 'CAR'`
 * del publisher: un caller nuevo no puede olvidarse de sellar la clase y caer silencioso a CAR.
 * B5-3 · suma los attrs de eligibilidad del vehículo activo (opcionales: el modelo legacy/texto-libre
 * no los aporta ⇒ dispatch no restringe a ese conductor).
 */
type SealedLocationReport = DriverLocationReport & {
  vehicleType: VehicleClass;
  seats?: number;
  segment?: VehicleSegment;
  vehicleYear?: number;
  certifications?: FleetDocumentType[];
};

@Injectable()
export class LocationPublisherService implements OnModuleInit, OnModuleDestroy {
  private producer?: KafkaEventProducer;
  private connected = false;
  private readonly logger: Logger = createLogger('driver-bff:location');

  constructor(private readonly config: ConfigService<Env, true>) {}

  async onModuleInit(): Promise<void> {
    // No bloquea el arranque: si Kafka aún no responde, se reintenta en la primera publicación.
    try {
      await this.connect();
    } catch (err) {
      this.logger.error({ err }, 'el productor Kafka de ubicación no conectó al iniciar');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.producer && this.connected) await this.producer.disconnect();
  }

  /**
   * Publica `driver.location_updated`. Devuelve true si se envió, false si Kafka no está disponible
   * (el caller decide cómo reflejarlo en el ack del socket). Nunca lanza al caller.
   */
  async publishDriverLocation(driverId: string, report: SealedLocationReport): Promise<boolean> {
    try {
      if (!this.connected || !this.producer) await this.connect();
      const producer = this.producer;
      if (!producer) return false;
      const point = { lat: report.lat, lon: report.lon };
      const payload: EventPayload<'driver.location_updated'> = {
        driverId,
        point,
        h3: toH3(point),
        at: report.ts,
        // Rumbo para rotar el ícono del vehículo en el mapa del pasajero. null si la muestra no lo trae.
        heading: report.heading ?? null,
        // Clase de vehículo activa del conductor, sellada por el gateway. dispatch filtra el matching.
        vehicleType: report.vehicleType,
        // B5-3 · attrs de eligibilidad del vehículo activo (del modelSpec). Opcionales: dispatch los usa
        // para filtrar por oferta; si faltan (legacy), degrada a "elegible".
        seats: report.seats,
        segment: report.segment,
        vehicleYear: report.vehicleYear,
        // B5-3.2 · certs vigentes del conductor; dispatch gatea las verticales fail-closed.
        certifications: report.certifications,
      };
      const envelope = createEnvelope({
        eventType: 'driver.location_updated',
        producer: 'driver-bff',
        payload,
      });
      await producer.publish(envelope, driverId);
      return true;
    } catch (err) {
      this.connected = false;
      this.logger.warn({ err, driverId }, 'no se pudo publicar driver.location_updated');
      return false;
    }
  }

  private async connect(): Promise<void> {
    const brokers = this.config
      .getOrThrow<string>('KAFKA_BROKERS')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);
    const kafka = createKafka({ clientId: 'driver-bff-location', brokers });
    this.producer = new KafkaEventProducer(kafka);
    await this.producer.connect();
    this.connected = true;
    this.logger.info({ brokers }, 'productor Kafka de ubicación conectado');
  }
}
