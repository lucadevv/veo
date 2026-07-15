import { Module } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { BookingsRepository } from './bookings.repository';
import { BookingsController } from './bookings.controller';
import { BookingPaymentConsumer } from './payment-event.consumer';
import { PaymentModule } from '../ports/payment/payment.module';
import { CostCapModule } from '../cost-cap/cost-cap.module';
import { FleetModule } from '../fleet/fleet.module';
import { IdentityModule } from '../identity/identity.module';

@Module({
  // PaymentModule provee el token PAYMENT_GATEWAY (gate de deuda al reservar · §5.4; charge al aprobar · F3b).
  // CostCapModule provee CostCapService (re-tope F1b del precioAcordado al reservar · escudo anti-lucro, evita
  // que el specialRequest del pasajero empuje el precio del asiento por encima del costo compartido topado).
  // FleetModule provee FLEET_CLIENT (gate de OPERABILIDAD del vehículo al reservar · Lote 3: no se reserva un
  // asiento en un vehículo cuyos docs SOAT/ITV vencieron/se revocaron después de publicar).
  // IdentityModule provee IDENTITY_CLIENT (gate de elegibilidad del conductor al reservar · Lote 3 fix#2 + gate
  // de suspensión sobreviniente al aprobar/rechazar · F3b). Proveedor ÚNICO (antes duplicado inline).
  imports: [PaymentModule, CostCapModule, FleetModule, IdentityModule],
  // BookingPaymentConsumer (F3c): el PRIMER consumer Kafka del servicio. Es un provider con lifecycle propio
  // (onModuleInit arranca el consumer, onModuleDestroy lo desconecta — KafkaConsumerBootstrap), igual que
  // DispatchConsumer en trip-service / ErasureConsumer en media-service. Depende de BookingsService (orquesta
  // el seat-lock §6) + REDIS (dedup por eventId, exportado por el CoreModule global) + ConfigService (brokers).
  providers: [BookingsService, BookingsRepository, BookingPaymentConsumer],
  controllers: [BookingsController],
  exports: [BookingsService],
})
export class BookingsModule {}
