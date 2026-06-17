/**
 * Cliente SMPP 3.4 mínimo y propio (sobre TCP nativo `node:net`), SIN librerías de terceros.
 * Implementa el subconjunto necesario para enviar SMS: bind_transceiver → submit_sm → unbind.
 * Una conexión efímera por envío (robusto y simple para el volumen transaccional de VEO).
 *
 * Referencia: SMPP Protocol Specification v3.4.
 */
import { connect, type Socket } from 'node:net';
import { ExternalServiceError } from '@veo/utils';

const CMD = {
  BIND_TRANSCEIVER: 0x00000009,
  BIND_TRANSCEIVER_RESP: 0x80000009,
  SUBMIT_SM: 0x00000004,
  SUBMIT_SM_RESP: 0x80000004,
  UNBIND: 0x00000006,
  UNBIND_RESP: 0x80000006,
} as const;

export interface SmppConfig {
  host: string;
  port: number;
  systemId: string;
  password: string;
  sourceAddr: string;
  timeoutMs: number;
}

function cString(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'ascii'), Buffer.from([0x00])]);
}

/** Construye un PDU SMPP completo (header de 16 bytes + body). */
function buildPdu(commandId: number, sequence: number, body: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16 + body.length, 0); // command_length
  header.writeUInt32BE(commandId, 4); // command_id
  header.writeUInt32BE(0, 8); // command_status
  header.writeUInt32BE(sequence, 12); // sequence_number
  return Buffer.concat([header, body]);
}

interface ParsedPdu {
  commandId: number;
  commandStatus: number;
  sequence: number;
}

function parseHeader(buf: Buffer): ParsedPdu {
  return {
    commandId: buf.readUInt32BE(4),
    commandStatus: buf.readUInt32BE(8),
    sequence: buf.readUInt32BE(12),
  };
}

export class SmppClient {
  constructor(private readonly cfg: SmppConfig) {}

  /** Envía un SMS abriendo una sesión efímera. Lanza ExternalServiceError ante cualquier fallo. */
  async send(destination: string, message: string): Promise<void> {
    const socket = connect({ host: this.cfg.host, port: this.cfg.port });
    socket.setTimeout(this.cfg.timeoutMs);
    try {
      await this.waitConnect(socket);
      await this.bind(socket);
      await this.submit(socket, destination, message);
      await this.unbind(socket);
    } finally {
      socket.destroy();
    }
  }

  private waitConnect(socket: Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('timeout', () => reject(new ExternalServiceError('SMPP: timeout de conexión')));
      socket.once('error', (err) => reject(new ExternalServiceError(`SMPP: ${err.message}`)));
    });
  }

  /** Envía un PDU y espera el primer PDU de respuesta, validando command_id y status. */
  private exchange(socket: Socket, pdu: Buffer, expectedResp: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const onData = (chunk: Buffer): void => {
        chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        if (buf.length < 16) return;
        const length = buf.readUInt32BE(0);
        if (buf.length < length) return; // PDU incompleto: seguir acumulando
        cleanup();
        const header = parseHeader(buf);
        if (header.commandId !== expectedResp) {
          reject(
            new ExternalServiceError(
              `SMPP: respuesta inesperada 0x${header.commandId.toString(16)}`,
            ),
          );
          return;
        }
        if (header.commandStatus !== 0) {
          reject(new ExternalServiceError(`SMPP: command_status=${header.commandStatus}`));
          return;
        }
        resolve(buf.subarray(0, length));
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(new ExternalServiceError(`SMPP: ${err.message}`));
      };
      const onTimeout = (): void => {
        cleanup();
        reject(new ExternalServiceError('SMPP: timeout esperando respuesta'));
      };
      const cleanup = (): void => {
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('timeout', onTimeout);
      };
      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('timeout', onTimeout);
      socket.write(pdu);
    });
  }

  private async bind(socket: Socket): Promise<void> {
    const body = Buffer.concat([
      cString(this.cfg.systemId),
      cString(this.cfg.password),
      cString(''), // system_type
      Buffer.from([0x34]), // interface_version 3.4
      Buffer.from([0x00]), // addr_ton
      Buffer.from([0x00]), // addr_npi
      cString(''), // address_range
    ]);
    await this.exchange(socket, buildPdu(CMD.BIND_TRANSCEIVER, 1, body), CMD.BIND_TRANSCEIVER_RESP);
  }

  private async submit(socket: Socket, destination: string, message: string): Promise<void> {
    const short = Buffer.from(message, 'ascii').subarray(0, 254);
    const body = Buffer.concat([
      cString(''), // service_type
      Buffer.from([0x05]), // source_addr_ton = alphanumeric
      Buffer.from([0x00]), // source_addr_npi
      cString(this.cfg.sourceAddr),
      Buffer.from([0x01]), // dest_addr_ton = international
      Buffer.from([0x01]), // dest_addr_npi = ISDN
      cString(destination.replace(/^\+/, '')),
      Buffer.from([0x00]), // esm_class
      Buffer.from([0x00]), // protocol_id
      Buffer.from([0x00]), // priority_flag
      cString(''), // schedule_delivery_time
      cString(''), // validity_period
      Buffer.from([0x00]), // registered_delivery
      Buffer.from([0x00]), // replace_if_present_flag
      Buffer.from([0x00]), // data_coding (default GSM)
      Buffer.from([0x00]), // sm_default_msg_id
      Buffer.from([short.length]), // sm_length
      short,
    ]);
    await this.exchange(socket, buildPdu(CMD.SUBMIT_SM, 2, body), CMD.SUBMIT_SM_RESP);
  }

  private async unbind(socket: Socket): Promise<void> {
    await this.exchange(socket, buildPdu(CMD.UNBIND, 3, Buffer.alloc(0)), CMD.UNBIND_RESP);
  }
}
