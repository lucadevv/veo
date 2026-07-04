import { FleetDocumentType } from '@veo/shared-types';
import { parseDni } from '../parse-dni';
import { parseMrzTd1 } from '../parse-mrz-td1';
import { parseLicense } from '../parse-license';
import { parseSoat } from '../parse-soat';
import { parsePropertyCard } from '../parse-property-card';
import { mapMtcCategoryToVehicleType } from '../vehicle-category';
import { parseDocument, isParsableDocumentType } from '../parse-document';
import { normalizePeruvianDate } from '../ocr-date';
import {
  normalizeLicenseCategory,
  normalizeLicenseClass,
  combineClassAndCategory,
} from '../license-category';

/**
 * Tests de los parsers PUROS de OCR con líneas REALISTAS de documentos peruanos (DNI, licencia, SOAT,
 * tarjeta de propiedad). Lo más valioso: (1) que extraigan los campos correctos de un documento legible
 * y (2) que ante texto BASURA no inventen nada (devuelvan vacío). Las líneas imitan lo que Vision/MLKit
 * reconoce on-device: etiquetas + valores, mayúsculas inconsistentes, fechas DD/MM/AAAA.
 */

describe('normalizePeruvianDate · normaliza fechas peruanas a YYYY-MM-DD', () => {
  it('numérica DD/MM/AAAA', () => {
    expect(normalizePeruvianDate('Vence 31/12/2027')).toBe('2027-12-31');
  });
  it('numérica con guiones y puntos', () => {
    expect(normalizePeruvianDate('05-03-2026')).toBe('2026-03-05');
    expect(normalizePeruvianDate('05.03.2026')).toBe('2026-03-05');
  });
  it('textual con mes en letras (abreviado y completo)', () => {
    expect(normalizePeruvianDate('12 ENE 2027')).toBe('2027-01-12');
    expect(normalizePeruvianDate('12 de enero de 2027')).toBe('2027-01-12');
  });
  it('rechaza fechas imposibles (31/02) → null (no inventa)', () => {
    expect(normalizePeruvianDate('31/02/2026')).toBeNull();
  });
  it('texto sin fecha → null', () => {
    expect(normalizePeruvianDate('LICENCIA DE CONDUCIR')).toBeNull();
  });
});

describe('normalizeLicenseCategory · mapea la forma COMBINADA a la unión tipada (clase A y B)', () => {
  it('reconoce variantes de A-IIb', () => {
    expect(normalizeLicenseCategory('A-IIb')).toBe('A-IIb');
    expect(normalizeLicenseCategory('A IIB')).toBe('A-IIb');
    expect(normalizeLicenseCategory('AIIB')).toBe('A-IIb');
  });
  it('reconoce A-I y A-IIIa', () => {
    expect(normalizeLicenseCategory('Categoría A-I')).toBe('A-I');
    expect(normalizeLicenseCategory('A-IIIa')).toBe('A-IIIa');
  });
  it('reconoce CLASE B (moto): B-I, B-IIa, B-IIb, B-IIc', () => {
    expect(normalizeLicenseCategory('B-I')).toBe('B-I');
    expect(normalizeLicenseCategory('B IIA')).toBe('B-IIa');
    expect(normalizeLicenseCategory('BIIB')).toBe('B-IIb');
    expect(normalizeLicenseCategory('B-IIc')).toBe('B-IIc');
  });
  it('texto sin categoría → null', () => {
    expect(normalizeLicenseCategory('NINGUNA CLASE AQUI XYZ')).toBeNull();
  });
  it('combinación inexistente en el catálogo → null (no inventa)', () => {
    expect(normalizeLicenseCategory('B-IIIa')).toBeNull(); // clase B no llega a IIIa
  });
});

describe('normalizeLicenseClass · A/B desde el rótulo Clase', () => {
  it('reconoce la clase del rótulo o del valor suelto', () => {
    expect(normalizeLicenseClass('Clase: A')).toBe('A');
    expect(normalizeLicenseClass('Clase B')).toBe('B');
    expect(normalizeLicenseClass('A')).toBe('A');
  });
  it('texto sin clase → null', () => {
    expect(normalizeLicenseClass('Categoria Uno')).toBeNull();
  });
});

describe('combineClassAndCategory · Clase + Categoría-palabra → canónica', () => {
  it('Clase A + Uno → A-I (palabra ordinal española)', () => {
    expect(combineClassAndCategory('A', 'Uno')).toBe('A-I');
  });
  it('Clase B + "Dos B" → B-IIb (palabra ordinal + sub-letra)', () => {
    expect(combineClassAndCategory('B', 'Dos B')).toBe('B-IIb');
  });
  it('Clase A + romano "IIb" también combina (por si el OCR lo da en romano)', () => {
    expect(combineClassAndCategory('A', 'IIb')).toBe('A-IIb');
  });
  it('Clase A + "Tres C" → A-IIIc', () => {
    expect(combineClassAndCategory('A', 'Tres C')).toBe('A-IIIc');
  });
  it('combinación inexistente → null (Clase B + Tres no existe)', () => {
    expect(combineClassAndCategory('B', 'Tres')).toBeNull();
  });
});

