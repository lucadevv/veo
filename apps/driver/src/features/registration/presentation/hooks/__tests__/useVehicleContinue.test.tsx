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
 * Pruebas del orquestador del "Registrar vehículo" del paso 2 (`useVehicleContinue`). Mismo patrón que
 * `usePersonalDataContinue`: la tarjeta de propiedad escaneada se sube DESPUÉS del `POST /drivers/vehicles`
 * (que crea el vehículo), reusando el uploader del paso de documentos. Un 409 en la subida (tarjeta ya
 * registrada) se trata como ÉXITO. Lo no-409 conserva la imagen para reintentar.
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

describe('useVehicleContinue · subida DIFERIDA de la tarjeta de propiedad (Lote 2)', () => {
  it('con tarjeta escaneada: crea el vehículo PRIMERO, LUEGO sube la tarjeta y limpia pending → ok', async () => {
    const order: string[] = [];
    const repo: RepoDouble = {
      registerVehicle: jest.fn(async () => {
        order.push('register');
        return vehicleView();
      }),
      submitDocument: jest.fn(async () => ({ type: 'PROPERTY_CARD', images: [] })),
    };
    const uploader: UploaderDouble = {
      upload: jest.fn(async () => {
        order.push('upload');
        return { images: [{ s3Key: 'drivers/d-1/property-card.jpg', side: 'SINGLE' }] };
      }),
    };

    act(() => {
      useRegistrationStore.getState().setPendingPropertyCard({
        front: img('data:image/jpeg;base64,/9j/card'),
        extractedData: {
          type: 'PROPERTY_CARD',
          plate: 'ABC-123',
          make: 'TOYOTA',
          model: 'YARIS',
          year: 2021,
          mtcCategory: 'M1',
        },
      });
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit(VALID_VEHICLE);
    });

    expect(result).toEqual({ status: 'ok' });
    // SECUENCIA: el alta del vehículo corre ANTES de subir la tarjeta.
    expect(order).toEqual(['register', 'upload']);

    // El registro del documento lleva la data OCR (ExtractedPropertyCardData) + trazabilidad.
    expect(repo.submitDocument).toHaveBeenCalledTimes(1);
    const body = repo.submitDocument.mock.calls[0]?.[0] as {
      type: string;
      documentNumber?: string;
      extractedData?: { type: string; plate?: string; make?: string };
      ocrEngine?: string;
      ocrAt?: string;
    };
    expect(body.type).toBe('PROPERTY_CARD');
    // FIX 1: la PLACA viaja como `documentNumber` de la tarjeta (el backend lo EXIGE para todo doc que no
    // sea VEHICLE_PHOTO; sin esto la subida diferida da 400 SIEMPRE). Normalizada (mayúsculas, sin espacios).
    expect(body.documentNumber).toBe('ABC-123');
    expect(body.extractedData).toEqual({
      type: 'PROPERTY_CARD',
      plate: 'ABC-123',
      make: 'TOYOTA',
      model: 'YARIS',
      year: 2021,
      mtcCategory: 'M1',
    });
    expect(['ios-visionkit', 'android-mlkit']).toContain(body.ocrEngine);
    expect(typeof body.ocrAt).toBe('string');

    // El vehículo se registró con make/model a TEXTO LIBRE (sin modelSpecId).
    const registerArg = repo.registerVehicle.mock.calls[0]?.[0] as {
      modelSpecId?: string;
      make?: string;
      model?: string;
    };
    expect(registerArg.make).toBe('TOYOTA');
    expect(registerArg.model).toBe('YARIS');
    expect(registerArg.modelSpecId).toBeUndefined();

    // Tras subir, la tarjeta pendiente se limpia (no se re-sube si el conductor vuelve).
    expect(useRegistrationStore.getState().pendingPropertyCard).toBeNull();
  });

  it('(d) la subida de la tarjeta devuelve 409 (ya registrada): lo trata como ÉXITO → ok, limpia pending', async () => {
    const repo: RepoDouble = {
      registerVehicle: jest.fn(async () => vehicleView()),
      submitDocument: jest.fn(),
    };
    // La tarjeta YA existe en fleet (un intento previo la registró) → 409 ConflictError. Retry legítimo.
    const uploader: UploaderDouble = {
      upload: jest.fn(async () => {
        throw new ApiError(409, 'CONFLICT', 'Ya existe un documento activo de ese tipo para el dueño');
      }),
    };

    act(() => {
      useRegistrationStore.getState().setPendingPropertyCard({
        front: img('data:image/jpeg;base64,/9j/card'),
        extractedData: null,
      });
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit(VALID_VEHICLE);
    });

    // El 409 NO produce `card-upload-failed`: la tarjeta ya está → el wizard avanza al paso de documentos.
    expect(result).toEqual({ status: 'ok' });
    expect(repo.registerVehicle).toHaveBeenCalledTimes(1);
    expect(uploader.upload).toHaveBeenCalledTimes(1);
    // Tras el 409, la tarjeta se limpia igual que en el éxito normal.
    expect(useRegistrationStore.getState().pendingPropertyCard).toBeNull();
  });

  it('la subida de la tarjeta falla (500) tras el alta: card-upload-failed y CONSERVA la imagen (reintento)', async () => {
    const repo: RepoDouble = {
      registerVehicle: jest.fn(async () => vehicleView()),
      submitDocument: jest.fn(),
    };
    const uploader: UploaderDouble = {
      upload: jest.fn(async () => {
        throw new ApiError(500, 'INTERNAL', 'Algo salió mal');
      }),
    };

    act(() => {
      useRegistrationStore.getState().setPendingPropertyCard({
        front: img('data:image/jpeg;base64,/9j/card'),
        extractedData: null,
      });
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit(VALID_VEHICLE);
    });

    expect(result).toEqual({ status: 'card-upload-failed' });
    // El vehículo YA existe (lo creó el alta); solo falló el binario → NO perdemos la imagen.
    expect(repo.registerVehicle).toHaveBeenCalledTimes(1);
    expect(useRegistrationStore.getState().pendingPropertyCard).not.toBeNull();
  });

  it('sin tarjeta escaneada (carga manual): crea el vehículo y NO sube nada → ok', async () => {
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
    expect(uploader.upload).not.toHaveBeenCalled();
  });

  it('409 del alta del vehículo (placa ajena): plate-taken (no toca el uploader)', async () => {
    const repo: RepoDouble = {
      registerVehicle: jest.fn(async () => {
        throw new ApiError(409, 'CONFLICT', 'Ya existe un vehículo con esa placa');
      }),
      submitDocument: jest.fn(),
    };
    const uploader: UploaderDouble = { upload: jest.fn() };

    act(() => {
      useRegistrationStore.getState().setPendingPropertyCard({
        front: img('data:image/jpeg;base64,/9j/card'),
        extractedData: null,
      });
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit(VALID_VEHICLE);
    });

    expect(result).toEqual({ status: 'plate-taken' });
    // El vehículo no se creó → no se sube la tarjeta; la imagen se conserva.
    expect(uploader.upload).not.toHaveBeenCalled();
    expect(useRegistrationStore.getState().pendingPropertyCard).not.toBeNull();
  });
});
