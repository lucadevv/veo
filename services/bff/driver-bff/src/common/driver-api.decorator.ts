/**
 * Decorador compuesto para los controladores protegidos del conductor:
 * valida el JWT (Bearer), exige tipo 'driver' y aplica el rate limiter Redis.
 * El orden importa: JwtAuthGuard (puebla req.user) → DriverTypeGuard → RateLimitGuard
 * (que ya dispone del usuario para la clave de la ventana).
 */
import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@veo/auth';
import { DriverTypeGuard } from './guards/driver-type.guard';
import { RateLimitGuard } from './guards/rate-limit.guard';

export function DriverApi(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    UseGuards(JwtAuthGuard, DriverTypeGuard, RateLimitGuard),
    ApiBearerAuth(),
  );
}
