import type { CredentialStore } from "./credential-store.js"
import { SeparateRequestAuthenticator, type StoredCredentials } from "./auth.js"

export class CredentialController {
  private updateTail = Promise.resolve()

  constructor(
    private readonly store: CredentialStore,
    private readonly authenticator: SeparateRequestAuthenticator,
    private credentials: StoredCredentials,
  ) {}

  update(input: { currentPassword: string; username: string; password: string }): Promise<void> {
    const operation = this.updateTail.then(async () => {
      validateManagerCredential(input.username, input.password)
      if (!this.authenticator.matchesManagerPassword(input.currentPassword)) {
        throw new CredentialUpdateError("CURRENT_PASSWORD_INVALID", "目前密碼不正確。", 401)
      }
      const next: StoredCredentials = {
        manager: { username: input.username, password: input.password },
        launcherToken: this.credentials.launcherToken,
      }
      // Persist first: a DPAPI/write failure must leave the currently accepted credentials untouched.
      await this.store.save(next)
      this.credentials = next
      this.authenticator.replace(next)
    })
    this.updateTail = operation.catch(() => undefined)
    return operation
  }
}

export class CredentialUpdateError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message)
  }
}

function validateManagerCredential(username: string, password: string): void {
  if (!username || /[:\u0000-\u001f\u007f]/.test(username)) {
    throw new CredentialUpdateError("USERNAME_INVALID", "帳號不可為空白、包含冒號或控制字元。", 400)
  }
  if (password.length < 16) {
    throw new CredentialUpdateError("PASSWORD_INVALID", "密碼至少需要 16 字元。", 400)
  }
}
