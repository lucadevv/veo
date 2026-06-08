import type {ShiftRepository, ShiftStartResult, ShiftState, ShiftStatusResult, StartShiftInput} from '../index';
import {EndShiftUseCase, PauseShiftUseCase, StartShiftUseCase} from '../index';

class FakeShiftRepository implements ShiftRepository {
  startInput: StartShiftInput | null = null;
  ended = false;
  paused = false;

  start(input: StartShiftInput): Promise<ShiftStartResult> {
    this.startInput = input;
    return Promise.resolve({status: 'AVAILABLE', score: 0.97});
  }
  end(): Promise<ShiftStatusResult> {
    this.ended = true;
    return Promise.resolve({status: 'OFFLINE'});
  }
  pause(): Promise<ShiftStatusResult> {
    this.paused = true;
    return Promise.resolve({status: 'ON_BREAK'});
  }
  getState(): Promise<ShiftState> {
    return Promise.resolve({driverId: 'd1', status: 'AVAILABLE'});
  }
}

describe('shift use cases', () => {
  it('StartShiftUseCase reenvía sessionRef y geo', async () => {
    const repo = new FakeShiftRepository();
    const result = await new StartShiftUseCase(repo).execute('sess-1', {geoLat: -12, geoLon: -77});
    expect(repo.startInput).toEqual({sessionRef: 'sess-1', geoLat: -12, geoLon: -77});
    expect(result.status).toBe('AVAILABLE');
  });

  it('EndShiftUseCase y PauseShiftUseCase invocan el repositorio', async () => {
    const repo = new FakeShiftRepository();
    await new EndShiftUseCase(repo).execute();
    await new PauseShiftUseCase(repo).execute();
    expect(repo.ended).toBe(true);
    expect(repo.paused).toBe(true);
  });
});
