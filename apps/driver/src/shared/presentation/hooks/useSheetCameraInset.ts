import { useCallback, useMemo, useState } from 'react';
import { useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  quantizePx,
  sheetVisibleHeight,
  type SheetSnapSpec,
} from '../../utils/mapCamera';

/** Cuantización del inset (px): jitter de layout < 8 px no re-anima la cámara del mapa. */
const SHEET_INSET_QUANTUM_PX = 8;

export interface SheetCameraInset {
  /** Alto visible (px, cuantizado) del sheet en su snap actual → `bottomInset` del AppMap. */
  bottomInset: number;
  /** Cablear al `onSnap` del DraggableSheet (re-encuadra al asentarse en un snap). */
  onSnap: (index: number) => void;
  /** Cablear a un `onLayout` del contenido de `renderHeader` (mide el alto del header fijo). */
  onHeaderLayout: (event: LayoutChangeEvent) => void;
  /** Cablear a un `onLayout` del wrapper del contenido scrolleable (mide el alto natural). */
  onContentLayout: (event: LayoutChangeEvent) => void;
}

/**
 * Deriva cuánto TAPA el `DraggableSheet` (ui-kit) en su snap actual, para compensar la cámara del
 * mapa (`bottomInset` del AppMap). El sheet solo notifica el ÍNDICE del snap asentado (`onSnap`);
 * el alto visible se reconstruye con el espejo de su math de content-hugging (`sheetVisibleHeight`)
 * a partir del header/contenido medidos por ESTA pantalla (ella los renderiza).
 *
 * `specs` debe ser el espejo 1:1 (y MISMO orden ascendente) de los `snapPoints` pasados al sheet —
 * declararlo como constante de módulo (identidad estable). Solo se recalcula al asentarse un snap o
 * al re-medirse el contenido (cuantizado): no persigue el drag frame a frame (decisión del pedido).
 */
export function useSheetCameraInset(
  specs: ReadonlyArray<SheetSnapSpec>,
  initialIndex: number,
): SheetCameraInset {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [index, setIndex] = useState(initialIndex);
  const [headerPx, setHeaderPx] = useState(0);
  const [contentPx, setContentPx] = useState(0);

  // Alto útil del sheet: igual que ui-kit (window − inset superior; estas pantallas no pasan
  // `bottomOffset`). El índice se acota por si los specs y los snapPoints divergen en largo.
  const available = Math.max(windowHeight - insets.top, 1);
  const spec = specs[Math.min(Math.max(index, 0), specs.length - 1)];

  const bottomInset = useMemo(
    () =>
      spec
        ? quantizePx(
            sheetVisibleHeight(spec, headerPx, contentPx, available),
            SHEET_INSET_QUANTUM_PX,
          )
        : 0,
    [spec, headerPx, contentPx, available],
  );

  const onSnap = useCallback((i: number) => setIndex(i), []);
  const onHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    setHeaderPx(Math.round(event.nativeEvent.layout.height));
  }, []);
  const onContentLayout = useCallback((event: LayoutChangeEvent) => {
    setContentPx(Math.round(event.nativeEvent.layout.height));
  }, []);

  return { bottomInset, onSnap, onHeaderLayout, onContentLayout };
}
