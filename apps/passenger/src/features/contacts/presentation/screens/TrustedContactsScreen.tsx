import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Banner,
  BottomSheet,
  Button,
  Card,
  ListItem,
  SafeScreen,
  StatusPill,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import {ContactValidationError} from '../../domain/usecases';
import {MAX_TRUSTED_CONTACTS, type TrustedContact} from '../../domain/entities';
import {ContactLeadCircle} from '../components/ContactLeadCircle';

/**
 * Contactos de confianza (BR-I06) contra el bff REAL `/contacts`. Lista, agrega (dispara OTP al
 * contacto), verifica el OTP, reenvía y elimina. Cubre estados carga/error/vacío con el kit.
 */
export function TrustedContactsScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const queryClient = useQueryClient();

  const listContacts = useDependency(TOKENS.listContactsUseCase);
  const addContact = useDependency(TOKENS.addContactUseCase);
  const verifyContact = useDependency(TOKENS.verifyContactUseCase);
  const resendOtp = useDependency(TOKENS.resendContactOtpUseCase);
  const removeContact = useDependency(TOKENS.removeContactUseCase);

  const listQuery = useQuery({
    queryKey: ['contacts'],
    queryFn: () => listContacts.execute(),
  });

  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<
    ContactValidationError['field'] | null
  >(null);

  const [verifyTarget, setVerifyTarget] = useState<TrustedContact | null>(null);
  const [code, setCode] = useState('');

  const [removeTarget, setRemoveTarget] = useState<TrustedContact | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({queryKey: ['contacts']});

  const addMutation = useMutation({
    mutationFn: () =>
      addContact.execute({
        name,
        phone,
        relationship,
        email: email || undefined,
      }),
    onSuccess: contact => {
      invalidate();
      setAddOpen(false);
      setName('');
      setPhone('');
      setRelationship('');
      setEmail('');
      setFieldError(null);
      // El bff envió OTP al contacto: abrimos la verificación.
      setVerifyTarget(contact);
    },
    onError: error => {
      if (error instanceof ContactValidationError) {
        setFieldError(error.field);
      }
    },
  });

  const verifyMutation = useMutation({
    mutationFn: () => verifyContact.execute(verifyTarget!.id, code),
    onSuccess: () => {
      invalidate();
      setVerifyTarget(null);
      setCode('');
    },
  });

  const resendMutation = useMutation({
    mutationFn: (id: string) => resendOtp.execute(id),
  });

  const removeMutation = useMutation({
    mutationFn: () => removeContact.execute(removeTarget!.id),
    onSuccess: () => {
      invalidate();
      setRemoveTarget(null);
    },
  });

  const contacts = listQuery.data ?? [];
  const atMax = contacts.length >= MAX_TRUSTED_CONTACTS;

  return (
    <SafeScreen
      footer={
        <Button
          label={t('contacts.add')}
          fullWidth
          disabled={atMax}
          onPress={() => {
            setFieldError(null);
            setAddOpen(true);
          }}
        />
      }>
      <Text
        variant="callout"
        color="inkMuted"
        style={{marginBottom: theme.spacing.lg}}>
        {t('contacts.subtitle')}
      </Text>

      {atMax ? (
        <Banner
          tone="info"
          title={t('contacts.maxReached')}
          style={{marginBottom: theme.spacing.md}}
        />
      ) : null}

      {listQuery.isLoading ? (
        <LoadingState />
      ) : listQuery.isError ? (
        <ErrorState onRetry={() => listQuery.refetch()} />
      ) : contacts.length === 0 ? (
        <EmptyState
          title={t('contacts.empty')}
          subtitle={t('contacts.emptySubtitle')}
        />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{gap: theme.spacing.sm}}>
          {contacts.map(contact => (
            <Card key={contact.id} variant="outlined" padding="md">
              <ListItem
                title={contact.name}
                subtitle={`${contact.phone} · ${contact.relationship}`}
                leading={<ContactLeadCircle />}
                trailing={
                  <StatusPill
                    label={
                      contact.verified
                        ? t('contacts.verified')
                        : t('contacts.pending')
                    }
                    tone={contact.verified ? 'success' : 'warn'}
                    dot
                  />
                }
              />
              <View
                style={{
                  flexDirection: 'row',
                  gap: theme.spacing.sm,
                  marginTop: theme.spacing.sm,
                }}>
                {!contact.verified ? (
                  <>
                    <Button
                      label={t('actions.verify')}
                      variant="secondary"
                      size="sm"
                      onPress={() => {
                        setVerifyTarget(contact);
                        setCode('');
                      }}
                    />
                    <Button
                      label={t('contacts.resend')}
                      variant="ghost"
                      size="sm"
                      loading={resendMutation.isPending}
                      onPress={() => resendMutation.mutate(contact.id)}
                    />
                  </>
                ) : null}
                <Button
                  label={t('actions.delete')}
                  variant="ghost"
                  size="sm"
                  onPress={() => setRemoveTarget(contact)}
                />
              </View>
            </Card>
          ))}
        </ScrollView>
      )}

      {/* Alta de contacto */}
      <BottomSheet
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        title={t('contacts.addTitle')}
        footer={
          <Button
            label={t('contacts.sendOtp')}
            fullWidth
            loading={addMutation.isPending}
            onPress={() => addMutation.mutate()}
          />
        }>
        <View style={{gap: theme.spacing.md}}>
          {addMutation.isError &&
          !(addMutation.error instanceof ContactValidationError) ? (
            <Banner tone="danger" title={t('contacts.addError')} />
          ) : null}
          <TextField
            label={t('contacts.nameLabel')}
            value={name}
            onChangeText={setName}
            error={
              fieldError === 'name' ? t('contacts.invalidName') : undefined
            }
          />
          <TextField
            label={t('contacts.phoneLabel')}
            keyboardType="phone-pad"
            value={phone}
            onChangeText={setPhone}
            error={
              fieldError === 'phone' ? t('contacts.invalidPhone') : undefined
            }
          />
          <TextField
            label={t('contacts.relationshipLabel')}
            helperText={t('contacts.relationshipHelper')}
            value={relationship}
            onChangeText={setRelationship}
            error={
              fieldError === 'relationship'
                ? t('contacts.invalidRelationship')
                : undefined
            }
          />
          <TextField
            label={t('contacts.emailLabel')}
            keyboardType="email-address"
            autoCapitalize="none"
            value={email}
            onChangeText={setEmail}
            error={
              fieldError === 'email' ? t('contacts.invalidEmail') : undefined
            }
          />
        </View>
      </BottomSheet>

      {/* Verificación de OTP del contacto */}
      <BottomSheet
        visible={verifyTarget !== null}
        onClose={() => setVerifyTarget(null)}
        title={t('contacts.verifyTitle')}
        footer={
          <Button
            label={t('contacts.verify')}
            fullWidth
            loading={verifyMutation.isPending}
            disabled={code.length !== 6}
            onPress={() => verifyMutation.mutate()}
          />
        }>
        <View style={{gap: theme.spacing.md}}>
          <Text variant="callout" color="inkMuted">
            {t('contacts.verifyBody', {phone: verifyTarget?.phone ?? ''})}
          </Text>
          {verifyMutation.isError ? (
            <Banner tone="danger" title={t('contacts.verifyError')} />
          ) : null}
          <TextField
            label={t('contacts.otpLabel')}
            keyboardType="number-pad"
            value={code}
            onChangeText={value =>
              setCode(value.replace(/\D/g, '').slice(0, 6))
            }
            maxLength={6}
          />
        </View>
      </BottomSheet>

      {/* Confirmación de eliminación */}
      <BottomSheet
        visible={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title={t('contacts.removeTitle')}
        footer={
          <View style={{gap: theme.spacing.sm}}>
            <Button
              label={t('contacts.remove')}
              variant="danger"
              fullWidth
              loading={removeMutation.isPending}
              onPress={() => removeMutation.mutate()}
            />
            <Button
              label={t('actions.cancel')}
              variant="ghost"
              fullWidth
              onPress={() => setRemoveTarget(null)}
            />
          </View>
        }>
        <Text variant="callout" color="inkMuted">
          {t('contacts.removeBody')}
        </Text>
      </BottomSheet>
    </SafeScreen>
  );
}
