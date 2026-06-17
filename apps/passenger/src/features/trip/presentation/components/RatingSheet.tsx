import {BottomSheet} from '@veo/ui-kit';
import React, {type ReactNode} from 'react';
import {useTranslation} from 'react-i18next';

export interface RatingSheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Sheet de calificación desde el detalle del viaje. Envuelve el `BottomSheet` canónico (drag-dismiss,
 * scrim, reduce-motion) con el título de calificación, para abrir el `RatingBody` in-sheet sin navegar
 * a la pantalla cruda. Calificar es OPCIONAL: el `RatingBody` ya ofrece "Ahora no" y maneja el 409.
 */
export function RatingSheet({
  visible,
  onClose,
  children,
}: RatingSheetProps): React.JSX.Element {
  const {t} = useTranslation();
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('ratings.sheetTitle')}>
      {children}
    </BottomSheet>
  );
}
