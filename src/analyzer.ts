import { createHash } from 'node:crypto';
import { statSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import type { FileNode, ImportEdge, ExportInfo, ExportKind } from './types.js';

export interface PathAliases {
  [prefix: string]: string[];
}

export function loadPathAliases(projectRoot: string): PathAliases {
  const result: PathAliases = { _baseUrl: [projectRoot] };

  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  try {
    const raw = readFileSync(tsconfigPath, 'utf-8');
    const json = JSON.parse(raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''));
    const baseUrl = json.compilerOptions?.baseUrl
      ? path.resolve(projectRoot, json.compilerOptions.baseUrl)
      : projectRoot;
    result['_baseUrl'] = [baseUrl];
    for (const [alias, targets] of Object.entries(json.compilerOptions?.paths ?? {})) {
      result[alias] = (targets as string[]).map((t) => path.resolve(baseUrl, t));
    }
  } catch {}

  loadWorkspaceAliases(projectRoot, result);

  return result;
}

function findPackageEntry(dir: string): string | undefined {
  const candidates = [
    'src/index.ts', 'src/index.tsx', 'src/index.js',
    'index.ts', 'index.tsx', 'index.js',
  ];
  for (const c of candidates) {
    const full = path.join(dir, c);
    if (existsSync(full)) return full;
  }
  return undefined;
}

function loadWorkspaceAliases(projectRoot: string, result: PathAliases): void {
  const rootPkg = path.join(projectRoot, 'package.json');
  let workspaceGlobs: string[] = [];
  try {
    const d = JSON.parse(readFileSync(rootPkg, 'utf-8'));
    const ws = d.workspaces;
    if (Array.isArray(ws)) workspaceGlobs = ws;
    else if (Array.isArray(ws?.packages)) workspaceGlobs = ws.packages;
  } catch { return; }

  const expandedDirs: string[] = [];
  for (const pattern of workspaceGlobs) {
    if (pattern.endsWith('/*')) {
      const parent = path.join(projectRoot, pattern.slice(0, -2));
      try {
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (entry.isDirectory()) expandedDirs.push(path.join(parent, entry.name));
        }
      } catch {}
    } else {
      expandedDirs.push(path.join(projectRoot, pattern));
    }
  }

  for (const dir of expandedDirs) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const d = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const name = d.name;
      if (!name) continue;

      const entryPoint = findPackageEntry(dir);
      if (entryPoint) {
        result[name] = [entryPoint];
        result[name + '/*'] = [path.join(dir, '*')];
      }
    } catch {}
  }
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function countLines(content: string): number {
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) count++;
  }
  return count;
}

function resolveTarget(
  specifier: string,
  sourceDir: string,
  aliases: PathAliases,
  knownFiles: Set<string>
): string {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    const baseUrl = aliases['_baseUrl']?.[0];
    if (baseUrl) {
      const candidate = tryResolveFs(path.resolve(baseUrl, specifier), knownFiles);
      if (candidate) return candidate;
    }

    for (const alias in aliases) {
      if (alias === '_baseUrl') continue;
      const pattern = alias.endsWith('*') ? alias.slice(0, -1) : alias;
      if (specifier.startsWith(pattern)) {
        const rest = specifier.slice(pattern.length);
        const targets = aliases[alias];
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          const resolved = tryResolveFs((t.endsWith('*') ? t.slice(0, -1) : t) + rest, knownFiles);
          if (resolved) return resolved;
        }
      }
    }

    return '';
  }

  const base = path.resolve(sourceDir, specifier);
  return tryResolveFs(base, knownFiles) ?? base;
}

const JS_TO_TS: Record<string, string> = {
  '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts',
};

function tryResolveFs(base: string, knownFiles: Set<string>): string | undefined {
  if (knownFiles.has(base)) return base;

  const baseExt = path.extname(base);
  if (baseExt) {
    const tsExt = JS_TO_TS[baseExt];
    if (tsExt) {
      const c = base.slice(0, -baseExt.length) + tsExt;
      if (knownFiles.has(c)) return c;
    }
  }

  for (let i = 0; i < EXTENSIONS.length; i++) {
    const c = base + EXTENSIONS[i];
    if (knownFiles.has(c)) return c;
  }
  for (let i = 0; i < EXTENSIONS.length; i++) {
    const c = base + '/index' + EXTENSIONS[i];
    if (knownFiles.has(c)) return c;
  }
  return undefined;
}

