import { test } from 'vitest';
import { Orchestrator } from '../lib/orchestrator.js';

/**
 * Lanzador de stack para PROBAR EN DISPOSITIVO (NO es el golden path).
 * Compila y arranca los 5 servicios + 2 BFFs, espera el health de todos y luego SE QUEDA VIVO
 * (la promesa nunca resuelve) para sostener los procesos mientras se prueba desde el iPhone.
 * Para bajarlo: mata este proceso vitest (o `pkill -f "node dist/main"`).
 *
 * Se corre aparte del golden path con el filtro `serve-stack`.
 */
test(
  'serve stack (device testing) — held alive',
  async () => {
    const orch = new Orchestrator();
    await orch.buildDeps();
    await orch.start();
    // eslint-disable-next-line no-console
    console.log('\n>>> STACK_UP_AND_HELD <<<\n');
    await new Promise(() => {}); // nunca resuelve → mantiene vivos los servicios
  },
  { timeout: 86_400_000 },
);
