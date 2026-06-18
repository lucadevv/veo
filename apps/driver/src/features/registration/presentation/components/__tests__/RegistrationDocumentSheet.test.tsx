import React, { type ReactElement } from 'react';
import { TextInput } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import TestRenderer, { act } from 'react-test-renderer';
import { ThemeProvider, driverTheme } from '@veo/ui-kit';
import { FleetDocumentType } from '@veo/shared-types';
import i18n from '../../../../../i18n';
import {
  RegistrationDocumentSheet,
  type RegistrationDocumentInput,
} from '../RegistrationDocumentSheet';
import type { PickedImage } from '../../../../documents/domain';
import type { RegistrationDocumentFormType } from '../registrationDocumentForm';

/**
 * El sheet de captura de documentos del alta es CONTEXTUAL por tipo:
 *  - LICENSE_A1 / SOAT: muestran y EXIGEN el campo de vencimiento, y el número usa su etiqueta propia.
 *  - PROPERTY_CARD: NO muestra vencimiento (la tarjeta de propiedad no vence en Perú) y se envía SIN
 *    `expiresAt` (el contrato `addDocumentRequest.expiresAt` es opcional — sin cambio de backend).
 */

const SAFE_AREA_METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function withProviders(node: ReactElement): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <ThemeProvider theme={driverTheme}>{node}</ThemeProvider>
    </SafeAreaProvider>
  );
}

/** Archivo capturado de mentira: el flujo lo trata como opaco (la foto es la fuente de verdad). */
const FILE: PickedImage = {
  uri: 'file:///tmp/doc.jpg',
  mimeType: 'image/jpeg',
  fileName: 'doc.jpg',
  width: 1080,
  height: 1920,
  fileSize: 1024,
};

interface Harness {
  renderer: TestRenderer.ReactTestRenderer;
  onSubmit: jest.Mock<void, [RegistrationDocumentInput]>;
}

function renderSheet(documentType: RegistrationDocumentFormType): Harness {
  const onSubmit = jest.fn<void, [RegistrationDocumentInput]>();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      withProviders(
        <RegistrationDocumentSheet
          visible
          documentLabel="Documento"
          documentType={documentType}
          uploadState="idle"
          onClose={jest.fn()}
          // Devuelve siempre un archivo: simula que el conductor ya capturó la foto.
          onPick={async () => FILE}
          onSubmit={onSubmit}
        />,
      ),
    );
  });
  return { renderer, onSubmit };
}

/** Texto exacto resuelto por i18n (la app corre es-PE). */
function tr(key: string): string {
  return i18n.t(key);
}

/** ¿Existe un nodo con este accessibilityLabel? (el DateField expone su label así). */
function hasAccessibilityLabel(renderer: TestRenderer.ReactTestRenderer, label: string): boolean {
  return (
    renderer.root.findAll((node) => node.props.accessibilityLabel === label).length > 0
  );
}

/** Encuentra todos los TextInput montados (el campo de número es el único). */
function findInputs(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAllByType(TextInput);
}

/** Invoca el onPress del botón con este accessibilityLabel (el último si hay varios). */
function pressByLabel(renderer: TestRenderer.ReactTestRenderer, label: string): void {
  const buttons = renderer.root.findAll(
    (node) =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  const target = buttons[buttons.length - 1];
  if (!target) throw new Error(`No se encontró un botón con accessibilityLabel="${label}"`);
  act(() => {
    target.props.onPress();
  });
}

/** Captura una foto (habilita el envío) y dispara el CTA "Guardar". */
async function captureAndSubmit(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  // Pulsa "Tomar foto" → onPick resuelve el archivo (await microtasks).
  await act(async () => {
    pressByLabel(renderer, tr('registration.documents.takePhoto'));
  });
  pressByLabel(renderer, tr('registration.documents.save'));
}

describe('RegistrationDocumentSheet · formulario contextual por tipo de documento', () => {
  it('LICENSE_A1: usa la etiqueta de número de la licencia y MUESTRA el campo de vencimiento', () => {
    const { renderer } = renderSheet(FleetDocumentType.LICENSE_A1);
    const numberLabel = tr('registration.documents.number.LICENSE_A1.label');
    const expiryLabel = tr('registration.documents.expiryLabel');

    // El campo de número expone su etiqueta propia (el TextField pasa el label como accessibilityLabel/placeholder).
    const numberPlaceholder = tr('registration.documents.number.LICENSE_A1.placeholder');
    const input = findInputs(renderer)[0];
    expect(input?.props.placeholder).toBe(numberPlaceholder);
    expect(numberLabel).toBe('N° de licencia');

    // El DateField de vencimiento está presente (la licencia vence).
    expect(hasAccessibilityLabel(renderer, expiryLabel)).toBe(true);
  });

  it('SOAT: usa la etiqueta de número del SOAT y MUESTRA el campo de vencimiento', () => {
    const { renderer } = renderSheet(FleetDocumentType.SOAT);
    const numberPlaceholder = tr('registration.documents.number.SOAT.placeholder');
    const expiryLabel = tr('registration.documents.expiryLabel');

    expect(tr('registration.documents.number.SOAT.label')).toBe('N° de póliza (SOAT)');
    expect(findInputs(renderer)[0]?.props.placeholder).toBe(numberPlaceholder);
    expect(hasAccessibilityLabel(renderer, expiryLabel)).toBe(true);
  });

  it('PROPERTY_CARD: usa su etiqueta de número y NO muestra el campo de vencimiento', () => {
    const { renderer } = renderSheet(FleetDocumentType.PROPERTY_CARD);
    const expiryLabel = tr('registration.documents.expiryLabel');

    expect(tr('registration.documents.number.PROPERTY_CARD.label')).toBe(
      'N° de tarjeta de propiedad',
    );
    // La tarjeta de propiedad no vence: el DateField NO se monta.
    expect(hasAccessibilityLabel(renderer, expiryLabel)).toBe(false);
  });

  it('PROPERTY_CARD: envía el documento SIN expiresAtIso (expiresAt opcional en el contrato)', async () => {
    const { renderer, onSubmit } = renderSheet(FleetDocumentType.PROPERTY_CARD);

    // Llena el número (PROPERTY_CARD no exige vencimiento, así que con número + foto basta).
    const input = findInputs(renderer)[0];
    act(() => {
      input?.props.onChangeText('TP-12345');
    });

    await captureAndSubmit(renderer);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]?.[0];
    expect(payload?.documentNumber).toBe('TP-12345');
    // El sheet NO incluye `expiresAtIso` para un documento que no vence.
    expect(payload && 'expiresAtIso' in payload).toBe(false);
    expect(payload?.file).toBe(FILE);
  });

  it('LICENSE_A1: NO envía mientras falte el vencimiento (requerido para documentos que vencen)', async () => {
    const { renderer, onSubmit } = renderSheet(FleetDocumentType.LICENSE_A1);

    const input = findInputs(renderer)[0];
    act(() => {
      input?.props.onChangeText('Q-99887766');
    });

    // Captura foto + intenta enviar SIN fecha de vencimiento → el sheet bloquea el envío.
    await captureAndSubmit(renderer);

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