function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const c = src.charCodeAt(i);
    if (c === 47) {
      const n = src.charCodeAt(i + 1);
      if (n === 47) {
        i += 2;
        while (i < len && src.charCodeAt(i) !== 10) i++;
        continue;
      }
      if (n === 42) {
        i += 2;
        while (i < len) {
          if (src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47) { i += 2; break; }
          i++;
        }
        out += ' ';
        continue;
      }
    }
    if (c === 96) {
      out += ' ';
      i++;
      while (i < len) {
        const t = src.charCodeAt(i);
        if (t === 96) { i++; break; }
        if (t === 92) i++;
        i++;
      }
      continue;
    }
    if (c === 34 || c === 39) {
      out += src[i];
      const q = c;
      i++;
      while (i < len) {
        const t = src.charCodeAt(i);
        out += src[i];
        if (t === q) { i++; break; }
        if (t === 92) { i++; if (i < len) { out += src[i]; } }
        i++;
      }
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

const STATIC_IMPORT_RE =
  /(?:^|;|\})\s*import\s+(?:type\s+)?(?:([\w$]+)(?:\s*,\s*)?)?(?:\*\s+as\s+([\w$]+))?(?:\{([^}]*)\})?\s*from\s+['"]([^'"]+)['"]/gm;

const SIDE_EFFECT_IMPORT_RE = /(?:^|;|\})\s*import\s+['"]([^'"]+)['"]/gm;

const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const EXPORT_NAMED_RE =
  /^\s*export\s+(?:(type)\s+)?(?:(default)\s+)?(function\*?|class|interface|type|enum|const|let|var|abstract\s+class|declare\s+\w+\s+)?\s*(\*\s+as\s+[\w$]+\s+from\s+['"][^'"]+['"]|[\w$]+)?/gm;

const EXPORT_FROM_RE =
  /^\s*export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gm;

const EXPORT_STAR_RE =
  /^\s*export\s+\*\s+(?:as\s+[\w$]+\s+)?from\s+['"]([^'"]+)['"]/gm;

function syntaxKindFromKeyword(kw: string | undefined): ExportKind {
  if (!kw) return 'unknown';
  const k = kw.trim();
  if (k.startsWith('function')) return 'function';
  if (k.startsWith('class') || k.startsWith('abstract')) return 'class';
  if (k === 'interface') return 'interface';
  if (k === 'type') return 'type';
  if (k === 'enum') return 'enum';
  if (k === 'const' || k === 'let' || k === 'var') return 'variable';
  if (k.startsWith('declare')) return 'unknown';
  return 'unknown';
}

function lineAt(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

function parseImports(
  src: string,
  stripped: string,
  sourceFilePath: string,
  sourceDir: string,
  aliases: PathAliases,
  knownFiles: Set<string>
): ImportEdge[] {
  const edges: ImportEdge[] = [];

  STATIC_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STATIC_IMPORT_RE.exec(stripped)) !== null) {
    const specifier = m[4];
    if (!specifier) continue;

    const defaultImport = m[1];
    const namespaceImport = m[2];
    const namedRaw = m[3];
    const named = namedRaw
      ? namedRaw.split(',').map((s) => s.trim().replace(/\s+as\s+\S+/, '').trim()).filter(Boolean)
      : [];

    const isTypeOnly = /^\s*import\s+type\s+/.test(stripped.slice(Math.max(0, m.index - 1), m.index + 20));

    const symbols = [
      ...(defaultImport ? [defaultImport] : []),
      ...(namespaceImport ? [namespaceImport] : []),
      ...named,
    ];

    edges.push({
      source: sourceFilePath,
      target: resolveTarget(specifier, sourceDir, aliases, knownFiles),
      rawSpecifier: specifier,
      symbols,
      isTypeOnly,
      isDynamic: false,
      line: lineAt(src, m.index),
    });
  }

  SIDE_EFFECT_IMPORT_RE.lastIndex = 0;
  while ((m = SIDE_EFFECT_IMPORT_RE.exec(stripped)) !== null) {
    const specifier = m[1];
    edges.push({
      source: sourceFilePath,
      target: resolveTarget(specifier, sourceDir, aliases, knownFiles),
      rawSpecifier: specifier,
      symbols: [],
      isTypeOnly: false,
      isDynamic: false,
      line: lineAt(src, m.index),
    });
  }

  DYNAMIC_IMPORT_RE.lastIndex = 0;
  while ((m = DYNAMIC_IMPORT_RE.exec(stripped)) !== null) {
    const specifier = m[1];
    edges.push({
      source: sourceFilePath,
      target: resolveTarget(specifier, sourceDir, aliases, knownFiles),
      rawSpecifier: specifier,
      symbols: [],
      isTypeOnly: false,
      isDynamic: true,
      line: lineAt(src, m.index),
    });
  }

  return edges;
}

