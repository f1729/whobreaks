import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DependencyGraph } from './types.js';
import { getImpact, getSummary, serializeGraph } from './graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dashboardHtml: string | null = null;
function getDashboardHtml(): string {
  if (!dashboardHtml) {
    const candidates = [
      path.join(__dirname, 'dashboard.html'),
      path.join(__dirname, '../src/dashboard.html'),
    ];
    for (const candidate of candidates) {
      try {
        dashboardHtml = readFileSync(candidate, 'utf-8');
        break;
      } catch {}
    }
    if (!dashboardHtml) dashboardHtml = '<h1>Dashboard not found</h1>';
  }
  return dashboardHtml;
}

function respond(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function notFound(res: ServerResponse, message: string): void {
  respond(res, { error: message }, 404);
}

function badRequest(res: ServerResponse, message: string): void {
  respond(res, { error: message }, 400);
}

function totalEdges(graph: DependencyGraph): number {
  let count = 0;
  for (const deps of graph.dependencies.values()) count += deps.size;
  return count;
}

export function createApiServer(
  graphRef: { current: DependencyGraph },
  port = 3001
): { listen: () => void; close: () => void } {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      respond(res, { error: 'Method not allowed' }, 405);
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const route = url.pathname;
    const graph = graphRef.current;

    if (route === '/' || route === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHtml());
      return;
    }

    if (route === '/health') {
      respond(res, {
        status: 'ok',
        files: graph.nodes.size,
        edges: totalEdges(graph),
        lastUpdate: graph.lastUpdate,
        projectRoot: graph.projectRoot,
      });
      return;
    }

    if (route === '/graph') {
      respond(res, serializeGraph(graph));
      return;
    }

    if (route === '/summary') {
      respond(res, getSummary(graph));
      return;
    }

    if (route === '/dependents') {
      const file = url.searchParams.get('file');
      if (!file) { badRequest(res, 'Missing ?file= parameter'); return; }

      const absPath = path.isAbsolute(file) ? file : path.join(graph.projectRoot, file);
      const deps = Array.from(graph.dependents.get(absPath) ?? []).map((p) =>
        path.relative(graph.projectRoot, p)
      );
      respond(res, { file, dependents: deps, count: deps.length });
      return;
    }

    if (route === '/dependencies') {
      const file = url.searchParams.get('file');
      if (!file) { badRequest(res, 'Missing ?file= parameter'); return; }

      const absPath = path.isAbsolute(file) ? file : path.join(graph.projectRoot, file);
      const deps = Array.from(graph.dependencies.get(absPath) ?? []).map((p) =>
        path.relative(graph.projectRoot, p)
      );
      respond(res, { file, dependencies: deps, count: deps.length });
      return;
    }

    if (route === '/impact') {
      const file = url.searchParams.get('file');
      if (!file) { badRequest(res, 'Missing ?file= parameter'); return; }

      const absPath = path.isAbsolute(file) ? file : path.join(graph.projectRoot, file);
      if (!graph.nodes.has(absPath)) {
        notFound(res, `File not in graph: ${file}`);
        return;
      }

      const impact = getImpact(graph, absPath);
      const rel = (p: string) => path.relative(graph.projectRoot, p);
      respond(res, {
        file,
        directDependents: impact.directDependents.map(rel),
        transitiveDependents: impact.transitiveDependents.map(rel),
        totalAffected: impact.totalAffected,
        criticalExports: impact.criticalExports,
      });
      return;
    }

    if (route === '/node') {
      const file = url.searchParams.get('file');
      if (!file) { badRequest(res, 'Missing ?file= parameter'); return; }

      const absPath = path.isAbsolute(file) ? file : path.join(graph.projectRoot, file);
      const node = graph.nodes.get(absPath);
      if (!node) { notFound(res, `File not in graph: ${file}`); return; }

      respond(res, {
        ...node,
        relativePath: path.relative(graph.projectRoot, node.path),
        dependentCount: graph.dependents.get(absPath)?.size ?? 0,
        dependencyCount: graph.dependencies.get(absPath)?.size ?? 0,
      });
      return;
    }

    notFound(res, `Unknown route: ${route}. Available: /health /graph /summary /dependents /dependencies /impact /node`);
  });

  return {
    listen() {
      server.listen(port, '127.0.0.1', () => {
        process.stdout.write(`  \x1b[90mDashboard: \x1b[0m\x1b[36mhttp://localhost:${port}\x1b[0m\n`);
        process.stdout.write(`  \x1b[90mAPI:       http://localhost:${port}/graph\x1b[0m\n`);
      });
    },
    close() {
      server.close();
    },
  };
}
