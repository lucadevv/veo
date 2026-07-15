'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Video ambiental de fondo del login, a sangre completa (puramente decorativo).
 *
 * `object-cover`: llena el viewport a CUALQUIER tamaño sin franjas negras (estándar de
 * bg-video). Un 16:9 sobre una pantalla 16:9 = sin recorte; sobre otra relación recorta
 * los bordes (el sujeto queda centrado). NO usar `object-contain`: deja vacíos negros
 * cuando el viewport no calza con el aspect del video.
 *
 * Degradación honesta: si el archivo no existe o el navegador no puede reproducirlo,
 * el componente se quita y el `bg-bg` del contenedor queda de fondo — nunca un hueco roto.
 *
 * Accesibilidad: respeta `prefers-reduced-motion` (sin movimiento, pausa), va `muted` +
 * `playsInline` (requisito de autoplay) y `aria-hidden` (no aporta información — el form sí).
 *
 * Asset esperado en `public/login-hero.mp4` (lo provee diseño). Sin él, cae al color.
 */
export function LoginBrandVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) video.pause();
  }, []);

  if (failed) return null;

  return (
    <video
      ref={videoRef}
      className="absolute inset-0 h-full w-full object-cover"
      autoPlay
      loop
      muted
      playsInline
      aria-hidden
      tabIndex={-1}
      onError={() => setFailed(true)}
    >
      <source src="/login-hero.mp4" type="video/mp4" />
    </video>
  );
}
