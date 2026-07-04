import React, { type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DocumentScannerError, type ScannedDocument } from '../../../../documents/domain';
import type { AppContainer } from '../../../../../core/di/container';
import { DiProvider } from '../../../../../core/di/useDi';
import { useRegistrationStore } from '../../state/registrationStore';
import { useScanLicense } from '../useScanLicense';

/**
 * Pruebas del flujo de escaneo de la LICENCIA (`useScanLicense`, CONDUCTOR · paso 1), ESPEJO de `useScanDni`
 * pero para la licencia: escaneo → OCR (`parseDocument`/`readoutFromParsed`) → GATING del campo CRÍTICO
 * (número + vencimiento) → GUARDADO de la captura como `pendingLicense` para subirla DESPUÉS del PATCH
 * /personal. Es un hook de captura + OCR PURO: NO toca la red (el presign de la licencia exige que el driver
 * YA exista, así que el escaneo NUNCA sube en el momento).
 *
 * El escáner se inyecta por DI con un doble (el hook NO conoce el módulo nativo). Se valida: OCR OK (lee
 * número + vencimiento → guarda `pendingLicense`, sin `criticalMissing`), OCR sin número/vencimiento
 * (`criticalMissing`, NO guarda `pendingLicense`) y cancelación (idle sin error).
 */

/** Texto OCR del ANVERSO de una licencia peruana legible: número etiquetado + par de fechas (expedición < revalidación). */
const LICENSE_FRONT_LINES: string[] = [
  'MINISTERIO DE TRANSPORTES Y COMUNICACIONES',
  'Licencia de Conducir',
  'Nro de Licencia: Q12345678',
  'Clase: A',
  'Categoria: Uno',
  'Fecha de Expedicion: 10/01/2020',
  'Fecha de Revalidacion: 31/12/2030',
];

/** Texto OCR ILEGIBLE: sin patrón de número de licencia y sin ninguna fecha → críticos ausentes. */
const LICENSE_UNREADABLE_LINES: string[] = [
  'MINISTERIO DE TRANSPORTES Y COMUNICACIONES',
  'documento ilegible',
];

/** Escaneo con dos imágenes (anverso + reverso) y las líneas dadas alineadas al anverso (`textLines[0]`). */
function licenseScan(frontLines: string[]): ScannedDocument {
  return {
    images: ['/9j/license-front', '/9j/license-back'],
    textLines: [frontLines, ['DETALLES DEL REVERSO']],
  };
}

interface ScannerDouble {
  scan: jest.Mock<Promise<ScannedDocument>, [options?: { maxPages?: number }]>;
}

/** Contenedor de DI de prueba: este flujo (captura + OCR puro) solo necesita el escáner. */
function fakeContainer(scanner: ScannerDouble): AppContainer {
  return {
    documentScanner: scanner,
  } as unknown as AppContainer;
}

/** Capturador del API del hook: lo expone fuera del árbol para poder accionarlo desde el test. */
interface HookHandle {
  current: ReturnType<typeof useScanLicense> | null;
}

function HookProbe({ handle }: { handle: HookHandle }): React.JSX.Element {
  handle.current = useScanLicense();
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

/** Store limpio antes de cada test (sin arrastrar la captura entre casos). */
beforeEach(() => {
  act(() => {
    useRegistrationStore.getState().reset();
  });
});

describe('useScanLicense', () => {
  it('OCR OK: lee número + vencimiento, guarda pendingLicense (FRONT+BACK) y NO marca criticalMissing', async () => {
    const scanner: ScannerDouble = { scan: jest.fn(async () => licenseScan(LICENSE_FRONT_LINES)) };
    const handle = renderHookWith(fakeContainer(scanner));

    await act(async () => {
      await handle.current?.scan();
    });

    // El escáner se abre a 2 páginas (anverso + reverso).
    expect(scanner.scan).toHaveBeenCalledWith({ maxPages: 2 });

    // Estado capturado, sin crítico faltante: el OCR leyó los dos campos que la licencia EXIGE.
    expect(handle.current?.state).toBe('captured');
    expect(handle.current?.criticalMissing).toBe(false);
    expect(handle.current?.licenseNumber).toBe('Q12345678');
    // El vencimiento es la fecha MÁS TARDÍA del anverso (revalidación > expedición), normalizada a ISO.
    expect(handle.current?.expiresAt).toBe('2030-12-31');

    // Caras capturadas: anverso siempre, reverso (2ª imagen) como data URI JPEG.
    expect(handle.current?.front).not.toBeNull();
    expect(handle.current?.back).not.toBeNull();
    expect(handle.current?.hasBack).toBe(true);
    expect(handle.current?.back?.uri).toBe('data:image/jpeg;base64,/9j/license-back');

    // Captura GUARDADA en el store, lista para subir tras el PATCH /personal (con número + vencimiento críticos).
    const pending = useRegistrationStore.getState().pendingLicense;
    expect(pending).not.toBeNull();
    expect(pending?.file.uri).toBe('data:image/jpeg;base64,/9j/license-front');
    expect(pending?.back?.uri).toBe('data:image/jpeg;base64,/9j/license-back');
    expect(pending?.documentNumber).toBe('Q12345678');
    expect(pending?.expiresAt).toBe('2030-12-31');
  });

  it('OCR sin número/vencimiento: marca criticalMissing y NO guarda pendingLicense (reescaneo honesto)', async () => {
    const scanner: ScannerDouble = {
      scan: jest.fn(async () => licenseScan(LICENSE_UNREADABLE_LINES)),
    };
    const handle = renderHookWith(fakeContainer(scanner));

    await act(async () => {
      await handle.current?.scan();
    });

    // La captura llega igual a `captured` (las caras existen) PERO con el crítico faltante señalado.
    expect(handle.current?.state).toBe('captured');
    expect(handle.current?.criticalMissing).toBe(true);
    expect(handle.current?.licenseNumber).toBeNull();
    expect(handle.current?.expiresAt).toBeNull();

    // Degradación honesta: SIN los campos críticos NO se guarda la captura (no se finge "capturada ✓").
    expect(useRegistrationStore.getState().pendingLicense).toBeNull();

    // Y `submit` no procede sobre una captura inválida.
    let confirmed: boolean | undefined;
    act(() => {
      confirmed = handle.current?.submit();
    });
    expect(confirmed).toBe(false);
    expect(useRegistrationStore.getState().pendingLicense).toBeNull();
  });

  it('E_CANCELLED: cancelar NO es error → vuelve a idle sin captura', async () => {
    const scanner: ScannerDouble = {
      scan: jest.fn(async () => {
        throw new DocumentScannerError('E_CANCELLED', 'user cancelled');
      }),
    };
    const handle = renderHookWith(fakeContainer(scanner));

    await act(async () => {
      await handle.current?.scan();
    });

    // Cancelar deja el flujo en `idle` (no `error`) y no toca el store.
    expect(handle.current?.state).toBe('idle');
    expect(handle.current?.unavailable).toBe(false);
    expect(handle.current?.criticalMissing).toBe(false);
    expect(useRegistrationStore.getState().pendingLicense).toBeNull();
  });
});
