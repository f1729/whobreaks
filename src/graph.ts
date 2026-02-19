import type {
  DependencyGraph,
  FileNode,
  ImpactAnalysis,
  CircularDependency,
  GraphSummary,
} from './types.js';

export function createGraph(projectRoot: string): DependencyGraph {
  return {
    nodes: new Map(),
    dependents: new Map(),
    dependencies: new Map(),
    projectRoot,
    lastUpdate: Date.now(),
  };
}

export function addNode(graph: DependencyGraph, node: FileNode): void {
  const existing = graph.nodes.get(node.path);
  if (existing) {
    removeNodeEdges(graph, existing);
  }

  graph.nodes.set(node.path, node);

  if (!graph.dependencies.has(node.path)) {
    graph.dependencies.set(node.path, new Set());
  }
  if (!graph.dependents.has(node.path)) {
    graph.dependents.set(node.path, new Set());
  }

  for (const imp of node.imports) {
    if (!imp.target) continue;

    graph.dependencies.get(node.path)!.add(imp.target);

    if (!graph.dependents.has(imp.target)) {
      graph.dependents.set(imp.target, new Set());
    }
    graph.dependents.get(imp.target)!.add(node.path);

    if (!graph.dependencies.has(imp.target)) {
      graph.dependencies.set(imp.target, new Set());
    }
  }

  graph.lastUpdate = Date.now();
}

export function removeNode(graph: DependencyGraph, filePath: string): void {
  const node = graph.nodes.get(filePath);
  if (!node) return;

  removeNodeEdges(graph, node);
  graph.nodes.delete(filePath);
  graph.dependencies.delete(filePath);
  graph.dependents.delete(filePath);
  graph.lastUpdate = Date.now();
}

function removeNodeEdges(graph: DependencyGraph, node: FileNode): void {
  for (const imp of node.imports) {
    if (!imp.target) continue;
    graph.dependents.get(imp.target)?.delete(node.path);
    graph.dependencies.get(node.path)?.delete(imp.target);
  }
}

export function getImpact(
  graph: DependencyGraph,
  filePath: string
): ImpactAnalysis {
  const direct = Array.from(graph.dependents.get(filePath) ?? []);

  const visited = new Set<string>();
  const queue = [...direct];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const upstreamDeps = graph.dependents.get(current);
    if (upstreamDeps) {
      for (const dep of upstreamDeps) {
        if (!visited.has(dep)) queue.push(dep);
      }
    }
  }

  const transitive = Array.from(visited).filter((f) => !direct.includes(f));

  const node = graph.nodes.get(filePath);
  const criticalExports =
    node?.exports
      .filter((exp) => {
        const users = direct.filter((dep) => {
          const depNode = graph.nodes.get(dep);
          return depNode?.imports.some(
            (imp) => imp.target === filePath && imp.symbols.includes(exp.name)
          );
        });
        return users.length > 3;
      })
      .map((e) => e.name) ?? [];

  return {
    file: filePath,
    directDependents: direct,
    transitiveDependents: transitive,
    totalAffected: direct.length + transitive.length,
    criticalExports,
  };
}

