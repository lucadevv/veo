import {useNavigation} from '@react-navigation/native';
import {
  Banner,
  Button,
  Card,
  hexAlpha,
  ListItem,
  SafeScreen,
  Switch,
  Text,
  useTheme,
} from '@veo/ui-kit';
import {CHILD_MODE_FEE_CENTS} from '@veo/shared-types';
import React, {useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, TextInput, View} from 'react-native';
import {formatPEN} from '../../../../shared/utils/format';
import {ScreenHeader} from '../../../../shared/presentation/components/ScreenHeader';
import {IconCheck} from '../../../auth/presentation/components/icons';
import {isValidChildCode} from '../../domain/entities';
import {useChildModeStore} from '../stores/childModeStore';

/** Rango real del código (espeja `CHILD_CODE_PATTERN` del dominio: 4-6 dígitos). */
const MIN_CODE = 4;
const MAX_CODE = 6;

/**
 * Configura el Modo Niño que viaja en `POST /trips` (`childMode`/`childCode`), conformado al pen
 * RSNDK: toggle con hint de protección, código en CELDAS PIN segmentadas (el pen dibuja 4; el
 * contrato acepta 4-6 → celdas dinámicas sobre un TextInput oculto accesible) y checklist de
 * reglas VERIFICADAS contra trip-service (BR-T07). El código (4-6 dígitos) se guarda solo en
 * memoria (nunca en disco ni visible al conductor: el bff valida un hash). Al guardar, el estado
 * queda disponible para la próxima solicitud de viaje en Home.
 */
