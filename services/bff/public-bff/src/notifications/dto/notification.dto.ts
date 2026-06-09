/**
 * Vista de bandeja del pasajero en el BFF. Estructuralmente igual al contrato `appNotification` de
 * @veo/api-client (fuente de verdad del borde): el BFF solo proxya, no renderiza ni conoce las keys
 * internas. La `category` se IMPORTA del contrato para no redefinir el enum (single source del borde).
 */
import type { NotificationCategory } from '@veo/api-client';

export type { NotificationCategory };

/** Aviso in-app del pasajero, ya renderizado (título + cuerpo interpolados desde el template i18n). */
export interface AppNotificationView {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  /** ISO-8601 de emisión. */
  createdAt: string;
}
