import * as path from 'node:path';
import type { GraphSummary } from './types.js';
import type { ScanResult } from './scanner.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const GRAY = '\x1b[90m';

function bold(s: string): string { return `${BOLD}${s}${RESET}`; }
function dim(s: string): string { return `${DIM}${s}${RESET}`; }
function red(s: string): string { return `${RED}${s}${RESET}`; }
function yellow(s: string): string { return `${YELLOW}${s}${RESET}`; }
function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }
function blue(s: string): string { return `${BLUE}${s}${RESET}`; }
function gray(s: string): string { return `${GRAY}${s}${RESET}`; }

function rel(filePath: string, projectRoot: string): string {
  return path.relative(projectRoot, filePath);
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function printHeader(): void {
  process.stdout.write('\n');
  process.stdout.write(`  ${CYAN}╭──────────────────────────────────────╮${RESET}\n`);
  process.stdout.write(`  ${CYAN}│${RESET}  ${bold('💥 whobreaks')} ${dim('v0.1.0')}                  ${CYAN}│${RESET}\n`);
  process.stdout.write(`  ${CYAN}│${RESET}  ${dim('Scanning your codebase...')}            ${CYAN}│${RESET}\n`);
  process.stdout.write(`  ${CYAN}╰──────────────────────────────────────╯${RESET}\n`);
  process.stdout.write('\n');
}

function printScanProgress(fileCount: number, elapsedMs: number): void {
  const elapsed = (elapsedMs / 1000).toFixed(1);
  process.stdout.write(`  ${BLUE}📁${RESET} Found ${bold(fmt(fileCount))} files\n`);
  process.stdout.write(`  ${BLUE}⏱️ ${RESET}  Analyzed in ${bold(elapsed + 's')}\n`);
  process.stdout.write('\n');
}

function printSummaryBox(summary: GraphSummary, projectRoot: string): void {
  const avgDepth = summary.avgDepth.toFixed(1);
  const maxDepthLabel = summary.maxDepthPath.length > 0
    ? dim(`(${rel(summary.maxDepthPath[summary.maxDepthPath.length - 1] ?? '', projectRoot)})`)
    : '';

  process.stdout.write(`  ${GRAY}┌─ Summary ──────────────────────────────┐${RESET}\n`);
  process.stdout.write(`  ${GRAY}│${RESET}                                        ${GRAY}│${RESET}\n`);
  process.stdout.write(`  ${GRAY}│${RESET}  Files:     ${bold(fmt(summary.totalFiles).padStart(12))}              ${GRAY}│${RESET}\n`);
  process.stdout.write(`  ${GRAY}│${RESET}  Edges:     ${bold(fmt(summary.totalEdges).padStart(12))}              ${GRAY}│${RESET}\n`);
  process.stdout.write(`  ${GRAY}│${RESET}  Avg depth: ${bold(avgDepth.padStart(12))}              ${GRAY}│${RESET}\n`);
  process.stdout.write(`  ${GRAY}│${RESET}  Max depth: ${bold(String(summary.maxDepth).padStart(12))} ${maxDepthLabel.padEnd(14)} ${GRAY}│${RESET}\n`);
  process.stdout.write(`  ${GRAY}│${RESET}                                        ${GRAY}│${RESET}\n`);
  process.stdout.write(`  ${GRAY}└────────────────────────────────────────┘${RESET}\n`);
  process.stdout.write('\n');
}

function printCircularDeps(summary: GraphSummary, projectRoot: string): void {
  if (summary.circularDependencies.length === 0) return;

  process.stdout.write(`  ${red('🔄 Circular Dependencies')} ${dim(`(${summary.circularDependencies.length})`)}\n`);

  const shown = summary.circularDependencies.slice(0, 5);
  for (const { cycle } of shown) {
    const parts = cycle.map((f) => cyan(rel(f, projectRoot)));
    const arrow = cycle.length === 2 ? ' ↔ ' : ' → ';
    process.stdout.write(`     ${parts.join(arrow)}\n`);
  }

  if (summary.circularDependencies.length > 5) {
    process.stdout.write(`     ${gray(`... +${summary.circularDependencies.length - 5} more`)}\n`);
  }
  process.stdout.write('\n');
}

function printOrphans(summary: GraphSummary, projectRoot: string): void {
  if (summary.orphanFiles.length === 0) return;

  process.stdout.write(`  ${yellow('🏝️  Orphan Files')} ${dim('— imported by nothing')} ${dim(`(${summary.orphanFiles.length})`)}\n`);

  const shown = summary.orphanFiles.slice(0, 8);
  for (const f of shown) {
    process.stdout.write(`     ${gray(rel(f, projectRoot))}\n`);
  }

  if (summary.orphanFiles.length > 8) {
    process.stdout.write(`     ${gray(`... +${summary.orphanFiles.length - 8} more`)}\n`);
  }
  process.stdout.write('\n');
}

function printGodModules(summary: GraphSummary, projectRoot: string): void {
  if (summary.godModules.length === 0) return;

  process.stdout.write(`  ${red('🕸️  God Modules')} ${dim('— imported by 20+ files')} ${dim(`(${summary.godModules.length})`)}\n`);

  for (const { path: filePath, dependentCount } of summary.godModules.slice(0, 5)) {
    const label = `${dependentCount} dependents`;
    process.stdout.write(`     ${cyan(rel(filePath, projectRoot).padEnd(42))} ${gray('→')} ${yellow(label)}\n`);
  }

  process.stdout.write('\n');
}

function printHighImpact(summary: GraphSummary, projectRoot: string): void {
  if (summary.highImpactFiles.length === 0) return;

  process.stdout.write(`  ${red('💣 High-Impact Files')} ${dim('— editing these affects the most files')}\n`);

  for (const { path: filePath, affectedCount } of summary.highImpactFiles.slice(0, 5)) {
    const label = `${affectedCount} files affected`;
    process.stdout.write(`     ${cyan(rel(filePath, projectRoot).padEnd(42))} ${gray('→')} ${yellow(label)}\n`);
  }

  process.stdout.write('\n');
}

function printFooter(projectRoot: string): void {
  const graphPath = path.join(projectRoot, '.whobreaks', 'graph.json');
  process.stdout.write(`  ${green('📁')} Output: ${dim(path.relative(process.cwd(), graphPath))}\n`);
  process.stdout.write('\n');
}

export function printScanResult(result: ScanResult, projectRoot: string): void {
  printHeader();
  printScanProgress(result.fileCount, result.elapsedMs);

  if (result.fileCount === 0) {
    process.stdout.write(`  ${yellow('No TypeScript/JavaScript files found.')}\n\n`);
    return;
  }

  printSummaryBox(result.summary, projectRoot);

  const hasIssues =
    result.summary.circularDependencies.length > 0 ||
    result.summary.orphanFiles.length > 0 ||
    result.summary.godModules.length > 0 ||
    result.summary.highImpactFiles.length > 0;

  if (hasIssues) {
    process.stdout.write(`  ${bold('⚠️  Issues Found:')}\n\n`);
    printCircularDeps(result.summary, projectRoot);
    printOrphans(result.summary, projectRoot);
    printGodModules(result.summary, projectRoot);
    printHighImpact(result.summary, projectRoot);
  } else {
    process.stdout.write(`  ${green('✅ No issues detected')}\n\n`);
  }

  printFooter(projectRoot);
}

export function printWatchEvent(event: 'change' | 'add' | 'unlink', filePath: string, projectRoot: string): void {
  const icons = { change: '~', add: '+', unlink: '-' };
  const colors = { change: yellow, add: green, unlink: red };
  const icon = icons[event];
  const color = colors[event];
  process.stdout.write(`  ${color(icon)} ${dim(rel(filePath, projectRoot))} ${gray(new Date().toLocaleTimeString())}\n`);
}

export function printWatchHeader(projectRoot: string): void {
  process.stdout.write('\n');
  process.stdout.write(`  ${CYAN}╭──────────────────────────────────────╮${RESET}\n`);
  process.stdout.write(`  ${CYAN}│${RESET}  ${bold('💥 whobreaks')} ${dim('— watch mode')}             ${CYAN}│${RESET}\n`);
  process.stdout.write(`  ${CYAN}│${RESET}  ${dim(`Watching: ${path.relative(process.cwd(), projectRoot) || '.'}`)}             ${CYAN}│${RESET}\n`);
  process.stdout.write(`  ${CYAN}╰──────────────────────────────────────╯${RESET}\n`);
  process.stdout.write('\n');
}
