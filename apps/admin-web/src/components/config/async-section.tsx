import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ErrorState } from '@/components/ui/states';

/**
 * Wrapper loading/error/data para una sección de config alimentada por una query de TanStack.
 * Colapsa el tríptico repetido (isError → ErrorState · isLoading||!data → skeleton · data → panel)
 * en un solo lugar, preservando la MISMA condición y el MISMO ErrorState/onRetry de cada page.tsx.
 *
 * El skeleton se inyecta como prop (alturas/formas distintas por panel) para no hardcodear uno.
 * NO mete márgenes: el margen entre secciones lo da el panel o el skeleton, como hoy.
 *
 * `query` se tipa estructuralmente (Pick) para aceptar cualquier UseQueryResult sin atarse al error type.
 */
interface AsyncSectionProps<TData> {
  query: Pick<UseQueryResult<TData>, 'isError' | 'isLoading' | 'data' | 'refetch'>;
  skeleton: ReactNode;
  children: (data: TData) => ReactNode;
}

export function AsyncSection<TData>({ query, skeleton, children }: AsyncSectionProps<TData>) {
  if (query.isError) {
    return <ErrorState onRetry={() => void query.refetch()} />;
  }
  if (query.isLoading || !query.data) {
    return <>{skeleton}</>;
  }
  return <>{children(query.data)}</>;
}
