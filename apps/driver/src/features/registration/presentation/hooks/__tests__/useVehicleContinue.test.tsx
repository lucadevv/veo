import React, { type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@veo/api-client';
import { VehicleType } from '@veo/shared-types';
import type { AppContainer } from '../../../../../core/di/container';
import { DiProvider } from '../../../../../core/di/useDi';
import type { PickedImage } from '../../../../documents/domain';
import type { VehicleData } from '../../../domain';
import { useRegistrationStore } from '../../state/registrationStore';
import { useVehicleContinue } from '../useVehicleContinue';

/**
 * Pruebas del orquestador del "Registrar vehículo" del paso 2 (`useVehicleContinue`).
 *
 * LOTE A (subida unificada e INMEDIATA): la IMAGEN de la tarjeta de propiedad YA NO se sube acá. Se sube al
 * SERVER apenas el escaneo tiene imagen + placa (efecto `uploadPropertyCardNow` en `VehicleScreen`), igual
 * que la foto/SOAT. Por eso este hook SOLO crea el vehículo (`POST /drivers/vehicles`) y mapea el resultado
 * a un discriminado: `ok` / `field-errors` / `plate-taken` / `server-error`. No toca el uploader ni el
 * `pendingPropertyCard`.
 *
 * modelSpecId OPCIONAL: el vehículo se crea con make/model a TEXTO LIBRE del OCR (sin modelSpecId).
 */

/** Vehículo válido en el store: rama TEXTO LIBRE (sin modelSpecId, con marca+modelo del OCR). */
const VALID_VEHICLE: VehicleData = {
  type: VehicleType.CAR,
  plate: 'ABC-123',
  year: '2021',
  modelSpecId: '',
  brand: 'TOYOTA',
  model: 'YARIS',
  // LOTE 1: tarjeta M1 → categoría cruda que viaja al backend como fuente de verdad del tipo.
  mtcCategory: 'M1',
  color: '',
};

/** Imagen de la tarjeta de mentira (el flujo la trata como opaca). */
function img(uri: string): PickedImage {
  return { uri, mimeType: 'image/jpeg', fileName: 'card.jpg', width: null, height: null, fileSize: null };
}

interface RepoDouble {
  registerVehicle: jest.Mock;
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
  current: ReturnType<typeof useVehicleContinue> | null;
}

function HookProbe({ handle }: { handle: HookHandle }): React.JSX.Element {
  handle.current = useVehicleContinue();
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

/** Vista de vehículo de mentira que devuelve el alta (el flujo no la inspecciona). */
function vehicleView() {
  return { id: 'v-1', plate: 'ABC-123', vehicleType: 'CAR', status: 'PENDING_REVIEW' };
}

beforeEach(() => {
  act(() => {
    useRegistrationStore.getState().reset();
  });
});

describe('useVehicleContinue · alta del vehículo (Lote A · subida de tarjeta desacoplada)', () => {
  it('crea el vehículo a TEXTO LIBRE del OCR (sin modelSpecId) → ok', async () => {
    const repo: RepoDouble = {
      registerVehicle: jest.fn(async () => vehicleView()),
      submitDocument: jest.fn(),
    };
    const uploader: UploaderDouble = { upload: jest.fn() };
    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit(VALID_VEHICLE);
    });

    expect(result).toEqual({ status: 'ok' });
    expect(repo.registerVehicle).toHaveBeenCalledTimes(1);
    // El vehículo se registró con make/model a TEXTO LIBRE (sin modelSpecId).
    const registerArg = repo.registerVehicle.mock.calls[0]?.[0] as {
      modelSpecId?: string;
      make?: string;
      model?: string;
    };
    expect(registerArg.make).toBe('TOYOTA');
    expect(registerArg.model).toBe('YARIS');
    expect(registerArg.modelSpecId).toBeUndefined();
  });

  it('NO sube la tarjeta ni toca el pendiente: esa responsabilidad vive en la pantalla (LOTE A)', async () => {
    const repo: RepoDouble = {
      registerVehicle: jest.fn(async () => vehicleView()),
      submitDocument: jest.fn(),
    };
    const uploader: UploaderDouble = { upload: jest.fn() };

    // Aunque haya una tarjeta escaneada PENDIENTE, el hook NO la sube ni la limpia: la subida ya ocurrió
    // (inmediata, al escanear) y el `pendingPropertyCard` lo gobierna la pantalla, no el alta.
    act(() => {
      useRegistrationStore.getState().setPendingPropertyCard({
        front: img('data:image/jpeg;base64,/9j/card'),
        extractedData: null,
      });
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));
    await act(async () => {
      await handle.current?.submit(VALID_VEHICLE);
    });

    expect(uploader.upload).not.toHaveBeenCalled();
    expect(repo.submitDocument).not.toHaveBeenCalled();
    expect(useRegistrationStore.getState().pendingPropertyCard).not.toBeNull();
  });

  it('409 del alta (la placa pertenece a OTRO conductor) → plate-taken', async () => {
    const repo: RepoDouble = {
      registerVehicle: jest.fn(async () => {
        throw new ApiError(409, 'CONFLICT', 'Ya existe un vehículo con esa placa');
      }),
      submitDocument: jest.fn(),
    };
    const uploader: UploaderDouble = { upload: jest.fn() };
    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit(VALID_VEHICLE);
    });

    expect(result).toEqual({ status: 'plate-taken' });
    expect(repo.registerVehicle).toHaveBeenCalledTimes(1);
  });

  it('error de red/servidor del alta (no-409) → server-error', async () => {
    const error = new ApiError(500, 'INTERNAL', 'Algo salió mal');
    const repo: RepoDouble = {
      registerVehicle: jest.fn(async () => {
        throw error;
      }),
      submitDocument: jest.fn(),
    };
    const uploader: UploaderDouble = { upload: jest.fn() };
    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit(VALID_VEHICLE);
    });

    expect(result).toEqual({ status: 'server-error', error });
  });
});
