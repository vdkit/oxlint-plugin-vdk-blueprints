#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9-]+)?(?:\+[a-zA-Z0-9-]+)?$/;

function kebabCase(value) {
  return value
    .toString()
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-')
    .toLowerCase();
}

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

function parseArgs(argv) {
  const args = {
    targets: ['schemas/v3.0.0/examples'],
    expectedSchemaVersion: '3.0',
    defaultKind: 'skill',
    defaultVersion: '1.0.0',
    fileExtensions: ['yaml', 'yml', 'md', 'mdx'],
    write: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--write') {
      args.write = true;
    } else if (token === '--target' && argv[i + 1]) {
      args.targets.push(argv[i + 1]);
      i += 1;
    } else if (token === '--schema-version' && argv[i + 1]) {
      args.expectedSchemaVersion = argv[i + 1];
      i += 1;
    } else if (token === '--default-kind' && argv[i + 1]) {
      args.defaultKind = argv[i + 1];
      i += 1;
    } else if (token === '--default-version' && argv[i + 1]) {
      args.defaultVersion = argv[i + 1];
      i += 1;
    } else if (token === '--ext' && argv[i + 1]) {
      args.fileExtensions.push(argv[i + 1]);
      i += 1;
    }
  }

  return args;
}

function splitFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(\n[\s\S]*)?$/);
  if (!match) {
    return null;
  }

  return {
    frontmatterRaw: match[1],
    body: (match[2] ?? '\n').replace(/^\n?/, '\n')
  };
}

function fixFile(filePath, options) {
  const original = fs.readFileSync(filePath, 'utf8');
  const split = splitFrontmatter(original);
  if (!split) {
    return { changed: false, reasons: ['missing-frontmatter'] };
  }

  let frontmatter;
  try {
    frontmatter = yaml.load(split.frontmatterRaw) ?? {};
  } catch {
    return { changed: false, reasons: ['invalid-yaml'] };
  }

  if (!frontmatter || typeof frontmatter !== 'object') {
    return { changed: false, reasons: ['invalid-frontmatter-object'] };
  }

  const reasons = [];

  if (frontmatter.schemaVersion !== options.expectedSchemaVersion) {
    frontmatter.schemaVersion = options.expectedSchemaVersion;
    reasons.push('schemaVersion');
  }

  if (!frontmatter.kind || typeof frontmatter.kind !== 'string') {
    frontmatter.kind = options.defaultKind;
    reasons.push('kind');
  }

  if (!frontmatter.version || typeof frontmatter.version !== 'string') {
    frontmatter.version = options.defaultVersion;
    reasons.push('version');
  } else if (!SEMVER_PATTERN.test(frontmatter.version)) {
    frontmatter.version = options.defaultVersion;
    reasons.push('version');
  }

  if (typeof frontmatter.id === 'string') {
    const normalized = kebabCase(frontmatter.id);
    if (normalized && normalized !== frontmatter.id) {
      frontmatter.id = normalized;
      reasons.push('id');
    }
  }

  if (reasons.length === 0) {
    return { changed: false, reasons: [] };
  }

  const next = `---\n${yaml.dump(frontmatter, { lineWidth: 120 }).trimEnd()}\n---${split.body}`;
  if (options.write) {
    fs.writeFileSync(filePath, next, 'utf8');
  }

  return { changed: true, reasons };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const targets = [...new Set(args.targets)];
  const extensions = new Set(args.fileExtensions.map((extension) => extension.toLowerCase()));

  let changed = 0;
  let scanned = 0;

  for (const target of targets) {
    const absoluteTarget = path.resolve(cwd, target);
    const files = collectBlueprintFiles(absoluteTarget, extensions);
    scanned += files.length;

    for (const filePath of files) {
      const result = fixFile(filePath, args);
      if (result.changed) {
        changed += 1;
        console.log(`fixed ${path.relative(cwd, filePath)} [${result.reasons.join(',')}]`);
      }
    }
  }

  console.log(
    `${args.write ? 'write' : 'dry-run'} complete: scanned ${scanned} files, ${changed} file(s) would change.`
  );
}

main();