function parseExports(src: string, stripped: string, sourceFilePath: string): ExportInfo[] {
  const exports: ExportInfo[] = [];
  const seen = new Set<string>();

  EXPORT_FROM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPORT_FROM_RE.exec(stripped)) !== null) {
    const names = m[1].split(',').map((s) => s.trim().replace(/\s+as\s+(\S+)/, '$1').trim()).filter(Boolean);
    const source = m[2];
    const line = lineAt(src, m.index);
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      exports.push({ name, kind: 'unknown', line, isReExport: true, reExportSource: source });
    }
  }

  EXPORT_STAR_RE.lastIndex = 0;
  while ((m = EXPORT_STAR_RE.exec(stripped)) !== null) {
    const line = lineAt(src, m.index);
    exports.push({ name: '*', kind: 'unknown', line, isReExport: true, reExportSource: m[1] });
  }

  EXPORT_NAMED_RE.lastIndex = 0;
  while ((m = EXPORT_NAMED_RE.exec(stripped)) !== null) {
    const keyword = m[3];
    const nameOrStar = m[4];
    if (!nameOrStar) continue;
    if (nameOrStar.startsWith('*')) continue;
    const isDefault = !!m[2];
    const name = isDefault ? 'default' : nameOrStar;
    if (seen.has(name)) continue;
    seen.add(name);
    const kind = isDefault ? 'unknown' : syntaxKindFromKeyword(keyword);
    exports.push({ name, kind, line: lineAt(src, m.index), isReExport: false });
  }

  return exports;
}

export function analyzeFileFromContent(
  filePath: string,
  content: string,
  projectRoot: string,
  aliases: PathAliases,
  knownFiles: Set<string>
): FileNode {
  const sourceDir = path.dirname(filePath);
  const stripped = stripComments(content);

  const imports = parseImports(content, stripped, filePath, sourceDir, aliases, knownFiles);
  const exports = parseExports(content, stripped, filePath);

  let sizeBytes = content.length;
  try { sizeBytes = statSync(filePath).size; } catch {}

  return {
    path: filePath,
    relativePath: path.relative(projectRoot, filePath),
    imports,
    exports,
    lastModified: Date.now(),
    hash: hashContent(content),
    sizeBytes,
    linesOfCode: countLines(content),
  };
}

export function analyzeFileAtPath(
  filePath: string,
  projectRoot: string,
  aliases: PathAliases,
  knownFiles: Set<string>
): FileNode | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  return analyzeFileFromContent(filePath, content, projectRoot, aliases, knownFiles);
}

const BATCH_SIZE = 200;
const MAX_CONCURRENT = 4;

export async function analyzeFiles(
  filePaths: string[],
  projectRoot: string,
  aliases: PathAliases,
  onProgress?: (done: number, total: number) => void
): Promise<FileNode[]> {
  const knownFiles = new Set(filePaths);
  const results: FileNode[] = new Array(filePaths.length);
  const total = filePaths.length;

  const batches: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < total; i += BATCH_SIZE) {
    batches.push({ start: i, end: Math.min(i + BATCH_SIZE, total) });
  }

  let batchIndex = 0;
  let done = 0;

  async function worker(): Promise<void> {
    while (batchIndex < batches.length) {
      const { start, end } = batches[batchIndex++];
      for (let i = start; i < end; i++) {
        const node = analyzeFileAtPath(filePaths[i], projectRoot, aliases, knownFiles);
        if (node) results[i] = node;
      }
      done += end - start;
      onProgress?.(Math.min(done, total), total);
      await new Promise((r) => setImmediate(r));
    }
  }

  const concurrency = Math.min(MAX_CONCURRENT, batches.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  return results.filter(Boolean);
}

export function analyzeFile(
  filePath: string,
  projectRoot: string,
  aliases: PathAliases,
  knownFiles: Set<string>
): FileNode | null {
  return analyzeFileAtPath(filePath, projectRoot, aliases, knownFiles);
}
