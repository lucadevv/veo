/**
 * Tests de las REGLAS DE NEGOCIO de lugares guardados (server-side, sin Nest DI ni Postgres real):
 *  - HOME/WORK únicos por usuario (al guardar, reemplazan el previo del mismo kind).
 *  - FAVORITE: máximo MAX_FAVORITES; el excedente se rechaza con FavoritesLimitError.
 *  - Listado ordenado: HOME, WORK, luego FAVORITEs por createdAt desc.
 *  - Validación: label 1..MAX_LABEL (con default Casa/Trabajo) y lat/lng en rango.
 *  - Aislamiento por userId: update/remove ajenos → PlaceNotFoundError.
 *
 * Se inyecta un PrismaService falso en memoria (espeja el subconjunto de queries usado por el servicio)
 * y un ConfigService falso. Determinista: el `now` se controla para ordenar favoritos.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PlaceKind, type SavedPlace } from '../generated/prisma';
import { PlacesService } from './places.service';
import { PrismaPlacesRepository } from './places.repository';
import { FavoritesLimitError, PlaceNotFoundError, PlaceValidationError } from './places.errors';

const MAX_FAVORITES = 20;
const MAX_LABEL = 40;

let clock = 0;
const nextDate = (): Date => new Date(1_700_000_000_000 + clock++ * 1_000);

let uuidCounter = 0;
const nextId = (): string => `00000000-0000-0000-0000-${String(++uuidCounter).padStart(12, '0')}`;

/** Store en memoria que implementa el subconjunto de Prisma usado por PlacesService. */
class FakeSavedPlaceDelegate {
  constructor(private readonly rows: SavedPlace[]) {}

  async findMany(args: { where: { userId: string } }): Promise<SavedPlace[]> {
    return this.rows.filter((r) => r.userId === args.where.userId);
  }

  async findFirst(args: {
    where: { id?: string; userId: string; kind?: PlaceKind };
  }): Promise<SavedPlace | null> {
    const { id, userId, kind } = args.where;
    return (
      this.rows.find(
        (r) =>
          r.userId === userId &&
          (id === undefined || r.id === id) &&
          (kind === undefined || r.kind === kind),
      ) ?? null
    );
  }

  async count(args: { where: { userId: string; kind?: PlaceKind } }): Promise<number> {
    const { userId, kind } = args.where;
    return this.rows.filter((r) => r.userId === userId && (kind === undefined || r.kind === kind))
      .length;
  }

  async create(args: {
    data: {
      userId: string;
      kind: PlaceKind;
      label: string;
      subtitle: string | null;
      lat: number;
      lng: number;
    };
  }): Promise<SavedPlace> {
    const at = nextDate();
    const row: SavedPlace = {
      id: nextId(),
      userId: args.data.userId,
      kind: args.data.kind,
      label: args.data.label,
      subtitle: args.data.subtitle,
      lat: args.data.lat,
      lng: args.data.lng,
      createdAt: at,
      updatedAt: at,
    };
    this.rows.push(row);
    return row;
  }

  async update(args: {
    where: { id: string };
    data: Partial<Omit<SavedPlace, 'id' | 'createdAt'>>;
  }): Promise<SavedPlace> {
    const row = this.rows.find((r) => r.id === args.where.id);
    if (!row) {
      throw new Error('not found');
    }
    Object.assign(row, args.data, { updatedAt: nextDate() });
    return row;
  }

  async deleteMany(args: {
    where: { id?: string | { not: string }; userId: string; kind?: PlaceKind };
  }): Promise<{ count: number }> {
    const { id, userId, kind } = args.where;
    const before = this.rows.length;
    const survivors = this.rows.filter((r) => {
      const matchUser = r.userId === userId;
      const matchKind = kind === undefined || r.kind === kind;
      let matchId = true;
      if (typeof id === 'string') {
        matchId = r.id === id;
      } else if (id && 'not' in id) {
        matchId = r.id !== id.not;
      }
      return !(matchUser && matchKind && matchId);
    });
    this.rows.length = 0;
    this.rows.push(...survivors);
    return { count: before - this.rows.length };
  }
}

