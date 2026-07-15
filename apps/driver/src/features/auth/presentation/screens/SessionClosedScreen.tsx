import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, SafeScreen } from '@veo/ui-kit';
import { NoticeHero } from '../../../../shared/presentation/components/NoticeHero';
import { IconMonitorOff } from '../../../../shared/presentation/icons';
import {
  useSessionClosedStore,
  type SessionClosedReason,
} from '../../../../core/session/sessionClosedStore';

/**
 * Aviso explícito de cierre remoto de sesión (frame `C/Sesion-Cerrada`). Antes la revocación remota
 * (`superseded`/`revoked`) mandaba al login EN SILENCIO; ahora se muestra este aviso con el motivo y un
 * único CTA "Volver a ingresar" que limpia la señal y deja pasar al login. No hay gesto atrás: la
 * sesión ya está muerta server-side, el único camino es re-ingresar.
 */
export const SessionClosedScreen = (): React.JSX.Element => {
  const { t } = useTranslation();
  const reason = useSessionClosedStore((s) => s.reason);
  const clear = useSessionClosedStore((s) => s.clear);

  // Copy según el motivo: `superseded` = "otro dispositivo" (frame); `revoked` = cierre remoto genérico.
  const bodyKey: SessionClosedReason = reason ?? 'superseded';

  return (
    <SafeScreen
      footer={
        <Button
          label={t('auth.sessionClosed.action')}
          variant="primary"
          fullWidth
          onPress={clear}
        />
      }
    >
      <NoticeHero
        tone="danger"
        icon={({ size, color }) => <IconMonitorOff size={size} color={color} strokeWidth={2} />}
        title={t('auth.sessionClosed.title')}
        description={t(`auth.sessionClosed.body.${bodyKey}`)}
      />
    </SafeScreen>
  );
};
