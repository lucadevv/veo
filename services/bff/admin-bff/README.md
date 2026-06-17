# @veo/admin-bff

Backend for Frontend para dashboard Next.js · RBAC, MFA step-up, agregaciones, ClickHouse

Puerto local: **4003**

## Patrón BFF

Este servicio NO contiene lógica de negocio — solo agrega llamadas a microservicios downstream y adapta payloads a la app específica. Si te encuentras escribiendo reglas de negocio aquí, probablemente pertenecen al microservicio dueño del dominio.

## Throttling

Rate limit por defecto: 100 req/min por IP. Ajustar por endpoint según necesidad.
