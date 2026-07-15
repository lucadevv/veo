import { requireNativeComponent, type HostComponent, type ViewProps } from 'react-native';
import type { NativeSyntheticEvent } from 'react-native';

/**
 * Códigos de error que emite el módulo nativo `BiometricCameraPreview` por su evento `onCameraError`.
 * Es el CONTRATO exacto con el lado Android (Kotlin): no inventar ni aceptar strings sueltos. Si llega
 * un código fuera de esta unión, la presentación lo trata como genérico (no como "permiso denegado").
 */
export type BiometricCameraErrorCode =
  | 'E_CAMERA_PERMISSION'
  | 'E_NO_FRONT_CAMERA'
  | 'E_CAMERA_CONFIG'
  | 'E_CAMERA_DEVICE';

/** Payload del evento `onCameraError` tal como lo manda el nativo: `{ code, message }`. */
export interface BiometricCameraErrorPayload {
  code: BiometricCameraErrorCode;
  message: string;
}

/**
 * Props del componente nativo `BiometricCameraPreview` (cámara frontal en vivo del KYC del alta).
 *
 * CONTRATO NATIVO (Android Kotlin, `BiometricCameraPreviewViewManager`):
 *  - `mirrored` (default true): espeja SOLO la preview (selfie natural), NO el archivo capturado.
 *  - `onCameraReady`: la cámara quedó lista para capturar (sin payload).
 *  - `onCameraError`: fallo de cámara (`{ code, message }`).
 *
 * La captura sigue saliendo por `NativeModules.VeoBiometricFrameGrabber.capturePhoto()`: si esta vista
 * está montada y lista, el nativo reusa la misma sesión de cámara abierta por la preview.
 */
export interface BiometricCameraPreviewNativeProps extends ViewProps {
  mirrored?: boolean;
  onCameraReady?: (event: NativeSyntheticEvent<Record<string, never>>) => void;
  onCameraError?: (event: NativeSyntheticEvent<BiometricCameraErrorPayload>) => void;
}

/**
 * Nombre del componente registrado por el `ViewManager` nativo (`getName()` en Kotlin). Debe coincidir
 * EXACTO; también es el nombre que se intenta registrar en el interop legacy de Fabric (ver `index.js`).
 */
export const BIOMETRIC_CAMERA_PREVIEW_NAME = 'BiometricCameraPreview';

/**
 * Vista nativa de preview biométrica. Es un `SimpleViewManager` LEGACY que, con `newArchEnabled=true`,
 * monta bajo Fabric vía la capa de interop. En RN 0.85.3 ese interop es AUTOMÁTICO (flag `useFabricInterop`
 * por defecto en true): el `requireNativeComponent` plano alcanza, no hay array de nombres en JS que llenar
 * (ver nota en `index.js`).
 */
const BiometricCameraPreview: HostComponent<BiometricCameraPreviewNativeProps> =
  requireNativeComponent<BiometricCameraPreviewNativeProps>(BIOMETRIC_CAMERA_PREVIEW_NAME);

export default BiometricCameraPreview;
