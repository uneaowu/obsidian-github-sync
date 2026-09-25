import { App } from "obsidian";

/** Matches manifest id — namespaces SecretStorage entries per vault. */
const SECRET_PREFIX = "github-vault-sync/github-token";

export function isSecretStorageAvailable(app: App): boolean {
  const storage = app.secretStorage;
  return !!storage?.getSecret && !!storage?.setSecret;
}

/** Per-vault random id stored in data.json (avoids mobile SecretStorage id collisions). */
export function ensureTokenSecretId(settings: { githubTokenSecretId: string }): string {
  if (settings.githubTokenSecretId) {
    return settings.githubTokenSecretId;
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  settings.githubTokenSecretId = Array.from(bytes, (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  return settings.githubTokenSecretId;
}

function storageKey(vaultSecretId: string): string {
  return `${SECRET_PREFIX}/${vaultSecretId}`;
}

export async function readGitHubToken(
  app: App,
  vaultSecretId: string
): Promise<string | null> {
  if (!vaultSecretId || !isSecretStorageAvailable(app)) {
    return null;
  }
  const token = await app.secretStorage.getSecret(storageKey(vaultSecretId));
  return token ? token : null;
}

export async function writeGitHubToken(
  app: App,
  vaultSecretId: string,
  token: string
): Promise<void> {
  if (!isSecretStorageAvailable(app)) {
    throw new Error(
      "Secure token storage requires Obsidian 1.11.4 or later. Please update Obsidian."
    );
  }
  await app.secretStorage.setSecret(storageKey(vaultSecretId), token);
}

export async function eraseGitHubToken(
  app: App,
  vaultSecretId: string
): Promise<void> {
  if (!vaultSecretId || !isSecretStorageAvailable(app)) {
    return;
  }
  await app.secretStorage.setSecret(storageKey(vaultSecretId), "");
}