describe('parseDni · DNI peruano (GROUND TRUTH: valor en la línea de ABAJO; combinado o separado)', () => {
  it('Modelo 2020: Primer Apellido + Segundo Apellido + Prenombres (valor LÍNEA ABAJO) → fullName compuesto', () => {
    // Layout REAL del DNI Modelo 2020: rótulo en una línea, valor en la de abajo. NO existe "Apellido
    // Paterno/Materno" impreso — los rótulos reales son "Primer Apellido"/"Segundo Apellido".
    const lines = [
      'REPÚBLICA DEL PERÚ',
      'Primer Apellido',
      'LÓPEZ',
      'Segundo Apellido',
      'TORRES',
      'Prenombres',
      'LUIS IVAN',
      'DNI',
      '12345678',
      'Fecha de Nacimiento',
      '07/12/1998',
    ];
    expect(parseDni(lines)).toEqual({
      documentNumber: '12345678',
      fullName: 'LÓPEZ TORRES LUIS IVAN',
      birthDate: '1998-12-07',
    });
  });

  it('DNIe 3.0 (2025): UN campo COMBINADO "Apellidos" + "Prenombres" (valor LÍNEA ABAJO) + CUI', () => {
    // Layout REAL del DNIe 3.0: apellidos COMBINADOS en un solo campo; CUI = 8 díg + "-" + verificador.
    const lines = [
      'REPÚBLICA DEL PERÚ',
      'Apellidos',
      'QUISPE MAMANI',
      'Prenombres',
      'JUAN CARLOS',
      'CUI',
      '41326541-5',
      'Fecha de Nacimiento',
      '23/08/1990',
    ];
    expect(parseDni(lines)).toEqual({
      documentNumber: '41326541',
      fullName: 'QUISPE MAMANI JUAN CARLOS',
      birthDate: '1990-08-23',
    });
  });

  it('CUI 41326541-5 → 41326541 (descarta el dígito verificador)', () => {
    expect(parseDni(['CUI', '41326541-5']).documentNumber).toBe('41326541');
    expect(parseDni(['DNI', '87654321 - 0']).documentNumber).toBe('87654321');
  });

  it('etiqueta "DNI" en una línea SEPARADA del número → mira la línea siguiente', () => {
    const lines = ['DOCUMENTO NACIONAL DE IDENTIDAD', '45678912', 'JUAN CARLOS'];
    expect(parseDni(lines).documentNumber).toBe('45678912');
  });

  it('toma el único 8-dígitos cuando no hay etiqueta DNI explícita', () => {
    const lines = ['REPUBLICA DEL PERU', '12349876', 'JUAN PEREZ'];
    expect(parseDni(lines).documentNumber).toBe('12349876');
  });

  it('NO adivina el DNI si hay varios 8-dígitos ambiguos sin etiqueta', () => {
    const lines = ['12349876', '88887777', 'sin etiqueta'];
    expect(parseDni(lines).documentNumber).toBeUndefined();
  });

  it('texto basura → objeto vacío (no inventa)', () => {
    expect(parseDni(['xxxx', 'yyyy', '12'])).toEqual({});
  });

  it('DATA REAL del device (DNIe moderno): CUI + nacimiento DD MM AAAA (etiqueta DISPERSA) + N° Tarjeta de 10 díg NO confunde', () => {
    // textLines capturadas en vivo: la etiqueta "Fecha de Nacimiento" vive en una línea COMBINADA
    // ("Nacionalidad Fecha de Nacimiento") LEJOS del valor "07 12 1998" (formato DD MM AAAA con espacios).
    // El número correcto es el CUI 73694046-4 → 73694046; el N° de Tarjeta 0206388595 (10 díg) NO debe ganar.
    const front = [
      'REGISTRO NACIONAL DE IDENTIFICACIÓN Y ESTADO CIVIL',
      'DNI',
      '73694046',
      'Apellidos',
      'CARRANZA SALDAÑA',
      'Prenombres',
      'LUIS IVAN',
      'Nacionalidad Fecha de Nacimiento',
      'PER',
      '07 12 1998',
      'Fecha de Emisión',
      '15 03 2025',
      'Fecha de Caducidad',
      '15 03 2033',
      'N° de Tarjeta',
      '0206388595',
      'REGISTRO NACIONAL DE IDENTIFICACIÓN 73694046-4',
    ];
    expect(parseDni(front)).toEqual({
      documentNumber: '73694046',
      fullName: 'CARRANZA SALDAÑA LUIS IVAN',
      birthDate: '1998-12-07',
    });
  });
});

