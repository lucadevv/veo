/** Sala Socket.IO de un conductor (keyed por su driverId, que es lo que portan los eventos Kafka). */
export function roomForDriver(driverId: string): string {
  return `driver:${driverId}`;
}
