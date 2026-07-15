import React, { type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VehicleType } from '@veo/shared-types';
import { DocumentScannerError, type ScannedDocument } from '../../../../documents/domain';
import type { AppContainer } from '../../../../../core/di/container';
import { DiProvider } from '../../../../../core/di/useDi';
import { useRegistrationStore } from '../../state/registrationStore';
import { useScanPropertyCard } from '../useScanPropertyCard';

/**
 * Pruebas del flujo scan-first de la TARJETA DE PROPIEDAD (Lote 2): `useScanPropertyCard` orquesta
 * escaneo (1 página) → OCR (`parsePropertyCard`) → DERIVA el `VehicleType` de la categoría MTC →
 * prellenado NO destructivo del store (placa/año/marca/modelo a TEXTO LIBRE) → GUARDADO de la imagen +
 * data OCR como `pendingPropertyCard` para la subida DIFERIDA tras crear el vehículo. El escáner se
 * inyecta por DI con un doble (el hook NO conoce el módulo nativo).
 *
 * modelSpecId es OPCIONAL: el scan toma la rama de TEXTO LIBRE (make/model del OCR), sin tocar el catálogo.
 */

/** Texto OCR de una tarjeta de propiedad / TIVe peruana M1 (auto): categoría + marca/modelo/año + placa. */
const CARD_M1_LINES: string[] = [
  'SUPERINTENDENCIA NACIONAL DE LOS REGISTROS PUBLICOS',
  'Tarjeta de Identificacion Vehicular',
  'Placa N°: ABC-123',
  'Categoría: M1',
  'Marca: TOYOTA',
  'Modelo: YARIS',
  'Año de Fab.: 2021',
  'Color: PLATA',
];

/** Tarjeta N1 (furgón): categoría NO soportada hoy → `mapMtcCategoryToVehicleType` = null → manual. */
const CARD_N1_LINES: string[] = [
  'Tarjeta de Identificacion Vehicular',
  'Placa N°: XYZ-789',
  'Categoría: N1',
  'Marca: HYUNDAI',
  'Modelo: H100',
  'Año de Fab.: 2019',
];

/** Tarjeta SIN placa legible (foto borrosa): el OCR no ancla la placa → fallback honesto / re-scan. */
const CARD_NO_PLATE_LINES: string[] = [
  'Tarjeta de Identificacion Vehicular',
  'Categoría: M1',
  'Marca: KIA',
  'Modelo: RIO',
  'Año de Fab.: 2020',
];

/**
 * Tarjeta M1 con un AÑO FUERA del rango del contrato (2003 < MIN_VEHICLE_YEAR=2005): el parser del OCR lo
 * lee (acepta 1950..2099) pero el alta lo rechazaría (`year_invalid`) → el hook NO debe prellenarlo, para
 * que la pantalla lo trate como corregible y no finja "capturada ✓". (FIX 4)
 */
const CARD_OLD_YEAR_LINES: string[] = [
  'Tarjeta de Identificacion Vehicular',
  'Placa N°: DEF-456',
  'Categoría: M1',
  'Marca: TOYOTA',
  'Modelo: COROLLA',
  'Año de Fab.: 2003',
];

/** Tarjeta L3 (moto · vehículo menor): categoría → MOTO, con placa de moto `7351-NB` (4 díg + 2 letras). */
const CARD_L3_LINES: string[] = [
  'Tarjeta de Identificacion Vehicular',
  'Placa N°: 7351-NB',
  'Categoría: L3',
  'Marca: KTM',
  'Modelo: DUKE 200',
  'Año de Fab.: 2022',
];

function scanOf(lines: string[]): ScannedDocument {
  return { images: ['/9j/card-base64'], textLines: [lines] };
}

interface ScannerDouble {
  scan: jest.Mock<Promise<ScannedDocument>, [options?: { maxPages?: number }]>;
}

/** Contenedor de DI de prueba: solo necesita el escáner (el scan NO sube, no toca uploader/repo). */
function fakeContainer(scanner: ScannerDouble): AppContainer {
  return { documentScanner: scanner } as unknown as AppContainer;
}

interface HookHandle {
  current: ReturnType<typeof useScanPropertyCard> | null;
}

function HookProbe({ handle }: { handle: HookHandle }): React.JSX.Element {
  handle.current = useScanPropertyCard();
  return <></>;
}

function renderHookWith(container: AppContainer): HookHandle {
  const handle: HookHandle = { current: null };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <DiProvider container={container}>
        <HookProbe handle={handle} />
      </DiProvider>
    </QueryClientProvider>
  );
  act(() => {
    TestRenderer.create(tree);
  });
  return handle;
}

beforeEach(() => {
  act(() => {
    useRegistrationStore.getState().reset();
  });
});

