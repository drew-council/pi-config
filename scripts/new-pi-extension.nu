#!/usr/bin/env nu

# Scaffold a publishable Pi extension package in its own Git repository.
#
# Example:
#   ./scripts/new-pi-extension.nu @scope/pi-example \
#     --description "An example Pi extension" \
#     --source ./agent/extensions/example
#
# By default, @scope/pi-example is created at ~/personal/pi-example. Pass
# --github-repo owner/pi-example to add repository metadata. Also pass
# --create-github to create and push the public GitHub repository after checks.

def command-exists [command: string] {
  not ((which $command) | is-empty)
}

def fail [message: string] {
  error make { msg: $message }
}

def main [
  package_name: string # npm package name, such as @scope/pi-example.
  --description: string = "A Pi coding agent extension"
  --directory (-d): string = "" # Defaults to ~/personal/<package basename>.
  --source: string = "" # Existing extension file or directory to copy into src/.
  --github-repo: string = "" # Add metadata for an owner/repository.
  --create-github # Create and push --github-repo as a public repository.
  --skip-install # Do not install dependencies or run the generated checks.
] {
  if not ($package_name =~ '^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$') {
    fail $"Invalid npm package name: ($package_name)"
  }

  for command in (["git"] | append (if $skip_install { [] } else { ["bun"] })) {
    if not (command-exists $command) {
      fail $"Missing required command: ($command)"
    }
  }
  if $create_github and ($github_repo | is-empty) {
    fail "--create-github requires --github-repo owner/name"
  }
  if $create_github and not (command-exists "gh") {
    fail "Missing required command: gh"
  }
  if ($github_repo | is-not-empty) and not ($github_repo =~ '^[^/]+/[^/]+$') {
    fail $"GitHub repository must be owner/name: ($github_repo)"
  }

  let package_basename = ($package_name | split row "/" | last)
  let target = if ($directory | is-empty) {
    $env.HOME | path join "personal" $package_basename
  } else {
    $directory | path expand
  }

  if ($target | path exists) {
    fail $"Target already exists: ($target)"
  }

  let source_path = if ($source | is-empty) { "" } else { $source | path expand }
  if ($source_path | is-not-empty) and not ($source_path | path exists) {
    fail $"Source does not exist: ($source_path)"
  }

  let pi_version = (if (command-exists "pi") { ^pi --version | str trim } else { "*" })
  let bun_version = (if (command-exists "bun") { ^bun --version | str trim } else { "1" })
  let repository_url = if ($github_repo | is-empty) { "" } else { $"https://github.com/($github_repo).git" }

  mkdir ($target | path join "src")
  mkdir ($target | path join "test")
  mkdir ($target | path join ".github" "workflows")

  if ($source_path | is-empty) {
    "import type { ExtensionAPI } from \"@earendil-works/pi-coding-agent\";\n\nexport default function extension(_pi: ExtensionAPI) {}\n"
    | save ($target | path join "src" "index.ts")
  } else if (($source_path | path type) == "dir") {
    ^cp -R $"($source_path)/." ($target | path join "src")
  } else {
    cp $source_path ($target | path join "src" "index.ts")
  }

  r#'import { expect, test } from "bun:test";
import extension from "../src/index.js";

test("exports an extension factory", () => {
  expect(typeof extension).toBe("function");
});
'#
  | save ($target | path join "test" "index.test.ts")

  let base_manifest = {
    name: $package_name
    version: "0.1.0"
    description: $description
    type: "module"
    license: "MIT"
    author: "Drew Council"
    packageManager: $"bun@($bun_version)"
    keywords: ["pi-package" "pi-extension" "pi-coding-agent"]
    files: ["src" "README.md" "LICENSE"]
    scripts: {
      check: "biome ci . && tsgo -p tsconfig.json && bun test"
      "check:fix": "biome check --write --unsafe . && tsgo -p tsconfig.json && bun test"
      test: "bun test"
      prepublishOnly: "bun run check && npm pack --dry-run"
    }
    publishConfig: { access: "public" }
    pi: { extensions: ["./src/index.ts"] }
    peerDependencies: { "@earendil-works/pi-coding-agent": "*" }
    devDependencies: {
      "@earendil-works/pi-coding-agent": $pi_version
    }
  }
  let manifest = if ($repository_url | is-empty) {
    $base_manifest
  } else {
    $base_manifest
    | insert repository { type: "git", url: $"git+($repository_url)" }
    | insert bugs { url: $"https://github.com/($github_repo)/issues" }
    | insert homepage $"https://github.com/($github_repo)#readme"
  }
  $manifest | to json --indent 2 | $"($in)\n" | save ($target | path join "package.json")

  r#'{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
'#
  | save ($target | path join "tsconfig.json")

  r#'{
  "$schema": "https://biomejs.dev/schemas/2.5.14/schema.json",
  "files": { "ignoreUnknown": true },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 120
  },
  "linter": { "enabled": true, "rules": { "preset": "recommended" } },
  "javascript": { "formatter": { "quoteStyle": "double" } },
  "assist": { "enabled": true, "actions": { "source": { "organizeImports": "on" } } }
}
'#
  | save ($target | path join "biome.json")

  r#'name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run check
'#
  | save ($target | path join ".github" "workflows" "ci.yml")

  r#'name: Publish

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
          package-manager-cache: false
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run check
      - name: Verify release tag
        run: test "${GITHUB_REF_NAME#v}" = "$(node -p "require('./package.json').version")"
      - run: npm publish
'#
  | save ($target | path join ".github" "workflows" "publish.yml")

  r#'node_modules/
coverage/
*.tgz
'#
  | save ($target | path join ".gitignore")

  r#'MIT License

Copyright (c) 2026 Drew Council

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
'#
  | save ($target | path join "LICENSE")

  r##'# __PACKAGE__

__DESCRIPTION__.

## Install

```sh
pi install npm:__PACKAGE__
```

Restart Pi after installation. Review extensions before installing them; Pi extensions run with your full user permissions.

## Development

```sh
bun install
bun run check
```

`bun run check` runs Biome, TypeScript 7 (`tsgo`), and Bun tests.

## Releasing

1. Update `version` in `package.json` and commit the lockfile.
2. For the initial release, run `npm publish` locally.
3. In the npm package settings, configure GitHub Actions trusted publishing for `.github/workflows/publish.yml`.
4. For later releases, create a GitHub release whose tag exactly matches `v<package.json version>`.

The publish workflow uses npm trusted publishing (OIDC), so it does not require a long-lived `NPM_TOKEN`.

## License

MIT
'##
  | str replace --all "__PACKAGE__" $package_name
  | str replace --all "__DESCRIPTION__" $description
  | save ($target | path join "README.md")

  ^git -C $target init -b main

  if not $skip_install {
    ^bun add --cwd $target --dev @biomejs/biome @types/bun @typescript/native-preview
    ^bun run --cwd $target check:fix
  }

  if $create_github {
    ^git -C $target add .
    ^git -C $target commit -m "Initial release"
    ^gh repo create $github_repo --public --source $target --remote origin --push
  }

  print $"Created ($package_name) at ($target)"
}