describe('parseDni · MRZ-first (reverso del DNIe) con fallback al frente', () => {
  // MRZ TD1 de ejemplo (3 líneas × 30 chars). L1: I<PER + docnum(9). L2: birth(981207) + check + M +
  // expiry. L3: APELLIDOS<<PRENOMBRES. Ver `parseMrzTd1`.
  const MRZ_BACK = [
    'I<PER123456789<<<<<<<<<<<<<<<<',
    '9812075M3001017PER<<<<<<<<<<<<',
    'LOPEZ<TORRES<<LUIS<IVAN<<<<<<<',
  ];

  it('usa el MRZ del reverso como plan A (número/nombre/nacimiento del MRZ)', () => {
    const front = ['REPÚBLICA DEL PERÚ', 'foto ilegible'];
    expect(parseDni(front, MRZ_BACK)).toEqual({
      documentNumber: '12345678',
      fullName: 'LOPEZ TORRES LUIS IVAN',
      birthDate: '1998-12-07',
    });
  });

  it('mergea: lo que el MRZ no trae se completa con el frente (rótulos REALES, valor línea abajo)', () => {
    // MRZ sin nombre legible (todo relleno en L3) → el nombre sale del frente (Modelo 2020 separado).
    const back = [
      'I<PER123456789<<<<<<<<<<<<<<<<',
      '9812075M3001017PER<<<<<<<<<<<<',
      '<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
    ];
    const front = ['Primer Apellido', 'LÓPEZ', 'Segundo Apellido', 'TORRES', 'Prenombres', 'LUIS'];
    expect(parseDni(front, back)).toEqual({
      documentNumber: '12345678',
      fullName: 'LÓPEZ TORRES LUIS',
      birthDate: '1998-12-07',
    });
  });

  it('viejo azul: el MRZ vive en el ANVERSO → MRZ-first también lo lee desde el frente', () => {
    // GROUND TRUTH: el DNI viejo azul tiene MRZ en el anverso (no en el reverso).
    const front = [
      'REPÚBLICA DEL PERÚ',
      'I<PER123456789<<<<<<<<<<<<<<<<',
      '9812075M3001017PER<<<<<<<<<<<<',
      'LOPEZ<TORRES<<LUIS<IVAN<<<<<<<',
    ];
    expect(parseDni(front)).toEqual({
      documentNumber: '12345678',
      fullName: 'LOPEZ TORRES LUIS IVAN',
      birthDate: '1998-12-07',
    });
  });

  it('sin MRZ válido → cae al parseo del frente (rótulos REALES, valor línea abajo)', () => {
    const back = ['REVERSO SIN MRZ', 'solo texto suelto'];
    const front = ['DNI', '45678912', 'Primer Apellido', 'PEREZ', 'Prenombres', 'ANA'];
    expect(parseDni(front, back)).toEqual({
      documentNumber: '45678912',
      fullName: 'PEREZ ANA',
    });
  });

  it('el NOMBRE prefiere el FRENTE sobre un MRZ mutilado que se comió el 2do apellido (caso real de campo)', () => {
    // GROUND TRUTH (bug reportado, DNIe CARRANZA SALDAÑA): el OCR mutila los `<` de la L3 del MRZ y DROPEA
    // el segundo apellido — leyó `CARRANZA<<LUIS<IVAN` en vez de `CARRANZA<SALDANA<<LUIS<IVAN`. El MRZ SÍ
    // parsea (número + nacimiento válidos), pero su nombre está INCOMPLETO. El frente tiene los rótulos
    // explícitos con AMBOS apellidos → el nombre del frente debe GANAR (número y nacimiento del MRZ).
    const back = [
      'I<PER73694046<5<<<<<<<<<<<<<<<',
      '9812079M3301236PER<<<<<<<<<<<<',
      'CARRANZA<<LUIS<IVAN<<<<<<<<<<<', // MRZ mutilado por el OCR: falta SALDAÑA
    ];
    const front = [
      'Primer Apellido',
      'CARRANZA',
      'Segundo Apellido',
      'SALDAÑA',
      'Prenombres',
      'LUIS IVAN',
    ];
    const parsed = parseDni(front, back);
    // El nombre COMPLETO del frente (con SALDAÑA), NO el del MRZ incompleto.
    expect(parsed.fullName).toBe('CARRANZA SALDAÑA LUIS IVAN');
    // El número sí sale del MRZ (dígitos estructurados, más estables).
    expect(parsed.documentNumber).toBe('73694046');
  });
});

describe('parseMrzTd1 · MRZ TD1 del DNIe (función pura)', () => {
  const REF = new Date(2026, 0, 1); // referencia fija para el pivote de siglo del nacimiento.

  it('extrae número, nombre y nacimiento de un MRZ TD1 de ejemplo', () => {
    const lines = [
      'I<PER123456789<<<<<<<<<<<<<<<<',
      '9812075M3001017PER<<<<<<<<<<<<',
      'LOPEZ<TORRES<<LUIS<IVAN<<<<<<<',
    ];
    expect(parseMrzTd1(lines, REF)).toEqual({
      documentNumber: '12345678',
      fullName: 'LOPEZ TORRES LUIS IVAN',
      birthDate: '1998-12-07',
    });
  });

  it('tolera ruido del OCR (espacios/minúsculas) en las líneas MRZ', () => {
    const lines = [
      ' i<per123456789<<<<<<<<<<<<<<<< ',
      '9812075M3001017PER<<<<<<<<<<<<',
      'lopez<torres<<luis<ivan<<<<<<<',
    ];
    expect(parseMrzTd1(lines, REF)?.documentNumber).toBe('12345678');
    expect(parseMrzTd1(lines, REF)?.fullName).toBe('LOPEZ TORRES LUIS IVAN');
  });

  it('pivote de siglo del nacimiento: YY > año actual de 2 díg → 19YY (no futuro)', () => {
    // Referencia 2026 → YY=50 (>26) ⇒ 1950; YY=10 (<=26) ⇒ 2010.
    const old = ['I<PER111111111<<<<<<<<<<<<<<<<', '5001015M3001017PER<<<<<<<<<<<<', 'A<<B<<<<<<<<<<<<<<<<<<<<<<<<<<'];
    const young = ['I<PER111111111<<<<<<<<<<<<<<<<', '1001015M3001017PER<<<<<<<<<<<<', 'A<<B<<<<<<<<<<<<<<<<<<<<<<<<<<'];
    expect(parseMrzTd1(old, REF)?.birthDate).toBe('1950-01-01');
    expect(parseMrzTd1(young, REF)?.birthDate).toBe('2010-01-01');
  });

  it('separador de nombre: "<<" parte apellidos↔nombres, "<" parte palabras', () => {
    // L3: APELLIDO1<APELLIDO2<<NOMBRE1<NOMBRE2 → "APELLIDO1 APELLIDO2 NOMBRE1 NOMBRE2".
    const lines = [
      'I<PER123456789<<<<<<<<<<<<<<<<',
      '9812075M3001017PER<<<<<<<<<<<<',
      'DE<LA<CRUZ<<MARIA<JOSE<<<<<<<<',
    ];
    expect(parseMrzTd1(lines, REF)?.fullName).toBe('DE LA CRUZ MARIA JOSE');
  });

  it('OCR partió las líneas MRZ en fragmentos → se RE-UNEN antes del check de 30 chars', () => {
    // El OCR cortó cada línea de 30 en dos mitades de 15. El detector las reconstruye (3×30=90 chars).
    const lines = [
      'I<PER123456789<',
      '<<<<<<<<<<<<<<<',
      '9812075M3001017',
      'PER<<<<<<<<<<<<',
      'LOPEZ<TORRES<<L',
      'UIS<IVAN<<<<<<<',
    ];
    expect(parseMrzTd1(lines, REF)).toEqual({
      documentNumber: '12345678',
      fullName: 'LOPEZ TORRES LUIS IVAN',
      birthDate: '1998-12-07',
    });
  });

  it('sin 3 líneas MRZ válidas → null (degradación honesta)', () => {
    expect(parseMrzTd1(['no es mrz', 'tampoco'])).toBeNull();
    expect(parseMrzTd1([])).toBeNull();
    expect(parseMrzTd1(undefined)).toBeNull();
  });
});

