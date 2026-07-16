export interface GeoPoint {
  lat: number;
  lon: number;
}
export interface User {
  id: string;
  phone: string;
  email?: string;
  photoUrl?: string;
  kycStatus: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
  createdAt: Date;
  deletedAt?: Date;
}
