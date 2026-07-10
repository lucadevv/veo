/**
 * Matcher CIDR IPv4/IPv6 sin dependencias — soporte de la política `access.ip-allowlist` (ADR-024 §5 · Fase 2).
 *
 * Por qué propio y no una lib: la regla del repo prohíbe sumar deps sin review (Snyk), y el catálogo pide un
 * matcher «simple y testeado». Representamos toda dirección como un BigInt de su ancho de bits (32 IPv4, 128
 * IPv6) y comparamos los `prefix` bits altos con el de la red. Normaliza IPv4-mapped (`::ffff:a.b.c.d`) a IPv4
 * para que un cliente que Express reporte en forma mapeada matchee un CIDR IPv4 (y viceversa). Fail-safe: ante
 * cualquier entrada inválida devuelve `false` (no matchea) — nunca lanza, nunca abre de más.
 */

/** Dirección IP parseada a bits + versión (tras normalizar IPv4-mapped a v4). */
interface ParsedIp {
  readonly bits: bigint;
  readonly version: 4 | 6;
}

/** Quita el zone-id de un literal IPv6 (`fe80::1%eth0` → `fe80::1`). */
function stripZone(ip: string): string {
  const pct = ip.indexOf('%');
  return pct >= 0 ? ip.slice(0, pct) : ip;
}

/** Parsea un IPv4 dotted-quad a entero de 32 bits sin signo; `null` si es inválido. */
function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** Grupo hex de 16 bits sin padding (para reinsertar un IPv4 embebido como dos grupos). */
function toHex16(n: number): string {
  return (n & 0xffff).toString(16);
}

/** Parsea un IPv6 (con `::` y IPv4 embebido) a BigInt de 128 bits; `null` si es inválido. */
function parseIPv6(input: string): bigint | null {
  let head = input;

  // IPv4 embebido en el último grupo (`::ffff:1.2.3.4`, `2001:db8::1.2.3.4`) → reescribir a dos grupos hex.
  const lastColon = input.lastIndexOf(':');
  if (lastColon >= 0 && input.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4(input.slice(lastColon + 1));
    if (v4 == null) return null;
    head = `${input.slice(0, lastColon + 1)}${toHex16((v4 >>> 16) & 0xffff)}:${toHex16(v4 & 0xffff)}`;
  }

  let groups: string[];
  const doubleColon = head.indexOf('::');
  if (doubleColon >= 0) {
    if (head.indexOf('::', doubleColon + 1) >= 0) return null; // más de un `::` → inválido
    const before = head.slice(0, doubleColon).split(':').filter((s) => s.length > 0);
    const after = head.slice(doubleColon + 2).split(':').filter((s) => s.length > 0);
    const missing = 8 - (before.length + after.length);
    if (missing < 0) return null;
    groups = [...before, ...Array<string>(missing).fill('0'), ...after];
  } else {
    groups = head.split(':');
  }
  if (groups.length !== 8) return null;

  let bits = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    bits = (bits << 16n) | BigInt(parseInt(g, 16));
  }
  return bits;
}

/** Parsea una IP (v4 o v6) a bits+versión, normalizando IPv4-mapped a IPv4; `null` si es inválida. */
function parseIp(input: string): ParsedIp | null {
  const ip = stripZone(input.trim());
  if (ip.length === 0) return null;

  if (ip.includes(':')) {
    const v6 = parseIPv6(ip);
    if (v6 == null) return null;
    // IPv4-mapped `::ffff:a.b.c.d` (los 96 bits altos = 0x…0000ffff) → tratar como IPv4.
    if (v6 >> 32n === 0xffffn) {
      return { bits: v6 & 0xffffffffn, version: 4 };
    }
    return { bits: v6, version: 6 };
  }

  const v4 = parseIPv4(ip);
  if (v4 == null) return null;
  return { bits: BigInt(v4), version: 4 };
}

/**
 * ¿La IP cae dentro del CIDR? Acepta CIDR con prefijo (`10.0.0.0/8`, `2001:db8::/32`) o una IP pelada
 * (match exacto = /32 o /128). Devuelve `false` (no matchea) ante cualquier entrada inválida o versiones
 * distintas — nunca lanza, nunca afloja el candado.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  const net = parseIp(slash >= 0 ? cidr.slice(0, slash) : cidr);
  const addr = parseIp(ip);
  if (!net || !addr || net.version !== addr.version) return false;

  const width = net.version === 4 ? 32 : 128;
  let prefix = width; // IP pelada = match exacto
  if (slash >= 0) {
    const prefixStr = cidr.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixStr)) return false;
    prefix = Number(prefixStr);
    if (prefix > width) return false;
  }
  if (prefix === 0) return true; // /0 = todo el espacio

  const shift = BigInt(width - prefix);
  return addr.bits >> shift === net.bits >> shift;
}

/** ¿La IP matchea AL MENOS un CIDR de la lista? Lista vacía → `false` (el llamador decide el fail-safe). */
export function ipInAnyCidr(ip: string, cidrs: readonly string[]): boolean {
  return cidrs.some((cidr) => ipInCidr(ip, cidr));
}
