import React, { type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@veo/api-client';
import type { AppContainer } from '../../../../../core/di/container';
import { DiProvider } from '../../../../../core/di/useDi';
import type { PickedImage } from '../../../../documents/domain';
import type { PersonalData } from '../../../domain';
import { useRegistrationStore } from '../../state/registrationStore';
import { usePersonalDataContinue } from '../usePersonalDataContinue';

/**
 * Pruebas del orquestador del "Continuar" del paso 1 (`usePersonalDataContinue`). Corrige el BUG de
 * SECUENCIA del onboarding: el DNI escaneado se sube DESPUÉS del `PATCH /drivers/me/personal` (que crea
 * el driver), nunca en el momento del escaneo (cuando el presign del DNI da 404 "no existe perfil").
 *
 * Se valida (caminos felices e infelices):
 *  - Con DNI escaneado: tras el PATCH OK, SUBE el DNI (FRONT+BACK) y limpia `pendingDni` → resultado `ok`.
 *  - La subida del DNI ocurre DESPUÉS del PATCH (orden), nunca antes.
 *  - Sin DNI escaneado (tipeo manual): NO sube nada → `ok`.
 *  - Subida del DNI falla tras el PATCH: resultado `dni-upload-failed` y `pendingDni` se CONSERVA (no se
 *    pierden las caras) → reintento posible.
 *  - PATCH inválido (DNI de 7 dígitos): `field-errors` y el DNI NO se sube (driver no creado).
 */

/** DNI válido en el store (pasa la validación de cliente: 8 dígitos + fecha ISO + nombre). */
const VALID_PERSONAL: PersonalData = {
  fullName: 'QUISPE MAMANI CARLOS',
  dni: '70123456',
  birthdate: '1990-03-15',
};

/** Cara del DNI de mentira (el flujo la trata como opaca: la foto es la fuente de verdad). */
function face(uri: string): PickedImage {
  return { uri, mimeType: 'image/jpeg', fileName: 'dni.jpg', width: null, height: null, fileSize: null };
}

interface RepoDouble {
  updatePersonalData: jest.Mock;
  submitDocument: jest.Mock;
}

interface UploaderDouble {
  upload: jest.Mock;
}

/** Registra el ORDEN de las llamadas (PATCH antes que upload) para verificar la secuencia. */
function fakeContainer(repo: RepoDouble, uploader: UploaderDouble): AppContainer {
  return {
    documentUploader: uploader,
    repositories: { registration: repo },
  } as unknown as AppContainer;
}

interface HookHandle {
  current: ReturnType<typeof usePersonalDataContinue> | null;
}

function HookProbe({ handle }: { handle: HookHandle }): React.JSX.Element {
  handle.current = usePersonalDataContinue();
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

/** Doble del uploader que devuelve las keys por cara (lo que produce el presign múltiple del DNI). */
function okUploader(): UploaderDouble {
  return {
    upload: jest.fn(async () => ({
      images: [
        { s3Key: 'drivers/d-1/dni-front.jpg', side: 'FRONT' },
        { s3Key: 'drivers/d-1/dni-back.jpg', side: 'BACK' },
      ],
    })),
  };
}

beforeEach(() => {
  // Envuelto en act: un probe de un test previo puede seguir suscrito al store cuando reseteamos.
  act(() => {
    useRegistrationStore.getState().reset();
  });
});

describe('usePersonalDataContinue · subida DIFERIDA del DNI (bug de secuencia)', () => {
  it('con DNI escaneado: PATCH primero, LUEGO sube el DNI (FRONT+BACK) y limpia pendingDni → ok', async () => {
    const order: string[] = [];
    const repo: RepoDouble = {
      updatePersonalData: jest.fn(async () => {
        order.push('patch');
        return { legalName: 'QUISPE MAMANI CARLOS', dni: '70123456', birthDate: '1990-03-15' };
      }),
      submitDocument: jest.fn(async () => ({ type: 'DNI', images: [] })),
    };
    const uploader = okUploader();
    uploader.upload.mockImplementation(async () => {
      order.push('upload');
      return {
        images: [
          { s3Key: 'drivers/d-1/dni-front.jpg', side: 'FRONT' },
          { s3Key: 'drivers/d-1/dni-back.jpg', side: 'BACK' },
        ],
      };
    });

    // El escaneo dejó las dos caras + la data OCR pendientes (lo hace `useScanDni` al capturar). El
    // registrar recibe el body completo (vía `submitDocument`), así que verificamos `extractedData` ahí.
    act(() => {
      useRegistrationStore.getState().setPendingDni({
        front: face('data:image/jpeg;base64,/9j/front'),
        back: face('data:image/jpeg;base64,/9j/back'),
        extractedData: {
          type: 'DNI',
          fullName: 'QUISPE MAMANI CARLOS',
          documentNumber: '70123456',
          birthdate: '1990-03-15',
        },
      });
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit(VALID_PERSONAL);
    });

    expect(result).toEqual({ status: 'ok' });
    // SECUENCIA: el PATCH (que crea el driver) corre ANTES de la subida del DNI.
    expect(order).toEqual(['patch', 'upload']);

    // El uploader recibió el DNI con AMBAS caras (FRONT + BACK).
    expect(uploader.upload).toHaveBeenCalledTimes(1);
    const [type, sides] = uploader.upload.mock.calls[0] as unknown as [
      string,
      { side: string }[],
    ];
    expect(type).toBe('DNI');
    expect(sides.map((s) => s.side)).toEqual(['FRONT', 'BACK']);

    // Lote 1: el REGISTRO del DNI lleva la data OCR (extractedData ExtractedDniData) + trazabilidad.
    expect(repo.submitDocument).toHaveBeenCalledTimes(1);
    const body = repo.submitDocument.mock.calls[0]?.[0] as {
      type: string;
      extractedData?: { type: string; documentNumber?: string; fullName?: string; birthdate?: string };
      ocrEngine?: string;
      ocrAt?: string;
    };
    expect(body.extractedData).toEqual({
      type: 'DNI',
      fullName: 'QUISPE MAMANI CARLOS',
      documentNumber: '70123456',
      birthdate: '1990-03-15',
    });
    // Motor del enum cerrado (el default de plataforma en test es android-mlkit) + timestamp ISO presente.
    expect(['ios-visionkit', 'android-mlkit']).toContain(body.ocrEngine);
    expect(typeof body.ocrAt).toBe('string');

    // Tras subir, las caras pendientes se limpian (no se re-suben si el conductor vuelve a entrar).
    expect(useRegistrationStore.getState().pendingDni).toBeNull();
  });

  it('sin DNI escaneado (tipeo manual): hace el PATCH y NO sube nada → ok', async () => {
    const repo: RepoDouble = {
      updatePersonalData: jest.fn(async () => ({
        legalName: 'QUISPE MAMANI CARLOS',
        dni: '70123456',
        birthDate: '1990-03-15',
      })),
      submitDocument: jest.fn(),
    };
    const uploader: UploaderDouble = { upload: jest.fn() };
    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit(VALID_PERSONAL);
    });

    expect(result).toEqual({ status: 'ok' });
    expect(repo.updatePersonalData).toHaveBeenCalledTimes(1);
    // Sin DNI escaneado no hay nada que subir: el avance procede sin tocar el uploader.
    expect(uploader.upload).not.toHaveBeenCalled();
  });

  it('la subida del DNI falla TRAS el PATCH: resultado dni-upload-failed y CONSERVA las caras (reintento)', async () => {
    const repo: RepoDouble = {
      updatePersonalData: jest.fn(async () => ({
        legalName: 'QUISPE MAMANI CARLOS',
        dni: '70123456',
        birthDate: '1990-03-15',
      })),
      submitDocument: jest.fn(),
    };
    const uploader: UploaderDouble = {
      upload: jest.fn(async () => {
        throw new Error('network');
      }),
    };

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
      result = await handle.current?.submit(VALID_PERSONAL);
    });

    expect(result).toEqual({ status: 'dni-upload-failed' });
    // El PATCH se hizo (el driver existe); solo falló el binario. NO perdemos las caras → reintento posible.
    expect(repo.updatePersonalData).toHaveBeenCalledTimes(1);
    expect(useRegistrationStore.getState().pendingDni).not.toBeNull();
  });

  it('la subida del DNI devuelve 409 (ya registrado): lo trata como ÉXITO → ok, limpia pendingDni, NO error', async () => {
    const repo: RepoDouble = {
      updatePersonalData: jest.fn(async () => ({
        legalName: 'QUISPE MAMANI CARLOS',
        dni: '70123456',
        birthDate: '1990-03-15',
      })),
      submitDocument: jest.fn(),
    };
    // El DNI YA existe en fleet (un intento previo lo registró): el backend responde 409 ConflictError
    // ("Ya existe un documento activo de ese tipo para el dueño"). Es un retry legítimo → ÉXITO, no error.
    const uploader: UploaderDouble = {
      upload: jest.fn(async () => {
        throw new ApiError(409, 'CONFLICT', 'Ya existe un documento activo de ese tipo para el dueño');
      }),
    };

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
      result = await handle.current?.submit(VALID_PERSONAL);
    });

    // El 409 NO produce `dni-upload-failed`: el DNI ya está → el wizard avanza al paso de vehículo.
    expect(result).toEqual({ status: 'ok' });
    expect(repo.updatePersonalData).toHaveBeenCalledTimes(1);
    expect(uploader.upload).toHaveBeenCalledTimes(1);
    // Tras el 409, las caras se limpian igual que en el éxito normal (no se re-suben al re-entrar).
    expect(useRegistrationStore.getState().pendingDni).toBeNull();
  });

  it('la subida del DNI devuelve 500 (servidor): muestra error (dni-upload-failed) y CONSERVA pendingDni', async () => {
    const repo: RepoDouble = {
      updatePersonalData: jest.fn(async () => ({
        legalName: 'QUISPE MAMANI CARLOS',
        dni: '70123456',
        birthDate: '1990-03-15',
      })),
      submitDocument: jest.fn(),
    };
    // 500 (o red): fallo transitorio, NO un 409. Debe seguir tratándose como error reintentable.
    const uploader: UploaderDouble = {
      upload: jest.fn(async () => {
        throw new ApiError(500, 'INTERNAL', 'Algo salió mal');
      }),
    };

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
      result = await handle.current?.submit(VALID_PERSONAL);
    });

    // Un error que NO es 409 sigue siendo fallo: la pantalla muestra el aviso y conserva las caras.
    expect(result).toEqual({ status: 'dni-upload-failed' });
    expect(repo.updatePersonalData).toHaveBeenCalledTimes(1);
    expect(useRegistrationStore.getState().pendingDni).not.toBeNull();
  });

  it('PATCH inválido (DNI de 7 dígitos): field-errors y el DNI NO se sube (driver no creado)', async () => {
    const repo: RepoDouble = {
      updatePersonalData: jest.fn(),
      submitDocument: jest.fn(),
    };
    const uploader: UploaderDouble = { upload: jest.fn() };

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
      // DNI de 7 dígitos: la validación de cliente del use-case lo rechaza ANTES de tocar la red.
      result = await handle.current?.submit({ ...VALID_PERSONAL, dni: '7012345' });
    });

    expect(result?.status).toBe('field-errors');
    // No se llamó al repositorio (validación de cliente) ni al uploader (no hay driver).
    expect(repo.updatePersonalData).not.toHaveBeenCalled();
    expect(uploader.upload).not.toHaveBeenCalled();
    // Las caras siguen pendientes (no se perdió el escaneo por un error de validación corregible).
    expect(useRegistrationStore.getState().pendingDni).not.toBeNull();
  });
});
