/**
 * CostCapModule — el GATE LEGAL F1b (cost-sharing por distancia · escudo anti-lucro) como módulo PROPIO,
 * desacoplado de published-trips. Provee + exporta `CostCapService` para que lo consuman DOS dueños sin
 * crear un ciclo de módulos:
 *  - PublishedTripsModule (publish/edit): topa `precioBase` + tramos al PUBLICAR.
 *  - BookingsModule (reservar): re-topa el `precioAcordado` (base + specialRequest) al RESERVAR.
 *
 * Antes `CostCapService` vivía DENTRO de PublishedTripsModule, que a su vez importa BookingsModule — meterlo
 * en BookingsModule habría cerrado un ciclo (bookings → published-trips → bookings). Extraerlo a su propio
 * módulo (que solo importa MapsModule + CostPerKmConfigModule, ambos hoja) rompe el ciclo: ambos dueños
 * importan CostCapModule, y CostCapModule no importa a ninguno de los dos.
 */
import { Module } from '@nestjs/common';
import { CostCapService } from './cost-cap.service';
import { MapsModule } from '../ports/maps/maps.module';
import { CostPerKmConfigModule } from '../cost-per-km/cost-per-km.module';

@Module({
  // MapsModule provee MAPS_CLIENT (distancia de la ruta); CostPerKmConfigModule provee el costo/km del admin.
  imports: [MapsModule, CostPerKmConfigModule],
  providers: [CostCapService],
  exports: [CostCapService],
})
export class CostCapModule {}
