import type { GeoPoint } from './user.js';
export interface BiometricCheck {
  id: string;
  driverId: string;
  shiftId: string;
  // Soberanía tecnológica (FOUNDATION §0.7): motor biométrico propio (biometric-service, ONNX).
  provider: 'VEO_ONNX';
  score: number;
  livenessPassed: boolean;
  matchPassed: boolean;
  photoHash: string;
  geoPoint?: GeoPoint;
  takenAt: Date;
  result: 'PASS' | 'FAIL' | 'BLOCKED';
}
