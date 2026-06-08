export interface AuditLogEntry {
  eventId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  ip: string;
  userAgent: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}
