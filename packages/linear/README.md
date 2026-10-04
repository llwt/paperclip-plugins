# Linear

Paperclip plugin that renders Linear issue links on Paperclip issues with live
status instead of plain links.

There is no plugin UI: inline status chips are rendered by the host from the
metadata this plugin returns.

## What it does

| Links detected | Status source |
| --- | --- |
| `https://linear.app/<workspace>/issue/<TEAM-123>[/<slug>]` | Workflow state name and type from the GraphQL API |

Only `https` links are detected.

### Status rules

- An archived Linear issue shows as `Archived`, not its last workflow state.
- A Linear issue shows as `Not found` only when Linear answers with an explicit
  "Entity not found: Issue" input error whose `path` is the root `issue` lookup
  and returns no issue data. Any other GraphQL error, including a missing
  nested entity such as the workflow state, is a retryable failure.
- A response that does not match the expected shape is a failure, never a
  status.

## Read-only

The plugin never writes to Linear, even when the bound key has Read and Write
scope:

- It declares `external.objects.detect` and `external.objects.read` only, not
  `external.objects.write`.
- Linear receives one fixed GraphQL `query` document
  (`LINEAR_ISSUE_QUERY` in `src/providers/linear.ts`) and nothing else. A test
  asserts that it is the only document sent.

## Credentials

The credential is a company secret bound in the plugin settings, never a file
on disk:

- `linearApiKey`: a Linear API key (read scope is enough).

With no secret bound, links are still detected and show as needing
authentication.

Logs and error messages contain fixed text only. Upstream error text is never
logged or returned, because it can echo a credential.

## Install into Paperclip

From npm:

```bash
paperclipai plugin install @llwt/paperclip-plugin-linear
```

Or from a local checkout, after building:

```bash
paperclipai plugin install <path-to-repo>/packages/linear
```

Do not run it alongside another plugin that claims Linear issue links: two
plugins must never claim the same link.

## Development

From the repo root:

```bash
pnpm install
pnpm --filter @llwt/paperclip-plugin-linear test
pnpm --filter @llwt/paperclip-plugin-linear typecheck
pnpm --filter @llwt/paperclip-plugin-linear build
pnpm --filter @llwt/paperclip-plugin-linear lint
```
