#!/usr/bin/env node
/**
 * publish-pkg — build a workspace package and publish it to GitHub Packages.
 *
 * Repo-agnostic: the same file runs in onchainpal and in aigg-agent-kit. It finds
 * the repo root from its own location, the repo URL from `git remote`, and the
 * workspace packages from pnpm-workspace.yaml.
 *
 * Inside a repo packages keep their workspace names and ship TS source. GitHub
 * Packages only accepts a scope equal to the repo owner, so they are published as
 * @jianmliu/<name> (see publishedName); other repos consume them under the old name
 * through a pnpm alias, so their imports stay unchanged:
 *
 *   "@onchainpal/pal-formats": "npm:@jianmliu/pal-formats@^0.1.0"
 *   .npmrc:  @jianmliu:registry=https://npm.pkg.github.com
 *
 * What gets published is built, not source: every code `exports` entry is bundled by
 * esbuild (ESM, code-splitting so shared modules stay one instance across subpaths,
 * e.g. MKF and its override hook; every package import stays external), with .d.ts
 * from tsc. Non-code exports (fixtures, package.json) are copied as-is. Workspace
 * deps become aliased registry deps the same way.
 *
 *   node scripts/publish-pkg.mjs packages/pal-formats            # build + npm publish --dry-run
 *   node scripts/publish-pkg.mjs packages/pal-formats --pack     # build + write the .tgz (local check)
 *   node scripts/publish-pkg.mjs packages/pal-formats --publish  # real publish (CI: NODE_AUTH_TOKEN)
 *
 * The token is never written anywhere: the staged .npmrc references ${NODE_AUTH_TOKEN}.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = 'jianmliu';
const REGISTRY = 'https://npm.pkg.github.com';
// these scopes publish under their bare name; any other scope keeps it as a prefix
// (@ai3-inference/core → @jianmliu/ai3-inference-core) so generic names can't collide
const BARE_SCOPES = new Set(['onchainpal', 'aigg']);

const root = fileURLToPath(new URL('..', import.meta.url));
const [dirArg, mode = '--dry-run'] = process.argv.slice(2);
if (!dirArg || !['--dry-run', '--pack', '--publish'].includes(mode)) {
  console.error('usage: publish-pkg.mjs <package-dir> [--dry-run|--pack|--publish]');
  process.exit(2);
}
const pkgDir = resolve(root, dirArg);
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
if (pkg.version === '0.0.0') {
  console.error(`${pkg.name}: version is 0.0.0 — set a real semver before publishing`);
  process.exit(2);
}
const repoUrl = gitRemoteUrl();

// --- entries: code exports → esbuild entries; "./x/*" over src expands to its .ts files;
//     anything else (fixtures, package.json) is a static export, copied verbatim ---
const entries = {};
const statics = {};
for (const [key, target] of Object.entries(pkg.exports ?? { '.': pkg.main })) {
  const src = typeof target === 'string' ? target : target.import;
  if (key === './package.json') continue; // npm always ships it; re-exported below
  if (!/\.ts$/.test(src) && !/\*\.ts$/.test(src)) { statics[key] = src; continue; }
  if (key.includes('*')) {
    const dir = join(pkgDir, src.slice(0, src.indexOf('*')));
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.ts') && !f.endsWith('.d.ts')) entries[f.slice(0, -3)] = join(dir, f);
    }
  } else {
    entries[key === '.' ? 'index' : key.replace(/^\.\//, '')] = join(pkgDir, src);
  }
}

const stage = join(pkgDir, '.publish');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const baseTsconfig = join(root, 'tsconfig.base.json');
await build({
  entryPoints: entries,
  outdir: join(stage, 'dist'),
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  packages: 'external',
  ...(existsSync(baseTsconfig) ? { tsconfig: baseTsconfig } : {}),
  logLevel: 'warning'
});

// --- types: tsc declarations, laid out like src (dist/<entry>.js ↔ types/<entry>.d.ts) ---
const srcRoot = join(pkgDir, 'src');
// typescript is resolved from the repo root (packages needn't depend on it); module
// settings are pinned because sources are written for Bundler resolution and some
// base configs pair NodeNext resolution with ESNext modules (TS5110)
const tscBin = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
// declarations for the shipped sources only — tests are neither published nor
// required to typecheck under the package's (possibly stricter) settings
const declTsconfig = join(stage, 'tsconfig.decl.json');
writeFileSync(declTsconfig, JSON.stringify({
  extends: join(pkgDir, 'tsconfig.json'),
  include: [join(srcRoot, '**/*')],
  exclude: [join(srcRoot, '**/__tests__/**'), join(srcRoot, '**/*.test.ts'), join(srcRoot, '**/*.smoke.ts')]
}));
const tsc = spawnSync(process.execPath, [tscBin, '-p', declTsconfig,
  '--noEmit', 'false', '--declaration', '--emitDeclarationOnly', '--declarationMap', 'false',
  '--module', 'esnext', '--moduleResolution', 'bundler',
  '--rootDir', srcRoot, '--outDir', join(stage, 'types')], { cwd: pkgDir, encoding: 'utf8' });
