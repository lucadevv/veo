/**
 * Orquestador del stack mínimo del golden path.
 *
 * Estrategia (alternativa válida del enunciado): en vez de construir una imagen Docker por servicio,
 * reusamos el dev-stack (infra) y arrancamos los servicios/BFFs en modo dev en background con
 * `pnpm --filter @veo/<svc> dev` (nest start --watch). Esto es lo mismo que haría un dev local,
 * solo que el harness lo automatiza, inyecta env coherente (puertos, claves JWT compartidas, modos
 * sandbox) y espera el health de cada uno antes de correr el test.
 *
 * Tear-down: mata todo el árbol de procesos (nest start lanza hijos) por process group.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, rmSync, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import {
  REPO_ROOT,
  commonEnv,
  bffSpecs,
  serviceSpecs,
  type ServiceSpec,
} from './config.js';
import { pingHealth, waitFor } from './wait.js';

const LOG_DIR = resolve(REPO_ROOT, 'e2e', '.logs');

interface RunningProc {
  spec: ServiceSpec;
  child: ChildProcess;
  log: WriteStream;
}

export class Orchestrator {
  private readonly procs: RunningProc[] = [];
  private readonly all: ServiceSpec[] = [...serviceSpecs(), ...bffSpecs()];

  /**
   * Compila los paquetes @veo/* a dist (FOUNDATION §1) y cada servicio/BFF a su `dist/main.js`.
   * Usamos un único turbo build filtrado por los 7 proyectos: turbo construye sus deps `^build`
   * (los @veo/*) antes, en orden y con caché. Es determinista (a diferencia de `nest start --watch`,
   * que con `deleteOutDir` deja dist a medias si se interrumpe).
   */
  async buildDeps(): Promise<void> {
    if (process.env.E2E_SKIP_BUILD === '1') return;
    // Limpia el `.tsbuildinfo` de cada servicio: con `incremental:true` + `deleteOutDir:true` un
    // tsbuildinfo viejo hace que `nest build` crea que ya emitió y NO escriba dist (deja `node
    // dist/main` sin archivo). Borrarlo fuerza una emisión completa y determinista.
    for (const spec of this.all) {
      const dir = resolve(REPO_ROOT, spec.cwd);
      rmSync(resolve(dir, 'tsconfig.tsbuildinfo'), { force: true });
      rmSync(resolve(dir, 'dist'), { force: true, recursive: true });
    }
    const filters = this.all.flatMap((s) => ['--filter', s.filter]);
    // `--force` evita que la caché de turbo "salte" un build cuyo dist acabamos de borrar.
    await this.runOnce('build-stack', 'pnpm', ['exec', 'turbo', 'run', 'build', '--force', ...filters]);

    // `nest build`/tsc solo compila los .ts; el cliente Prisma generado (src/generated, ya en JS) no
    // se copia a dist, así que `require('../generated/prisma')` falla en runtime. Lo copiamos nosotros.
    for (const spec of this.all) {
      if (!spec.hasPrismaGenerated) continue;
      const src = resolve(REPO_ROOT, spec.cwd, 'src', 'generated');
      const dst = resolve(REPO_ROOT, spec.cwd, 'dist', 'generated');
      if (existsSync(src)) cpSync(src, dst, { recursive: true });
    }
  }

  /** Arranca los 5 servicios + 2 BFFs (compilados) y espera el health de TODOS. */
  async start(): Promise<void> {
    mkdirSync(LOG_DIR, { recursive: true });
    for (const spec of this.all) this.spawnService(spec);

    // Esperamos health en orden: primero los servicios, luego los BFFs (que dependen de ellos).
    for (const spec of this.all) {
      const url = `http://localhost:${spec.httpPort}`;
      const path = spec.healthPath ?? '/health';
      await waitFor(() => pingHealth(url, path, 1500, spec.healthAcceptAnyStatus ?? false), {
        timeoutMs: 120_000,
        intervalMs: 1000,
        label: `${spec.name} health en ${url}${path}`,
      });
    }
  }

  private spawnService(spec: ServiceSpec): void {
    const log = createWriteStream(resolve(LOG_DIR, `${spec.name}.log`), { flags: 'w' });
    // Arrancamos el binario ya compilado (`start:prod` = node dist/main): determinista y rápido.
    // CWD = directorio del proyecto, para que @nestjs/config cargue su `.env` (process.env, que
    // inyectamos aquí, gana sobre el `.env`, así que nuestros overrides mandan).
    const child = spawn('pnpm', ['run', 'start:prod'], {
      cwd: resolve(REPO_ROOT, spec.cwd),
      env: { ...process.env, ...commonEnv(), ...spec.env },
      // process group propio → matamos todo el subárbol.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    child.on('exit', (code, signal) => {
      log.write(`\n[orchestrator] ${spec.name} exit code=${code} signal=${signal}\n`);
    });
    this.procs.push({ spec, child, log });
  }

  /** Mata todos los procesos del stack (best-effort). */
  async stop(): Promise<void> {
    for (const p of this.procs) {
      try {
        if (p.child.pid) {
          // negativo = al process group entero
          process.kill(-p.child.pid, 'SIGTERM');
        }
      } catch {
        /* ya muerto */
      }
    }
    // Margen para cierre limpio (shutdown hooks de Nest), luego SIGKILL a lo que quede.
    await new Promise((r) => setTimeout(r, 2500));
    for (const p of this.procs) {
      try {
        if (p.child.pid) process.kill(-p.child.pid, 'SIGKILL');
      } catch {
        /* ya muerto */
      }
      p.log.end();
    }
    this.procs.length = 0;
  }

  /** Corre un comando una vez y resuelve al exit 0 (lanza si falla). */
  private runOnce(label: string, cmd: string, args: string[]): Promise<void> {
    mkdirSync(LOG_DIR, { recursive: true });
    const log = createWriteStream(resolve(LOG_DIR, `${label}.log`), { flags: 'w' });
    return new Promise<void>((resolveP, reject) => {
      const child = spawn(cmd, args, {
        cwd: REPO_ROOT,
        env: { ...process.env, ...commonEnv() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.pipe(log);
      child.stderr?.pipe(log);
      child.on('exit', (code) => {
        log.end();
        if (code === 0) resolveP();
        else reject(new Error(`${label} falló (exit ${code}); ver e2e/.logs/${label}.log`));
      });
      child.on('error', reject);
    });
  }
}
