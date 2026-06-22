/**
 * Health/readiness del booking-service. NOTA: el booking-service reusa los HealthController/MetricsController
 * compartidos de @veo/observability (montados en app.module, fuera del prefijo global, igual que identity).
 * Este archivo deja el contrato local nombrado por si un check propio del marketplace lo necesita en el
 * futuro; hoy delega 100% en los controllers compartidos + el READINESS_CHECKS provider del AppModule.
 *
 * (Se conserva por el SCOPE de F0 que pide common/health.controller.ts explícito; la implementación real
 * de /health + /health/ready la dan los controllers compartidos para no duplicar la lógica de sondas.)
 */
export {};
