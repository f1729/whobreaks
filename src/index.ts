#!/usr/bin/env node
import * as path from 'node:path';
import { scanProject, persistGraph } from './scanner.js';
import { printScanResult } from './reporter.js';

function resolveProjectRoot(arg?: string): string {
  if (!arg || arg === '.') return process.cwd();
  return path.resolve(process.cwd(), arg);
}

function parseArgs(argv: string[]): {
  command: string;
  projectRoot: string;
  flags: Record<string, string | boolean>;
} {
  const args = argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  const knownCommands = new Set(['scan', 'watch', 'mcp']);
  const firstArg = positional[0];
  const command = firstArg && knownCommands.has(firstArg) ? firstArg : 'scan';
  const pathArg = knownCommands.has(firstArg ?? '') ? positional[1] : positional[0];
  const projectRoot = resolveProjectRoot(pathArg);

  return { command, projectRoot, flags };
}

async function runScan(projectRoot: string, flags: Record<string, string | boolean>): Promise<void> {
  const maxFiles = flags['max-files'] ? parseInt(flags['max-files'] as string, 10) : undefined;
  const port = flags['port'] ? parseInt(flags['port'] as string, 10) : undefined;

  const result = await scanProject({ projectRoot, maxFiles });

  printScanResult(result, projectRoot);
  persistGraph(result.graph, projectRoot);

  if (port) {
    const { createApiServer } = await import('./server.js');
    const graphRef = { current: result.graph };
    createApiServer(graphRef, port).listen();
    process.stdout.write('  Press Ctrl+C to stop.\n\n');
    process.on('SIGINT', () => { process.stdout.write('\n  Stopped.\n\n'); process.exit(0); });
    await new Promise(() => {});
  }
}

