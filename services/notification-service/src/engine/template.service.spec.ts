import { describe, it, expect } from 'vitest';
import { interpolate } from './template.service';

describe('interpolate', () => {
  it('reemplaza placeholders {{var}}', () => {
    expect(interpolate('Hola {{name}}, ETA {{eta}} min', { name: 'Ana', eta: 5 })).toBe(
      'Hola Ana, ETA 5 min',
    );
  });

  it('tolera espacios dentro de las llaves', () => {
    expect(interpolate('{{ a }}-{{b}}', { a: 1, b: 2 })).toBe('1-2');
  });

  it('variables ausentes → cadena vacía', () => {
    expect(interpolate('x={{missing}}', {})).toBe('x=');
  });
});
