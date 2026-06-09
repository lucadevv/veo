import { describe, it, expect } from 'vitest';
import { LocalMapsEngine } from '@veo/maps';
import { categoryFareCents } from './fare';

/**
 * Regla de negocio: AGREGAR UNA PARADA recalcula la RUTA y SUBE la TARIFA.
 *
 * Prueba END-TO-END con el motor REAL (`LocalMapsEngine`, el que corre en dev — NO un mock): rutea
 * origen→parada→destino, la distancia/duración crecen, y la fórmula de tarifa (`categoryFareCents`,
 * la misma del quote) devuelve un precio MAYOR. Lockea que un waypoint nunca se descarte del cálculo
 * (ni en la ruta del mapa ni en el precio).
 */
describe('waypoints · agregar una parada recalcula ruta y tarifa (motor real, sin mocks)', () => {
  const engine = new LocalMapsEngine();
  // Lima real: Miraflores (origen) → San Isidro (destino); parada en Barranco (al SUR → desvío claro).
  const origin = { lat: -12.1211, lon: -77.0297 }; // Miraflores
  const destination = { lat: -12.0976, lon: -77.0365 }; // San Isidro
  const stop = { lat: -12.1465, lon: -77.0207 }; // Barranco

  it('la RUTA con parada es más larga y la geometría pasa por la parada (el mapa redibuja)', async () => {
    const direct = await engine.route(origin, destination);
    const withStop = await engine.route(origin, destination, [stop]);

    expect(withStop.distanceMeters).toBeGreaterThan(direct.distanceMeters);
    expect(withStop.durationSeconds).toBeGreaterThan(direct.durationSeconds);
    // Geometría: directo = 2 puntos (origen, destino); con parada = 3 (origen, parada, destino).
    expect(direct.geometry.coordinates).toHaveLength(2);
    expect(withStop.geometry.coordinates).toHaveLength(3);
  });

  it('la TARIFA con parada es mayor que la directa (misma categoría)', async () => {
    const direct = await engine.route(origin, destination);
    const withStop = await engine.route(origin, destination, [stop]);
    const fareDirect = categoryFareCents(direct.distanceMeters, direct.durationSeconds, 1.0);
    const fareWithStop = categoryFareCents(withStop.distanceMeters, withStop.durationSeconds, 1.0);

    // Números reales, para evidencia (vitest los muestra).
    console.log(
      `[waypoints] directo: ${direct.distanceMeters} m → S/ ${(fareDirect / 100).toFixed(2)}  |  ` +
        `con 1 parada: ${withStop.distanceMeters} m → S/ ${(fareWithStop / 100).toFixed(2)}`,
    );
    expect(fareWithStop).toBeGreaterThan(fareDirect);
  });
});
