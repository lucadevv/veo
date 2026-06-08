export interface Rating {
  id: string;
  tripId: string;
  raterId: string;
  ratedId: string;
  stars: 1 | 2 | 3 | 4 | 5;
  comment?: string;
  createdAt: Date;
}
