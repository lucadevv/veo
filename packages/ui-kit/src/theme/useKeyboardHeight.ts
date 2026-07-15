import { useEffect, useState } from 'react';
import { Dimensions, Keyboard, LayoutAnimation, Platform } from 'react-native';

/**
 * Alto del teclado en COORDENADAS DE VENTANA (iOS): `alto de ventana − screenY del teclado`, del
 * evento `keyboardWillChangeFrame` (cubre mostrar/ocultar/cambio de frame, e INCLUYE la barra de
 * predicciones). Todo se lee EN el evento — nada precalculado — así que se adapta a cualquier
 * dispositivo, teclado u orientación.
 *
 * Reemplaza al `KeyboardAvoidingView` en las pantallas de composición (chat): KAV calcula el
 * corrimiento mezclando el frame LOCAL de su contenedor con la Y GLOBAL del teclado, y bajo un
 * header (nativo o in-body) + safe area queda CORTO — el input/enviar terminaban escondidos tras
 * la barra de predicciones. Uso: `paddingBottom: keyboardHeight` en el contenedor raíz de la
 * pantalla (y descontar el `insets.bottom` propio del composer mientras el teclado esté abierto).
 *
 * Android no lo necesita: `adjustResize` redimensiona la ventana solo (devuelve 0 siempre).
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') {
      return;
    }
    const sub = Keyboard.addListener('keyboardWillChangeFrame', (event) => {
      const next = Math.max(
        0,
        Dimensions.get('window').height - event.endCoordinates.screenY,
      );
      LayoutAnimation.configureNext({
        duration: event.duration > 0 ? event.duration : 250,
        update: { type: 'keyboard' },
      });
      setHeight(next);
    });
    return () => sub.remove();
  }, []);
  return height;
}