describe('parseLicense · licencia de conducir peruana (GROUND TRUTH: documento real, Clase + Categoría partidos)', () => {
  it('DOC REAL clase A: número F73694046, Clase A + Categoría Uno → A-I, Fecha de Revalidación = vencimiento', () => {
    // Rótulos REALES del documento (anverso): número = letra de depto + DNI (`F73694046`); la categoría
    // viene PARTIDA: `Clase A` + `Categoría Uno` (la PALABRA ordinal); el vencimiento es la REVALIDACIÓN
    // (17/10/2032), NO la EXPEDICIÓN (17/10/2022).
    const lines = [
      'MINISTERIO DE TRANSPORTES Y COMUNICACIONES',
      'LICENCIA DE CONDUCIR',
      'Nro de Licencia F73694046',
      'Clase A',
      'Categoría Uno',
      'Fecha de Expedición 17/10/2022',
      'Fecha de Revalidación 17/10/2032',
    ];
    expect(parseLicense(lines)).toEqual({
      number: 'F73694046',
      category: 'A-I',
      expiresAt: '2032-10-17',
    });
  });

  it('CLASE B (moto): Clase B + Categoría "Dos B" → B-IIb', () => {
    const lines = [
      'LICENCIA DE CONDUCIR',
      'Nro de Licencia F73694046',
      'Clase B',
      'Categoría Dos B',
      'Fecha de Revalidación 17/10/2032',
    ];
    expect(parseLicense(lines)).toEqual({
      number: 'F73694046',
      category: 'B-IIb',
      expiresAt: '2032-10-17',
    });
  });

  it('OCR DISPERSO/rotado: rótulo Clase/Categoría SOLO + valor en la línea siguiente → combina igual', () => {
    // El anverso rota/dispersa el texto: el rótulo y su valor quedan en renglones distintos.
    const lines = [
      'Clase',
      'A',
      'Categoría',
      'Uno',
      'Nro de Licencia',
      'F73694046',
      'Fecha de Revalidación',
      '17/10/2032',
    ];
    expect(parseLicense(lines)).toEqual({
      number: 'F73694046',
      category: 'A-I',
      expiresAt: '2032-10-17',
    });
  });

  it('ignora la Fecha de Expedición y toma la de Revalidación (NO confundirlas)', () => {
    const lines = [
      'Clase A',
      'Categoría Uno',
      'Fecha de Expedición 15/06/2024',
      'Fecha de Revalidación 15/06/2029',
      'Nro de Licencia F98765432',
    ];
    const parsed = parseLicense(lines);
    expect(parsed.expiresAt).toBe('2029-06-15');
    expect(parsed.category).toBe('A-I');
    expect(parsed.number).toBe('F98765432');
  });

  it('respaldo: categoría YA combinada en la línea de Categoría (sin rótulo Clase) sigue funcionando', () => {
    const lines = ['Categoría: A-IIb', 'Nro de Licencia Q70128450', 'Fecha de Revalidación 15/06/2028'];
    expect(parseLicense(lines)).toEqual({
      number: 'Q70128450',
      category: 'A-IIb',
      expiresAt: '2028-06-15',
    });
  });

  it('DATA REAL del device (escaneo 1): layout en COLUMNAS, rótulos y valores AGRUPADOS → A-I + max-fecha', () => {
    // textLines REALES del OCR (escaneo 1 del documento real). El layout es en COLUMNAS: los rótulos van
    // juntos (`Categoria`,`Clase`) y los valores juntos (`Uno`,`A`); las dos fechas también agrupadas. La
    // proximidad rótulo→línea-siguiente NO sirve (la línea tras `Categoria` es OTRO rótulo `Clase`). El
    // parser usa escaneo GLOBAL (clase `A` + ordinal `Uno` = A-I) y MAX-fecha (revalidación 17/10/2032).
    const lines = [
      'REPUBLICA DEL PERU',
      'MINISTERIO DE TRANSPORTES Y COMUNICACIONES',
      'DIRECCION GENERAL DE AUTORIZACIONES EN TRANSPORTES',
      'LICENCIA DE CONDUCIR',
      'Apellidos',
      'CARRANZA SALDAÑA',
      'LUIS IVAN',
      'Nro de Licencia',
      'F73694046',
      'Categoria',
      'Clase',
      'Uno',
      'A',
      'Fecha de Revalidación',
      'Fecha de Expedición',
      '17/10/2032',
      '17/10/2022',
      'FIRMA DEL TITULAR',
    ];
    expect(parseLicense(lines)).toEqual({
      number: 'F73694046',
      category: 'A-I',
      expiresAt: '2032-10-17',
    });
  });

  it('DATA REAL del device (escaneo 2): MISMO documento, ORDEN distinto e inestable → mismo resultado', () => {
    // Segundo escaneo del MISMO documento: el OCR devolvió las líneas en OTRO orden (rótulos/valores y
    // fechas reordenados). Como el parser es order-independent (escaneo global + max-fecha), el resultado
    // es idéntico al escaneo 1.
    const lines = [
      'REPUBLICA DEL PERU',
      'MINISTERIO DE TRANSPORTES Y COMUNICACIONES',
      'DIRECCION GENERAL DE AUTORIZACIONES EN TRANSPORTES',
      'LICENCIA DE CONDUCIR',
      'Apellidos',
      'CARRANZA SALDAÑA',
      'Nombres',
      'LUIS IVAN',
      'Nro de Licencia',
      'F73694046',
      'Clase',
      'Categoría',
      'A',
      'Uno',
      'Fecha de Revalidación',
      'Fecha de Expedición',
      '17/10/2022',
      '17/10/2032',
      'FIRMA DEL TITULAR',
    ];
    expect(parseLicense(lines)).toEqual({
      number: 'F73694046',
      category: 'A-I',
      expiresAt: '2032-10-17',
    });
  });

  it('CLASE B (moto) en layout COLUMNAS dispersas: clase `B` + ordinal `Dos B` sueltos → B-IIb', () => {
    // Valores `B` y `Dos B` sueltos (columna de valores), lejos de sus rótulos: el escaneo global los une.
    const lines = [
      'LICENCIA DE CONDUCIR',
      'Categoria',
      'Clase',
      'Dos B',
      'B',
      'Nro de Licencia',
      'F73694046',
      'Fecha de Revalidación',
      '17/10/2032',
    ];
    expect(parseLicense(lines)).toEqual({
      number: 'F73694046',
      category: 'B-IIb',
      expiresAt: '2032-10-17',
    });
  });

  it('degradado: SIN fecha → expiresAt undefined (no crash)', () => {
    const parsed = parseLicense(['Clase', 'A', 'Categoria', 'Uno', 'Nro de Licencia', 'F73694046']);
    expect(parsed.expiresAt).toBeUndefined();
    expect(parsed.number).toBe('F73694046');
    expect(parsed.category).toBe('A-I');
  });

  it('degradado: categoría que NO arma (clase sin ordinal) → category undefined', () => {
    const parsed = parseLicense(['Nro de Licencia', 'F73694046', 'Clase', 'A', 'Fecha de Revalidación', '17/10/2032']);
    expect(parsed.category).toBeUndefined();
    expect(parsed.number).toBe('F73694046');
    expect(parsed.expiresAt).toBe('2032-10-17');
  });

  it('texto basura → objeto vacío (no inventa)', () => {
    expect(parseLicense(['hola', 'mundo'])).toEqual({});
  });
});

