/**
 * bundle-docs.js
 *
 * Reads all markdown files from your local builder-docs clone and bundles
 * them into data/docs.json for use by the support bot.
 *
 * Usage:
 *   npm run bundle-docs
 *
 * Run this any time you push updates to builder-docs and want the bot to
 * reflect the latest content. Then commit and push this repo.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// Path to your local builder-docs clone. Override with env var if needed.
const DOCS_ROOT = process.env.BUILDER_DOCS_PATH ||
  path.join(os.homedir(), 'Documents', 'builder-docs', 'docs');

const OUTPUT_PATH = path.join(process.cwd(), 'data', 'docs.json');

// Files to skip — these are nav/config stubs with little useful content
const SKIP_FILES = new Set([
  'index.md',
  'README.md',
]);

function parseFrontMatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { title: null, body: content };

  const frontMatter = match[1];
  const body = content.slice(match[0].length).trim();

  const titleMatch = frontMatter.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const title = titleMatch ? titleMatch[1] : null;

  return { title, body };
}

function collectMarkdownFiles(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

function relPath(fullPath) {
  return path.relative(path.join(os.homedir(), 'Documents', 'builder-docs'), fullPath);
}

// --- Main ---

if (!fs.existsSync(DOCS_ROOT)) {
  console.error(`Error: builder-docs not found at ${DOCS_ROOT}`);
  console.error('Set BUILDER_DOCS_PATH env var to override the default path.');
  process.exit(1);
}

const files = collectMarkdownFiles(DOCS_ROOT);
const docs = [];

for (const filePath of files) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { title, body } = parseFrontMatter(raw);

  // Skip nearly-empty files
  if (body.trim().length < 100) continue;

  const rel = relPath(filePath);
  const derivedTitle = title || path.basename(filePath, '.md')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  docs.push({
    title: derivedTitle,
    path: rel,
    content: body,
  });
}

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(docs, null, 2));

console.log(`Bundled ${docs.length} docs → ${OUTPUT_PATH}`);
docs.forEach(d => console.log(`  [${d.title}] ${d.path}`));
