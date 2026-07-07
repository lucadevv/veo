import React, { type ReactElement } from 'react';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { ApiError } from '@veo/api-client';
import '../../../../../i18n';
import { VehicleScreen } from '../VehicleScreen';
import { DocumentUploadCard, RegistrationDocumentSheet } from '../../components';
import type { RegistrationDocumentInput } from '../../components/RegistrationDocumentSheet';
import { useRegistrationStore } from '../../state/registrationStore';
import { REGISTRATION_DOCUMENTS_QUERY_KEY } from '../../hooks/useRegistrationDocuments';

/**
 * FIX A · La foto del vehículo (`VEHICLE_PHOTO`) que recibe un 409 del backend ("ya existe un documento
 * activo de ese tipo") se trata como ÉXITO, no como error: re-subir es idempotente para el conductor. El
 * `catch` de `onSubmitPhoto` detecta el 409 tipado (`isConflictError`, status 409) y, en vez de pintar un
 * error, marca el doc `VEHICLE_PHOTO` como `uploaded` (lo que habilita "Registrar vehículo" vía
 * `photoUploaded`) y cierra el sheet. MISMO patrón que `useVehicleContinue.uploadPendingCard` (tarjeta) y
 * el DNI. Sin este fix, el 409 dejaba al conductor bloqueado: no podía re-subir ni avanzar.
 *
 * Estrategia: mockeamos `useUploadAndRegisterDocument` para que su `mutateAsync` lance el 409 tipado, así
 * el test aísla EXACTAMENTE la rama nueva del catch (no re-testea el pipeline presign→PUT→registro). El
 * resto de hooks de datos (`useDriverVehicles`, `useRegistrationDocuments`) se mockean a estados vacíos
 * (alta nueva, sin docs en el servidor) para renderizar la pantalla aislada (mismo idioma que
 * `UnderReviewScreen.test`).
 */

const mockMutateAsync = jest.fn();

jest.mock('../../hooks/useRegistrationDocuments', () => {
  const actual = jest.requireActual('../../hooks/useRegistrationDocuments');
  return {
    ...actual,
    // Listado de docs del servidor: vacío (conductor nuevo, sin foto previa replicada).
    useRegistrationDocuments: () => ({ data: [] }),
    // Uploader: su `mutateAsync` lo controla cada test (lanza 409, o resuelve).
    useUploadAndRegisterDocument: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
  };
});

jest.mock('../../hooks/useRegistrationWizard', () => {
  const actual = jest.requireActual('../../hooks/useRegistrationWizard');
  return {
    ...actual,
    // Sin vehículo registrado previo (alta nueva): habilita el camino de captura de foto.
    useDriverVehicles: () => ({ data: [] }),
  };
});

// La unidad bajo test es la PANTALLA aislada, no el navigator. `VehicleScreen` usa
// `useRegistrationStepBack`, que llama `useNavigation()`/`useFocusEffect` de @react-navigation —
// fuera de un `NavigationContainer` ambos lanzan "Couldn't find a navigation object". Los stubeamos
// (mismo idioma que `UnderReviewScreen.test`): `useNavigation` devuelve un objeto mínimo y
// `useFocusEffect` corre el callback como un efecto normal.
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useNavigation: () => ({
      navigate: jest.fn(),
      goBack: jest.fn(),
      dispatch: jest.fn(),
      addListener: () => () => undefined,
      canGoBack: () => false,
      reset: jest.fn(),
      getState: () => ({ routes: [], index: 0 }),
    }),
    useFocusEffect: (effect: () => void | (() => void)) => {
      const ReactLib = require('react');
      ReactLib.useEffect(() => effect(), [effect]);
    },
  };
});

// Reveal consulta AccessibilityInfo al montar; en Jest el método nativo es undefined → estabilizar.
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
jest
  .spyOn(AccessibilityInfo, 'addEventListener')
  .mockReturnValue({ remove: () => undefined } as ReturnType<
    typeof AccessibilityInfo.addEventListener
  >);

const SAFE_AREA_METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** Imagen capturada de mentira (el flujo la trata como opaca). */
const PHOTO_FILE = {
  uri: 'file:///tmp/vehicle-photo.jpg',
  mimeType: 'image/jpeg',
  fileName: 'vehicle-photo.jpg',
  width: null,
  height: null,
  fileSize: null,
};