describe('parseSoat · SOAT (GROUND TRUTH: N° Póliza - Certificado combinado + Hasta de control policial)', () => {
  it('número combinado "N° Póliza - Certificado" + Hasta del bloque CERTIFICADO SOAT / CONTROL POLICIAL', () => {
    // Hay DOS "Hasta": el de VIGENCIA DE LA PÓLIZA y el de CERTIFICADO SOAT/CONTROL POLICIAL. Se prefiere
    // el del bloque de control. El número es UN campo combinado: "\\d{8,10} - \\d{1,2}".
    const lines = [
      'SEGURO OBLIGATORIO DE ACCIDENTES DE TRÁNSITO',
      'N° Póliza - Certificado: 2012044701 - 1',
      'VIGENCIA DE LA PÓLIZA',
      'Desde 01/01/2026 Hasta 30/12/2026',
      'CERTIFICADO SOAT - CONTROL POLICIAL',
      'Desde 01/01/2026 Hasta 31/12/2026',
      'Placa ABC-123',
    ];
    expect(parseSoat(lines)).toEqual({
      policyNumber: '2012044701 - 1',
      expiresAt: '2026-12-31',
    });
  });

  it('variante separador "/" y "Nº": el valor se normaliza al canónico con "-"', () => {
    const lines = ['Nº Póliza / Certificado', '2099123456 / 12', 'Hasta: 30/09/2027'];
    expect(parseSoat(lines)).toEqual({ policyNumber: '2099123456 - 12', expiresAt: '2027-09-30' });
  });

  it('fallback: si NO hay bloque de control, usa el Hasta de la vigencia de la póliza', () => {
    const lines = [
      'N° Poliza-Certificado: 2012044701-1',
      'VIGENCIA DE LA POLIZA',
      'Desde 01/01/2026 Hasta 31/12/2026',
    ];
    expect(parseSoat(lines)).toEqual({ policyNumber: '2012044701 - 1', expiresAt: '2026-12-31' });
  });

  it('NO adivina el número de póliza sin etiqueta (omite)', () => {
    const lines = ['SEGURO', 'Hasta 31/12/2026'];
    const parsed = parseSoat(lines);
    expect(parsed.policyNumber).toBeUndefined();
    expect(parsed.expiresAt).toBe('2026-12-31');
  });

  it('texto basura → objeto vacío (no inventa)', () => {
    expect(parseSoat(['xx', 'yy'])).toEqual({});
  });

  it('SOAT REAL (Certificado Electrónico DS 015-2016 MTC) — orden normal: Nº Póliza - Certificado combinado + max-fecha', () => {
    // GROUND TRUTH del PDF oficial (La Positiva): el SOAT REAL es el Certificado Electrónico (NO la boleta
    // de pago). El número es el campo COMBINADO `143139370 - 0`; las dos vigencias van Desde 2026 / Hasta
    // 2027 → el vencimiento es la fecha MÁS TARDÍA (Hasta 13/06/2027).
    const lines = [
      'Certificado Electrónico',
      'Decreto Supremo 015 - 2016 MTC',
      'SOAT',
      'LA POSITIVA SEGUROS Y REASEGUROS',
      'Nº Póliza - Certificado: 143139370 - 0',
      'VIGENCIA DE LA PÓLIZA',
      'Desde 13/06/2026 Hasta 13/06/2027',
      'CERTIFICADO SOAT - CONTROL POLICIAL',
      'Desde 13/06/2026 Hasta 13/06/2027',
      'Placa 7351NB',
      'Vehiculo Menor',
      'Particular',
      'VIN VBKJYC402MC067338',
      'CARRANZA SALDAÑA, LUIS IVAN',
      'Prima S/. 699',
      'Fecha emisión 13/06/2026',
    ];
    expect(parseSoat(lines)).toEqual({
      policyNumber: '143139370 - 0',
      expiresAt: '2027-06-13',
    });
  });

  it('SOAT REAL — orden DISPERSO (device): etiqueta y valor separados, "Hasta" sin fecha adyacente, fechas agrupadas', () => {
    // El OCR del device DISPERSA: "Nº Póliza - Certificado" queda LEJOS de su valor `143139370 - 0`; las
    // etiquetas "Desde"/"Hasta" quedan sin su fecha al lado; las fechas se agrupan en otro bloque. Como el
    // parser es order-independent (fallback GLOBAL del token combinado + max-fecha), el resultado es idéntico.
    const lines = [
      'Certificado Electrónico',
      'SOAT',
      'LA POSITIVA SEGUROS Y REASEGUROS',
      'Nº Póliza - Certificado',
      'VIGENCIA DE LA PÓLIZA',
      'Desde',
      'Hasta',
      'CERTIFICADO SOAT - CONTROL POLICIAL',
      'Desde',
      'Hasta',
      'Placa',
      '7351NB',
      'VIN',
      'VBKJYC402MC067338',
      '13/06/2026',
      '13/06/2027',
      '13/06/2026',
      '13/06/2027',
      '13/06/2026',
      '143139370 - 0',
    ];
    expect(parseSoat(lines)).toEqual({
      policyNumber: '143139370 - 0',
      expiresAt: '2027-06-13',
    });
  });

  it('DATA REAL: BOLETA de venta electrónica (La Positiva) — POLIZA standalone + FIN VIG. DOC/POL', () => {
    // textLines de la boleta/recibo del SOAT (La Positiva): etiquetas DISTINTAS al certificado. El número
    // de póliza es `POLIZA : 143139370` standalone (NO la proforma 817392974 ni el COD.CONTRATANTE). El
    // vencimiento es FIN VIG. DOC/POL = 13/06/2027 (NUNCA el 13/06/2026 de INICIO VIG ni de VENC. DOC.).
    const lines = [
      'LA POSITIVA SEGUROS - BOLETA DE VENTA ELECTRONICA',
      'N° PROFORMA : 817392974',
      'COD.CONTRATANTE : N076625084',
      'POLIZA          : 143139370',
      'RAMO            : SOAT',
      'INICIO VIG. POL : 13/06/2026',
      'FIN VIG. POL    : 13/06/2027',
      'INICIO VIG.DOC. : 13/06/2026',
      'FIN VIG. DOC.   : 13/06/2027',
      'VENC. DOC.      : 13/06/2026',
      'PLACA           : 7351-NB',
    ];
    expect(parseSoat(lines)).toEqual({
      policyNumber: '143139370',
      expiresAt: '2027-06-13',
    });
  });
});

