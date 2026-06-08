'use client';

import { createContext, useContext } from 'react';
import type { SessionUser } from '@veo/api-client';

const SessionContext = createContext<SessionUser | null>(null);

/** Provee el sessionUser (cargado en el server) al árbol cliente para RBAC y estado MFA. */
export function SessionProvider({
  user,
  children,
}: {
  user: SessionUser;
  children: React.ReactNode;
}) {
  return <SessionContext.Provider value={user}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionUser {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession debe usarse dentro de SessionProvider');
  return ctx;
}
