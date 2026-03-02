import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { eslintCompatPlugin } from '@oxlint/plugins';

const DEFAULT_KINDS = new Set([
  'project-memory',
  'conditional-rule',
  'skill',
  'command',
  'workflow',
  'agent',
  'hook',
  'mcp-integration',
  'plugin-distribution'
]);

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9-]+)?(?:\+[a-zA-Z0-9-]+)?$/;

function collectBlueprintFiles(targetPath, allowedExtensions) {
  const files = [];
  if (!fs.existsSync(targetPath)) {
    return files;
  }

  const stack = [targetPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).slice(1).toLowerCase();
        if (allowedExtensions.has(extension)) {
          files.push(fullPath);
        }
      }
    }
  }

  return files;
}

function parseFrontmatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) {
    return { error: 'Missing YAML frontmatter block (--- ... ---).' };
  }

  try {
    return { frontmatter: yaml.load(match[1]) ?? {} };
  } catch (error) {
    return {
      error: `Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function validateBlueprintFile(filePath, frontmatter, options) {
  const issues = [];
  const add = (message) => issues.push({ filePath, message });

  if (!frontmatter || typeof frontmatter !== 'object') {
    add('Frontmatter must parse to an object.');
    return issues;
  }

  if (!frontmatter.id || typeof frontmatter.id !== 'string') {
    add('Missing required field: id (string).');
  } else if (options.enforceKebabCaseId && !/^[a-z0-9-]+$/.test(frontmatter.id)) {
    add(`id must be kebab-case: "${frontmatter.id}"`);
  } else if (frontmatter.id.length > 100) {
    add('id must be at most 100 characters.');
  }

  if (!frontmatter.title || typeof frontmatter.title !== 'string') {
    add('Missing required field: title (string).');
  } else if (frontmatter.title.length > 100) {
    add('title must be at most 100 characters.');
  }

  if (!frontmatter.description || typeof frontmatter.description !== 'string') {
    add('Missing required field: description (string).');
  } else if (frontmatter.description.length < 10 || frontmatter.description.length > 500) {
    add('description must be between 10 and 500 characters.');
  }

  if (options.requireVersion) {
    if (!frontmatter.version || typeof frontmatter.version !== 'string') {
      add('Missing required field: version (semver string).');
    } else if (!SEMVER_PATTERN.test(frontmatter.version)) {
      add(`version must be semver-compatible, got "${frontmatter.version}".`);
    }
  }

  if (!frontmatter.schemaVersion || typeof frontmatter.schemaVersion !== 'string') {
    add('Missing required field: schemaVersion (string).');
  } else if (
    options.expectedSchemaVersion &&
    frontmatter.schemaVersion !== options.expectedSchemaVersion
  ) {
    add(
      `schemaVersion must be "${options.expectedSchemaVersion}", got "${frontmatter.schemaVersion}".`
    );
  }

  if (options.requireKind) {
    if (!frontmatter.kind || typeof frontmatter.kind !== 'string') {
      add('Missing required field: kind (string).');
    } else if (options.allowedKinds.has(frontmatter.kind) === false) {
      add(`Unsupported kind "${frontmatter.kind}".`);
    }
  }

  if (!frontmatter.platforms || typeof frontmatter.platforms !== 'object') {
    add('Missing required field: platforms (object).');
  } else if (Object.keys(frontmatter.platforms).length === 0) {
    add('platforms must include at least one configured platform.');
  }

  return issues;
}

const validateBlueprintsRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Validate VDK blueprint YAML frontmatter contracts'
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          targets: {
            type: 'array',
            items: { type: 'string' }
          },
          expectedSchemaVersion: { type: 'string' },
          requireKind: { type: 'boolean' },
          requireVersion: { type: 'boolean' },
          enforceKebabCaseId: { type: 'boolean' },
          allowedKinds: {
            type: 'array',
            items: { type: 'string' }
          },
          fileExtensions: {
            type: 'array',
            items: { type: 'string' }
          }
        }
      }
    ],
    messages: {
      issue: '{{message}}'
    }
  },

  createOnce(context) {
    return {
      Program(node) {
        const [userOptions = {}] = context.options;
        const cwd = context.cwd || process.cwd();
        const targets = Array.isArray(userOptions.targets) ? userOptions.targets : ['schemas'];
        const options = {
          expectedSchemaVersion: userOptions.expectedSchemaVersion ?? '3.0',
          requireKind: userOptions.requireKind ?? true,
          requireVersion: userOptions.requireVersion ?? true,
          enforceKebabCaseId: userOptions.enforceKebabCaseId ?? true,
          allowedKinds: new Set(userOptions.allowedKinds ?? [...DEFAULT_KINDS]),
          fileExtensions: new Set(
            (userOptions.fileExtensions ?? ['yaml', 'yml', 'md', 'mdx'])
              .map((extension) => String(extension).trim().toLowerCase())
              .filter(Boolean)
          )
        };

        const issues = [];
        const seenIds = new Map();

        for (const relativeTarget of targets) {
          const absoluteTarget = path.resolve(cwd, relativeTarget);
          for (const filePath of collectBlueprintFiles(absoluteTarget, options.fileExtensions)) {
            const text = fs.readFileSync(filePath, 'utf8');
            const parsed = parseFrontmatter(text);

            if (parsed.error) {
              issues.push({ filePath, message: parsed.error });
              continue;
            }

            const frontmatter = parsed.frontmatter;
            issues.push(...validateBlueprintFile(filePath, frontmatter, options));

            if (frontmatter?.id && typeof frontmatter.id === 'string') {
              const existing = seenIds.get(frontmatter.id);
              if (existing && existing !== filePath) {
                issues.push({
                  filePath,
                  message: `Duplicate blueprint id "${frontmatter.id}" also found in ${path.relative(cwd, existing)}.`
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
            messageId: 'issue',
            data: {
              message: `[vdk-blueprints] ${path.relative(cwd, issue.filePath)}: ${issue.message}`
            }
          });
        }
      }
    };
  }
};

export default eslintCompatPlugin({
  meta: {
    name: '@vdk/oxlint-plugin-blueprints'
  },
  rules: {
    'validate-blueprints': validateBlueprintsRule
  }
});