export function detectCircularDependencies(
  graph: DependencyGraph
): CircularDependency[] {
  const cycles: CircularDependency[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycleSet = new Set<string>();

  function dfs(node: string, path: string[]): void {
    visited.add(node);
    inStack.add(node);

    const deps = graph.dependencies.get(node) ?? new Set();
    for (const dep of deps) {
      if (!graph.nodes.has(dep)) continue;

      if (!visited.has(dep)) {
        dfs(dep, [...path, node]);
      } else if (inStack.has(dep)) {
        const cycleStart = path.indexOf(dep);
        const cycle = cycleStart >= 0
          ? [...path.slice(cycleStart), node, dep]
          : [...path, node, dep];

        const cycleKey = [...cycle].sort().join('|');
        if (!cycleSet.has(cycleKey)) {
          cycleSet.add(cycleKey);
          cycles.push({ cycle });
        }
      }
    }

    inStack.delete(node);
  }

  for (const nodePath of graph.nodes.keys()) {
    if (!visited.has(nodePath)) {
      dfs(nodePath, []);
    }
  }

  return cycles;
}

export function computeMaxDepth(
  graph: DependencyGraph
): { maxDepth: number; path: string[] } {
  let maxDepth = 0;
  let maxPath: string[] = [];

  function dfs(node: string, path: string[], visited: Set<string>): void {
    if (path.length > maxDepth) {
      maxDepth = path.length;
      maxPath = [...path];
    }

    const deps = graph.dependencies.get(node) ?? new Set();
    for (const dep of deps) {
      if (!graph.nodes.has(dep) || visited.has(dep)) continue;
      visited.add(dep);
      dfs(dep, [...path, dep], visited);
      visited.delete(dep);
    }
  }

  for (const nodePath of graph.nodes.keys()) {
    dfs(nodePath, [nodePath], new Set([nodePath]));
  }

  return { maxDepth, path: maxPath };
}

export function getSummary(graph: DependencyGraph): GraphSummary {
  const totalFiles = graph.nodes.size;

  let totalEdges = 0;
  for (const deps of graph.dependencies.values()) {
    totalEdges += deps.size;
  }

  const orphanFiles: string[] = [];
  const godModules: Array<{ path: string; dependentCount: number }> = [];
  const highImpactFiles: Array<{ path: string; affectedCount: number }> = [];

  let maxDependents = 0;
  let maxDependentsFile = '';
  let totalDependents = 0;

  for (const [filePath, deps] of graph.dependents.entries()) {
    if (!graph.nodes.has(filePath)) continue;

    const count = deps.size;
    totalDependents += count;

    if (count === 0) {
      orphanFiles.push(filePath);
    }

    if (count > maxDependents) {
      maxDependents = count;
      maxDependentsFile = filePath;
    }

    if (count >= 20) {
      godModules.push({ path: filePath, dependentCount: count });
    }
  }

  godModules.sort((a, b) => b.dependentCount - a.dependentCount);

  for (const filePath of graph.nodes.keys()) {
    const impact = getImpact(graph, filePath);
    if (impact.totalAffected >= 10) {
      highImpactFiles.push({ path: filePath, affectedCount: impact.totalAffected });
    }
  }

  highImpactFiles.sort((a, b) => b.affectedCount - a.affectedCount);

  const avgDependentsPerFile = totalFiles > 0 ? totalDependents / totalFiles : 0;

  const circularDependencies = detectCircularDependencies(graph);
  const { maxDepth, path: maxDepthPath } = computeMaxDepth(graph);

  const avgDepth = maxDepth / 2;

  return {
    totalFiles,
    totalEdges,
    avgDependentsPerFile,
    maxDependents,
    maxDependentsFile,
    avgDepth,
    maxDepth,
    maxDepthPath,
    orphanFiles,
    godModules,
    circularDependencies,
    highImpactFiles,
  };
}

export function serializeGraph(graph: DependencyGraph): object {
  const nodes = Array.from(graph.nodes.values()).map((node) => ({
    ...node,
    imports: node.imports,
    exports: node.exports,
    dependentCount: graph.dependents.get(node.path)?.size ?? 0,
    dependencyCount: graph.dependencies.get(node.path)?.size ?? 0,
  }));

  const edgeSet = new Set<string>();
  const edges: Array<{ source: string; target: string; symbols: string[] }> = [];
  for (const node of graph.nodes.values()) {
    for (const imp of node.imports) {
      if (!imp.target || !graph.nodes.has(imp.target)) continue;
      const key = node.path + '|' + imp.target;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ source: node.path, target: imp.target, symbols: imp.symbols });
    }
  }

  return {
    version: '0.1.0',
    projectRoot: graph.projectRoot,
    lastUpdate: graph.lastUpdate,
    nodes,
    edges,
  };
}
