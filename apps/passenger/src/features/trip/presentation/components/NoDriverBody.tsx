import {Button, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {View} from 'react-native';

export interface NoDriverBodyProps {
  /**
   * REINTENTAR: re-pide el mismo viaje FIJO. Local: limpia el viaje EXPIRED pero CONSERVA el borrador
   * (origen/destino) → la fase vuelve a 'quoting' con el destino intacto y el CTA de confirmar a un tap.
   */
  onRetry: () => void;
  /** SALIR: abandona la búsqueda FIJO expirada y vuelve al home LIMPIO (limpia viaje + borrador). */
  onExit: () => void;
}

/**
 * Cuerpo "FIJO sin conductor" del sheet unificado (fase `noDriver` · EXPIRED en modo FIXED). Es la
 * CONTRAPARTE de `NoOffersBody` (PUJA): un viaje de PRECIO FIJO que expira sin que ningún conductor lo
 * tome NO tiene "pon tu precio / re-pujar" (eso es puja) — muestra un estado honesto de "no encontramos
 * conductor" con DOS salidas SIEMPRE visibles, sin dead-ends:
 *   - REINTENTAR: re-pide el mismo viaje (vuelve a cotización con el destino intacto).
 *   - SALIR: abandona y vuelve al home limpio.
 */
export function NoDriverBody({onRetry, onExit}: NoDriverBodyProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  return (
    <View style={{gap: theme.spacing.lg}}>
      <View style={{gap: theme.spacing.xs}}>
        <Text variant="title3">{t('noDriver.title')}</Text>
        <Text variant="callout" color="inkMuted">
          {t('noDriver.body')}
        </Text>
      </View>

      <View style={{gap: theme.spacing.sm}}>
        <Button
          label={t('noDriver.retry')}
          variant="primary"
          fullWidth
          onPress={onRetry}
        />
        <Button label={t('noDriver.exit')} variant="ghost" fullWidth onPress={onExit} />
      </View>
    </View>
  );
}