describe('parsePropertyCard · tarjeta de propiedad / TIVe (GROUND TRUTH: Categoría EXPLÍCITA, valor AL LADO)', () => {
  it('extrae plate, make, model, year (Año de Fab.) y mtcCategory (Categoría: M1, valor al lado)', () => {
    // Layout REAL de la TIVe: "Datos del Vehículo" con valor AL LADO tras ":". Categoría IMPRESA explícita.
    const lines = [
      'SUNARP - TARJETA DE IDENTIFICACIÓN VEHICULAR',
      'Placa N°: ABC123',
      'Datos del Vehículo',
      'Categoría: M1',
      'Marca: TOYOTA',
      'Modelo: YARIS',
      'Año de Fab.: 2019',
      'Año Modelo: 2020',
      'Color: PLATA',
    ];
    expect(parsePropertyCard(lines)).toEqual({
      plate: 'ABC-123',
      make: 'TOYOTA',
      model: 'YARIS',
      year: 2019,
      mtcCategory: 'M1',
      color: 'PLATA',
    });
  });

  it('extrae el color (Color : NEGRO, valor al lado)', () => {
    expect(parsePropertyCard(['Color : NEGRO']).color).toBe('NEGRO');
  });

  it('limpia el ruido del OCR tras el color (NEGRO ##### ####) y se queda con el color', () => {
    expect(parsePropertyCard(['Color: NEGRO ##### ####']).color).toBe('NEGRO');
    expect(parsePropertyCard(['Color : BLANCO ##########']).color).toBe('BLANCO');
  });

  it('color disperso: etiqueta "Color" sola + valor en la línea siguiente', () => {
    expect(parsePropertyCard(['Color', 'ROJO']).color).toBe('ROJO');
  });

  it('sin etiqueta de color → color ausente (no inventa)', () => {
    expect(parsePropertyCard(['Placa: ABC-123']).color).toBeUndefined();
  });

  it('no confunde "Modelo" con "Año Modelo" (toma el Modelo del vehículo, no el año modelo)', () => {
    const lines = ['Modelo: COROLLA', 'Año Modelo: 2021', 'Año de Fab.: 2020'];
    const parsed = parsePropertyCard(lines);
    expect(parsed.model).toBe('COROLLA');
    expect(parsed.year).toBe(2020);
  });

  it('categoría especial/no-auto (N1 furgón) se EXTRAE como código crudo (el mapeo es otro paso)', () => {
    const lines = ['Categoría: N1', 'Placa: XYZ-789'];
    expect(parsePropertyCard(lines)).toEqual({ plate: 'XYZ-789', mtcCategory: 'N1' });
  });

  it('reconoce la placa sin etiqueta si es la única del documento', () => {
    const lines = ['TARJETA DE PROPIEDAD', 'XYZ-789'];
    expect(parsePropertyCard(lines).plate).toBe('XYZ-789');
  });

  it('texto basura → objeto vacío (no inventa)', () => {
    expect(parsePropertyCard(['nada', 'aqui'])).toEqual({});
  });

  it('DATA REAL del device (TIVe electrónica MOTO): placa por PATRÓN disperso + Año Modelo fallback; descarta DUA/Título/VIN/2X1', () => {
    // textLines capturadas en vivo: el OCR DISPERSA "Placa N°" de su valor "7351-NB" (línea separada, no
    // adyacente). No hay "Año de Fab." → se usa "Año Modelo" como fallback. El ruido (DUA, Título, VIN,
    // Form. Rod. 2X1, modelo "RC 200") NO debe confundirse con la placa.
    const lines = [
      'SUNARP - TARJETA DE IDENTIFICACIÓN VEHICULAR ELECTRÓNICA',
      'Placa N°',
      'Categoria : L3',
      'Marca : KTM',
      'Modelo : RC 200',
      'Año Modelo : 2021',
      '7351-NB',
      'N° DUA/DAM : 118-2021-10-173280-26',
      'N° Título : 1923911-2026',
      'VIN : VBKJYC402MC067338',
      'Form. Rod. : 2X1',
    ];
    expect(parsePropertyCard(lines)).toEqual({
      plate: '7351-NB',
      make: 'KTM',
      model: 'RC 200',
      year: 2021,
      mtcCategory: 'L3',
    });
  });

  it('placa de MOTO (3-4 díg + 2 letras) se reconoce por patrón aunque haya etiqueta "Placa" sin valor', () => {
    expect(parsePropertyCard(['Placa N°', '7351-NB']).plate).toBe('7351-NB');
    expect(parsePropertyCard(['Placa', '123-AB']).plate).toBe('123-AB');
  });

  it('descarta DUA/DAM, Título y VIN como falsos positivos de placa', () => {
    const noise = [
      'N° DUA/DAM : 118-2021-10-173280-26',
      'N° Título : 1923911-2026',
      'VIN : VBKJYC402MC067338',
      'Form. Rod. : 2X1',
    ];
    expect(parsePropertyCard(noise).plate).toBeUndefined();
  });

  describe('OCR DISPERSO: etiqueta SOLA + valor en la LÍNEA SIGUIENTE (PDF en pantalla)', () => {
    it('"Modelo" sola + "RC 200" en la línea siguiente → extrae model', () => {
      const lines = ['Modelo', 'RC 200'];
      expect(parsePropertyCard(lines).model).toBe('RC 200');
    });

    it('"Categoria" sola + "L3" en la línea siguiente → mtcCategory L3', () => {
      const lines = ['Categoria', 'L3'];
      expect(parsePropertyCard(lines).mtcCategory).toBe('L3');
    });

    it('marca/modelo/año/categoría TODOS dispersos (etiqueta arriba, valor abajo)', () => {
      const lines = [
        'SUNARP - TARJETA DE IDENTIFICACIÓN VEHICULAR',
        'Categoria',
        'L3',
        'Marca',
        'KTM',
        'Modelo',
        'RC 200',
        'Año Modelo',
        '2021',
        'Placa N°',
        '7351-NB',
      ];
      expect(parsePropertyCard(lines)).toEqual({
        plate: '7351-NB',
        make: 'KTM',
        model: 'RC 200',
        year: 2021,
        mtcCategory: 'L3',
      });
    });

    it('NO captura una etiqueta-vecina como valor disperso ("Modelo" sola seguida de "Año Modelo")', () => {
      // "Modelo" queda sola y la línea de abajo es OTRA etiqueta conocida ("Año Modelo"): NO se toma como
      // valor. El modelo real ("COROLLA") está disperso más abajo bajo su propia etiqueta.
      const lines = ['Modelo', 'Año Modelo', '2021', 'Modelo', 'COROLLA'];
      const parsed = parsePropertyCard(lines);
      expect(parsed.model).toBe('COROLLA');
    });

    it('NO captura la etiqueta vecina como categoría ("Categoria" sola seguida de "Marca")', () => {
      const lines = ['Categoria', 'Marca', 'KTM'];
      expect(parsePropertyCard(lines).mtcCategory).toBeUndefined();
    });

    it('el caso INLINE sigue funcionando intacto (valor al lado tras ":")', () => {
      const lines = ['Modelo: YARIS', 'Categoría: M1', 'Marca: TOYOTA', 'Año de Fab.: 2019'];
      expect(parsePropertyCard(lines)).toEqual({
        make: 'TOYOTA',
        model: 'YARIS',
        year: 2019,
        mtcCategory: 'M1',
      });
    });
  });

  describe('combustible → energySource (ADR-017 §1.8: combustible REAL de la TIVe → fuente tipada)', () => {
    it('Combustible: GASOLINA → GASOLINE_90 (UNA sola gasolina, sin octanaje · ADR-017 §1.1)', () => {
      expect(parsePropertyCard(['Combustible: GASOLINA']).energySource).toBe('GASOLINE_90');
    });

    it('Combustible: DIESEL / DIÉSEL / PETROLEO → DIESEL', () => {
      expect(parsePropertyCard(['Combustible: DIESEL']).energySource).toBe('DIESEL');
      expect(parsePropertyCard(['Combustible: DIÉSEL']).energySource).toBe('DIESEL');
      expect(parsePropertyCard(['Combustible: PETROLEO']).energySource).toBe('DIESEL');
    });

    it('Combustible: GNV / GAS NATURAL → energySource AUSENTE (no es tipo de plataforma, ADR-017)', () => {
      // GNV es combustible REAL común en Lima (conversión a gas) pero NO es tipo de plataforma: el combustible
      // real es el margen privado del dueño del auto, la plataforma no lo trackea. Se omite, IGUAL que el GLP.
      expect(parsePropertyCard(['Combustible: GNV']).energySource).toBeUndefined();
      expect(parsePropertyCard(['Combustible: GAS NATURAL']).energySource).toBeUndefined();
    });

    it('Combustible: ELECTRICO / ELÉCTRICO / ELECTRICA → ELECTRIC', () => {
      expect(parsePropertyCard(['Combustible: ELECTRICO']).energySource).toBe('ELECTRIC');
      expect(parsePropertyCard(['Combustible: ELÉCTRICO']).energySource).toBe('ELECTRIC');
      expect(parsePropertyCard(['Combustible: ELECTRICA']).energySource).toBe('ELECTRIC');
    });

    it('Combustible: GLP / GAS LICUADO DE PETROLEO → energySource AUSENTE (fuera del enum, no DIESEL)', () => {
      // GLP es común en taxis de Lima pero NO está en los 4 tipos de ADR-017 §1.1: degradación honesta. OJO:
      // "GAS LICUADO DE PETROLEO" contiene "PETROLEO" → NO debe caer como DIESEL (cortocircuito explícito).
      expect(parsePropertyCard(['Combustible: GLP']).energySource).toBeUndefined();
      expect(parsePropertyCard(['Combustible: GAS LICUADO DE PETROLEO']).energySource).toBeUndefined();
    });

    it('combustible DISPERSO: etiqueta "Combustible" sola + valor en la línea siguiente', () => {
      expect(parsePropertyCard(['Combustible', 'GASOLINA']).energySource).toBe('GASOLINE_90');
      expect(parsePropertyCard(['Combustible', 'DIESEL']).energySource).toBe('DIESEL');
    });

    it('TIVe SIN combustible → energySource ausente (no inventa)', () => {
      expect(parsePropertyCard(['Placa: ABC-123', 'Marca: TOYOTA']).energySource).toBeUndefined();
    });

    it('TIVe completa con Combustible: el campo fluye junto al resto (no rompe los demás)', () => {
      const lines = [
        'SUNARP - TARJETA DE IDENTIFICACIÓN VEHICULAR',
        'Placa N°: ABC123',
        'Categoría: M1',
        'Marca: TOYOTA',
        'Modelo: YARIS',
        'Año de Fab.: 2019',
        'Color: PLATA',
        'Combustible: GASOLINA',
      ];
      expect(parsePropertyCard(lines)).toEqual({
        plate: 'ABC-123',
        make: 'TOYOTA',
        model: 'YARIS',
        year: 2019,
        mtcCategory: 'M1',
        color: 'PLATA',
        energySource: 'GASOLINE_90',
      });
    });
  });
});

