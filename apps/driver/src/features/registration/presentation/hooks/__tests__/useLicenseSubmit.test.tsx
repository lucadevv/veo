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
import { deriveDocumentPhase, useRegistrationStore } from '../../state/registrationStore';
import { useLicenseSubmit } from '../useLicenseSubmit';

/**
 * Pruebas de la subida EAGER de la LICENCIA (`useLicenseSubmit`, Lote 3), ESPEJO del DNI pero SIN
 * pre-check de unicidad y CON un guard "needs-dni". Orquesta, EN ORDEN:
 *  1) guard `needs-dni`: si `!driverExists` → corta SIN subir nada (la licencia necesita el driver que crea
 *     el DNI).
 *  2) subir la licencia con fase POR CARA (`setSendPhase('license', side, phase)`), 409-como-éxito.
 *  3) `POST /drivers/onboard` con `{ licenseNumber, licenseExpiresAt }`.
 * Se valida: needs-dni corta (sin upload ni onboard); ok sube y deja las fases por cara en `sent` + onboard +
 * limpia la captura; un 409 = éxito; un fallo real conserva la captura (`pendingLicense`) y deja la fase
 * derivada en `error`; sin captura → ok.
 */

/** Licencia de mentira pendiente: imagen + número + vencimiento (críticos, garantizados por el sheet). */
function pendingLicense(back: PickedImage | null = null) {
  return {
    file: face('data:image/jpeg;base64,/9j/license'),
    back,
    documentNumber: 'Q12345678',
    expiresAt: '2030-12-31',
    extractedData: null,
  };
}

function face(uri: string): PickedImage {
  return {
    uri,
    mimeType: 'image/jpeg',
    fileName: 'license.jpg',
    width: null,
    height: null,
    fileSize: null,
  };
}

interface RepoDouble {
  submitDocument: jest.Mock;
  /** `POST /drivers/onboard` (alta de licencia). Lo invoca la subida eager tras el registro del binario. */
  onboardLicense: jest.Mock;
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
  current: ReturnType<typeof useLicenseSubmit> | null;
}

