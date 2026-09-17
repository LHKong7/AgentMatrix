import { safeStorage } from 'electron'
import type { SecretCipher } from './vault'

export const electronCipher: SecretCipher = {
  async available() {
    const available = await safeStorage.isAsyncEncryptionAvailable()
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend()
      if (backend === 'basic_text' || backend === 'unknown') return false
    }
    return available
  },
  encrypt: (value) => safeStorage.encryptStringAsync(value),
  async decrypt(value) {
    const result = await safeStorage.decryptStringAsync(value)
    return { value: result.result, reencrypt: result.shouldReEncrypt }
  },
}
