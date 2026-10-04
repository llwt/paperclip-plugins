import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginExternalObjectDetection
} from "@paperclipai/plugin-sdk";
import { linearProvider } from "./providers/linear.js";
import type { Provider } from "./providers/types.js";

const providers: Provider[] = [linearProvider];

let ctx: PluginContext | null = null;

function isSecretRef(value: unknown): value is { type: "secret_ref"; secretId: string } {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "secret_ref";
}

const plugin = definePlugin({
  async setup(context) {
    ctx = context;
  },

  async onHealth() {
    return { status: "ok", message: "Plugin worker is running" };
  },

  async onDetectExternalObjects({ urls }) {
    const detections: PluginExternalObjectDetection[] = [];
    for (const candidate of urls) {
      let url: URL;
      try {
        url = new URL(candidate.sanitizedCanonicalUrl);
      } catch {
        continue;
      }
      if (url.protocol !== "https:") continue;
      for (const provider of providers) {
        const detection = provider.detect(url);
        if (!detection) continue;
        detections.push({
          urlIdentityHash: candidate.canonicalIdentityHash,
          providerKey: provider.providerKey,
          iconKey: provider.iconKey,
          confidence: "exact",
          ...detection
        });
        break;
      }
    }
    return { detections };
  },

  async onResolveExternalObject({ companyId, providerKey, objectType, externalId }) {
    const provider = providers.find((entry) => entry.providerKey === providerKey);
    if (!provider || !ctx) {
      return { ok: false, liveness: "unreachable", errorCode: "unsupported_provider" };
    }
    const host = ctx;

    // Resolve inputs are not guaranteed to come from detection. Reject them
    // before any secret is resolved or request is made.
    if (objectType !== provider.objectType || typeof externalId !== "string" || !provider.isValidExternalId(externalId)) {
      return {
        ok: false,
        liveness: "unreachable",
        errorCode: `${provider.providerKey}_invalid_reference`,
        errorMessage: `Not a valid ${provider.providerKey} ${provider.objectType} reference`
      };
    }

    const config = await host.config.get(companyId);
    const secretRef = config[provider.configKey];
    if (!isSecretRef(secretRef)) {
      return {
        ok: false,
        liveness: "auth_required",
        errorCode: `${provider.providerKey}_auth_required`,
        errorMessage: `Bind a company secret to ${provider.configKey} in the plugin settings`
      };
    }

    try {
      // Resolved per call and never cached or logged.
      const token = await host.secrets.resolve(secretRef, {
        companyId,
        configPath: provider.configKey
      });
      return await provider.resolve({
        externalId,
        token,
        fetch: (url, init) => host.http.fetch(url, init)
      });
    } catch {
      // The thrown error is deliberately dropped: transport and secret errors
      // can carry the credential, so only fixed text is logged or returned.
      host.logger.warn("External object resolve failed", { providerKey: provider.providerKey });
      return {
        ok: false,
        liveness: "unreachable",
        errorCode: `${provider.providerKey}_unreachable`,
        errorMessage: `${provider.providerKey} request failed`
      };
    }
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
