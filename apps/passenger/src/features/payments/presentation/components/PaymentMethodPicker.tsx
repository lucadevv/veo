import type {MobilePaymentMethod} from '@veo/api-client';
import {StatusPill, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, View} from 'react-native';
import {PaymentMethodLogo} from '../../../../shared/assets/payment-methods';

/**
 * Variante visual y SEMÁNTICA del picker:
 *  - `full`: SELECTOR de método (al pedir). Cada fila es un `radio` (estado seleccionado visible),
 *    admite la pill "Tu predeterminado", el badge "Automático" del Yape vinculado y el toggle
 *    "Recordar como predeterminado". Elegir una fila NO cierra nada: solo notifica `onSelect`.
 *  - `compact`: COMPLETAR un cobro ya iniciado (cambiar método de un pago pendiente). Cada fila es un
 *    `button` de ACCIÓN (dispara el cambio y re-arma el checkout): sin radio, sin default-pill, sin
 *    remember. El método ACTUAL se atenúa y se deshabilita (no tiene sentido "cambiar" al mismo).
 */
export type PaymentMethodPickerVariant = 'full' | 'compact';

export interface PaymentMethodPickerProps {
  /**
   * SUBSET de métodos a mostrar, en orden de presentación. La fuente CANÓNICA es `PAYMENT_METHODS`
   * (store): el caller pasa la lista completa (perfil/al-pedir) o el subset digital
   * (`DIGITAL_PAYMENT_METHODS`, derivado de la misma fuente) para "cambiar método".
   */
  methods: readonly MobilePaymentMethod[];
  /**
   * Modo del picker. `full` (default) → filas `radio` seleccionables (selector al pedir). `compact` →
   * filas `button` de acción-cambio (completar un cobro en curso): sin radio, sin default-pill, sin
   * remember. La SEMÁNTICA de accesibilidad y el layout derivan de acá, no se infieren por fila.
   */
  variant?: PaymentMethodPickerVariant;
  /** Método marcado como elegido (radio activo en `full`). En `compact` se ignora (no hay selección). */
  selected?: MobilePaymentMethod;
  /**
   * Notifica la elección. `remember` solo viaja con sentido en `full` + `rememberToggle`: es el toggle
   * "Recordar como predeterminado". En `compact` siempre llega `false` (no aplica recordar un cobro
   * que ya está en curso).
   */
  onSelect: (method: MobilePaymentMethod, remember: boolean) => void;
  /**
   * Método PREDETERMINADO del perfil. Si se pasa (solo `full`), su fila lleva la pill "Tu
   * predeterminado" para que SIEMPRE se vea cuál es "con qué pagas siempre", independiente de lo
   * elegido para este viaje. En `compact` NO se pasa: completar un cobro no arrastra el default.
   */
  defaultMethod?: MobilePaymentMethod;
  /**
   * ¿La afiliación Yape (On-File) está ACTIVA? Distingue LÉXICAMENTE la fila YAPE: activa → "Yape ·
   * automático" + badge "Automático" (se cobra solo); inactiva → "Yape" a secas (QR/deepLink al final).
   * Nunca "automático" en el one-shot.
   */
  yapeAutoActive?: boolean;
  /**
   * Muestra el toggle "Recordar como mi método predeterminado" (solo tiene sentido en `full`). Se
   * reinicia a apagado cada vez que el picker se monta/abre: una decisión por apertura, jamás arrastra
   * el estado anterior (sería un cambio silencioso de la preferencia).
   */
  rememberToggle?: boolean;
  /**
   * Método ACTUAL de un cobro en curso (solo `compact`): su fila se atenúa y se deshabilita (no se
   * "cambia" al mismo método). Es el método con el que el cobro ya está iniciado.
   */
  currentMethod?: MobilePaymentMethod;
  /**
   * Método SUGERIDO a DESTACAR (variante `compact`): su fila lleva un anillo de acento + la pill
   * "Sugerido" para GUIAR la elección (p. ej. al RESOLVER un pago, destacamos el predeterminado del
   * perfil). NO es una selección radio (las filas siguen siendo de acción): solo orienta visualmente.
   * En `full` se ignora (ahí la guía es el radio `selected` + la pill "Tu predeterminado").
   */
  highlightedMethod?: MobilePaymentMethod;
  /** Deshabilita TODAS las filas (p. ej. mientras el server arma el checkout del método elegido). */
  disabled?: boolean;
}

