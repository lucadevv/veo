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
 * (`parseDni`) → prellenado NO destructivo del store → subida del DNI como documento de 2 caras.
 *
 * El escáner y el uploader se inyectan por DI con dobles (el hook NO conoce el módulo nativo ni la red).
 * Se valida: prellenado de los 3 campos, captura del reverso, subida FRONT+BACK (presign con sides
 * [FRONT,BACK] y register con images de 2 entradas), fallback honesto ante `E_UNAVAILABLE`, y que el OCR
 * NO pisa un campo que el conductor ya tipeó.
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

  it('sube el DNI como FRONT+BACK: presign con sides [FRONT,BACK] y register con images de 2 caras', async () => {
    const scanner: ScannerDouble = { scan: jest.fn(async () => dniScan()) };
    // Doble del uploader REAL del hook: devuelve las images por cara (lo que produciría el presign múltiple).
    const upload = jest.fn(async () => ({
      images: [
        { s3Key: 'drivers/d-1/dni-front.jpg', side: 'FRONT' },
        { s3Key: 'drivers/d-1/dni-back.jpg', side: 'BACK' },
      ],
    }));
    const submitDocument = jest.fn(async () => ({
      type: 'DNI',
      documentNumber: '70123456',
      status: 'PENDING_REVIEW',
      simpleStatus: 'en_revision',
      expiresAt: null,
      ok: false,
      rejectionReason: null,
      images: [
        { side: 'FRONT', order: 0 },
        { side: 'BACK', order: 1 },
      ],
    }));
    const handle = renderHookWith(
      fakeContainer(scanner, { upload }, { submitDocument }),
    );

    await act(async () => {
      await handle.current?.scan();
    });
    await act(async () => {
      await handle.current?.submit();
    });

    // El uploader recibe el tipo DNI y AMBAS caras (FRONT + BACK), cada una con su archivo.
    expect(upload).toHaveBeenCalledTimes(1);
    const uploadCall = upload.mock.calls[0] as unknown as [
      string,
      { side: string; file: { uri: string } }[],
    ];
    const [type, sides] = uploadCall;
    expect(type).toBe('DNI');
    expect(sides.map((s) => s.side)).toEqual(['FRONT', 'BACK']);
    expect(sides[0]?.file.uri).toBe('data:image/jpeg;base64,/9j/front-base64');
    expect(sides[1]?.file.uri).toBe('data:image/jpeg;base64,/9j/back-base64');

    // El registro lleva las DOS imágenes (con su cara) y el número confirmado del store.
    expect(submitDocument).toHaveBeenCalledTimes(1);
    const submitCall = submitDocument.mock.calls[0] as unknown as [
      { type: string; documentNumber: string; images: { s3Key: string; side: string }[] },
    ];
    const body = submitCall[0];
    expect(body.type).toBe('DNI');
    expect(body.documentNumber).toBe('70123456');
    expect(body.images).toEqual([
      { s3Key: 'drivers/d-1/dni-front.jpg', side: 'FRONT' },
      { s3Key: 'drivers/d-1/dni-back.jpg', side: 'BACK' },
    ]);
    expect(handle.current?.state).toBe('success');
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
