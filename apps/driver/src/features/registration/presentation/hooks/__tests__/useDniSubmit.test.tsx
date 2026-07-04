import React, { type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@veo/api-client';
import { DocumentSide } from '@veo/shared-types';
import type { AppContainer } from '../../../../../core/di/container';
import { DiProvider } from '../../../../../core/di/useDi';
import type {
  DocumentSideFile,
  DocumentSidePhaseCallback,
  PickedImage,
} from '../../../../documents/domain';
import type { PersonalData } from '../../../domain';
import { deriveDocumentPhase, useRegistrationStore } from '../../state/registrationStore';
import { useDniSubmit } from '../useDniSubmit';

/**
 * Pruebas de la subida EAGER del DNI (`useDniSubmit`, Lote 1). Orquesta, EN ORDEN:
 *  1) `POST /drivers/me/check-dni` — si `{ exists: true }` → `dni-taken`, NO sube nada (corta).
 *  2) `PATCH /drivers/me/personal` (alta fresca) — un `code` `DNI_ALREADY_REGISTERED` también → `dni-taken`.
 *  3) subir el DNI con fase POR CARA (`setSendPhase('dni', side, phase)`), 409-como-éxito.
 * Se valida: dni-taken corta (sin PATCH ni upload); ok sube y deja las fases por cara en `sent`; un fallo
 * real conserva la captura (`pendingDni`) y deja la fase derivada en `error`.
 */

/** DNI válido en el store (pasa la validación de cliente del PATCH: 8 dígitos + fecha ISO + nombre). */
const VALID_PERSONAL: PersonalData = {
  fullName: 'QUISPE MAMANI CARLOS',
  dni: '70123456',
  birthdate: '1990-03-15',
};

function face(uri: string): PickedImage {
  return { uri, mimeType: 'image/jpeg', fileName: 'dni.jpg', width: null, height: null, fileSize: null };
}

interface RepoDouble {
  checkDni: jest.Mock;
  updatePersonalData: jest.Mock;
  submitDocument: jest.Mock;
}

interface UploaderDouble {
  upload: jest.Mock;
}

function fakeContainer(repo: RepoDouble, uploader: UploaderDouble): AppContainer {
  return {
    documentUploader: uploader,
    repositories: { registration: repo },
  } as unknown as AppContainer;
}

interface HookHandle {
  current: ReturnType<typeof useDniSubmit> | null;
}

function HookProbe({ handle }: { handle: HookHandle }): React.JSX.Element {
  handle.current = useDniSubmit();
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

/**
 * Uploader OK que INVOCA el callback por cara (sending→sent) por cada `side`, igual que el HttpDocumentUploader
 * real, y devuelve las keys. Así el test verifica que las fases por cara llegan al store.
 */
function okUploaderWithPhases(): UploaderDouble {
  return {
    upload: jest.fn(
      async (
        _type: string,
        sides: DocumentSideFile[],
        onSidePhase?: DocumentSidePhaseCallback,
      ) => {
        for (const { side } of sides) {
          onSidePhase?.(side, 'sending');
          onSidePhase?.(side, 'sent');
        }
        return { images: sides.map(({ side }) => ({ s3Key: `drivers/d-1/${side}.jpg`, side })) };
      },
    ),
  };
}

beforeEach(() => {
  act(() => {
    useRegistrationStore.getState().reset();
  });
});

describe('useDniSubmit · subida eager del DNI', () => {
  it('checkDni { exists: true }: devuelve dni-taken y NO hace PATCH ni sube nada', async () => {
    const repo: RepoDouble = {
      checkDni: jest.fn(async () => ({ exists: true })),
      updatePersonalData: jest.fn(),
      submitDocument: jest.fn(),
    };
    const uploader = okUploaderWithPhases();

    act(() => {
      useRegistrationStore.getState().setPendingDni({
        front: face('data:image/jpeg;base64,/9j/front'),
        back: face('data:image/jpeg;base64,/9j/back'),
        extractedData: null,
      });
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: false });
    });

    expect(result).toEqual({ status: 'dni-taken' });
    expect(repo.checkDni).toHaveBeenCalledWith({ dni: '70123456' });
    // Corta ANTES de crear el driver o subir el binario.
    expect(repo.updatePersonalData).not.toHaveBeenCalled();
    expect(uploader.upload).not.toHaveBeenCalled();
    // La captura se conserva (el conductor puede corregir el DNI) y no se marcó ninguna fase.
    expect(useRegistrationStore.getState().pendingDni).not.toBeNull();
    expect(deriveDocumentPhase(useRegistrationStore.getState().sendPhases.dni)).toBe('idle');
  });

  it('camino feliz (alta fresca): check ok → PATCH → sube DNI (FRONT+BACK), fase por cara sent, limpia pendingDni → ok', async () => {
    const order: string[] = [];
    const repo: RepoDouble = {
      checkDni: jest.fn(async () => {
        order.push('check');
        return { exists: false };
      }),
      updatePersonalData: jest.fn(async () => {
        order.push('patch');
        return { legalName: 'QUISPE MAMANI CARLOS', dni: '70123456', birthDate: '1990-03-15' };
      }),
      submitDocument: jest.fn(async () => ({ type: 'DNI', images: [] })),
    };
    const uploader = okUploaderWithPhases();
    uploader.upload.mockImplementation(
      async (_type: string, sides: DocumentSideFile[], onSidePhase?: DocumentSidePhaseCallback) => {
        order.push('upload');
        for (const { side } of sides) {
          onSidePhase?.(side, 'sending');
          onSidePhase?.(side, 'sent');
        }
        return { images: sides.map(({ side }) => ({ s3Key: `drivers/d-1/${side}.jpg`, side })) };
      },
    );

    act(() => {
      useRegistrationStore.getState().setPendingDni({
        front: face('data:image/jpeg;base64,/9j/front'),
        back: face('data:image/jpeg;base64,/9j/back'),
        extractedData: null,
      });
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: false });
    });

    expect(result).toEqual({ status: 'ok' });
    // ORDEN: check → patch → upload.
    expect(order).toEqual(['check', 'patch', 'upload']);
    // El uploader recibió ambas caras y un callback de fase (3er arg).
    const [type, sides, onSidePhase] = uploader.upload.mock.calls[0] as unknown as [
      string,
      { side: DocumentSide }[],
      DocumentSidePhaseCallback,
    ];
    expect(type).toBe('DNI');
    expect(sides.map((s) => s.side)).toEqual([DocumentSide.FRONT, DocumentSide.BACK]);
    expect(typeof onSidePhase).toBe('function');
    // Fase POR CARA en el store: ambas caras quedaron `sent` ⇒ el documento derivado es `sent`.
    const phases = useRegistrationStore.getState().sendPhases.dni;
    expect(phases.front).toBe('sent');
    expect(phases.back).toBe('sent');
    expect(deriveDocumentPhase(phases)).toBe('sent');
    // Tras subir, la captura se limpia (no se re-sube al reentrar).
    expect(useRegistrationStore.getState().pendingDni).toBeNull();
  });

  it('resume (driverExists=true): NO hace PATCH, igual sube el DNI → ok', async () => {
    const repo: RepoDouble = {
      checkDni: jest.fn(async () => ({ exists: false })),
      updatePersonalData: jest.fn(),
      submitDocument: jest.fn(async () => ({ type: 'DNI', images: [] })),
    };
    const uploader = okUploaderWithPhases();

    act(() => {
      useRegistrationStore.getState().setPendingDni({
        front: face('data:image/jpeg;base64,/9j/front'),
        back: null,
        extractedData: null,
      });
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: true });
    });

    expect(result).toEqual({ status: 'ok' });
    expect(repo.updatePersonalData).not.toHaveBeenCalled();
    expect(uploader.upload).toHaveBeenCalledTimes(1);
    // Doc de UNA cara (sin reverso): la única cara SINGLE quedó sent ⇒ documento sent.
    expect(deriveDocumentPhase(useRegistrationStore.getState().sendPhases.dni)).toBe('sent');
  });

  it('PATCH responde DNI_ALREADY_REGISTERED (carrera): dni-taken y NO sube el binario', async () => {
    const repo: RepoDouble = {
      checkDni: jest.fn(async () => ({ exists: false })),
      updatePersonalData: jest.fn(async () => {
        throw new ApiError(409, 'DNI_ALREADY_REGISTERED', 'El DNI ya está registrado');
      }),
      submitDocument: jest.fn(),
    };
    const uploader = okUploaderWithPhases();

    act(() => {
      useRegistrationStore.getState().setPendingDni({
        front: face('data:image/jpeg;base64,/9j/front'),
        back: null,
        extractedData: null,
      });
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: false });
    });

    expect(result).toEqual({ status: 'dni-taken' });
    // El binario NO se sube (el DNI es de otra cuenta) y la captura se conserva.
    expect(uploader.upload).not.toHaveBeenCalled();
    expect(useRegistrationStore.getState().pendingDni).not.toBeNull();
  });

  it('la subida falla (red): devuelve error, CONSERVA la captura y deja la fase derivada en error', async () => {
    const repo: RepoDouble = {
      checkDni: jest.fn(async () => ({ exists: false })),
      updatePersonalData: jest.fn(async () => ({
        legalName: 'QUISPE MAMANI CARLOS',
        dni: '70123456',
        birthDate: '1990-03-15',
      })),
      submitDocument: jest.fn(),
    };
    // El uploader marca la cara FRONT `sending` y luego LANZA (falla el PUT): la fase de esa cara queda error.
    const uploader: UploaderDouble = {
      upload: jest.fn(
        async (_type: string, sides: DocumentSideFile[], onSidePhase?: DocumentSidePhaseCallback) => {
          const first = sides[0];
          if (first) {
            onSidePhase?.(first.side, 'sending');
            onSidePhase?.(first.side, 'error');
          }
          throw new ApiError(500, 'INTERNAL', 'Algo salió mal');
        },
      ),
    };

    act(() => {
      useRegistrationStore.getState().setPendingDni({
        front: face('data:image/jpeg;base64,/9j/front'),
        back: null,
        extractedData: null,
      });
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: false });
    });

    expect(result?.status).toBe('error');
    // El PATCH se hizo (driver creado); solo falló el binario → NO perdemos la captura.
    expect(repo.updatePersonalData).toHaveBeenCalledTimes(1);
    expect(useRegistrationStore.getState().pendingDni).not.toBeNull();
    // La fase derivada del DNI es honesta: `error` (no un `sent` que mentiría).
    expect(deriveDocumentPhase(useRegistrationStore.getState().sendPhases.dni)).toBe('error');
  });

  it('la subida devuelve 409 (DNI ya activo · retry): lo trata como ÉXITO → ok y limpia la captura', async () => {
    const repo: RepoDouble = {
      checkDni: jest.fn(async () => ({ exists: false })),
      updatePersonalData: jest.fn(async () => ({
        legalName: 'QUISPE MAMANI CARLOS',
        dni: '70123456',
        birthDate: '1990-03-15',
      })),
      submitDocument: jest.fn(),
    };
    // Los PUT van OK (caras sent), pero el REGISTRO responde 409 (documento ya activo) → éxito.
    const uploader: UploaderDouble = {
      upload: jest.fn(
        async (_type: string, sides: DocumentSideFile[], onSidePhase?: DocumentSidePhaseCallback) => {
          for (const { side } of sides) {
            onSidePhase?.(side, 'sending');
            onSidePhase?.(side, 'sent');
          }
          throw new ApiError(409, 'CONFLICT', 'Ya existe un documento activo de ese tipo');
        },
      ),
    };

    act(() => {
      useRegistrationStore.getState().setPendingDni({
        front: face('data:image/jpeg;base64,/9j/front'),
        back: null,
        extractedData: null,
      });
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: false });
    });

    expect(result).toEqual({ status: 'ok' });
    expect(useRegistrationStore.getState().pendingDni).toBeNull();
  });
});