class FakePrisma {
  private readonly rows: SavedPlace[] = [];
  readonly savedPlace = new FakeSavedPlaceDelegate(this.rows);
  get read(): { savedPlace: FakeSavedPlaceDelegate } {
    return { savedPlace: this.savedPlace };
  }
  get write(): {
    savedPlace: FakeSavedPlaceDelegate;
    $transaction: <T>(
      fn: (tx: { savedPlace: FakeSavedPlaceDelegate }) => Promise<T>,
      opts?: unknown,
    ) => Promise<T>;
  } {
    // El fake es secuencial (sin concurrencia real): la tx corre el body con el MISMO delegate in-memory;
    // el isolationLevel se ignora. Verifica la LÓGICA (tope de favoritos, reemplazo HOME/WORK), no la carrera.
    return {
      savedPlace: this.savedPlace,
      $transaction: (fn, _opts) => fn({ savedPlace: this.savedPlace }),
    };
  }
}

function makeService(): PlacesService {
  const prisma = new FakePrisma();
  // El repo real (adaptador Prisma) envuelve el prisma falso: ejercita el mismo unit-of-work que en runtime
  // (findManyByUser / deleteByUser / runInTx) sin Postgres. El $transaction del fake ignora el isolationLevel.
  const repo = new PrismaPlacesRepository(prisma as never);
  const config = {
    getOrThrow: (key: string): number => (key === 'MAX_FAVORITES' ? MAX_FAVORITES : MAX_LABEL),
  };
  // El ctor sólo usa repo (PLACES_REPO) y config.getOrThrow → los falsos bastan (sin Nest DI).
  return new PlacesService(repo, config as never);
}

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const validPoint = { lat: -12.05, lng: -77.04 };

beforeEach(() => {
  clock = 0;
  uuidCounter = 0;
});

describe('PlacesService · HOME/WORK únicos', () => {
  it('reemplaza el HOME previo en vez de crear otro (upsert por userId+kind)', async () => {
    const svc = makeService();
    await svc.save(USER, { kind: PlaceKind.HOME, label: 'Casa', ...validPoint });
    await svc.save(USER, { kind: PlaceKind.HOME, label: 'Casa nueva', lat: -12.1, lng: -77.0 });

    const list = await svc.listByUser(USER);
    const homes = list.filter((p) => p.kind === PlaceKind.HOME);
    expect(homes).toHaveLength(1);
    expect(homes[0]?.label).toBe('Casa nueva');
  });

  it('WORK también es único por usuario', async () => {
    const svc = makeService();
    await svc.save(USER, { kind: PlaceKind.WORK, label: 'Trabajo', ...validPoint });
    await svc.save(USER, { kind: PlaceKind.WORK, label: 'Oficina', ...validPoint });

    const works = (await svc.listByUser(USER)).filter((p) => p.kind === PlaceKind.WORK);
    expect(works).toHaveLength(1);
    expect(works[0]?.label).toBe('Oficina');
  });

  it('el HOME de un usuario no afecta al de otro', async () => {
    const svc = makeService();
    await svc.save(USER, { kind: PlaceKind.HOME, label: 'Casa A', ...validPoint });
    await svc.save(OTHER, { kind: PlaceKind.HOME, label: 'Casa B', ...validPoint });

    expect(await svc.listByUser(USER)).toHaveLength(1);
    expect(await svc.listByUser(OTHER)).toHaveLength(1);
  });
});

describe('PlacesService · tope de favoritos', () => {
  it(`permite hasta ${MAX_FAVORITES} favoritos`, async () => {
    const svc = makeService();
    for (let i = 0; i < MAX_FAVORITES; i++) {
      await svc.save(USER, { kind: PlaceKind.FAVORITE, label: `Fav ${i}`, ...validPoint });
    }
    const favs = (await svc.listByUser(USER)).filter((p) => p.kind === PlaceKind.FAVORITE);
    expect(favs).toHaveLength(MAX_FAVORITES);
  });

  it('rechaza el favorito que excede el tope (FavoritesLimitError)', async () => {
    const svc = makeService();
    for (let i = 0; i < MAX_FAVORITES; i++) {
      await svc.save(USER, { kind: PlaceKind.FAVORITE, label: `Fav ${i}`, ...validPoint });
    }
    await expect(
      svc.save(USER, { kind: PlaceKind.FAVORITE, label: 'uno de más', ...validPoint }),
    ).rejects.toBeInstanceOf(FavoritesLimitError);
  });

  it('HOME/WORK no cuentan contra el tope de favoritos', async () => {
    const svc = makeService();
    await svc.save(USER, { kind: PlaceKind.HOME, label: 'Casa', ...validPoint });
    await svc.save(USER, { kind: PlaceKind.WORK, label: 'Trabajo', ...validPoint });
    for (let i = 0; i < MAX_FAVORITES; i++) {
      await svc.save(USER, { kind: PlaceKind.FAVORITE, label: `Fav ${i}`, ...validPoint });
    }
    expect(await svc.listByUser(USER)).toHaveLength(MAX_FAVORITES + 2);
  });
});

