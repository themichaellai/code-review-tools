#!/usr/bin/env bun

import { $ } from 'bun';
import path from 'path';
import fs from 'fs';
import { Buffer } from 'buffer';
import madge from 'madge';

$.throws(true);

if (process.argv.length < 3) {
  console.error('Usage: git pr-graph <dir>');
  process.exit(1);
}

const readFileMaybe = (path: string): Record<string, any> | null => {
  try {
    const contents = fs.readFileSync(path);
    return JSON.parse(contents.toString());
  } catch {
    return null;
  }
};

const findMonorepoRoot = async (dirPath: string) => {
  let cwd = dirPath;
  // Look to see if there's a package.json with a workspaces property. If not,
  // go up a directory
  let iters = 0;
  while (iters < 20) {
    const pkg = readFileMaybe(path.join(cwd, 'package.json'));
    if (pkg != null && pkg['workspaces']) {
      return cwd;
    }
    const next = path.join(cwd, '..');
    if (next === cwd) {
      throw new Error('could not find monorepo root');
    }
    cwd = next;
    iters++;
  }
  throw new Error('could not find monorepo root');
};
const tmpFileName = () =>
  `/tmp/git-pr-graph-${Math.random().toString(36).substring(7)}`;

const convertMadgeGraphToAbsolutePaths = (
  monorepoRootAbsolute: string,
  madgeRootAbsolute: string,
  relative: MadgeOutput,
) => {
  const convert = (p: string) =>
    path.relative(monorepoRootAbsolute, path.join(madgeRootAbsolute, p));
  return Object.fromEntries(
    Object.entries(relative).map(([edgeLeftRelative, edgesRightRelative]) => [
      convert(edgeLeftRelative),
      edgesRightRelative.map(convert),
    ]),
  );
};

const topologicalSortMadgeOutput = async (madgeOutput: MadgeOutput) => {
  const edges = Object.entries(madgeOutput).flatMap(([k, vs]) =>
    vs.map((v) => `${v} ${k}`),
  );
  const tmpPath = tmpFileName();
  fs.writeFileSync(tmpPath, edges.join('\n'));
  const sorted = await $`tsort < ${tmpPath}`.text();
  return sorted.trim().split('\n');
};

const popFromSet = <T,>(set: Set<T>): T => {
  const value = set.values().next().value;
  set.delete(value);
  return value;
};

const createBidirectionalAdjList = (
  graph: MadgeOutput,
): Map<string, [outgoing: Set<string>, incoming: Set<string>]> => {
  const adjList = new Map<
    string,
    [outgoing: Set<string>, incoming: Set<string>]
  >();
  const toVisit = new Set(Object.keys(graph));
  while (toVisit.size > 0) {
    const node = popFromSet(toVisit);
    const outgoing = graph[node];
    const incomingSet = adjList.get(node)?.[1] ?? new Set<string>();
    adjList.set(node, [new Set(outgoing), incomingSet]);
    for (const out of outgoing) {
      const curr = adjList.get(out);
      if (curr != null) {
        curr[1].add(node);
      } else {
        adjList.set(out, [new Set<string>(), new Set([node])]);
      }
    }
  }
  return adjList;
};

/**
 * Given a directed graph, removes nodes that are not in the given set. For
 * nodes that are removed, nodes from their incoming edges are connected to
 * nodes from the outgoing edges.
 */
const filterNodes = (
  graph: MadgeOutput,
  toInclude: Set<string>,
): MadgeOutput => {
  const adjList = createBidirectionalAdjList(graph);

  const filteredAdjList = new Map<string, Set<string>>();
  const toVisit = new Set<string>(adjList.keys());
  while (toVisit.size > 0) {
    const node = popFromSet(toVisit);
    const edges = adjList.get(node);
    if (toInclude.has(node)) {
      // Include the node -- copy over edges
      const outgoing = edges?.[0] == null ? [] : Array.from(edges[0]);
      filteredAdjList.set(
        node,
        new Set<string>(outgoing.filter((n) => toInclude.has(n))),
      );
    } else {
      // Filter out the node -- connect incoming to outgoing
      if (edges == null) {
        // Probably shouldn't happen
        continue;
      }
      const [outgoing, incoming] = edges;
      for (const incomingNode of incoming) {
        const incomingNodeEdges = adjList.get(incomingNode);
        if (incomingNodeEdges == null) {
          // Probably shouldn't happen
          continue;
        }
        incomingNodeEdges[0].delete(node);
        const newOutgoing = incomingNodeEdges[0].union(outgoing);
        adjList.set(incomingNode, [newOutgoing, incomingNodeEdges[1]]);
      }
    }
  }
  return Object.fromEntries(
    Array.from(filteredAdjList.entries()).map(([k, v]) => [k, Array.from(v)]),
  );
};

const generateDotGraph = async (
  graph: MadgeOutput,
  outputGraph: string,
): Promise<void> => {
  const dotGraph = `digraph G {
    ${Object.entries(graph)
      .map(([node, edges]) =>
        edges.map((edge) => `"${node}" -> "${edge}";`).join('\n'),
      )
      .join('\n')}
  }`;
  await $`dot -Tsvg -o ${outputGraph} < ${Buffer.from(dotGraph)}`;
};

/** A directed graph */
type MadgeOutput = Record<string, Array<string>>;

const main = async () => {
  const packageArg = process.argv[2];

  const srcRoot = `${packageArg}/src`;
  const madgeOutput = (await madge(srcRoot, {
    tsConfig: `${packageArg}/tsconfig.json`,
    fileExtensions: ['ts', 'tsx'],
  })).obj();

  const monoRoot = await findMonorepoRoot(srcRoot);
  $.cwd(monoRoot);

  const MERGE_BASE = process.env['MERGE_BASE'] ?? 'origin/main';
  const mergeBase = (await $`git merge-base HEAD ${MERGE_BASE}`.text()).trim();
  // Changed files are relative to monorepo root
  const changedFiles = new Set(
    (await $`git diff --name-only ${mergeBase}`.text())
      .split('\n')
      .filter((l) => l),
  );

  // Convert madge output paths to be relative to monorepo
  const madgeOutputRelativeToMonorepoRoot = convertMadgeGraphToAbsolutePaths(
    monoRoot,
    srcRoot,
    madgeOutput,
  );

  const res = filterNodes(madgeOutputRelativeToMonorepoRoot, changedFiles);
  const graphName = `${tmpFileName()}.svg`;
  await generateDotGraph(res, `${graphName}`);
  console.error(`wrote to ${graphName}`);

  const madgeTopoSorted = await topologicalSortMadgeOutput(
    madgeOutputRelativeToMonorepoRoot,
  );

  for (const path of madgeTopoSorted.filter((p) => changedFiles.has(p))) {
    console.log(path);
  }
};

await main();

