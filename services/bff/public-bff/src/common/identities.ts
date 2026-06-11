/**
 * Identidades sintéticas internas del BFF público. La FORMA canónica vive en @veo/auth
 * (`anonymousIdentity`); acá solo se declara el sabor de este BFF (pasajero).
 */
import { anonymousIdentity } from '@veo/auth';

/** Identidad de sistema para lecturas sin usuario final (p.ej. vista pública de seguimiento). */
export const ANONYMOUS_IDENTITY = anonymousIdentity('passenger');
