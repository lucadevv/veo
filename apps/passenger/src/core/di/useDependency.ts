import {useMemo} from 'react';
import type {Token} from './container';
import {container} from './registry';

/**
 * Hook de consumo del contenedor desde la capa de presentación.
 *
 * Patrón: las pantallas/hooks resuelven una ABSTRACCIÓN (repositorio o caso de uso) por su
 * token y la usan; no conocen la implementación concreta. Ejemplo:
 *
 *   const auth = useDependency(TOKENS.authRepository);
 *   const { mutateAsync } = useMutation({ mutationFn: auth.requestOtp });
 *
 * La resolución es singleton, así que `useMemo` evita reconsultas innecesarias.
 */
export function useDependency<T>(token: Token<T>): T {
  return useMemo(() => container.resolve(token), [token]);
}