describe('mapMtcCategoryToVehicleType · MTC → VehicleType tipado (degradación honesta)', () => {
  it('M1 → CAR; L* → MOTO', () => {
    expect(mapMtcCategoryToVehicleType('M1')).toBe('CAR');
    expect(mapMtcCategoryToVehicleType('L3')).toBe('MOTO');
    expect(mapMtcCategoryToVehicleType('L5')).toBe('MOTO');
    expect(mapMtcCategoryToVehicleType(' m1 ')).toBe('CAR');
  });

  it('N1 (furgón), M2/M3 (buses), especiales M1SC → null (no soportado, cae a manual)', () => {
    expect(mapMtcCategoryToVehicleType('N1')).toBeNull();
    expect(mapMtcCategoryToVehicleType('M2')).toBeNull();
    expect(mapMtcCategoryToVehicleType('M3')).toBeNull();
    expect(mapMtcCategoryToVehicleType('M1SC')).toBeNull();
  });

  it('código que no calza [LMNO]\\d[A-Z]* → null (no inventa)', () => {
    expect(mapMtcCategoryToVehicleType('')).toBeNull();
    expect(mapMtcCategoryToVehicleType('XYZ')).toBeNull();
    expect(mapMtcCategoryToVehicleType('A-IIb')).toBeNull();
  });
});

