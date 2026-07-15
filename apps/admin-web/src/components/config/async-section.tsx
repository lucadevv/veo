import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ApiError } from '@veo/api-client';
import { ErrorState, PermissionState } from '@/components/ui/states';

/**
 * Wrapper loading/error/data para una sección de config alimentada por una query de TanStack.
 * Colapsa el tríptico repetido (isError → ErrorState · isLoading||!data → skeleton · data → panel)
 * en un solo lugar, preservando la MISMA condición y el MISMO ErrorState/onRetry de cada page.tsx.
 *
 * Un 403 NO es un error rojo con "Reintentar": es el overlay de permisos (ADR-025) restando la sección.
 * Cuando el error es un `ApiError` status 403 se muestra `PermissionState` (candado ámbar), no el
 * ErrorState de reintento — un reintento sobre un 403 de gobierno solo vuelve a fallar. El resto de los
 * errores (red/5xx) siguen con el ErrorState reintentable de siempre.
 *
 * El skeleton se inyecta como prop (alturas/formas distintas por panel) para no hardcodear uno.
 * NO mete márgenes: el margen entre secciones lo da el panel o el skeleton, como hoy.
 *
 * `query` se tipa estructuralmente (Pick) para aceptar cualquier UseQueryResult sin atarse al error type.
 */
interface AsyncSectionProps<TData> {
  query: Pick<UseQueryResult<TData>, 'isError' | 'isLoading' | 'data' | 'refetch' | 'error'>;
  skeleton: ReactNode;
  children: (data: TData) => ReactNode;
  /** Nombre humano de la sección para el PermissionState del 403 (fallback: "Esta sección"). */
  permissionLabel?: string;
  /** Slug del permiso que exige la sección, mostrado verbatim en el 403 (fallback: "permiso requerido"). */
  permission?: string;
}

export function AsyncSection<TData>({
  query,
  skeleton,
  children,
  permissionLabel,
  permission,
}: AsyncSectionProps<TData>) {
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 403) {
      return (
        <PermissionState
          section={permissionLabel ?? 'Esta sección'}
          permission={permission ?? 'permiso requerido'}
        />
      );
    }
    return <ErrorState onRetry={() => void query.refetch()} />;
  }
  if (query.isLoading || !query.data) {
    return <>{skeleton}</>;
  }
  return <>{children(query.data)}</>;
}
