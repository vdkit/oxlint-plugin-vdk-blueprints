# @vdk/oxlint-plugin-blueprints

Oxlint JS plugin for validating VDK blueprint/frontmatter contracts in YAML files.

## Install

```bash
pnpm add -D @vdkit/oxlint-plugin-blueprints oxlint
```

## Usage

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "jsPlugins": [
    {
      "name": "vdk",
      "specifier": "@vdk/oxlint-plugin-blueprints"
    }
  ],
  "rules": {
    "vdk/validate-blueprints": [
      "error",
      {
        "targets": ["schemas/v3.0.0/examples"],
        "expectedSchemaVersion": "3.0",
        "requireKind": true,
        "enforceKebabCaseId": true
      }
    ]
  }
}
```

Run with plugin import enabled:

```bash
oxlint --import-plugin -c .oxlintrc.json "lint/blueprint-lint-trigger.mjs"
oxlint --import-plugin -c .oxlintrc.json "lint/blueprint-lint-trigger.ts"
```

### Auto-fix command

The package also ships a fixer CLI for deterministic frontmatter normalization.

```bash
# Dry run
vdk-blueprints-fix --target schemas/v3.0.0/examples

# Write changes
vdk-blueprints-fix --write --target schemas/v3.0.0/examples
```

What it fixes:

- `schemaVersion` mismatch/missing → expected version
- missing `kind` → default kind (`skill`, configurable)
- missing/invalid `version` → default semver (`1.0.0`, configurable)
- `id` normalization to kebab-case

## Rule: `vdk/validate-blueprints`

Checks all YAML files in `targets` for:

- Frontmatter presence and YAML validity
- Required frontmatter fields (`id`, `title`, `description`, `schemaVersion`, `kind`, `platforms`)
- Required `version` with semver-compatible format
- `schemaVersion` exact match
- `id` kebab-case
- `id` max length (100)
- `title` max length (100)
- `description` length bounds (10-500)
- `kind` allowed list
- non-empty `platforms` object
- Duplicate `id` collisions across scanned files

Supported file types are configurable and include `yaml`, `yml`, `md`, `mdx`, and `mdc` by default.

### Options

- `targets: string[]` (default: `["schemas"]`)
- `expectedSchemaVersion: string` (default: `"3.0"`)
- `requireKind: boolean` (default: `true`)
- `requireVersion: boolean` (default: `true`)
- `enforceKebabCaseId: boolean` (default: `true`)
- `allowedKinds: string[]` (default: canonical VDK kinds)
- `fileExtensions: string[]` (default: `['yaml', 'yml', 'md', 'mdx', 'mdc']`)

Fixer CLI options:

- `--target <path>` (repeatable)
- `--schema-version <value>`
- `--default-kind <value>`
- `--default-version <value>`
- `--ext <extension>` (repeatable)
- `--write` (without it, runs in dry-run mode)
- `-h`, `--help`
- `-v`, `--version`

## Publish

```bash
pnpm publish --access public
```
