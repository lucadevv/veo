import React, { type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DocumentScannerError, type ScannedDocument } from '../../../../documents/domain';
import type { AppContainer } from '../../../../../core/di/container';
import { DiProvider } from '../../../../../core/di/useDi';
import { useRegistrationStore } from '../../state/registrationStore';
import { useScanDni } from '../useScanDni';

/**
 * Pruebas del flujo de escaneo del DNI (sub-lote 3B): el hook `useScanDni` orquesta escaneo → OCR
 * (`parseDni`) → prellenado NO destructivo del store → GUARDADO de las caras como `pendingDni` para
 * subirlas DESPUÉS del PATCH /personal (BUG de secuencia: el presign del DNI exige que el driver YA
 * exista, así que el escaneo NUNCA sube en el momento).
 *
 * El escáner se inyecta por DI con un doble (el hook NO conoce el módulo nativo). Se valida: prellenado de
 * los 3 campos, captura del reverso, que el escaneo NO sube (no toca el uploader) y deja las caras en
 * `pendingDni`, que confirmar (`submit`) deja el estado `ready` con las caras guardadas, fallback honesto
 * ante `E_UNAVAILABLE`, y que el OCR NO pisa un campo que el conductor ya tipeó.
 */

/** Texto OCR del FRENTE de un DNI peruano (palabras clave + 8 dígitos + nacimiento + apellidos/nombres). */
const DNI_FRONT_LINES: string[] = [
  'REPUBLICA DEL PERU',
  'Documento Nacional de Identidad',
  'DNI 70123456',
  'Apellidos: QUISPE MAMANI',
  'Pre Nombres: CARLOS',
  'Fecha de Nacimiento: 15/03/1990',
];

/** Escaneo por defecto: dos imágenes (anverso + reverso) con el texto del frente alineado a images[0]. */
function dniScan(): ScannedDocument {
  return {
    images: ['/9j/front-base64', '/9j/back-base64'],
    textLines: [DNI_FRONT_LINES, ['DETALLES DEL REVERSO']],
  };
}

interface ScannerDouble {
  scan: jest.Mock<Promise<ScannedDocument>, [options?: { maxPages?: number }]>;
}

interface UploaderDouble {
  upload: jest.Mock;
}

interface SubmitDouble {
  submitDocument: jest.Mock;
}

/**
 * Contenedor de DI de prueba: solo necesita el escáner, el uploader y el `registration.submitDocument`
 * (el registrador del caso de uso). El resto del `AppContainer` no se toca en este flujo.
 */
function fakeContainer(
  scanner: ScannerDouble,
  uploader: UploaderDouble,
  submit: SubmitDouble,
): AppContainer {
  return {
    documentScanner: scanner,
    documentUploader: uploader,
    repositories: { registration: submit },
  } as unknown as AppContainer;
}

/** Capturador del API del hook: lo expone fuera del árbol para poder accionarlo desde el test. */
interface HookHandle {
  current: ReturnType<typeof useScanDni> | null;
}