describe('parseDocument · dispatcher tipado por FleetDocumentType', () => {
  it('LICENSE_A1 → parser de licencia (kind=license)', () => {
    const result = parseDocument(FleetDocumentType.LICENSE_A1, [
      'N° Licencia Q12345678',
      'Categoría A-IIb',
      'Vencimiento 15/06/2028',
    ]);
    expect(result).toEqual({
      kind: 'license',
      number: 'Q12345678',
      category: 'A-IIb',
      expiresAt: '2028-06-15',
    });
  });

  it('SOAT → parser de SOAT (kind=soat)', () => {
    const result = parseDocument(FleetDocumentType.SOAT, [
      'N° Póliza - Certificado: 2012044701 - 1',
      'Hasta 31/12/2027',
    ]);
    expect(result).toEqual({ kind: 'soat', policyNumber: '2012044701 - 1', expiresAt: '2027-12-31' });
  });

  it('PROPERTY_CARD → parser de tarjeta (kind=propertyCard)', () => {
    const result = parseDocument(FleetDocumentType.PROPERTY_CARD, ['Placa ABC-123']);
    expect(result).toEqual({ kind: 'propertyCard', plate: 'ABC-123' });
  });

  it('documento ilegible → solo el kind (degradación honesta, sin campos)', () => {
    expect(parseDocument(FleetDocumentType.SOAT, ['basura'])).toEqual({ kind: 'soat' });
  });

  it('isParsableDocumentType: VEHICLE_PHOTO no es parseable; los demás sí', () => {
    expect(isParsableDocumentType(FleetDocumentType.VEHICLE_PHOTO)).toBe(false);
    expect(isParsableDocumentType(FleetDocumentType.LICENSE_A1)).toBe(true);
    expect(isParsableDocumentType(FleetDocumentType.SOAT)).toBe(true);
    expect(isParsableDocumentType(FleetDocumentType.PROPERTY_CARD)).toBe(true);
  });
});
