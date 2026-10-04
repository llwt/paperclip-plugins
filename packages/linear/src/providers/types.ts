import type { PluginExternalObjectResolveResult } from "@paperclipai/plugin-sdk";

export interface ProviderDetection {
  objectType: string;
  externalId: string;
  displayKey: string;
}

export type ProviderFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Provider {
  providerKey: string;
  iconKey: string;
  /** The only object type this provider resolves. */
  objectType: string;
  /** Key in the plugin instance config that holds the secret ref. */
  configKey: string;
  /** Returns null when the URL does not belong to this provider. */
  detect(url: URL): ProviderDetection | null;
  /** Guards the resolve boundary: ids do not have to come from `detect`. */
  isValidExternalId(externalId: string): boolean;
  resolve(input: {
    externalId: string;
    token: string;
    fetch: ProviderFetch;
  }): Promise<PluginExternalObjectResolveResult>;
}

export const TTL_SECONDS = 300;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Error messages are fixed strings built from the provider key and HTTP status
// only. Upstream error text is never forwarded: it can echo the credential.
export function authRequired(providerKey: string): PluginExternalObjectResolveResult {
  return {
    ok: false,
    liveness: "auth_required",
    errorCode: `${providerKey}_auth_required`,
    errorMessage: `${providerKey} rejected the configured credential`
  };
}

export function malformedResponse(providerKey: string): PluginExternalObjectResolveResult {
  return {
    ok: false,
    liveness: "unreachable",
    errorCode: `${providerKey}_malformed_response`,
    errorMessage: `${providerKey} API returned an unexpected response`
  };
}

/** Parses a JSON body. Returns undefined when the body is not valid JSON. */
export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Shared mapping for non-2xx responses. Returns null for statuses the provider handles itself. */
export function failureForStatus(
  providerKey: string,
  response: Response
): PluginExternalObjectResolveResult | null {
  if (response.ok) return null;
  if (response.status === 401 || response.status === 403) return authRequired(providerKey);
  const retryAfter = Number(response.headers.get("retry-after"));
  return {
    ok: false,
    liveness: "unreachable",
    errorCode: response.status === 429 ? `${providerKey}_rate_limited` : `${providerKey}_unreachable`,
    errorMessage: `${providerKey} API returned HTTP ${response.status}`,
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {})
  };
}
