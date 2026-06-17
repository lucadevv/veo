/**
 * LOAD TEST del HOT-PATH del pasajero: POST /maps/quote (public-bff:4001).
 *
 * El quote es el endpoint de MAYOR frecuencia (cada vez que el pasajero pone un destino) y ejercita
 * TODA la cadena server-driven que construimos en Fase B: ruta (OSRM/Mapbox) + resolución de modo
 * (PricingSchedule) + catálogo efectivo (overlay admin) + recargo de combustible + fare por oferta.
 * Es read-only (no muta estado, no choca con la regla "un solo viaje activo") → se puede martillar.
 *
 * Token: pasado por env TOKEN (mint-token.mjs). Base: BASE_URL (default public-bff local).
 *
 * IMPORTANTE (honestidad de la medición): esto corre contra el STACK LOCAL en UNA máquina (servicios
 * nativos + infra docker), NO contra EKS multi-AZ de prod. Mide el comportamiento del hot-path y el
 * PUNTO DE SATURACIÓN en esta caja — es indicativo/relativo, NO la capacidad de producción (que depende
 * de réplicas HPA, tamaño de RDS, etc.). Sirve para: detectar el cuello de botella y tener un número base.
 *
 * Uso:  TOKEN=$(node dev-stack/loadtest/mint-token.mjs) k6 run dev-stack/loadtest/quote-hotpath.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const BASE = __ENV.BASE_URL || 'http://localhost:4001';
const QUOTE_URL = `${BASE}/api/v1/maps/quote`; // el public-bff monta la API bajo /api/v1

// Un token por VU con userId DISTINTO → el rate-limit (IP:userId:ruta, 120/min) NO agrupa los VUs:
// así medimos el SERVER, no el límite por-cliente. Generar antes con:
//   COUNT=120 node dev-stack/loadtest/mint-token.mjs > dev-stack/loadtest/tokens.json
const TOKENS = new SharedArray('tokens', () => JSON.parse(open('./tokens.json')));

/** Token de ESTE VU (round-robin si hay menos tokens que VUs). */
function tokenForVU() {
  return TOKENS[(__VU - 1) % TOKENS.length];
}
function paramsForVU() {
  return {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenForVU()}` },
    tags: { endpoint: 'maps_quote' },
  };
}

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 20 }, // calentar
        { duration: '30s', target: 50 }, // carga media
        { duration: '30s', target: 100 }, // empujar
        { duration: '15s', target: 0 }, // bajar
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    // El lote NO "aguanta" si: >1% de errores o p95 > 800ms (el quote es un preview, debe ser ágil).
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800', 'p(99)<1500'],
    checks: ['rate>0.99'],
  },
};

// Ruta real de Lima (Av. Tomás Valle → zona este), ~la misma del e2e en el simulador.
const BODY = JSON.stringify({
  origin: { lat: -12.0264, lng: -77.0581 },
  destination: { lat: -12.0850, lng: -76.9772 },
});

export function setup() {
  if (TOKENS.length === 0) {
    throw new Error('Faltan tokens: COUNT=120 node dev-stack/loadtest/mint-token.mjs > dev-stack/loadtest/tokens.json');
  }
  // Smoke de 1 request antes de la rampa: si el token/stack no sirven, fallamos rápido y claro.
  const res = http.post(QUOTE_URL, BODY, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKENS[0]}` },
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`smoke del quote falló: HTTP ${res.status} — ${res.body && res.body.slice(0, 200)}`);
  }
}

export default function () {
  const res = http.post(QUOTE_URL, BODY, paramsForVU());
  check(res, {
    'status 2xx': (r) => r.status === 200 || r.status === 201,
    'trae options': (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).options);
      } catch {
        return false;
      }
    },
  });
  sleep(1); // ~1 req/s por VU (think-time realista del pasajero ajustando el destino)
}
