/**
 * SandboxWatermarkAdapter · burn determinista sin ffmpeg (Lote 2).
 *
 * El quemado de watermark (Lote 3) necesita un adapter que corra en CI sin el binario ffmpeg. El sandbox
 * resuelve `burn()` como passthrough identidad: devuelve los MISMOS bytes de entrada + `video/mp4`, y
 * expone `lastBurnText` para que los tests aserten que la línea de watermark se compuso bien.
 */
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { SandboxWatermarkAdapter } from './sandbox-watermark.adapter';

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

describe('SandboxWatermarkAdapter · burn passthrough determinista', () => {
  it('devuelve los MISMOS bytes de entrada (passthrough identidad) + contentType video/mp4', async () => {
    const adapter = new SandboxWatermarkAdapter();
    const original = Buffer.from('VEO video crudo · bytes opacos  ÿ\x00\x01\x02', 'binary');

    const result = await adapter.burn({
      source: Readable.from(original),
      text: 'VEO · ana@veo.pe · req-123 · 2026-06-26T00:00:00.000Z',
    });

    expect(result.contentType).toBe('video/mp4');
    const out = await drain(result.output);
    expect(out.equals(original)).toBe(true);
  });

  it('reconstruye el cuerpo aunque la fuente llegue en varios chunks', async () => {
    const adapter = new SandboxWatermarkAdapter();
    const parts = [Buffer.from('parte-A '), Buffer.from('parte-B '), Buffer.from('parte-C')];
    const expected = Buffer.concat(parts);

    const result = await adapter.burn({
      source: Readable.from(parts),
      text: 'VEO · op@veo.pe · r1 · t',
    });

    const out = await drain(result.output);
    expect(out.equals(expected)).toBe(true);
  });

  it('expone el último texto recibido en lastBurnText (observable para tests del Lote 3)', async () => {
    const adapter = new SandboxWatermarkAdapter();
    expect(adapter.lastBurnText).toBeNull();

    const text = 'VEO · ana@veo.pe · req-xyz · 2026-06-26T12:34:56.000Z';
    await adapter.burn({ source: Readable.from(Buffer.from('x')), text });

    expect(adapter.lastBurnText).toBe(text);
  });

  it('lastBurnText refleja el ÚLTIMO burn (se sobreescribe en cada invocación)', async () => {
    const adapter = new SandboxWatermarkAdapter();
    await adapter.burn({ source: Readable.from(Buffer.from('a')), text: 'primero' });
    await adapter.burn({ source: Readable.from(Buffer.from('b')), text: 'segundo' });
    expect(adapter.lastBurnText).toBe('segundo');
  });
});
