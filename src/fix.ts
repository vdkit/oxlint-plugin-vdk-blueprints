#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9-]+)?(?:\+[a-zA-Z0-9-]+)?$/;

interface FixCliOptions {
  targets: string[];
  expectedSchemaVersion: string;
  defaultKind: string;
  defaultVersion: string;
  fileExtensions: Set<string>;
  write: boolean;
}

interface FixResult {
  changed: boolean;
  reasons: string[];
}

type ParsedArguments =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; options: FixCliOptions };

class UsageError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectExecution(importMetaUrl: string): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && pathToFileURL(entrypoint).href === importMetaUrl;
}

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function kebabCase(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/--+/gu, "-")
    .toLowerCase();
}

function printHelp(): void {
  writeStdout("Usage: vdk-blueprints-fix [options]");
  writeStdout("");
  writeStdout("Options:");
  writeStdout("  --target <path>            Scan a file or directory. Repeatable.");
  writeStdout("  --schema-version <value>   Expected schemaVersion. Default: 3.0");
  writeStdout("  --default-kind <value>     Fill missing kind values. Default: skill");
  writeStdout("  --default-version <value>  Fill missing/invalid versions. Default: 1.0.0");
  writeStdout("  --ext <extension>          Allowed extension. Repeatable.");
  writeStdout("  --write                    Apply changes in place.");
  writeStdout("  -h, --help                 Show this help message.");
  writeStdout("  -v, --version              Show the package version.");
}

async function readPackageVersion(): Promise<string> {
  const packageJsonPath = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

  if (isRecord(packageJson) && typeof packageJson.version === "string") {
    return packageJson.version;
  }

  throw new Error("Unable to read package version.");
}

function parseArgs(argv: readonly string[]): ParsedArguments {
  const targets = ["schemas/v3.0.0/examples"];
  const fileExtensions = ["yaml", "yml", "md", "mdx", "mdc"];
  let expectedSchemaVersion = "3.0";
  let defaultKind = "skill";
  let defaultVersion = "1.0.0";
  let write = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    switch (token) {
      case "--help":
      case "-h":
        return { kind: "help" };
      case "--version":
      case "-v":
        return { kind: "version" };
      case "--write":
        write = true;
        break;
      case "--target": {
        const value = argv[index + 1];
        if (value === undefined) {
          throw new UsageError("Missing value for --target.");
        }

        targets.push(value);
        index += 1;
        break;
      }
      case "--schema-version": {
        const value = argv[index + 1];
        if (value === undefined) {
          throw new UsageError("Missing value for --schema-version.");
        }

        expectedSchemaVersion = value;
        index += 1;
        break;
      }
      case "--default-kind": {
        const value = argv[index + 1];
        if (value === undefined) {
          throw new UsageError("Missing value for --default-kind.");
        }

        defaultKind = value;
        index += 1;
        break;
      }
      case "--default-version": {
        const value = argv[index + 1];
        if (value === undefined) {
          throw new UsageError("Missing value for --default-version.");
        }

        if (!SEMVER_PATTERN.test(value)) {
          throw new UsageError(`--default-version must be semver-compatible, received "${value}".`);
        }

        defaultVersion = value;
        index += 1;
        break;
      }
      case "--ext": {
        const value = argv[index + 1];
        if (value === undefined) {
          throw new UsageError("Missing value for --ext.");
        }

        fileExtensions.push(value);
        index += 1;
        break;
      }
      default:
        throw new UsageError(`Unknown option: ${token}`);
    }
  }

  return {
    kind: "run",
    options: {
      targets: [...new Set(targets)],
      expectedSchemaVersion,
      defaultKind,
      defaultVersion,
      fileExtensions: new Set(
        fileExtensions.map((extension) => extension.trim().toLowerCase()).filter(Boolean),
      ),
      write,
    },
  };
}

