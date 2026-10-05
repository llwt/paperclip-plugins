# Linear

Paperclip plugin that renders Linear issue links on Paperclip issues with live
status instead of plain links, and adds a manual control to change the state
of a linked Linear issue.

Inline status chips are rendered by the host from the metadata this plugin
returns. The manual control is the plugin's only UI.

## What it does

| Links detected | Status source |
| --- | --- |
| `https://linear.app/<workspace>/issue/<TEAM-123>[/<slug>]` | Workflow state name and type from the GraphQL API |

Only `https` links are detected.

### Chip display

The chip reads the Linear identifier and the workflow state name, for example
`ENG-123 - Todo`. The issue title is not shown, on the chip or on hover.

The status icon is picked from the host's fixed icon set by state type:

| Linear state type | Icon key |
| --- | --- |
| `triage` | `clock` |
| `backlog` | `circle` |
| `unstarted` | `circle` |
| `started` | `loader` |
| `completed` | `check-circle` |
| `canceled` | `x-circle` |
| Archived, Not found | `archive` |

### Status rules

- An archived Linear issue shows as `Archived`, not its last workflow state.
- A Linear issue shows as `Not found` only when Linear answers with an explicit
  "Entity not found: Issue" input error whose `path` is the root `issue` lookup
  and returns no issue data. Any other GraphQL error, including a missing
  nested entity such as the workflow state, is a retryable failure.
- A response that does not match the expected shape is a failure, never a
  status.

## Manual status control

On a task that links Linear issues, a "Linear" card on the task page lists
each linked issue with a picker of its team's workflow states. Picking another
state sends that one change to Linear. Archived and missing issues are listed
without a picker.

- The control lists links found in the task's description and comments. A
  link that sits only in a task document still gets a chip but is not listed.
- Linked issues are listed 25 at a time. "Show more" loads the next 25, so
  every linked issue is reachable.
- Only a board user can change a state. Agents and system callers are refused.
- The worker reads the task again on every change and refuses a Linear issue
  that is not linked on it, and a state that is not in that issue's team
  workflow.
- A failed change is shown with fixed text and is never retried.

### Link chips after a change

The control shows the state Linear returned straight away. The link chips are
drawn by the host, and a plugin can only ask the host to read them again:

- Whenever the control loads (opening the task, coming back to it, or after a
  change) it compares each chip with what it read from Linear and asks the
  host to re-read the ones that differ.
- The host declines to re-read a chip it read within the last 5 minutes. The
  control then says the chips are behind and asks again when that time has
  passed, as long as the task page is open. Leaving the page does not lose
  the refresh: the comparison runs again the next time the task is opened.
- If the host cannot be asked, the control says so and offers "Refresh
  chips". That only asks the host again. It never repeats the change.
- The host does not redraw a chip that is already on screen when its data
  changes. Reload the page to see the new chip.

## What is written

Nothing is ever written to Linear automatically. Task status changes, link
detection, status reads and agents never cause a write:

- The status chips send one fixed GraphQL `query` document
  (`LINEAR_ISSUE_QUERY` in `src/providers/linear.ts`) and nothing else.
- The manual control sends one fixed read `query` (`LINEAR_WORKFLOW_QUERY`)
  and one fixed `mutation` (`LINEAR_SET_STATE_MUTATION`, an `issueUpdate` whose
  only input is a state id), both in `src/control.ts`. The mutation is sent
  only when a board user picks a state.
- Tests assert that these are the only documents sent.

Nothing is written to Paperclip either: the plugin declares
`external.objects.detect`, `external.objects.read`, `issues.read`,
`issue.comments.read` and `ui.detailTab.register`, and no write capability.

## Credentials

The credential is a company secret bound in the plugin settings, never a file
on disk:

- `linearApiKey`: a Linear API key. Read scope is enough for the status chips.
  Changing a state with the manual control needs write scope, and the change
  shows in Linear as made by the key's owner.

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