describe('PlacesService · orden de listado', () => {
  it('ordena HOME, WORK, luego FAVORITEs por createdAt desc', async () => {
    const svc = makeService();
    await svc.save(USER, { kind: PlaceKind.FAVORITE, label: 'Fav viejo', ...validPoint });
    await svc.save(USER, { kind: PlaceKind.FAVORITE, label: 'Fav nuevo', ...validPoint });
    await svc.save(USER, { kind: PlaceKind.WORK, label: 'Trabajo', ...validPoint });
    await svc.save(USER, { kind: PlaceKind.HOME, label: 'Casa', ...validPoint });

    const list = await svc.listByUser(USER);
    expect(list.map((p) => p.kind)).toEqual([
      PlaceKind.HOME,
      PlaceKind.WORK,
      PlaceKind.FAVORITE,
      PlaceKind.FAVORITE,
    ]);
    // Entre favoritos: el más reciente primero.
    const favs = list.filter((p) => p.kind === PlaceKind.FAVORITE);
    expect(favs.map((p) => p.label)).toEqual(['Fav nuevo', 'Fav viejo']);
  });
});

describe('PlacesService · validación', () => {
  it('rechaza label vacío para favorito (sin default)', async () => {
    const svc = makeService();
    await expect(
      svc.save(USER, { kind: PlaceKind.FAVORITE, label: '   ', ...validPoint }),
    ).rejects.toBeInstanceOf(PlaceValidationError);
  });

  it('aplica default "Casa" cuando HOME viene sin label', async () => {
    const svc = makeService();
    const place = await svc.save(USER, { kind: PlaceKind.HOME, label: '', ...validPoint });
    expect(place.label).toBe('Casa');
  });

  it(`rechaza label de más de ${MAX_LABEL} caracteres`, async () => {
    const svc = makeService();
    await expect(
      svc.save(USER, { kind: PlaceKind.FAVORITE, label: 'x'.repeat(MAX_LABEL + 1), ...validPoint }),
    ).rejects.toBeInstanceOf(PlaceValidationError);
  });

  it('rechaza lat/lng no finitos o fuera de rango', async () => {
    const svc = makeService();
    await expect(
      svc.save(USER, { kind: PlaceKind.FAVORITE, label: 'mal', lat: Number.NaN, lng: 0 }),
    ).rejects.toBeInstanceOf(PlaceValidationError);
    await expect(
      svc.save(USER, { kind: PlaceKind.FAVORITE, label: 'mal', lat: 0, lng: 999 }),
    ).rejects.toBeInstanceOf(PlaceValidationError);
  });
});

describe('PlacesService · update/remove con aislamiento por userId', () => {
  it('update de un id ajeno lanza PlaceNotFoundError', async () => {
    const svc = makeService();
    const mine = await svc.save(USER, { kind: PlaceKind.FAVORITE, label: 'mío', ...validPoint });
    await expect(
      svc.update(OTHER, mine.id, { kind: PlaceKind.FAVORITE, label: 'robado', ...validPoint }),
    ).rejects.toBeInstanceOf(PlaceNotFoundError);
  });

  it('remove de un id ajeno lanza PlaceNotFoundError y no borra', async () => {
    const svc = makeService();
    const mine = await svc.save(USER, { kind: PlaceKind.FAVORITE, label: 'mío', ...validPoint });
    await expect(svc.remove(OTHER, mine.id)).rejects.toBeInstanceOf(PlaceNotFoundError);
    expect(await svc.listByUser(USER)).toHaveLength(1);
  });

  it('update que cambia un favorito a HOME mantiene la unicidad de HOME', async () => {
    const svc = makeService();
    await svc.save(USER, { kind: PlaceKind.HOME, label: 'Casa', ...validPoint });
    const fav = await svc.save(USER, {
      kind: PlaceKind.FAVORITE,
      label: 'futuro hogar',
      ...validPoint,
    });

    await svc.update(USER, fav.id, { kind: PlaceKind.HOME, label: 'Casa real', ...validPoint });

    const homes = (await svc.listByUser(USER)).filter((p) => p.kind === PlaceKind.HOME);
    expect(homes).toHaveLength(1);
    expect(homes[0]?.label).toBe('Casa real');
  });

  it('remove de un id propio lo elimina', async () => {
    const svc = makeService();
    const mine = await svc.save(USER, { kind: PlaceKind.FAVORITE, label: 'mío', ...validPoint });
    await svc.remove(USER, mine.id);
    expect(await svc.listByUser(USER)).toHaveLength(0);
  });
});
