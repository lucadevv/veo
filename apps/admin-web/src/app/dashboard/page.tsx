import { redirect } from 'next/navigation';

// `/dashboard` es un alias intuitivo: el centro de operación vive en `/ops`.
// Evita el 404 pelado cuando alguien tipea la URL "natural" del panel.
export default function DashboardAlias() {
  redirect('/ops');
}
