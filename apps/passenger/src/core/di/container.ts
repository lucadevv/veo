/**
 * Contenedor de inyección de dependencias TIPADO y ligero (service locator manual).
 *
 * No añade dependencias externas. Cumple DIP: las features dependen de abstracciones
 * (interfaces de repositorio en `domain`), y aquí se registran las implementaciones
 * concretas (`data`). El tipo del token "transporta" el tipo de la dependencia, así que
 * `resolve(token)` devuelve el tipo correcto sin casts en el sitio de uso.
 */

/** Token tipado: un símbolo único que recuerda (en tipos) qué resuelve. */
export interface Token<T> {
  readonly symbol: symbol;
  /** Marca de tipo en tiempo de compilación (no existe en runtime). */
  readonly _type?: T;
}

/** Crea un token tipado e irrepetible. */
export function createToken<T>(description: string): Token<T> {
  return { symbol: Symbol(description) };
}

/** Fábrica perezosa de una dependencia; recibe el contenedor para resolver sus propias deps. */
export type Factory<T> = (container: Container) => T;

/**
 * Contenedor con resolución perezosa y cacheo singleton por token.
 * Registrar es barato (no instancia nada); la instancia se crea al primer `resolve`.
 */
export class Container {
  private readonly factories = new Map<symbol, Factory<unknown>>();
  private readonly singletons = new Map<symbol, unknown>();

  /** Registra (o sobrescribe) la fábrica de un token. */
  register<T>(token: Token<T>, factory: Factory<T>): this {
    this.factories.set(token.symbol, factory as Factory<unknown>);
    // Si se re-registra, invalidamos el singleton previo.
    this.singletons.delete(token.symbol);
    return this;
  }

  /** Resuelve la dependencia, instanciándola una sola vez (singleton). */
  resolve<T>(token: Token<T>): T {
    if (this.singletons.has(token.symbol)) {
      return this.singletons.get(token.symbol) as T;
    }
    const factory = this.factories.get(token.symbol);
    if (!factory) {
      throw new Error(
        `[di] dependencia no registrada: ${token.symbol.description ?? 'desconocida'}`,
      );
    }
    const instance = factory(this) as T;
    this.singletons.set(token.symbol, instance);
    return instance;
  }

  /** True si el token tiene una fábrica registrada. */
  has<T>(token: Token<T>): boolean {
    return this.factories.has(token.symbol);
  }

  /** Limpia los singletons cacheados (útil en tests). */
  reset(): void {
    this.singletons.clear();
  }
}
