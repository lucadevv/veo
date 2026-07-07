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
  return {
    uri,
    mimeType: 'image/jpeg',
    fileName: 'dni.jpg',
    width: null,
    height: null,
    fileSize: null,
  };
}

interface RepoDouble {
  updatePersonalData: jest.Mock;
  submitDocument: jest.Mock;
  /** `POST /drivers/onboard` (alta de licencia). Lo invoca la subida DIFERIDA de la licencia tras el PATCH. */
  onboardLicense?: jest.Mock;
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
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: false });
    });

    expect(result).toEqual({ status: 'ok' });
    // SECUENCIA: el PATCH (que crea el driver) corre ANTES de la subida del DNI.
    expect(order).toEqual(['patch', 'upload']);

    // El uploader recibió el DNI con AMBAS caras (FRONT + BACK).
    expect(uploader.upload).toHaveBeenCalledTimes(1);
    const [type, sides] = uploader.upload.mock.calls[0] as unknown as [string, { side: string }[]];
    expect(type).toBe('DNI');
    expect(sides.map((s) => s.side)).toEqual(['FRONT', 'BACK']);

    // Lote 1: el REGISTRO del DNI lleva la data OCR (extractedData ExtractedDniData) + trazabilidad.
    expect(repo.submitDocument).toHaveBeenCalledTimes(1);
    const body = repo.submitDocument.mock.calls[0]?.[0] as {
      type: string;
      extractedData?: {
        type: string;
        documentNumber?: string;
        fullName?: string;
        birthdate?: string;
      };
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
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: false });
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
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: false });
    });

    expect(result).toEqual({ status: 'document-upload-failed', document: 'dni' });
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
        throw new ApiError(
          409,
          'CONFLICT',
          'Ya existe un documento activo de ese tipo para el dueño',
        );
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
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: false });
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
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: false });
    });

    // Un error que NO es 409 sigue siendo fallo: la pantalla muestra el aviso y conserva las caras.
    expect(result).toEqual({ status: 'document-upload-failed', document: 'dni' });
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
      result = await handle.current?.submit({
        personal: { ...VALID_PERSONAL, dni: '7012345' },
        driverExists: false,
      });
    });

    expect(result?.status).toBe('field-errors');
    // No se llamó al repositorio (validación de cliente) ni al uploader (no hay driver).
    expect(repo.updatePersonalData).not.toHaveBeenCalled();
    expect(uploader.upload).not.toHaveBeenCalled();
    // Las caras siguen pendientes (no se perdió el escaneo por un error de validación corregible).
    expect(useRegistrationStore.getState().pendingDni).not.toBeNull();
  });
});

/**
 * Licencia escaneada en el paso 1 (LOTE B · BUG #2). MISMO patrón que el DNI: la subida + el onboarding se
 * DIFIEREN al "Continuar" (tras el PATCH que crea el driver), porque para un conductor NUEVO el presign de
 * la licencia da 404 "no existe perfil" si se intenta en el momento del escaneo.
 */
