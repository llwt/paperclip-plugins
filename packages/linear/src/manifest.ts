import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "llwt.paperclip-linear",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Linear",
  description: "Read-only live status for Linear issue links on Paperclip issues",
  author: "llwt",
  categories: ["connector"],
  // Read-only by design: `external.objects.write` is deliberately not declared.
  capabilities: [
    "external.objects.detect",
    "external.objects.read",
    "http.outbound",
    "secrets.read-ref"
  ],
  entrypoints: {
    worker: "./dist/worker.js"
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      linearApiKey: {
        // The settings form saves a `{ type: "secret_ref", secretId }` binding,
        // so the value is an object. Declaring it a string fails the save.
        type: "object",
        format: "secret-ref",
        title: "Linear API key",
        description: "Company secret holding a Linear API key. Read scope is enough."
      }
    }
  },
  objectReferences: [
    {
      providerKey: "linear",
      displayName: "Linear",
      objectTypes: ["issue"],
      urlPatterns: ["https://linear.app/:workspace/issue/:identifier/:slug"],
      refreshPolicy: { defaultTtlSeconds: 300, staleAfterSeconds: 1800 }
    }
  ]
};

export default manifest;
