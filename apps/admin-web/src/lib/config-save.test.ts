import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@veo/api-client';
import { conflictMessage, runConfigSave } from './config-save';

/**
 * Núcleo del ciclo de guardado de los 8 paneles de config. Se testea la función PURA (sin React: el entorno de
 * vitest es `node`, sin DOM ni testing-library) — el hook `useConfigSave` es un wrapper fino que solo inyecta el
 * `toast` del contexto, así que cubrir `runConfigSave` cubre el comportamiento. Tres ramas: éxito, 409→info, error→danger.
 */
describe('runConfigSave', () => {
  const base = {
    payload: { value: 1 },
    successTitle: 'Guardado OK',
    conflictNoun: 'la tarifa base',
    errorPrefix: 'No se pudo guardar la tarifa base',
  };

  it('éxito → toast success con el título de éxito', async () => {
    const toast = vi.fn();
    const mutateAsync = vi.fn().mockResolvedValue(undefined);

    await runConfigSave({ ...base, toast, mutateAsync });

    expect(mutateAsync).toHaveBeenCalledWith(base.payload);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith({ tone: 'success', title: 'Guardado OK' });
  });

  it('409 (ApiError) → toast info con el copy CANÓNICO de conflicto', async () => {
    const toast = vi.fn();
    const mutateAsync = vi
      .fn()
      .mockRejectedValue(new ApiError(409, 'CONFLICT', 'version mismatch'));

    await runConfigSave({ ...base, toast, mutateAsync });

    expect(toast).toHaveBeenCalledWith({
      tone: 'info',
      title: 'Otro admin cambió la tarifa base. Recargamos lo vigente — revisá y reintentá.',
    });
  });

  it('otro error (Error) → toast danger con el prefijo + el message', async () => {
    const toast = vi.fn();
    const mutateAsync = vi.fn().mockRejectedValue(new Error('boom'));

    await runConfigSave({ ...base, toast, mutateAsync });

    expect(toast).toHaveBeenCalledWith({
      tone: 'danger',
      title: 'No se pudo guardar la tarifa base: boom',
    });
  });

  it('un ApiError que NO es 409 cae en danger (no en el copy de conflicto)', async () => {
    const toast = vi.fn();
    const mutateAsync = vi.fn().mockRejectedValue(new ApiError(500, 'INTERNAL', 'server down'));

    await runConfigSave({ ...base, toast, mutateAsync });

    expect(toast).toHaveBeenCalledWith({
      tone: 'danger',
      title: 'No se pudo guardar la tarifa base: server down',
    });
  });

  it('un error no-Error → danger con solo el prefijo (sin ": message")', async () => {
    const toast = vi.fn();
    const mutateAsync = vi.fn().mockRejectedValue('plain string');

    await runConfigSave({ ...base, toast, mutateAsync });

    expect(toast).toHaveBeenCalledWith({
      tone: 'danger',
      title: 'No se pudo guardar la tarifa base',
    });
  });
});

describe('conflictMessage (copy canónico)', () => {
  it('el sustantivo va después del verbo → sirve para cualquier género/número sin clítico', () => {
    expect(conflictMessage('los precios de energía')).toBe(
      'Otro admin cambió los precios de energía. Recargamos lo vigente — revisá y reintentá.',
    );
    expect(conflictMessage('el costo/km de PE')).toBe(
      'Otro admin cambió el costo/km de PE. Recargamos lo vigente — revisá y reintentá.',
    );
  });
});
