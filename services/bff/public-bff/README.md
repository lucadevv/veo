# @veo/public-bff

Backend for Frontend para passenger app · agrega identity, trip, payment, share, rating

Puerto local: **4001**

## Patrón BFF

Este servicio NO contiene lógica de negocio — solo agrega llamadas a microservicios downstream y adapta payloads a la app específica. Si te encuentras escribiendo reglas de negocio aquí, probablemente pertenecen al microservicio dueño del dominio.

## Throttling

Rate limit por defecto: 100 req/min por IP. Ajustar por endpoint según necesidad.
