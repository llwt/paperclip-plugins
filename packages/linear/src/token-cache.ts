import type { EnvSecretRefBinding, PluginContext } from "@paperclipai/plugin-sdk";
import type { ProviderFetch } from "./providers/types.js";

export const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

export interface ResolvedToken {
  token: string;
  fetch: ProviderFetch;
  invalidate(): void;
}

interface CacheEntry {
  companyId: string;
  expiresAt: number;
  pending: Promise<ResolvedToken>;
}

// One instance per worker, shared by status chips and the manual control.
// Credentials and in-flight resolves stay in memory and never reach logs.
export class TokenCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly host: PluginContext) {}

  clear(companyId?: string | null): void {
    for (const [key, entry] of this.entries) {
      if (companyId == null || entry.companyId === companyId) this.entries.delete(key);
    }
  }

  resolve(companyId: string, secretRef: EnvSecretRefBinding, configPath: string): Promise<ResolvedToken> {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    const key = JSON.stringify([
      companyId,
      secretRef.secretId,
      secretRef.version ?? "latest",
      secretRef.projectionClass,
      secretRef.projectionAllowlistKey
    ]);
    const cached = this.entries.get(key);
    if (cached) return cached.pending;

    const entry: CacheEntry = {
      companyId,
      expiresAt: Infinity,
      pending: Promise.resolve().then(async () => {
        try {
          const token = await this.host.secrets.resolve(secretRef, { companyId, configPath });
          entry.expiresAt = Date.now() + TOKEN_CACHE_TTL_MS;
          const invalidate = () => {
            // An old request must not evict a newer credential after expiry
            // or a config change. The next call resolves again, no retries.
            if (this.entries.get(key) === entry) this.entries.delete(key);
          };
          return {
            token,
            invalidate,
            fetch: async (url, init) => {
              const response = await this.host.http.fetch(url, init);
              if (response.status === 401 || response.status === 403) invalidate();
              return response;
            }
          };
        } catch {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          throw new Error("Linear credential resolve failed");
        }
      })
    };
    this.entries.set(key, entry);
    return entry.pending;
  }
}