/**
 * PaymentMethodPicker · COMPONENTE CANÓNICO de lista de métodos de pago (única fuente visual de filas
 * seleccionables). Reúne las 3 superficies que antes tenían su propia lista: el selector al pedir
 * (`PaymentMethodSheet`), el "cambiar método" del pago pendiente (`DebtSheet`) y comparte el átomo
 * visual (logo circular canónico `PaymentMethodLogo` + nombre + hint es-PE) con la fila-instrumento
 * del perfil (`PaymentInstrumentRow`).
 *
 * UNA sola fuente de métodos: el caller siempre pasa un subset de `PAYMENT_METHODS` (store). Los labels
 * salen SIEMPRE de i18n (`payments.method.*` / `payments.hint.*`), nunca hardcodeados acá.
 *
 * El picker NO conoce las reglas de negocio (qué método aplica, qué pasa al elegir): solo refleja y
 * dispara. Eso vive en el caller (sheet de pedido, sheet de deuda).
 */
export function PaymentMethodPicker({
  methods,
  variant = 'full',
  selected,
  onSelect,
  defaultMethod,
  yapeAutoActive = false,
  rememberToggle = false,
  currentMethod,
  highlightedMethod,
  disabled = false,
}: PaymentMethodPickerProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  // Toggle "recordar como predeterminado". Se reinicia al montar (una decisión por apertura): el caller
  // remonta/oculta el picker al cerrar el sheet, así que el estado nunca se arrastra entre aperturas.
  const [remember, setRemember] = React.useState(false);

  return (
    <View style={{gap: theme.spacing.sm}}>
      {methods.map(method => (
        <PaymentMethodPickerRow
          key={method}
          method={method}
          variant={variant}
          selected={variant === 'full' && selected === method}
          isDefault={variant === 'full' && defaultMethod === method}
          yapeAutoActive={yapeAutoActive}
          isCurrent={currentMethod === method}
          // "Sugerido" SOLO en `compact` y SOLO si no es el método actual (no se sugiere el ya iniciado).
          isSuggested={
            variant === 'compact' &&
            highlightedMethod === method &&
            currentMethod !== method
          }
          disabled={disabled}
          onPress={() => onSelect(method, rememberToggle ? remember : false)}
        />
      ))}

      {rememberToggle ? (
        <RememberToggle
          checked={remember}
          onToggle={() => setRemember(v => !v)}
          label={t('payments.rememberDefault')}
        />
      ) : null}
    </View>
  );
}

interface PaymentMethodPickerRowProps {
  method: MobilePaymentMethod;
  /** Modo del picker: `full` → fila `radio`; `compact` → fila `button` de acción-cambio. */
  variant: PaymentMethodPickerVariant;
  /** Fila elegida (radio activo). Solo aplica cuando el caller pasó `selected` (variante `full`). */
  selected: boolean;
  /** Es el método predeterminado del perfil → pill "Tu predeterminado" (solo si el caller lo marcó). */
  isDefault: boolean;
  /** Afiliación Yape activa → nombre/hint "automático" + badge en la fila YAPE. */
  yapeAutoActive: boolean;
  /** Es el método ACTUAL de un cobro en curso (variante `compact`) → fila atenuada + deshabilitada. */
  isCurrent: boolean;
  /** Es el método SUGERIDO (variante `compact`) → anillo de acento + pill "Sugerido". Guía, no radio. */
  isSuggested: boolean;
  /** Deshabilitación global (server en vuelo). */
  disabled: boolean;
  onPress: () => void;
}

/**
 * UNA fila del picker. La SEMÁNTICA se deriva de las props, no de un flag de variante:
 *  - si la fila es `isCurrent` (cobro en curso) → es de ACCIÓN-cambio (`button`), atenuada y deshabilitada;
 *  - si el caller pasó `selected`/`isDefault` (al pedir) → es `radio` con radio-dot + pill de default;
 *  - el badge "Automático" y el nombre léxico del Yape vinculado aplican a ambas.
 */
