import type {DriverProfile} from '../entities';
import {profileToSessionUser} from '../mappers/session-user';

const PROFILE: DriverProfile = {
  driverId: 'drv-1',
  userId: 'usr-1',
  phone: '+51987654321',
  kycStatus: 'APPROVED',
  currentStatus: 'OFFLINE',
  backgroundCheckStatus: 'CLEARED',
  rejectionReason: null,
  averageRating: 4.8,
  rating: null,
  documents: [],
  compliance: {compliant: true, requiredTypes: [], missing: []},
};

describe('profileToSessionUser', () => {
  it('proyecta el perfil al usuario de sesión (cubre hueco del verify sin user)', () => {
    expect(profileToSessionUser(PROFILE)).toEqual({
      id: 'usr-1',
      phone: '+51987654321',
      type: 'driver',
      kycStatus: 'APPROVED',
    });
  });
});
