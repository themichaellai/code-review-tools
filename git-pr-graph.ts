import { $ } from 'bun';
import path from 'path';
import fs from 'fs';

$.throws(true);

if (process.argv.length < 3) {
  console.error('Usage: madge <dir>');
  process.exit(1);
}

const findMonorepoRoot = async () => {
  let cwd = process.cwd();
  // Look to see if there's a package.json with a workspaces property. If not,
  // go up a directory
  let iters = 0;
  while (iters < 20) {
    const pkg = require(path.join(cwd, 'package.json'));
    if (pkg.workspaces) {
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
  `/tmp/git-madge2-${Math.random().toString(36).substring(7)}`;

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

type MadgeOutput = Record<string, Array<string>>

const main = async () => {
  const packageArg = process.argv[2];

  const madgeOutputPath = tmpFileName();
  const srcRoot = `${packageArg}/src`;
  await $`madge --extensions ts,tsx --json --ts-config ${packageArg}/tsconfig.json ${srcRoot} > ${madgeOutputPath}`;
  // Madge output is relative to src root
  const madgeOutput = JSON.parse(fs.readFileSync(madgeOutputPath, 'utf8')) as MadgeOutput;

  const monoRoot = await findMonorepoRoot();

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

  const madgeTopoSorted = await topologicalSortMadgeOutput(
    madgeOutputRelativeToMonorepoRoot,
  );

  for (const path of madgeTopoSorted.filter((p) => changedFiles.has(p))) {
    console.log(path);
  }
};

await main();