async function collectBlueprintFiles(
  targetPath: string,
  allowedExtensions: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();

  const targetStats = await stat(targetPath).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  });

  if (!targetStats) {
    return [];
  }

  if (targetStats.isFile()) {
    const extension = path.extname(targetPath).slice(1).toLowerCase();
    return allowedExtensions.has(extension) ? [targetPath] : [];
  }

  const files: string[] = [];
  const stack = [targetPath];

  while (stack.length > 0) {
    signal.throwIfAborted();

    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).slice(1).toLowerCase();
      if (allowedExtensions.has(extension)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function splitFrontmatter(content: string): { frontmatterRaw: string; body: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(\n[\s\S]*)?$/u);
  if (!match) {
    return null;
  }

  const frontmatterRaw = match[1];
  if (frontmatterRaw === undefined) {
    return null;
  }

  return {
    frontmatterRaw,
    body: (match[2] ?? "\n").replace(/^\n?/u, "\n"),
  };
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let renamed = false;

  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

async function fixFile(
  filePath: string,
  options: FixCliOptions,
  signal: AbortSignal,
): Promise<FixResult> {
  signal.throwIfAborted();

  const original = await readFile(filePath, "utf8");
  const split = splitFrontmatter(original);
  if (!split) {
    return { changed: false, reasons: ["missing-frontmatter"] };
  }

  let frontmatter: Record<string, unknown>;
  try {
    const parsed = yaml.load(split.frontmatterRaw);
    if (!isRecord(parsed)) {
      return { changed: false, reasons: ["invalid-frontmatter-object"] };
    }

    frontmatter = parsed;
  } catch {
    return { changed: false, reasons: ["invalid-yaml"] };
  }

  const reasons: string[] = [];

  if (frontmatter.schemaVersion !== options.expectedSchemaVersion) {
    frontmatter.schemaVersion = options.expectedSchemaVersion;
    reasons.push("schemaVersion");
  }

  if (typeof frontmatter.kind !== "string" || frontmatter.kind.length === 0) {
    frontmatter.kind = options.defaultKind;
    reasons.push("kind");
  }

  if (typeof frontmatter.version !== "string" || !SEMVER_PATTERN.test(frontmatter.version)) {
    frontmatter.version = options.defaultVersion;
    reasons.push("version");
  }

  if (typeof frontmatter.id === "string") {
    const normalized = kebabCase(frontmatter.id);
    if (normalized.length > 0 && normalized !== frontmatter.id) {
      frontmatter.id = normalized;
      reasons.push("id");
    }
  }

  if (reasons.length === 0) {
    return { changed: false, reasons: [] };
  }

  const next = `---\n${yaml.dump(frontmatter, { lineWidth: 120 }).trimEnd()}\n---${split.body}`;

  if (options.write) {
    signal.throwIfAborted();
    await writeFileAtomic(filePath, next);
  }

  return { changed: true, reasons };
}

function installSignalHandlers(controller: AbortController): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    writeStderr(`Operation cancelled by ${signal}.`);
    controller.abort(new Error(`Received ${signal}`));
  };

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.once(signal, onSignal);
  }

  return () => {
    for (const signal of signals) {
      process.removeListener(signal, onSignal);
    }
  };
}

async function run(options: FixCliOptions): Promise<void> {
  const controller = new AbortController();
  const cleanupSignals = installSignalHandlers(controller);
  const cwd = process.cwd();

  try {
    let changed = 0;
    let scanned = 0;

    for (const target of options.targets) {
      controller.signal.throwIfAborted();

      const absoluteTarget = path.resolve(cwd, target);
      const files = await collectBlueprintFiles(
        absoluteTarget,
        options.fileExtensions,
        controller.signal,
      );
      scanned += files.length;

      for (const filePath of files) {
        controller.signal.throwIfAborted();

        const result = await fixFile(filePath, options, controller.signal);
        if (!result.changed) {
          continue;
        }

        changed += 1;
        writeStdout(`fixed ${path.relative(cwd, filePath)} [${result.reasons.join(",")}]`);
      }
    }

    writeStdout(
      `${options.write ? "write" : "dry-run"} complete: scanned ${scanned} files, ${changed} file(s) would change.`,
    );
  } finally {
    cleanupSignals();
  }
}

async function main(): Promise<void> {
  const parsedArguments = parseArgs(process.argv.slice(2));

  switch (parsedArguments.kind) {
    case "help":
      printHelp();
      process.exitCode = 0;
      return;
    case "version":
      writeStdout(await readPackageVersion());
      process.exitCode = 0;
      return;
    case "run":
      await run(parsedArguments.options);
      process.exitCode = 0;
      return;
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof UsageError) {
      writeStderr(error.message);
      writeStderr("Run `vdk-blueprints-fix --help` for usage.");
      process.exitCode = 2;
      return;
    }

    writeStderr(`Blueprint fix failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
