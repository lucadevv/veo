/**
 * PlacesRepository — puerto + adaptador Prisma de los lugares guardados (unit-of-work · FOUNDATION §10).
 * ÚNICO dueño de Prisma en el feature: el PlacesService depende de la INTERFAZ (PLACES_REPO), nunca del
 * cliente. Las reglas de negocio (tope de favoritos, unicidad HOME/WORK) siguen viviendo en el service y
 * corren DENTRO de `runInTx` — el repo sólo provee la transacción (SERIALIZABLE, ver abajo) y el cliente tx.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type SavedPlace } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const PLACES_REPO = Symbol('PLACES_REPO');

/** Cliente de transacción entregado por `runInTx` (count/create/findFirst/update/deleteMany atómicos). */
export type PlacesTx = Prisma.TransactionClient;

/** Puerto: el servicio depende de esto, no de Prisma. */
export interface PlacesRepository {
  /** Lugares del usuario SIN ordenar (el orden de presentación lo aplica el service). */
  findManyByUser(userId: string): Promise<SavedPlace[]>;
  /** Borra el lugar del propio usuario; devuelve cuántas filas cayeron (0 = ajeno/inexistente). */
  deleteByUser(id: string, userId: string): Promise<number>;
  /**
   * Abre una transacción SERIALIZABLE y entrega el cliente tx al callback. Serializable porque las dos
   * escrituras del feature (tope de favoritos y unicidad HOME/WORK) eran TOCTOU: serializa esas lecturas
   * con el write para que una carrera real (mismo usuario y kind a la vez) falle honesta (serialization
   * error) en vez de violar el invariante.
   */
  runInTx<T>(fn: (tx: PlacesTx) => Promise<T>): Promise<T>;
}

@Injectable()
export class PrismaPlacesRepository implements PlacesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findManyByUser(userId: string): Promise<SavedPlace[]> {
    return this.prisma.read.savedPlace.findMany({ where: { userId } });
  }

  async deleteByUser(id: string, userId: string): Promise<number> {
    const result = await this.prisma.write.savedPlace.deleteMany({ where: { id, userId } });
    return result.count;
  }

  async runInTx<T>(fn: (tx: PlacesTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(async (tx) => fn(tx), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }
}