function HookProbe({ handle }: { handle: HookHandle }): React.JSX.Element {
  handle.current = useScanDni();
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

/** DNI vacío en el store antes de cada test (sin arrastrar valores entre casos). */
beforeEach(() => {
  useRegistrationStore.getState().reset();
});

describe('useScanDni', () => {
  it('escanea el DNI y PRELLENA dni/fullName/birthdate en el store desde el OCR del frente', async () => {
    const scanner: ScannerDouble = { scan: jest.fn(async () => dniScan()) };
    const uploader: UploaderDouble = { upload: jest.fn() };
    const submit: SubmitDouble = { submitDocument: jest.fn() };
    const handle = renderHookWith(fakeContainer(scanner, uploader, submit));

    await act(async () => {
      await handle.current?.scan();
    });

    // El escáner se abre a 2 páginas (anverso + reverso).
    expect(scanner.scan).toHaveBeenCalledWith({ maxPages: 2 });

    const personal = useRegistrationStore.getState().personal;
    expect(personal.dni).toBe('70123456');
    expect(personal.fullName).toBe('QUISPE MAMANI CARLOS');
    // `parseDni` normaliza la fecha a ISO AAAA-MM-DD (compatible con el DateField del wizard).
    expect(personal.birthdate).toBe('1990-03-15');

    // El hook reporta qué campos prellenó y queda en estado `captured`.
    expect(handle.current?.state).toBe('captured');
    expect(handle.current?.autofilled).toEqual({ dni: true, fullName: true, birthdate: true });
  });

  it('captura el reverso (segunda imagen) y lo deja listo para subir', async () => {
    const scanner: ScannerDouble = { scan: jest.fn(async () => dniScan()) };
    const uploader: UploaderDouble = { upload: jest.fn() };
    const submit: SubmitDouble = { submitDocument: jest.fn() };
    const handle = renderHookWith(fakeContainer(scanner, uploader, submit));

    await act(async () => {
      await handle.current?.scan();
    });

    expect(handle.current?.front).not.toBeNull();
    expect(handle.current?.back).not.toBeNull();
    expect(handle.current?.hasBack).toBe(true);
    // El reverso se modela como data: URI JPEG (reusa el pipeline de subida sin tocar el uploader).
    expect(handle.current?.back?.uri).toBe('data:image/jpeg;base64,/9j/back-base64');
  });

  it('NO sube en el momento del escaneo: deja las caras (FRONT+BACK) en `pendingDni` para subir tras el PATCH', async () => {
    const scanner: ScannerDouble = { scan: jest.fn(async () => dniScan()) };
    // El uploader NO debe tocarse durante el escaneo (la subida está DIFERIDA al continue del paso 1).
    const upload = jest.fn();
    const submitDocument = jest.fn();
    const handle = renderHookWith(
      fakeContainer(scanner, { upload }, { submitDocument }),
    );

    await act(async () => {
      await handle.current?.scan();
    });

    // BUG de secuencia corregido: el escaneo NUNCA sube (el driver aún no existe → presign 404).
    expect(upload).not.toHaveBeenCalled();
    expect(submitDocument).not.toHaveBeenCalled();

    // Las caras quedan GUARDADAS en el store, listas para que el `onContinue` las suba tras el PATCH.
    const pending = useRegistrationStore.getState().pendingDni;
    expect(pending).not.toBeNull();
    expect(pending?.front.uri).toBe('data:image/jpeg;base64,/9j/front-base64');
    expect(pending?.back?.uri).toBe('data:image/jpeg;base64,/9j/back-base64');
  });

  it('confirmar (`submit`) deja el estado `ready` con las caras guardadas — sigue SIN subir', async () => {
    const scanner: ScannerDouble = { scan: jest.fn(async () => dniScan()) };
    const upload = jest.fn();
    const submitDocument = jest.fn();
    const handle = renderHookWith(
      fakeContainer(scanner, { upload }, { submitDocument }),
    );

    await act(async () => {
      await handle.current?.scan();
    });
    act(() => {
      handle.current?.submit();
    });

    expect(handle.current?.state).toBe('ready');
    expect(upload).not.toHaveBeenCalled();
    // Las caras siguen disponibles para la subida diferida.
    const pending = useRegistrationStore.getState().pendingDni;
    expect(pending?.front.uri).toBe('data:image/jpeg;base64,/9j/front-base64');
    expect(pending?.back?.uri).toBe('data:image/jpeg;base64,/9j/back-base64');
  });

  it('E_UNAVAILABLE: cae al fallback manual sin crash y deja los campos como estaban (editables)', async () => {
    const scanner: ScannerDouble = {
      scan: jest.fn(async () => {
        throw new DocumentScannerError('E_UNAVAILABLE', 'no native module');
      }),
    };
    const uploader: UploaderDouble = { upload: jest.fn() };
    const submit: SubmitDouble = { submitDocument: jest.fn() };
    const handle = renderHookWith(fakeContainer(scanner, uploader, submit));

    await act(async () => {
      await handle.current?.scan();
    });

    // Degradación honesta: marca `unavailable`, vuelve a idle y NO toca el store (tipeo manual sigue).
    expect(handle.current?.unavailable).toBe(true);
    expect(handle.current?.state).toBe('idle');
    const personal = useRegistrationStore.getState().personal;
    expect(personal).toEqual({ fullName: '', dni: '', birthdate: '' });
  });

  it('prellenado NO destructivo: un campo que el conductor ya tipeó NO lo pisa el OCR', async () => {
    const scanner: ScannerDouble = { scan: jest.fn(async () => dniScan()) };
    const uploader: UploaderDouble = { upload: jest.fn() };
    const submit: SubmitDouble = { submitDocument: jest.fn() };
    const handle = renderHookWith(fakeContainer(scanner, uploader, submit));

    // El conductor ya escribió su DNI a mano (un valor DISTINTO del que trae el OCR).
    act(() => {
      useRegistrationStore.getState().setPersonal({ dni: '99887766' });
    });

    await act(async () => {
      await handle.current?.scan();
    });

    const personal = useRegistrationStore.getState().personal;
    // El DNI tipeado a mano GANA: el OCR no lo pisa.
    expect(personal.dni).toBe('99887766');
    // Los campos que SÍ estaban vacíos sí se prellenan.
    expect(personal.fullName).toBe('QUISPE MAMANI CARLOS');
    expect(personal.birthdate).toBe('1990-03-15');
    // Y el hook NO marca `dni` como auto-extraído (no lo escribió).
    expect(handle.current?.autofilled.dni).toBe(false);
    expect(handle.current?.autofilled.fullName).toBe(true);
  });
});
