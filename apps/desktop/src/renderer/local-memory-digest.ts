import type { Sha256Digest } from '@maka/core/local-memory';

/** Precompute one SubtleCrypto digest so the sync Sha256Digest seam can run in the renderer. */
export async function webSha256Digest(input: string): Promise<Sha256Digest> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)),
  );
  return {
    digest(value: string): Uint8Array {
      if (value !== input) {
        throw new Error('webSha256Digest was asked to hash a different string');
      }
      return bytes;
    },
  };
}
