/**
 * Puerto del Foreground Service del turno/viaje.
 *
 * En Android es OBLIGATORIO (regla #3 de CLAUDE.md): mantiene GPS + WebRTC vivos en background con
 * una notificación persistente. En iOS no existe un equivalente; el sistema usa los
 * `UIBackgroundModes` (location/audio/voip) declarados en `Info.plist`, por lo que la implementación
 * nativa de iOS es un no-op deliberado.
 */

export interface ForegroundServiceOptions {
  /** Título de la notificación persistente (Android). */
  title?: string;
  /** Texto de la notificación persistente (Android). */
  text?: string;
}

export interface ForegroundServicePort {
  /** Arranca el servicio en primer plano (idempotente). */
  start(options?: ForegroundServiceOptions): Promise<void>;
  /** Detiene el servicio en primer plano. */
  stop(): Promise<void>;
}
