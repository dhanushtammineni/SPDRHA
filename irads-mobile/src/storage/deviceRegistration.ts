
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const CREDENTIAL_STORAGE_KEY =
  'irads_installation_credential_v1';

export async function getOrCreateDeviceCredential(): Promise<string> {
  const saved = await SecureStore.getItemAsync(
    CREDENTIAL_STORAGE_KEY
  );

  if (saved) {
    return saved;
  }

  const bytes = Crypto.getRandomBytes(32);

  const credential = Array.from(
    bytes,
    (value) => value.toString(16).padStart(2, '0')
  ).join('');

  await SecureStore.setItemAsync(
    CREDENTIAL_STORAGE_KEY,
    credential
  );

  return credential;
}
