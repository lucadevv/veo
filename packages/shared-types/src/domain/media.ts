export interface MediaSegment {
  id: string;
  tripId: string;
  startedAt: Date;
  endedAt: Date;
  s3Key: string;
  sizeBytes: number;
  codec: string;
  encryptionKeyId: string;
  retentionUntil: Date;
  accessedCount: number;
  lastAccessedAt?: Date;
}
