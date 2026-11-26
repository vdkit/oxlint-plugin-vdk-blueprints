import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { definePlugin, defineRule, eslintCompatPlugin, type Context } from "@oxlint/plugins";

const DEFAULT_KINDS = new Set([
  "project-memory",
  "conditional-rule",
  "skill",
  "command",
  "workflow",
  "agent",
  "hook",
  "mcp-integration",
  "plugin-distribution",
]);

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9-]+)?(?:\+[a-zA-Z0-9-]+)?$/;

interface BlueprintFrontmatter extends Record<string, unknown> {
  id?: string;
  title?: string;
  description?: string;
  version?: string;
  schemaVersion?: string;
  kind?: string;
  platforms?: Record<string, unknown>;
}

interface ValidationIssue {
  filePath: string;
  message: string;
}

interface ResolvedRuleOptions {
  targets: string[];
  expectedSchemaVersion: string;
  requireKind: boolean;
  requireVersion: boolean;
  enforceKebabCaseId: boolean;
  allowedKinds: Set<string>;
  fileExtensions: Set<string>;
}

type ParseFrontmatterResult = { frontmatter: BlueprintFrontmatter } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getBooleanOption(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function getStringOption(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function getStringArrayOption(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const entries = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return entries.length > 0 ? entries : fallback;
}

function resolveRuleOptions(rawOptions: Context["options"]): ResolvedRuleOptions {
  const userOptions = rawOptions[0];

  if (!isRecord(userOptions)) {
    return {
      targets: ["schemas"],
      expectedSchemaVersion: "3.0",
      requireKind: true,
      requireVersion: true,
      enforceKebabCaseId: true,
      allowedKinds: new Set(DEFAULT_KINDS),
      fileExtensions: new Set(["yaml", "yml", "md", "mdx", "mdc"]),
    };
  }

  return {
    targets: getStringArrayOption(userOptions.targets, ["schemas"]),
    expectedSchemaVersion: getStringOption(userOptions.expectedSchemaVersion, "3.0"),
    requireKind: getBooleanOption(userOptions.requireKind, true),
    requireVersion: getBooleanOption(userOptions.requireVersion, true),
    enforceKebabCaseId: getBooleanOption(userOptions.enforceKebabCaseId, true),
    allowedKinds: new Set(getStringArrayOption(userOptions.allowedKinds, [...DEFAULT_KINDS])),
    fileExtensions: new Set(
      getStringArrayOption(userOptions.fileExtensions, ["yaml", "yml", "md", "mdx", "mdc"]).map(
        (extension) => extension.toLowerCase(),
      ),
    ),
  };
}

function collectBlueprintFiles(
  targetPath: string,
  allowedExtensions: ReadonlySet<string>,
): string[] {
  const targetStats = fs.statSync(targetPath, { throwIfNoEntry: false });
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
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = fs.readdirSync(current, { withFileTypes: true });

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

function parseFrontmatter(text: string): ParseFrontmatterResult {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u);
  if (!match) {
    return { error: "Missing YAML frontmatter block (--- ... ---)." };
  }

  const frontmatterText = match[1];
  if (frontmatterText === undefined) {
    return { error: "Missing YAML frontmatter block (--- ... ---)." };
  }

  try {
    const parsed = yaml.load(frontmatterText);
    if (!isRecord(parsed)) {
      return { error: "Frontmatter must parse to an object." };
    }

    return { frontmatter: parsed };
  } catch (error) {
    return {
      error: `Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function validateBlueprintFile(
  filePath: string,
  frontmatter: BlueprintFrontmatter,
  options: ResolvedRuleOptions,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (message: string): void => {
    issues.push({ filePath, message });
  };

  if (!frontmatter.id || typeof frontmatter.id !== "string") {
    add("Missing required field: id (string).");
  } else if (options.enforceKebabCaseId && !/^[a-z0-9-]+$/u.test(frontmatter.id)) {
    add(`id must be kebab-case: "${frontmatter.id}"`);
  } else if (frontmatter.id.length > 100) {
    add("id must be at most 100 characters.");
  }

  if (!frontmatter.title || typeof frontmatter.title !== "string") {
    add("Missing required field: title (string).");
  } else if (frontmatter.title.length > 100) {
    add("title must be at most 100 characters.");
  }

  if (!frontmatter.description || typeof frontmatter.description !== "string") {
    add("Missing required field: description (string).");
  } else if (frontmatter.description.length < 10 || frontmatter.description.length > 500) {
    add("description must be between 10 and 500 characters.");
  }

  if (options.requireVersion) {
    if (!frontmatter.version || typeof frontmatter.version !== "string") {
      add("Missing required field: version (semver string).");
    } else if (!SEMVER_PATTERN.test(frontmatter.version)) {
      add(`version must be semver-compatible, got "${frontmatter.version}".`);
    }
  }

  if (!frontmatter.schemaVersion || typeof frontmatter.schemaVersion !== "string") {
    add("Missing required field: schemaVersion (string).");
  } else if (frontmatter.schemaVersion !== options.expectedSchemaVersion) {
    add(
      `schemaVersion must be "${options.expectedSchemaVersion}", got "${frontmatter.schemaVersion}".`,
    );
  }

  if (options.requireKind) {
    if (!frontmatter.kind || typeof frontmatter.kind !== "string") {
      add("Missing required field: kind (string).");
    } else if (!options.allowedKinds.has(frontmatter.kind)) {
      add(`Unsupported kind "${frontmatter.kind}".`);
    }
  }

  if (!isRecord(frontmatter.platforms)) {
    add("Missing required field: platforms (object).");
  } else if (Object.keys(frontmatter.platforms).length === 0) {
    add("platforms must include at least one configured platform.");
  }

  return issues;
}

const validateBlueprintsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Validate VDK blueprint YAML frontmatter contracts",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          targets: {
            type: "array",
            items: { type: "string" },
          },
          expectedSchemaVersion: { type: "string" },
          requireKind: { type: "boolean" },
          requireVersion: { type: "boolean" },
          enforceKebabCaseId: { type: "boolean" },
          allowedKinds: {
            type: "array",
            items: { type: "string" },
          },
          fileExtensions: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    ],
    messages: {
      issue: "{{message}}",
    },
  },

  createOnce(context) {
    return {
      Program(node) {
        const cwd = context.cwd ?? process.cwd();
        const options = resolveRuleOptions(context.options);
        const issues: ValidationIssue[] = [];
        const seenIds = new Map<string, string>();

        for (const relativeTarget of options.targets) {
          const absoluteTarget = path.resolve(cwd, relativeTarget);
          for (const filePath of collectBlueprintFiles(absoluteTarget, options.fileExtensions)) {
            const text = fs.readFileSync(filePath, "utf8");
            const parsed = parseFrontmatter(text);

            if ("error" in parsed) {
              issues.push({ filePath, message: parsed.error });
              continue;
            }

            const frontmatter = parsed.frontmatter;
            issues.push(...validateBlueprintFile(filePath, frontmatter, options));

            if (typeof frontmatter.id === "string") {
              const existing = seenIds.get(frontmatter.id);
              if (existing && existing !== filePath) {
                issues.push({
                  filePath,
                  message: `Duplicate blueprint id "${frontmatter.id}" also found in ${path.relative(cwd, existing)}.`,
                });
              } else {
                seenIds.set(frontmatter.id, filePath);
              }
            }
          }
        }

        for (const issue of issues) {
          context.report({
            node,
            messageId: "issue",
            data: {
              message: `[vdk-blueprints] ${path.relative(cwd, issue.filePath)}: ${issue.message}`,
            },
          });
        }
      },
    };
  },
});

export default eslintCompatPlugin(
  definePlugin({
    meta: {
      name: "@vdkit/oxlint-plugin-blueprints",
    },
    rules: {
      "validate-blueprints": validateBlueprintsRule,
    },
  }),
);