export function ChildModeScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation();
  const store = useChildModeStore();

  const [enabled, setEnabled] = useState(store.enabled);
  const [code, setCode] = useState(store.code);
  const [touched, setTouched] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const codeValid = isValidChildCode(code);
  const canSave = !enabled || codeValid;
  const showError = touched && enabled && !codeValid;

  // Celdas dinámicas: arranca en 4 (como dibuja el pen) y crece hasta 6 a medida que se escribe,
  // dejando SIEMPRE una celda vacía visible mientras quepan más dígitos (comunica el rango 4-6).
  const cellCount = Math.min(MAX_CODE, Math.max(MIN_CODE, code.length + 1));

  const save = () => {
    if (enabled && !codeValid) {
      setTouched(true);
      return;
    }
    store.setEnabled(enabled);
    store.setCode(enabled ? code : '');
    navigation.goBack();
  };

  /**
   * Reglas del pen RSNDK verificadas contra el backend real (trip-service):
   *  1. `DESTINATION_EDITABLE` excluye IN_PROGRESS → el destino no se reescribe durante el viaje.
   *  2. Solo se persiste `childCodeHash` (bcrypt); el conductor solo ve el boolean `childMode`.
   *  3. BR-T07: el código se exige al INICIAR el viaje (recojo) — el pen decía "para cambiar el
   *     destino", ajustado a la verdad del contrato.
   */
  const rules = [
    t('childMode.rule1'),
    t('childMode.rule2'),
    t('childMode.rule3'),
  ];

  return (
    <SafeScreen
      footer={
        <Button
          label={t('childMode.save')}
          fullWidth
          disabled={!canSave}
          onPress={save}
        />
      }>
      {/* Header in-body (patrón ScreenHeader del pen): el subtítulo propio se pliega al header. */}
      <View style={{marginBottom: theme.spacing.lg}}>
        <ScreenHeader
          title={t('screens.childMode')}
          subtitle={t('childMode.subtitle')}
        />
      </View>

      {/* Toggle con hint de estado (pen): label + "Protección activada para este viaje" cuando ON. */}
      <Card variant="outlined" padding="md">
        <ListItem
          style={styles.toggleRow}
          title={t('childMode.enable')}
          subtitle={enabled ? t('childMode.hintActive') : undefined}
          trailing={
            <Switch
              value={enabled}
              onValueChange={setEnabled}
              accessibilityLabel={t('childMode.enable')}
            />
          }
        />
      </Card>

      {enabled ? (
        <View style={{marginTop: theme.spacing.lg, gap: theme.spacing.sm}}>
          <Text variant="subhead" color="inkMuted">
            {t('childMode.codeLabel')}
          </Text>
          {/* Celdas PIN sobre un TextInput OCULTO (absoluto, opacity 0): el input real recibe el
              foco/teclado y la accesibilidad; las celdas solo pintan. Los dígitos se muestran como
              puntos (pen) — el código nunca se expone en claro en pantalla. */}
          <View style={styles.cellsWrap}>
            <View style={[styles.cellsRow, {gap: theme.spacing.sm}]}>
              {Array.from({length: cellCount}, (_, i) => {
                const filled = i < code.length;
                const active =
                  focused && i === Math.min(code.length, cellCount - 1);
                return (
                  <View
                    key={i}
                    style={[
                      styles.cell,
                      {
                        backgroundColor: theme.colors.surfaceElevated,
                        borderRadius: theme.radii.md,
                        borderColor: showError
                          ? theme.colors.danger
                          : active
                            ? theme.colors.accent
                            : theme.colors.borderStrong,
                      },
                    ]}>
                    {filled ? (
                      <Text variant="title2" tabular>
                        •
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
            <TextInput
              ref={inputRef}
              style={styles.hiddenInput}
              value={code}
              onChangeText={value =>
                setCode(value.replace(/\D/g, '').slice(0, MAX_CODE))
              }
              keyboardType="number-pad"
              maxLength={MAX_CODE}
              caretHidden
              autoComplete="off"
              accessibilityLabel={t('childMode.codeLabel')}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />
          </View>
          <Text
            variant="footnote"
            color={showError ? 'danger' : 'inkMuted'}
            accessibilityLiveRegion={showError ? 'polite' : 'none'}>
            {showError ? t('childMode.invalidCode') : t('childMode.codeHelper')}
          </Text>
        </View>
      ) : null}

      {/* Checklist de reglas (pen): solo afirmaciones que el backend sustenta (ver docstring). */}
      <View style={{marginTop: theme.spacing.xl, gap: theme.spacing.md}}>
        {rules.map(rule => (
          <View key={rule} style={[styles.ruleRow, {gap: theme.spacing.md}]}>
            <View
              style={[
                styles.ruleIconWrap,
                {
                  backgroundColor: hexAlpha(theme.colors.success, 0.14),
                  borderRadius: theme.radii.pill,
                },
              ]}>
              <IconCheck color={theme.colors.success} size={16} />
            </View>
            <Text variant="callout" color="inkMuted" style={styles.ruleText}>
              {rule}
            </Text>
          </View>
        ))}
      </View>

      {/* Transparencia del recargo (BR-T07): se avisa al activar, no recién al confirmar. El monto sale
          de la constante compartida (@veo/shared-types), misma fuente que el server, formateada en PEN. */}
      {/* DEUDA: (backend) el recargo de modo niño (CHILD_MODE_FEE_CENTS) se muestra como monto real desde una constante compartida @veo/shared-types. Idealmente server-driven (p.ej. en GET /maps/catalog o GET /pricing/child-mode) para cambiar la tarifa sin release, consistente con el resto de fees dinámicos del app. */}
      {enabled ? (
        <Banner
          tone="info"
          title={t('childMode.feeNotice', {
            amount: formatPEN(CHILD_MODE_FEE_CENTS),
          })}
          style={{marginTop: theme.spacing.xl}}
        />
      ) : null}
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  // Neutraliza el padding/minHeight propios del ListItem: la fila vive dentro de un Card padding="md"
  // (el inset lo pone la card) y su alto es natural, como el toggleRow original.
  toggleRow: {paddingVertical: 0, paddingHorizontal: 0, minHeight: 0, gap: 12},
  cellsWrap: {position: 'relative'},
  cellsRow: {flexDirection: 'row'},
  cell: {
    flex: 1,
    height: 64,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // El input REAL: cubre las celdas (tap = foco directo) pero invisible; las celdas son el espejo.
  hiddenInput: {...StyleSheet.absoluteFill, opacity: 0},
  ruleRow: {flexDirection: 'row', alignItems: 'center'},
  ruleIconWrap: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ruleText: {flex: 1},
});