if (tsc.status !== 0) {
  console.error(tsc.stdout, tsc.stderr);
  process.exit(1);
}
rmSync(join(stage, 'types', '__tests__'), { recursive: true, force: true });
rmSync(declTsconfig);
addJsExtensions(join(stage, 'types'));

// --- static exports: copy the files/dirs they point at ---
const files = ['dist', 'types'];
for (const target of Object.values(statics)) {
  const rel = target.replace(/^\.\//, '').replace(/\/?\*.*$/, '');
  cpSync(join(pkgDir, rel), join(stage, rel), { recursive: true });
  files.push(rel);
}

// --- manifest: published name, built exports, workspace deps → aliased registry deps ---
const exportsOut = {};
for (const [name, file] of Object.entries(entries)) {
  const rel = relative(srcRoot, file).replace(/\.ts$/, '');
  exportsOut[name === 'index' ? '.' : `./${name}`] = {
    types: `./types/${rel}.d.ts`,
    import: `./dist/${name}.js`
  };
}
Object.assign(exportsOut, statics, { './package.json': './package.json' });
const deps = { ...pkg.dependencies };
for (const [dep, range] of Object.entries(deps)) {
  if (!String(range).startsWith('workspace:')) continue;
  const depPkg = findWorkspacePkg(dep);
  if (depPkg.version === '0.0.0') throw new Error(`workspace dep ${dep} is unversioned (0.0.0) — publish it first`);
  deps[dep] = `npm:${publishedName(dep)}@^${depPkg.version}`;
}
const manifest = {
  name: publishedName(pkg.name),
  version: pkg.version,
  description: pkg.description,
  type: 'module',
  sideEffects: pkg.sideEffects ?? true,
  main: './dist/index.js',
  types: './types/index.d.ts',
  exports: exportsOut,
  files,
  dependencies: Object.keys(deps).length ? deps : undefined,
  repository: { type: 'git', url: `git+${repoUrl}.git`, directory: relative(root, pkgDir) },
  publishConfig: { registry: REGISTRY }
};
writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(stage, '.npmrc'), `@${OWNER}:registry=${REGISTRY}\n//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\n`);

const npmArgs = mode === '--pack' ? ['pack'] : ['publish', ...(mode === '--dry-run' ? ['--dry-run'] : [])];
const npm = spawnSync('npm', npmArgs, {
  cwd: stage,
  stdio: 'inherit',
  // dry-run/pack need no auth; keep npm from choking on the unset placeholder
  env: { ...process.env, NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN ?? '' }
});
if (npm.status !== 0) process.exit(npm.status ?? 1);
console.log(`\n${manifest.name}@${manifest.version} ${mode.slice(2)} ok (staged in ${relative(root, stage)})`);

function publishedName(name) {
  const m = /^@([^/]+)\/(.+)$/.exec(name);
  if (!m) return `@${OWNER}/${name}`;
  return `@${OWNER}/${BARE_SCOPES.has(m[1]) ? m[2] : `${m[1]}-${m[2]}`}`;
}

function gitRemoteUrl() {
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY) {
    return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`;
  }
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
  const url = r.stdout.trim().replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
  if (!url) throw new Error('cannot determine repository URL (no origin remote)');
  return url;
}

/**
 * Sources use extensionless relative imports (moduleResolution Bundler), and tsc
 * copies them into the .d.ts verbatim. Consumers on NodeNext reject those (TS2834),
 * so point each one at the emitted file: './mkf' → './mkf.js', './dir' → './dir/index.js'.
 */
function addJsExtensions(dir) {
  const spec = /(\bfrom\s+|\bimport\s+|\bimport\(\s*)(['"])(\.{1,2}\/[^'"]*)\2/g;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, ent.name);
    if (ent.isDirectory()) { addJsExtensions(file); continue; }
    if (!ent.name.endsWith('.d.ts')) continue;
    const text = readFileSync(file, 'utf8');
    const out = text.replace(spec, (m, lead, q, rel) => {
      if (/\.(js|mjs|cjs|json)$/.test(rel)) return m;
      const target = resolve(dir, rel);
      if (existsSync(`${target}.d.ts`)) return `${lead}${q}${rel}.js${q}`;
      if (existsSync(join(target, 'index.d.ts'))) return `${lead}${q}${rel}/index.js${q}`;
      throw new Error(`${relative(root, file)}: cannot resolve declaration import '${rel}'`);
    });
    if (out !== text) writeFileSync(file, out);
  }
}

/** workspace package dirs, from pnpm-workspace.yaml globs ("dir/*" or "dir") */
function workspaceDirs() {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const dirs = [];
  for (const m of yaml.matchAll(/^\s*-\s*["']?([^"'#\s]+)["']?/gm)) {
    const glob = m[1];
    if (glob.endsWith('/*')) {
      const base = join(root, glob.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const d of readdirSync(base)) dirs.push(join(base, d));
    } else {
      dirs.push(join(root, glob));
    }
  }
  return dirs;
}

function findWorkspacePkg(name) {
  for (const d of workspaceDirs()) {
    const f = join(d, 'package.json');
    if (!existsSync(f)) continue;
    const p = JSON.parse(readFileSync(f, 'utf8'));
    if (p.name === name) return p;
  }
  throw new Error(`workspace dep ${name} not found (searched pnpm-workspace.yaml globs from ${dirname(root)})`);
}
