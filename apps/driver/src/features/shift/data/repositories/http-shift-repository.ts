import type { HttpClient } from '@veo/api-client';
import {
  driverShiftStartResult,
  driverShiftStateView,
  driverShiftStatusResult,
} from '@veo/api-client';
import type {
  ShiftRepository,
  ShiftStartResult,
  ShiftState,
  ShiftStatusResult,
  StartShiftInput,
} from '../../domain';

/** Implementación HTTP del `ShiftRepository` contra el driver-bff. */
export class HttpShiftRepository implements ShiftRepository {
  constructor(private readonly http: HttpClient) {}

  start(input: StartShiftInput): Promise<ShiftStartResult> {
    return this.http.post('/drivers/shift/start', { body: input, schema: driverShiftStartResult });
  }

  end(): Promise<ShiftStatusResult> {
    return this.http.post('/drivers/shift/end', { schema: driverShiftStatusResult });
  }

  pause(): Promise<ShiftStatusResult> {
    return this.http.post('/drivers/shift/pause', { schema: driverShiftStatusResult });
  }

  getState(): Promise<ShiftState> {
    return this.http.get('/drivers/shift/state', { schema: driverShiftStateView });
  }
}
