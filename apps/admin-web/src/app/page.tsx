import { redirect } from 'next/navigation';

// La raíz lleva al centro de operación; el middleware redirige a /login si no hay sesión.
export default function RootPage() {
  redirect('/ops');
}
