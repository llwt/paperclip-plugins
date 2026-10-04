#!/usr/bin/env bash
# Maps a release tag of the form `<package>-v<version>` to its package
# directory and fails unless the version matches that package's package.json.
# Prints `dir=packages/<package>` for the release workflow.
set -euo pipefail

tag="${1:?usage: check-release-tag.sh <package>-v<version>}"

if [[ ! "$tag" =~ ^([a-z0-9]+(-[a-z0-9]+)*)-v([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]]; then
  echo "Tag '$tag' is not of the form <package>-v<version>" >&2
  exit 1
fi

package="${BASH_REMATCH[1]}"
version="${BASH_REMATCH[3]}"
dir="packages/$package"

if [[ ! -f "$dir/package.json" ]]; then
  echo "Tag '$tag' names '$package', but $dir/package.json does not exist" >&2
  exit 1
fi

actual="$(node -p "require('./$dir/package.json').version")"

if [[ "$actual" != "$version" ]]; then
  echo "Tag '$tag' is version $version, but $dir/package.json is version $actual" >&2
  exit 1
fi

echo "dir=$dir"
