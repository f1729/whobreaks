export interface ImportEdge {
  source: string;
  target: string;
  rawSpecifier: string;
  symbols: string[];
  isTypeOnly: boolean;
  isDynamic: boolean;
  line: number;
}

export type ExportKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'enum'
  | 'namespace'
  | 'unknown';

export interface ExportInfo {
  name: string;
  kind: ExportKind;
  line: number;
  isReExport: boolean;
  reExportSource?: string;
}

export interface FileNode {
  path: string;
  relativePath: string;
  imports: ImportEdge[];
  exports: ExportInfo[];
  lastModified: number;
  hash: string;
  sizeBytes: number;
  linesOfCode: number;
}

export interface DependencyGraph {
  nodes: Map<string, FileNode>;
  dependents: Map<string, Set<string>>;
  dependencies: Map<string, Set<string>>;
  projectRoot: string;
  lastUpdate: number;
}

export interface ImpactAnalysis {
  file: string;
  directDependents: string[];
  transitiveDependents: string[];
  totalAffected: number;
  criticalExports: string[];
}

export interface CircularDependency {
  cycle: string[];
}

export interface GraphSummary {
  totalFiles: number;
  totalEdges: number;
  avgDependentsPerFile: number;
  maxDependents: number;
  maxDependentsFile: string;
  avgDepth: number;
  maxDepth: number;
  maxDepthPath: string[];
  orphanFiles: string[];
  godModules: Array<{ path: string; dependentCount: number }>;
  circularDependencies: CircularDependency[];
  highImpactFiles: Array<{ path: string; affectedCount: number }>;
}

export interface ScanOptions {
  projectRoot: string;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
}