function HookProbe({ handle }: { handle: HookHandle }): React.JSX.Element {
  handle.current = useLicenseSubmit();
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

describe('useLicenseSubmit · subida eager de la licencia', () => {
  it('driverExists=false: devuelve needs-dni y NO sube nada ni llama onboard', async () => {
    const repo: RepoDouble = {
      submitDocument: jest.fn(),
      onboardLicense: jest.fn(),
    };
    const uploader = okUploaderWithPhases();

    act(() => {
      useRegistrationStore.getState().setPendingLicense(pendingLicense());
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ driverExists: false });
    });

    expect(result).toEqual({ status: 'needs-dni' });
    // Corta ANTES de subir el binario o dar de alta la licencia.
    expect(uploader.upload).not.toHaveBeenCalled();
    expect(repo.onboardLicense).not.toHaveBeenCalled();
    // La captura se conserva (el conductor escanea el DNI y reintenta) y no se marcó ninguna fase.
    expect(useRegistrationStore.getState().pendingLicense).not.toBeNull();
    expect(deriveDocumentPhase(useRegistrationStore.getState().sendPhases.license)).toBe('idle');
  });

  it('camino feliz (FRONT+BACK): sube ambas caras (fase por cara sent), llama onboard, limpia pendingLicense → ok', async () => {
    const order: string[] = [];
    const repo: RepoDouble = {
      submitDocument: jest.fn(async () => ({ type: 'LICENSE_A1', images: [] })),
      onboardLicense: jest.fn(async () => {
        order.push('onboard');
      }),
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
      useRegistrationStore.getState().setPendingLicense(
        pendingLicense(face('data:image/jpeg;base64,/9j/back')),
      );
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ driverExists: true });
    });

    expect(result).toEqual({ status: 'ok' });
    // ORDEN: la subida corre ANTES del onboard.
    expect(order).toEqual(['upload', 'onboard']);
    // El uploader recibió ambas caras y un callback de fase (3er arg).
    const [type, sides, onSidePhase] = uploader.upload.mock.calls[0] as unknown as [
      string,
      { side: DocumentSide }[],
      DocumentSidePhaseCallback,
    ];
    expect(type).toBe('LICENSE_A1');
    expect(sides.map((s) => s.side)).toEqual([DocumentSide.FRONT, DocumentSide.BACK]);
    expect(typeof onSidePhase).toBe('function');
    // El onboarding recibió número + vencimiento de la captura pendiente.
    expect(repo.onboardLicense).toHaveBeenCalledWith({
      licenseNumber: 'Q12345678',
      licenseExpiresAt: '2030-12-31',
    });
    // Fase POR CARA en el store: ambas caras quedaron `sent` ⇒ el documento derivado es `sent`.
    const phases = useRegistrationStore.getState().sendPhases.license;
    expect(phases.front).toBe('sent');
    expect(phases.back).toBe('sent');
    expect(deriveDocumentPhase(phases)).toBe('sent');
    // Tras subir, la captura se limpia (no se re-sube al reentrar).
    expect(useRegistrationStore.getState().pendingLicense).toBeNull();
  });

  it('la licencia (o su onboarding) devuelve 409: lo trata como ÉXITO → ok y limpia la captura', async () => {
    const repo: RepoDouble = {
      submitDocument: jest.fn(async () => ({ type: 'LICENSE_A1', images: [] })),
      // El onboarding responde 409 (la licencia YA fue dada de alta en un intento previo) → ÉXITO, no error.
      onboardLicense: jest.fn(async () => {
        throw new ApiError(409, 'CONFLICT', 'Ya existe una licencia activa');
      }),
    };
    // Los PUT van OK (caras sent), pero el ONBOARD responde 409 → éxito.
    const uploader: UploaderDouble = {
      upload: jest.fn(
        async (_type: string, sides: DocumentSideFile[], onSidePhase?: DocumentSidePhaseCallback) => {
          for (const { side } of sides) {
            onSidePhase?.(side, 'sending');
            onSidePhase?.(side, 'sent');
          }
          return { images: sides.map(({ side }) => ({ s3Key: `drivers/d-1/${side}.jpg`, side })) };
        },
      ),
    };

    act(() => {
      useRegistrationStore.getState().setPendingLicense(pendingLicense());
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ driverExists: true });
    });

    expect(result).toEqual({ status: 'ok' });
    expect(useRegistrationStore.getState().pendingLicense).toBeNull();
  });

  it('la subida falla (red · no-409): devuelve error, CONSERVA la captura y deja la fase derivada en error', async () => {
    const repo: RepoDouble = {
      submitDocument: jest.fn(),
      onboardLicense: jest.fn(),
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
      useRegistrationStore.getState().setPendingLicense(pendingLicense());
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ driverExists: true });
    });

    expect(result?.status).toBe('error');
    // Solo falló el binario (el driver YA existe) → NO perdemos la captura ni corrió el onboard.
    expect(repo.onboardLicense).not.toHaveBeenCalled();
    expect(useRegistrationStore.getState().pendingLicense).not.toBeNull();
    // La fase derivada de la licencia es honesta: `error` (no un `sent` que mentiría).
    expect(deriveDocumentPhase(useRegistrationStore.getState().sendPhases.license)).toBe('error');
  });

  it('sin licencia pendiente: no hay nada que subir → ok (sin tocar uploader ni onboard)', async () => {
    const repo: RepoDouble = {
      submitDocument: jest.fn(),
      onboardLicense: jest.fn(),
    };
    const uploader = okUploaderWithPhases();

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ driverExists: true });
    });

    expect(result).toEqual({ status: 'ok' });
    expect(uploader.upload).not.toHaveBeenCalled();
    expect(repo.onboardLicense).not.toHaveBeenCalled();
  });
});