async function runWatch(projectRoot: string, flags: Record<string, string | boolean>): Promise<void> {
  const { printWatchHeader, printWatchEvent } = await import('./reporter.js');
  const { analyzeFile, loadPathAliases } = await import('./analyzer.js');
  const { addNode, removeNode } = await import('./graph.js');
  const { createApiServer } = await import('./server.js');
  const chokidar = await import('chokidar');

  const port = flags['port'] ? parseInt(flags['port'] as string, 10) : 3001;
  const maxFiles = flags['max-files'] ? parseInt(flags['max-files'] as string, 10) : undefined;

  printWatchHeader(projectRoot);
  process.stdout.write('  Running initial scan...\n\n');

  const result = await scanProject({ projectRoot, maxFiles });
  printScanResult(result, projectRoot);
  persistGraph(result.graph, projectRoot);

  const { graph } = result;
  const graphRef = { current: graph };

  const api = createApiServer(graphRef, port);
  api.listen();
  process.stdout.write('\n');

  const aliases = loadPathAliases(projectRoot);

  let debounceTimer: NodeJS.Timeout | null = null;
  const pendingChanges = new Map<string, 'change' | 'add' | 'unlink'>();

  function queueChange(filePath: string, event: 'change' | 'add' | 'unlink'): void {
    const absPath = path.join(projectRoot, filePath);
    pendingChanges.set(absPath, event);
    printWatchEvent(event, absPath, projectRoot);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void processBatch(), 200);
  }

  async function processBatch(): Promise<void> {
    const changes = new Map(pendingChanges);
    pendingChanges.clear();

    for (const [absPath, event] of changes.entries()) {
      if (event === 'unlink') {
        removeNode(graph, absPath);
        continue;
      }
      const node = analyzeFile(absPath, projectRoot, aliases, new Set(graph.nodes.keys()));
      if (node) addNode(graph, node);
    }

    persistGraph(graph, projectRoot);

    let edgeCount = 0;
    for (const deps of graph.dependencies.values()) edgeCount += deps.size;
    process.stdout.write(`  \x1b[90mGraph updated — ${graph.nodes.size} files, ${edgeCount} edges\x1b[0m\n`);
  }

  const watcher = chokidar.watch(
    ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mts', '**/*.mjs'],
    {
      cwd: projectRoot,
      ignored: ['node_modules/**', '.whobreaks/**', 'dist/**', 'build/**'],
      persistent: true,
      ignoreInitial: true,
    }
  );

  watcher
    .on('change', (p) => queueChange(p, 'change'))
    .on('add', (p) => queueChange(p, 'add'))
    .on('unlink', (p) => queueChange(p, 'unlink'));

  process.stdout.write('  Watching for changes... (Ctrl+C to stop)\n\n');

  process.on('SIGINT', () => {
    watcher.close();
    api.close();
    process.stdout.write('\n  Stopped.\n\n');
    process.exit(0);
  });
}

async function runMcp(projectRoot: string): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const { getImpact } = await import('./graph.js');

  const result = await scanProject({ projectRoot });
  const { graph } = result;

  const server = new McpServer({
    name: 'whobreaks',
    version: '0.1.0',
  });

  server.tool(
    'get_impact',
    'Check what files will be affected if you edit this file. Use this before making changes.',
    { file: z.string().describe('File path relative to project root') },
    async ({ file }: { file: string }) => {
      const absPath = path.resolve(projectRoot, file);
      const impact = getImpact(graph, absPath);
      const rel = (p: string) => path.relative(projectRoot, p);

      if (impact.totalAffected === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Editing ${file} affects 0 other files (safe to change).`,
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Editing ${file} will affect ${impact.totalAffected} files:`,
            '',
            `Direct dependents (${impact.directDependents.length}):`,
            ...impact.directDependents.map((f) => `  - ${rel(f)}`),
            '',
            `Transitive dependents (${impact.transitiveDependents.length}):`,
            ...impact.transitiveDependents.slice(0, 20).map((f) => `  - ${rel(f)}`),
            impact.transitiveDependents.length > 20
              ? `  ... +${impact.transitiveDependents.length - 20} more`
              : '',
            impact.criticalExports.length > 0
              ? `\nHigh-usage exports: ${impact.criticalExports.join(', ')}`
              : '',
          ].filter(Boolean).join('\n'),
        }],
      };
    }
  );

  server.tool(
    'get_context',
    'Get architectural context for a file before editing it',
    { file: z.string().describe('File path relative to project root') },
    async ({ file }: { file: string }) => {
      const absPath = path.resolve(projectRoot, file);
      const node = graph.nodes.get(absPath);
      const rel = (p: string) => path.relative(projectRoot, p);

      if (!node) {
        return {
          content: [{
            type: 'text' as const,
            text: `File not found in graph: ${file}. Run 'architect .' first.`,
          }],
        };
      }

      const deps = Array.from(graph.dependencies.get(absPath) ?? []);
      const dependents = Array.from(graph.dependents.get(absPath) ?? []);
      const riskLevel =
        dependents.length > 20 ? 'HIGH' :
        dependents.length > 5 ? 'MEDIUM' : 'LOW';

      return {
        content: [{
          type: 'text' as const,
          text: [
            `## ${file}`,
            '',
            `Imports from (${deps.length}): ${deps.map(rel).join(', ') || 'nothing'}`,
            `Imported by (${dependents.length}): ${dependents.map(rel).join(', ') || 'nothing'}`,
            `Exports: ${node.exports.map((e) => `${e.name} (${e.kind})`).join(', ') || 'nothing'}`,
            `Risk level: ${riskLevel} (${dependents.length} dependents)`,
            `Lines: ${node.linesOfCode}`,
          ].join('\n'),
        }],
      };
    }
  );

  server.tool(
    'find_related',
    'Find files related to a path pattern or module name',
    { query: z.string().describe('Partial file path or module name to search for') },
    async ({ query }: { query: string }) => {
      const rel = (p: string) => path.relative(projectRoot, p);
      const matches = Array.from(graph.nodes.values()).filter((n) =>
        n.relativePath.includes(query) || n.path.includes(query)
      );

      if (matches.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No files found matching: ${query}`,
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: matches.map((f) => {
            const dependentCount = graph.dependents.get(f.path)?.size ?? 0;
            return `${rel(f.path)} (${dependentCount} dependents, exports: ${f.exports.map((e) => e.name).join(', ')})`;
          }).join('\n'),
        }],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function printHelp(): void {
  process.stdout.write(`
  ${'\x1b[1m'}whobreaks${'\x1b[0m'} — find out what breaks before you touch a file

  ${'\x1b[90m'}Usage:${'\x1b[0m'}
    npx whobreaks [path]              Scan a project (default: current directory)
    npx whobreaks watch [path]        Watch mode + live HTTP API server
    npx whobreaks mcp                 MCP server (uses current directory)

  ${'\x1b[90m'}Options:${'\x1b[0m'}
    --port <n>                        HTTP API port for watch/serve (default: 3001)
    --max-files <n>                   Limit files scanned
    --help                            Show this help

  ${'\x1b[90m'}MCP install (run once per project):${'\x1b[0m'}
    claude mcp add whobreaks npx whobreaks mcp

  ${'\x1b[90m'}MCP tools:${'\x1b[0m'}
    get_impact      What breaks if I edit this file?
    get_context     Architecture context for a file
    find_related    Find files matching a path/name pattern

  ${'\x1b[90m'}HTTP API (available in watch mode):${'\x1b[0m'}
    GET /health                       Server status + file/edge counts
    GET /graph                        Full dependency graph (JSON)
    GET /summary                      Architecture summary
    GET /impact?file=src/foo.ts       Impact analysis for a file
    GET /dependents?file=src/foo.ts   Files that import this file
    GET /dependencies?file=src/foo.ts Files this file imports
    GET /node?file=src/foo.ts         Full node details

  ${'\x1b[90m'}Examples:${'\x1b[0m'}
    npx whobreaks .
    npx whobreaks watch . --port 3001
    npx whobreaks mcp

`);
}

async function main(): Promise<void> {
  const { command, projectRoot, flags } = parseArgs(process.argv);

  if (flags['help'] || flags['h']) {
    printHelp();
    return;
  }

  switch (command) {
    case 'scan':
    case '.':
      await runScan(projectRoot, flags);
      break;

    case 'watch':
      await runWatch(projectRoot, flags);
      break;

    case 'mcp':
      await runMcp(projectRoot);
      break;

    default:
      await runScan(projectRoot, flags);
  }
}

main().catch((err) => {
  process.stderr.write(`\nError: ${err.message}\n`);
  process.exit(1);
});
