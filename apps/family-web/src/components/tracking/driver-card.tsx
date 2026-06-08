import { Star, User, Car } from 'lucide-react';
import type { FamilyDriver } from '@veo/api-client';
import { Card } from '@/components/ui/card';
import { formatRating } from '@/lib/format';

/** Datos del conductor y del vehículo. Oculta los campos que el bff no envíe (null). */
export function DriverCard({ driver }: { driver: FamilyDriver }) {
  const rating = formatRating(driver.rating);
  const vehicleParts = [driver.vehicleModel, driver.vehicleColor].filter(
    (part): part is string => Boolean(part),
  );

  return (
    <Card className="p-5">
      <h2 className="text-sm font-medium text-ink-muted">Conductor</h2>
      <div className="mt-3 flex items-center gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-muted">
          <User className="size-6" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold">{driver.name}</p>
          {rating ? (
            <p className="mt-0.5 flex items-center gap-1 text-sm text-ink-muted">
              <Star className="size-4 text-warn" aria-hidden />
              <span className="tabular">{rating}</span>
              <span className="sr-only">de calificación</span>
            </p>
          ) : null}
        </div>
      </div>

      {driver.vehiclePlate || vehicleParts.length > 0 ? (
        <div className="mt-4 flex items-start gap-3 border-t border-border pt-4">
          <Car className="mt-0.5 size-5 shrink-0 text-ink-muted" aria-hidden />
          <div className="min-w-0">
            {driver.vehiclePlate ? (
              <p className="font-mono text-base font-semibold tracking-wide tabular">{driver.vehiclePlate}</p>
            ) : null}
            {vehicleParts.length > 0 ? (
              <p className="mt-0.5 text-sm text-ink-muted">{vehicleParts.join(', ')}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
