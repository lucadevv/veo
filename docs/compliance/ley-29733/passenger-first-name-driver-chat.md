# Exposición del PRIMER nombre del pasajero al conductor (chat)

> Ley 29733 (Protección de Datos Personales, Perú) · minimización de PII · **requiere pair-review de
> security/compliance antes de merge** (regla del repo: cambios de PII/KYC).

## Qué cambia
El header del chat del conductor (frame `C/Chat`) muestra el **primer nombre** del pasajero (p. ej. "Ana")
en lugar de un título genérico. Para eso, el `driver-bff` pasa a exponer `passengerFirstName` en el
`driverTripView`.

## Dato expuesto y minimización
- Se expone **únicamente el PRIMER token** del nombre visible del pasajero (`UserReply.name` → primer
  token). **NUNCA** el nombre completo, apellidos, teléfono, correo ni ningún otro PII.
- Base: coordinación operativa del recojo (finalidad legítima, proporcional). Estándar de la industria
  (Uber/Cabify muestran el primer nombre al conductor).
- Se resuelve **SOLO post-aceptación** y **SOLO en el detalle** `GET /trips/:id` (que ya está gateado
  anti-IDOR: el viaje debe ser de ESE conductor). El resto de endpoints devuelven `passengerFirstName: null`.
- Degradación honesta: `null` si identity no responde o el pasajero no tiene nombre registrado.

## Qué NO cambia
- Se mantiene la minimización previa (`passenger-verification.service`: solo el booleano de KYC, cero PII).
- No se expone teléfono ni se agrega botón de llamar (se descartó esa opción por PII).

## Dónde
- `packages/api-client/src/mobile.ts` → `driverTripView.passengerFirstName` (nullable).
- `services/bff/driver-bff/src/trips/trips.service.ts` → `getTrip` resuelve el primer nombre (GetUser).
- `services/bff/driver-bff/src/trips/dto/trips.dto.ts` → `TripView.passengerFirstName`.
- `apps/driver/.../chat/presentation/screens/ChatScreen.tsx` → header.

## Pendiente de review
- [ ] Pair-review security/compliance (regla del repo para PII).
- [ ] Confirmar retención/audit: la lectura de `GetUser` desde el BFF no persiste PII del pasajero en el
      lado conductor (solo se transmite en la respuesta, no se almacena).
