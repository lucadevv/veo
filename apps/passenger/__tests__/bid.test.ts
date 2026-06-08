import {
  BID_STEP_CENTS,
  initialBidCents,
  isAtFloor,
  roundToSolCents,
  stepBidCents,
} from '../src/shared/utils/bid';

/**
 * El stepper de puja tiene UNA propiedad de seguridad inviolable: el bid NUNCA baja del piso de zona
 * (`bidFloorCents`). Si se rompe, el pasajero ofrecería por debajo del mínimo y el server lo rechazaría
 * (o peor, se aceptaría una tarifa indigna). Estas pruebas blindan el clamp + el redondeo a sol entero.
 */
describe('puja · stepper (lógica pura)', () => {
  const FLOOR = 700; // S/ 7.00 piso de zona

  it('redondea céntimos al sol entero más cercano', () => {
    expect(roundToSolCents(1250)).toBe(1300); // 12.5 → 13
    expect(roundToSolCents(1249)).toBe(1200); // 12.49 → 12
    expect(roundToSolCents(1300)).toBe(1300);
  });

  it('arranca en el sugerido (redondeado), nunca bajo el piso', () => {
    expect(initialBidCents(1250, FLOOR)).toBe(1300); // sugerido sobre piso
    expect(initialBidCents(500, FLOOR)).toBe(FLOOR); // sugerido < piso → piso
    expect(initialBidCents(undefined, FLOOR)).toBe(FLOOR); // sin sugerido → piso
  });

  it('sube de a S/1', () => {
    expect(stepBidCents(1300, 1, FLOOR)).toBe(1400);
    expect(BID_STEP_CENTS).toBe(100);
  });

  it('NUNCA baja del piso (clamp de seguridad)', () => {
    expect(stepBidCents(1300, -1, FLOOR)).toBe(1200);
    expect(stepBidCents(FLOOR, -1, FLOOR)).toBe(FLOOR); // en el piso, "−" no hace nada
    expect(stepBidCents(750, -1, FLOOR)).toBe(FLOOR); // un paso lo dejaría en 650 < piso → clampea a 700
  });

  it('detecta el piso para deshabilitar el "−" y avisar', () => {
    expect(isAtFloor(FLOOR, FLOOR)).toBe(true);
    expect(isAtFloor(800, FLOOR)).toBe(false);
    expect(isAtFloor(650, FLOOR)).toBe(true); // por las dudas, <= piso también
  });
});