describe('usePersonalDataContinue · subida DIFERIDA de la licencia (BUG #2)', () => {
  /** Licencia de mentira pendiente: imagen + número + vencimiento (críticos, garantizados por el sheet). */
  function pendingLicense() {
    return {
      file: face('data:image/jpeg;base64,/9j/license'),
      back: null,
      documentNumber: 'Q12345678',
      expiresAt: '2030-12-31',
      extractedData: null,
    };
  }

  it('PATCH → DNI → LICENCIA + onboard en ORDEN, limpia ambos pendings → ok', async () => {
    const order: string[] = [];
    const repo: RepoDouble = {
      updatePersonalData: jest.fn(async () => {
        order.push('patch');
        return { legalName: 'QUISPE MAMANI CARLOS', dni: '70123456', birthDate: '1990-03-15' };
      }),
      submitDocument: jest.fn(async () => ({ type: 'DOC', images: [] })),
      onboardLicense: jest.fn(async () => {
        order.push('onboard');
      }),
    };
    const uploader: UploaderDouble = {
      upload: jest.fn(async (type: string) => {
        order.push(`upload:${type}`);
        return { images: [{ s3Key: `drivers/d-1/${type}.jpg`, side: 'SINGLE' }] };
      }),
    };

    act(() => {
      useRegistrationStore.getState().setPendingDni({
        front: face('data:image/jpeg;base64,/9j/front'),
        back: null,
        extractedData: null,
      });
      useRegistrationStore.getState().setPendingLicense(pendingLicense());
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: false });
    });

    expect(result).toEqual({ status: 'ok' });
    // ORDEN: PATCH (crea driver) → sube DNI → sube licencia → onboard de la licencia. Todo tras el PATCH.
    expect(order).toEqual(['patch', 'upload:DNI', 'upload:LICENSE_A1', 'onboard']);
    // El onboarding recibió número + vencimiento de la captura pendiente.
    expect(repo.onboardLicense).toHaveBeenCalledWith({
      licenseNumber: 'Q12345678',
      licenseExpiresAt: '2030-12-31',
    });
    // Tras subir, ambas capturas pendientes se limpian (no se re-suben si el conductor vuelve a entrar).
    expect(useRegistrationStore.getState().pendingDni).toBeNull();
    expect(useRegistrationStore.getState().pendingLicense).toBeNull();
  });

  it('sin licencia escaneada: hace PATCH (+ DNI si lo hay) y NO toca onboard → ok', async () => {
    const repo: RepoDouble = {
      updatePersonalData: jest.fn(async () => ({
        legalName: 'QUISPE MAMANI CARLOS',
        dni: '70123456',
        birthDate: '1990-03-15',
      })),
      submitDocument: jest.fn(),
      onboardLicense: jest.fn(),
    };
    const uploader: UploaderDouble = { upload: jest.fn() };
    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: false });
    });

    expect(result).toEqual({ status: 'ok' });
    // Sin licencia escaneada no hay subida ni onboarding de licencia.
    expect(uploader.upload).not.toHaveBeenCalled();
    expect(repo.onboardLicense).not.toHaveBeenCalled();
  });

  it('la subida de la LICENCIA falla TRAS el PATCH: document-upload-failed (license) y CONSERVA pendingLicense', async () => {
    const repo: RepoDouble = {
      updatePersonalData: jest.fn(async () => ({
        legalName: 'QUISPE MAMANI CARLOS',
        dni: '70123456',
        birthDate: '1990-03-15',
      })),
      submitDocument: jest.fn(async () => ({ type: 'DOC', images: [] })),
      onboardLicense: jest.fn(),
    };
    // El DNI sube OK; la licencia (2ª subida) falla con un 500: el driver YA existe, solo falló el binario.
    const uploader: UploaderDouble = {
      upload: jest.fn(async (type: string) => {
        if (type === 'LICENSE_A1') {
          throw new ApiError(500, 'INTERNAL', 'Algo salió mal');
        }
        return { images: [{ s3Key: `drivers/d-1/${type}.jpg`, side: 'SINGLE' }] };
      }),
    };

    act(() => {
      useRegistrationStore.getState().setPendingDni({
        front: face('data:image/jpeg;base64,/9j/front'),
        back: null,
        extractedData: null,
      });
      useRegistrationStore.getState().setPendingLicense(pendingLicense());
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: false });
    });

    // CAMINO INFELIZ: la licencia falló → no avanza, conserva la captura para reintentar (PATCH idempotente).
    expect(result).toEqual({ status: 'document-upload-failed', document: 'license' });
    // El DNI sí subió (se limpió); la licencia NO (se conserva). El onboarding NUNCA corrió (subida falló antes).
    expect(useRegistrationStore.getState().pendingDni).toBeNull();
    expect(useRegistrationStore.getState().pendingLicense).not.toBeNull();
    expect(repo.onboardLicense).not.toHaveBeenCalled();
  });

  it('la licencia (o su onboarding) devuelve 409: lo trata como ÉXITO → ok, limpia pendingLicense', async () => {
    const repo: RepoDouble = {
      updatePersonalData: jest.fn(async () => ({
        legalName: 'QUISPE MAMANI CARLOS',
        dni: '70123456',
        birthDate: '1990-03-15',
      })),
      submitDocument: jest.fn(async () => ({ type: 'DOC', images: [] })),
      // El onboarding responde 409 (la licencia YA fue dada de alta en un intento previo) → ÉXITO, no error.
      onboardLicense: jest.fn(async () => {
        throw new ApiError(409, 'CONFLICT', 'Ya existe una licencia activa');
      }),
    };
    const uploader: UploaderDouble = {
      upload: jest.fn(async (type: string) => ({
        images: [{ s3Key: `drivers/d-1/${type}.jpg`, side: 'SINGLE' }],
      })),
    };

    act(() => {
      useRegistrationStore.getState().setPendingLicense(pendingLicense());
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: false });
    });

    // El 409 NO produce fallo: la licencia ya está → el wizard avanza y se limpia la captura.
    expect(result).toEqual({ status: 'ok' });
    expect(useRegistrationStore.getState().pendingLicense).toBeNull();
  });
});

