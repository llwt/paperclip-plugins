# paperclip-plugins

Paperclip plugins: live status for external links, one package per provider.

| Package | npm | What it does |
| --- | --- | --- |
| [`packages/linear`](packages/linear) | `@llwt/paperclip-plugin-linear` | Live status for Linear issue links, and a manual control to change a linked issue's state |

## Development

A pnpm workspace. Node 22.14 or later.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm lint
```

## Releasing

Each package is released on its own by a tag of the form
`<package>-v<version>`, for example `linear-v0.1.0` for `packages/linear`.

1. Set the version in the package's `package.json` (and its `src/manifest.ts`)
   and merge that to `main`.
2. Push the tag on that commit.

The `Release` workflow checks that the tag matches the package version and
that the commit is on `main`, runs the checks, then publishes to npm. It uses
npm trusted publishing (OIDC), so there is no npm token in this repo. Each
package on npmjs.com must list this repository and `release.yml` as its
trusted publisher. npm only allows that on a package that already exists, so
the first release of a new package is a one-off manual `npm publish`.

When adding the trusted publisher, also allow `npm publish` under **Allowed
actions**. A new configuration allows only `npm stage publish` by default,
while `release.yml` publishes directly with `npm publish`, so without it the
tag release fails. See the
[npm trusted publishers docs](https://docs.npmjs.com/trusted-publishers/).
