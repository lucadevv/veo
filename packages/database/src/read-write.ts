/**
 * Separación lectura/escritura (decisión cliente: read/write split desde el inicio).
 * Cada servicio tiene su PrismaClient generado propio (schema-per-servicio). Este wrapper es
 * genérico vía tipado estructural para no acoplarse a un cliente concreto.
 *
 * Uso en un servicio:
 *   const db = new ReadWriteClient(PrismaClient, {
 *     writeUrl: env.DATABASE_URL, readUrl: env.DATABASE_URL_REPLICA,
 *   });
 *   await db.connect();
 *   db.write.trip.create(...)   // primary
 *   db.read.trip.findMany(...)  // replica
 *
 * ⚠ Replica lag: NUNCA leer de `read` un registro que se acaba de escribir en un flujo crítico
 *   (ej. confirmar un trip recién creado). En esos casos usar `write` para la lectura.
 */
export interface PrismaLike {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
}

export interface PrismaClientOptions {
  datasourceUrl?: string;
  log?: unknown[];
}

export type PrismaClientCtor<T extends PrismaLike> = new (options?: PrismaClientOptions) => T;

export interface ReadWriteOptions {
  writeUrl: string;
  /** Si se omite o es igual al primary, lecturas van al primary. */
  readUrl?: string;
  log?: unknown[];
}

export class ReadWriteClient<T extends PrismaLike> {
  readonly write: T;
  readonly read: T;
  private readonly splitEnabled: boolean;

  constructor(Ctor: PrismaClientCtor<T>, opts: ReadWriteOptions) {
    this.write = new Ctor({ datasourceUrl: opts.writeUrl, log: opts.log });
    this.splitEnabled = Boolean(opts.readUrl) && opts.readUrl !== opts.writeUrl;
    this.read = this.splitEnabled ? new Ctor({ datasourceUrl: opts.readUrl, log: opts.log }) : this.write;
  }

  async connect(): Promise<void> {
    await this.write.$connect();
    if (this.splitEnabled) await this.read.$connect();
  }

  async disconnect(): Promise<void> {
    await this.write.$disconnect();
    if (this.splitEnabled) await this.read.$disconnect();
  }
}
