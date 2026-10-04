import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "llwt.paperclip-linear",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Linear",
  description: "Live status for Linear issue links on Paperclip issues, with a manual control to change a linked issue's state",
  author: "llwt",
  categories: ["connector"],
  // Nothing is written to Paperclip: no write, create or update capability is
  // declared. The only write to Linear is the manual status control.
  capabilities: [
    "external.objects.detect",
    "external.objects.read",
    "http.outbound",
    "secrets.read-ref",
    "issues.read",
    "issue.comments.read",
    "ui.detailTab.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "taskDetailView",
        id: "linear-status-control",
        displayName: "Linear",
        exportName: "LinearStatusControl",
        entityTypes: ["issue"]
      }
    ]
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
        description: "Company secret holding a Linear API key. Read scope shows status; changing a state by hand needs write scope."
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