function PaymentMethodPickerRow({
  method,
  variant,
  selected,
  isDefault,
  yapeAutoActive,
  isCurrent,
  isSuggested,
  disabled,
  onPress,
}: PaymentMethodPickerRowProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  // Borde/anillo de acento: en `full` lo enciende el radio elegido (`selected`); en `compact` lo
  // enciende el SUGERIDO (`isSuggested`). Unifica el realce visual sin mezclar las dos semánticas.
  const accented = selected || isSuggested;
  const isYapeAuto = method === 'YAPE' && yapeAutoActive;
  // Nombre distinguido LÉXICAMENTE: Yape vinculado ("Yape · automático") vs one-shot ("Yape" a secas).
  const name = isYapeAuto
    ? t('payments.nameYapeAuto')
    : t(`payments.method.${method}`);
  // Subtítulo: Yape vinculado describe el cobro automático; el resto su hint canónico es-PE.
  const hint = isYapeAuto
    ? t('payments.hintYapeAuto')
    : t(`payments.hint.${method}`);

  // SEMÁNTICA por variante: `compact` (completar un cobro) → fila de ACCIÓN (`button`), sin radio;
  // `full` (selector al pedir) → `radio` con estado seleccionado. Es explícito, no inferido por fila.
  const action = variant === 'compact';
  const rowDisabled = disabled || isCurrent;

  return (
    <Pressable
      // `radio` cuando es un SELECTOR (al pedir); `button` cuando es una ACCIÓN de cambio (pago en curso).
      accessibilityRole={action ? 'button' : 'radio'}
      accessibilityState={action ? {disabled: rowDisabled} : {selected}}
      accessibilityLabel={t(`payments.method.${method}`)}
      disabled={rowDisabled}
      onPress={onPress}
      style={({pressed}) => [
        styles.row,
        {
          minHeight: 56,
          gap: theme.spacing.md,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.sm,
          borderRadius: theme.radii.md,
          borderWidth: accented ? 2 : 1,
          borderColor: accented ? theme.colors.accent : theme.colors.border,
          backgroundColor: accented
            ? theme.colors.surfaceElevated
            : theme.colors.surface,
          opacity: isCurrent ? 0.4 : rowDisabled ? 0.45 : pressed ? 0.7 : 1,
        },
      ]}>
      {/* Logo circular CANÓNICO; cuando la fila está elegida/sugerida, un anillo de acento lo rodea. */}
      <View
        style={[
          styles.leadRing,
          {borderColor: accented ? theme.colors.accent : 'transparent'},
        ]}>
        <PaymentMethodLogo method={method} size={36} />
      </View>

      <View style={styles.body}>
        <View style={[styles.nameRow, {gap: theme.spacing.xs}]}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {name}
          </Text>
          {/* Pill del PREDETERMINADO: siempre visible cuál es "con qué pagas siempre" (solo `full`). */}
          {isDefault ? (
            <StatusPill label={t('payments.defaultHere')} tone="neutral" />
          ) : null}
          {/* Pill del SUGERIDO (variante `compact` · resolver): orienta hacia el método recomendado. */}
          {isSuggested ? (
            <StatusPill label={t('payments.suggested')} tone="success" />
          ) : null}
          {/* Badge del Yape VINCULADO (On-File): refleja el cobro automático. NUNCA en el one-shot. */}
          {isYapeAuto ? (
            <StatusPill label={t('payments.autoBadge')} tone="success" dot />
          ) : null}
        </View>
        <Text variant="footnote" color="inkMuted" numberOfLines={1}>
          {hint}
        </Text>
      </View>

      {/* Radio-dot a la derecha SOLO en el selector (`full`); en la fila de acción no hay radio. */}
      {action ? null : (
        <View
          style={[
            styles.radioOuter,
            {
              borderColor: selected
                ? theme.colors.accent
                : theme.colors.borderStrong,
            },
          ]}>
          {selected ? (
            <View
              style={[
                styles.radioInner,
                {backgroundColor: theme.colors.accent},
              ]}
            />
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

interface RememberToggleProps {
  checked: boolean;
  onToggle: () => void;
  label: string;
}

/** Toggle "recordar como predeterminado": checkbox dibujado sin dependencia de iconos. Hit-target ≥44pt. */
function RememberToggle({
  checked,
  onToggle,
  label,
}: RememberToggleProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{checked}}
      accessibilityLabel={label}
      onPress={onToggle}
      style={({pressed}) => [
        styles.rememberRow,
        {gap: theme.spacing.sm, opacity: pressed ? 0.7 : 1},
      ]}>
      <View
        style={[
          styles.checkbox,
          {
            borderColor: checked
              ? theme.colors.accent
              : theme.colors.borderStrong,
            backgroundColor: checked ? theme.colors.accent : 'transparent',
          },
        ]}>
        {checked ? (
          <View
            style={[styles.checkMark, {borderColor: theme.colors.surface}]}
          />
        ) : null}
      </View>
      <Text variant="footnote" color="inkMuted" style={styles.rememberLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center'},
  // Anillo de 2px alrededor del logo circular (acento cuando la fila está elegida, transparente si no).
  leadRing: {
    borderRadius: 22,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {flex: 1, gap: 2},
  nameRow: {flexDirection: 'row', alignItems: 'center'},
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioInner: {width: 10, height: 10, borderRadius: 5},
  rememberRow: {flexDirection: 'row', alignItems: 'center', minHeight: 44},
  rememberLabel: {flex: 1},
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Tilde dibujado con dos bordes (sin dependencia de iconos): esquina inferior-izquierda rotada.
  checkMark: {
    width: 6,
    height: 11,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    transform: [{rotate: '45deg'}],
    marginTop: -2,
  },
});