describe('useScanPropertyCard', () => {
  it('(a) M1: deriva CAR, prellena placa/año y guarda marca/modelo a TEXTO LIBRE', async () => {
    const scanner: ScannerDouble = { scan: jest.fn(async () => scanOf(CARD_M1_LINES)) };
    const handle = renderHookWith(fakeContainer(scanner));

    let outcome: Awaited<ReturnType<NonNullable<HookHandle['current']>['scan']>> | undefined;
    await act(async () => {
      outcome = await handle.current?.scan();
    });

    // El escáner se abre a UNA página (la tarjeta es una sola cara).
    expect(scanner.scan).toHaveBeenCalledWith({ maxPages: 1 });

    const vehicle = useRegistrationStore.getState().vehicle;
    // Tipo DERIVADO de la categoría MTC M1 → CAR (fijado en el store, sin selector manual).
    expect(vehicle.type).toBe(VehicleType.CAR);
    expect(vehicle.plate).toBe('ABC-123');
    expect(vehicle.year).toBe('2021');
    // Marca/modelo a TEXTO LIBRE (sin modelSpecId): el catálogo no se toca (fuzzy-match = Lote 3).
    expect(vehicle.brand).toBe('TOYOTA');
    expect(vehicle.model).toBe('YARIS');
    expect(vehicle.modelSpecId).toBe('');
    // LOTE 1: la categoría MTC cruda se persiste en el store (viaja al backend como fuente de verdad).
    expect(vehicle.mtcCategory).toBe('M1');
    // Color de carrocería leído de la tarjeta (`Color: PLATA`) → prellenado en el store (viaja al backend
    // opcional vía `registerVehicleRequest.color`).
    expect(vehicle.color).toBe('PLATA');

    expect(handle.current?.state).toBe('captured');
    expect(outcome?.derivedType).toBe(VehicleType.CAR);
    expect(outcome?.mtcUnsupported).toBe(false);
    expect(outcome?.autofilled).toEqual({
      plate: true,
      year: true,
      make: true,
      model: true,
      color: true,
      vehicleType: true,
    });

    // La imagen + la data OCR quedan pendientes para la subida DIFERIDA tras crear el vehículo.
    const pending = useRegistrationStore.getState().pendingPropertyCard;
    expect(pending).not.toBeNull();
    expect(pending?.front.uri).toBe('data:image/jpeg;base64,/9j/card-base64');
    expect(pending?.extractedData).toEqual({
      type: 'PROPERTY_CARD',
      plate: 'ABC-123',
      make: 'TOYOTA',
      model: 'YARIS',
      year: 2021,
      mtcCategory: 'M1',
    });
  });

  it('(b) categoría N1 (no soportada): NO auto-fija el tipo y marca mtcUnsupported → selector manual', async () => {
    const scanner: ScannerDouble = { scan: jest.fn(async () => scanOf(CARD_N1_LINES)) };
    const handle = renderHookWith(fakeContainer(scanner));

    let outcome: Awaited<ReturnType<NonNullable<HookHandle['current']>['scan']>> | undefined;
    await act(async () => {
      outcome = await handle.current?.scan();
    });

    // Categoría N1 (furgón) no tiene tier soportado hoy → derivedType null, fallback al selector manual.
    expect(outcome?.derivedType).toBeNull();
    expect(outcome?.mtcUnsupported).toBe(true);
    expect(handle.current?.autofilled.vehicleType).toBe(false);

    // LOTE 1: SIN seed "Auto". El tipo del store queda en `null` (el scan NO derivó ni inventó): cae al
    // selector de FALLBACK (ambos tipos) y Registrar queda bloqueado hasta elegir. Nunca un "Auto" mudo.
    const vehicle = useRegistrationStore.getState().vehicle;
    expect(vehicle.type).toBeNull();
    // El resto SÍ se prellenó (placa/marca/modelo/año): solo el TIPO cae a manual.
    expect(vehicle.plate).toBe('XYZ-789');
    expect(vehicle.brand).toBe('HYUNDAI');
    // LOTE 1: la categoría MTC cruda se PERSISTE en el store (viaja al backend como fuente de verdad)
    // aunque no derive a un tier soportado: el servidor la guarda y deriva el tipo server-authoritative.
    expect(vehicle.mtcCategory).toBe('N1');
    // La categoría cruda viaja también en la data OCR (el backend la conserva); el mapeo a tipo es del flujo.
    expect(useRegistrationStore.getState().pendingPropertyCard?.extractedData?.mtcCategory).toBe(
      'N1',
    );
  });

  it('(c) placa NO leída (foto borrosa): NO fabrica placa; el gating del campo crítico queda en falso', async () => {
    const scanner: ScannerDouble = { scan: jest.fn(async () => scanOf(CARD_NO_PLATE_LINES)) };
    const handle = renderHookWith(fakeContainer(scanner));

    await act(async () => {
      await handle.current?.scan();
    });

    const vehicle = useRegistrationStore.getState().vehicle;
    // La PLACA (campo crítico) NO se leyó → queda VACÍA (jamás se inventa). La pantalla pide re-scan/input.
    expect(vehicle.plate).toBe('');
    expect(handle.current?.autofilled.plate).toBe(false);
    // El resto sí (M1 → CAR + marca/modelo/año), pero sin placa no se puede avanzar.
    expect(vehicle.type).toBe(VehicleType.CAR);
    expect(vehicle.brand).toBe('KIA');
    expect(handle.current?.state).toBe('captured');
  });

  it('(d) año FUERA de rango del contrato (2003 < 2005): NO lo prellena → corregible, no finge capturada', async () => {
    const scanner: ScannerDouble = { scan: jest.fn(async () => scanOf(CARD_OLD_YEAR_LINES)) };
    const handle = renderHookWith(fakeContainer(scanner));

    let outcome: Awaited<ReturnType<NonNullable<HookHandle['current']>['scan']>> | undefined;
    await act(async () => {
      outcome = await handle.current?.scan();
    });

    const vehicle = useRegistrationStore.getState().vehicle;
    // El año (2003) cae bajo MIN_VEHICLE_YEAR (2005): el hook NO lo escribe → el campo queda VACÍO para que
    // la pantalla ofrezca un input corregible (no se finge "capturada ✓" con un año que el alta rechazaría).
    expect(vehicle.year).toBe('');
    expect(outcome?.autofilled.year).toBe(false);
    expect(handle.current?.autofilled.year).toBe(false);
    // El resto SÍ se prellenó (placa/marca/modelo/tipo): solo el AÑO queda corregible.
    expect(vehicle.plate).toBe('DEF-456');
    expect(vehicle.brand).toBe('TOYOTA');
    expect(vehicle.type).toBe(VehicleType.CAR);
    // La data OCR (que viaja al backend) conserva el año crudo leído: el backend lo audita; el gating es del flujo.
    expect(useRegistrationStore.getState().pendingPropertyCard?.extractedData?.year).toBe(2003);
  });

  it('prellenado NO destructivo: una placa ya tipeada por el conductor NO la pisa el OCR', async () => {
    const scanner: ScannerDouble = { scan: jest.fn(async () => scanOf(CARD_M1_LINES)) };
    const handle = renderHookWith(fakeContainer(scanner));

    act(() => {
      useRegistrationStore.getState().setVehicle({ plate: 'ZZZ-999' });
    });

    await act(async () => {
      await handle.current?.scan();
    });

    const vehicle = useRegistrationStore.getState().vehicle;
    expect(vehicle.plate).toBe('ZZZ-999');
    expect(handle.current?.autofilled.plate).toBe(false);
    // Los campos vacíos sí se prellenan.
    expect(vehicle.brand).toBe('TOYOTA');
  });

  it('re-escaneo M1→L3: actualiza mtcCategory Y tipo JUNTOS (no deja mtcCategory STALE en M1)', async () => {
    // FIX LOTE 1: mtcCategory y vehicleType son DERIVADOS del documento y deben moverse JUNTOS. Antes
    // mtcCategory era no-destructivo (solo-si-vacío) mientras el tipo se reescribía siempre: un re-escaneo
    // dejaba {mtcCategory:'M1', type:MOTO} → el backend re-derivaba CAR de M1 y descartaba el hint MOTO
    // (divergencia "auto silencioso"). Ahora la categoría se reescribe en sincronía con el tipo.
    const scanner: ScannerDouble = {
      scan: jest
        .fn<Promise<ScannedDocument>, [options?: { maxPages?: number }]>()
        .mockResolvedValueOnce(scanOf(CARD_M1_LINES))
        .mockResolvedValueOnce(scanOf(CARD_L3_LINES)),
    };
    const handle = renderHookWith(fakeContainer(scanner));

    // Escaneo 1: M1 → CAR, mtcCategory M1.
    await act(async () => {
      await handle.current?.scan();
    });
    expect(useRegistrationStore.getState().vehicle.type).toBe(VehicleType.CAR);
    expect(useRegistrationStore.getState().vehicle.mtcCategory).toBe('M1');

    // Escaneo 2: L3 → MOTO. La categoría DEBE actualizarse a L3 (no quedar stale en M1).
    await act(async () => {
      await handle.current?.scan();
    });
    const vehicle = useRegistrationStore.getState().vehicle;
    expect(vehicle.type).toBe(VehicleType.MOTO);
    expect(vehicle.mtcCategory).toBe('L3');
  });

  it('E_UNAVAILABLE: cae al fallback manual sin crash y NO toca el store', async () => {
    const scanner: ScannerDouble = {
      scan: jest.fn(async () => {
        throw new DocumentScannerError('E_UNAVAILABLE', 'no native module');
      }),
    };
    const handle = renderHookWith(fakeContainer(scanner));

    await act(async () => {
      await handle.current?.scan();
    });

    expect(handle.current?.unavailable).toBe(true);
    expect(handle.current?.state).toBe('idle');
    // El store no se tocó (el vehículo sigue en su semilla; sin pending).
    expect(useRegistrationStore.getState().pendingPropertyCard).toBeNull();
    expect(useRegistrationStore.getState().vehicle.plate).toBe('');
  });
});