/** `navigation` mínima que la pantalla consume (`navigate` para avanzar a Documentos). */
function fakeNavigation() {
  return { navigate: jest.fn() } as never;
}

function withProviders(node: ReactElement, client: QueryClient): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </SafeAreaProvider>
  );
}

describe('VehicleScreen · FIX A · 409 de la foto del vehículo se trata como ÉXITO', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    mockMutateAsync.mockReset();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    act(() => {
      useRegistrationStore.getState().reset();
    });
  });

  afterEach(() => {
    queryClient.clear();
  });

  /**
   * Abre el sheet de la FOTO (toca SU tarjeta) y devuelve su `onSubmit` (= `onSubmitPhoto`). LOTE B: el paso
   * Vehículo ahora tiene DOS `DocumentUploadCard` (foto + SOAT), así que seleccionamos la de la foto por su
   * label ("Foto del vehículo") en vez de `findByType` (que tiraría con varias coincidencias).
   */
  function openPhotoSheetAndGetSubmit(
    renderer: TestRenderer.ReactTestRenderer,
  ): (input: RegistrationDocumentInput) => void {
    const card = renderer.root
      .findAllByType(DocumentUploadCard)
      .find((c) => c.props.label === 'Foto del vehículo');
    if (!card) {
      throw new Error('No se encontró la tarjeta de la foto del vehículo');
    }
    act(() => {
      (card.props.onPress as () => void)();
    });
    const sheet = renderer.root.findByType(RegistrationDocumentSheet);
    return sheet.props.onSubmit as (input: RegistrationDocumentInput) => void;
  }

  it('un 409 en la subida de la foto marca VEHICLE_PHOTO como `uploaded` (no error) Y reconcilia el servidor (invalida la query)', async () => {
    // El backend responde 409: ya existe una VEHICLE_PHOTO activa (re-subida de un intento previo).
    mockMutateAsync.mockRejectedValue(
      new ApiError(409, 'CONFLICT', 'Ya existe un documento activo de ese tipo para el dueño'),
    );
    // FIX 2 · La rama 409-éxito debe RECONCILIAR el estado de servidor: invalida la MISMA key que el
    // `onSuccess` del hook de upload, para que `serverDocs` no quede stale. Espiamos el queryClient real.
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <VehicleScreen navigation={fakeNavigation()} route={{} as never} />,
          queryClient,
        ),
      );
    });

    const onSubmit = openPhotoSheetAndGetSubmit(renderer);
    await act(async () => {
      await (onSubmit as unknown as (i: RegistrationDocumentInput) => Promise<void>)({
        file: PHOTO_FILE as never,
      });
    });

    // El 409 NO marca error: el doc queda `uploaded` (mismo efecto que el éxito normal).
    const photoDoc = useRegistrationStore
      .getState()
      .documents.find((d) => d.type === 'VEHICLE_PHOTO');
    expect(photoDoc?.status).toBe('uploaded');
    // Y se reconcilió el servidor: la query de documentos del alta se invalidó con su key canónica.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: REGISTRATION_DOCUMENTS_QUERY_KEY });

    act(() => {
      renderer.unmount();
    });
  });

  it('un error NO-409 (500) sí marca error y NO marca la foto como subida', async () => {
    mockMutateAsync.mockRejectedValue(new ApiError(500, 'INTERNAL', 'Algo salió mal'));

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <VehicleScreen navigation={fakeNavigation()} route={{} as never} />,
          queryClient,
        ),
      );
    });

    const onSubmit = openPhotoSheetAndGetSubmit(renderer);
    await act(async () => {
      await (onSubmit as unknown as (i: RegistrationDocumentInput) => Promise<void>)({
        file: PHOTO_FILE as never,
      });
    });

    // Un 5xx es un fallo real: el doc NO queda `uploaded` (se conserva el comportamiento de error).
    const photoDoc = useRegistrationStore
      .getState()
      .documents.find((d) => d.type === 'VEHICLE_PHOTO');
    expect(photoDoc?.status).not.toBe('uploaded');

    act(() => {
      renderer.unmount();
    });
  });
});