/**
 * RESUME unificado (Lote A · `driverExists`): el conductor REANUDA un alta cuyo driver YA existe en el
 * servidor. Causa raíz del dead-end "los datos leídos no son válidos": el `personal` LOCAL está vacío al
 * reanudar (`fullName`/`birthdate` no se rehidratan: el contrato del server no los expone), así que un PATCH
 * con ese payload vacío hacía rechazar la validación (`field-errors`) SIN campo editable. El fix: cuando el
 * driver YA existe, NO se re-PATCHea — sus datos personales ya están server-side; solo se navega (y se
 * corren las subidas diferidas, que en un resume puro no existen → null → no hacen nada).
 */
describe('usePersonalDataContinue · RESUME (driverExists) — NO re-PATCHea', () => {
  it('driverExists=true con personal VACÍO y SIN pendientes: NO llama updatePersonalData ni el uploader → ok', async () => {
    const repo: RepoDouble = {
      // Si esto se llegara a llamar, el test FALLA (el resume NO debe re-PATCHear con payload vacío).
      updatePersonalData: jest.fn(),
      submitDocument: jest.fn(),
      onboardLicense: jest.fn(),
    };
    const uploader: UploaderDouble = { upload: jest.fn() };
    const handle = renderHookWith(fakeContainer(repo, uploader));

    // `personal` VACÍO: espeja el estado real al reanudar (fullName/birthdate no rehidratados).
    const EMPTY_PERSONAL: PersonalData = { fullName: '', dni: '', birthdate: '' };

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ personal: EMPTY_PERSONAL, driverExists: true });
    });

    // Navega (ok) SIN field-errors ni "datos no válidos": no se tocó la red de datos personales.
    expect(result).toEqual({ status: 'ok' });
    expect(repo.updatePersonalData).not.toHaveBeenCalled();
    // Sin pendientes en un resume puro, tampoco hay subidas.
    expect(uploader.upload).not.toHaveBeenCalled();
    expect(repo.onboardLicense).not.toHaveBeenCalled();
  });

  it('driverExists=true CON pendientes (re-escaneo en resume): NO PATCHea pero SÍ sube los diferidos → ok', async () => {
    const order: string[] = [];
    const repo: RepoDouble = {
      updatePersonalData: jest.fn(),
      submitDocument: jest.fn(async () => ({ type: 'DOC', images: [] })),
      onboardLicense: jest.fn(async () => {
        order.push('onboard');
      }),
    };
    const uploader: UploaderDouble = {
      upload: jest.fn(async (type: string) => {
        order.push(`upload:${type}`);
        return { images: [{ s3Key: `drivers/d-1/${type}.jpg`, side: 'SINGLE' }] };
      }),
    };

    act(() => {
      useRegistrationStore.getState().setPendingDni({
        front: face('data:image/jpeg;base64,/9j/front'),
        back: null,
        extractedData: null,
      });
      useRegistrationStore.getState().setPendingLicense({
        file: face('data:image/jpeg;base64,/9j/license'),
        back: null,
        documentNumber: 'Q12345678',
        expiresAt: '2030-12-31',
        extractedData: null,
      });
    });

    const handle = renderHookWith(fakeContainer(repo, uploader));

    let result: Awaited<ReturnType<NonNullable<HookHandle['current']>['submit']>> | undefined;
    await act(async () => {
      result = await handle.current?.submit({ personal: VALID_PERSONAL, driverExists: true });
    });

    expect(result).toEqual({ status: 'ok' });
    // El PATCH NO corre (driver existe), pero las subidas diferidas SÍ (el conductor re-escaneó en resume).
    expect(repo.updatePersonalData).not.toHaveBeenCalled();
    expect(order).toEqual(['upload:DNI', 'upload:LICENSE_A1', 'onboard']);
    expect(useRegistrationStore.getState().pendingDni).toBeNull();
    expect(useRegistrationStore.getState().pendingLicense).toBeNull();
  });

  it('driverExists=false (alta FRESCA): SÍ PATCHea (crea el driver) y luego sube los pendientes', async () => {
    const order: string[] = [];
    const repo: RepoDouble = {
      updatePersonalData: jest.fn(async () => {
        order.push('patch');
        return { legalName: 'QUISPE MAMANI CARLOS', dni: '70123456', birthDate: '1990-03-15' };
      }),
      submitDocument: jest.fn(async () => ({ type: 'DOC', images: [] })),
    };
    const uploader: UploaderDouble = {
      upload: jest.fn(async (type: string) => {
        order.push(`upload:${type}`);
        return { images: [{ s3Key: `drivers/d-1/${type}.jpg`, side: 'SINGLE' }] };
      }),
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
    // En alta fresca el PATCH crea el driver ANTES de subir el DNI escaneado (orden conservado).
    expect(repo.updatePersonalData).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['patch', 'upload:DNI']);
  });
});
