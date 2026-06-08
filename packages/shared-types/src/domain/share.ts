export interface TrustedContact {
  id: string;
  userId: string;
  phone: string;
  email?: string;
  name: string;
  otpVerifiedAt?: Date;
  relationship: string;
}
export interface ShareLink {
  id: string;
  tripId: string;
  contactId?: string;
  tokenHash: string;
  expiresAt: Date;
  maxUses: number;
  usedCount: number;
  revokedAt?: Date;
}
