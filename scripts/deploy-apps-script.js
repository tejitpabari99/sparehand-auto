#!/usr/bin/env node
'use strict';
// Deploys an Apps Script automation folder (<name>/ or <group>/<name>/) with clasp. No dependencies.
//   node scripts/deploy-apps-script.js changed <beforeSha> <sha>   -> prints folders to deploy
//   node scripts/deploy-apps-script.js all                          -> prints every folder with deploy.json
//   node scripts/deploy-apps-script.js deploy <folder>              -> push + update existing deployment
// Credentials: clasp reads ~/.clasprc.json (written by the workflow from the CLASPRC_JSON secret).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLASP_VERSION = '3.4.1';
const ZERO_SHA = /^0*$/;

function isZeroSha(sha) { return ZERO_SHA.test(sha || ''); }

// Only top-level Apps Script sources. Subfolders (tests/, docs/), md, deploy.json never ship.
function isDeployableFile(rel) {
  if (rel.includes('/') || rel.includes('\\')) return false;
  return rel === 'appsscript.json' || /\.(gs|html)$/.test(rel);
}

function readConfig(dir) {
  const cfgPath = path.join(dir, 'deploy.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { throw new Error(`cannot read valid deploy.json in ${dir}: ${e.message}`); }
  if (!cfg || typeof cfg !== 'object') throw new Error('deploy.json must be an object');
  for (const k of ['scriptId', 'deploymentId']) {
    if (typeof cfg[k] !== 'string' || !cfg[k].trim()) throw new Error(`deploy.json: ${k} must be a non-empty string`);
  }
  if (!fs.existsSync(path.join(dir, 'appsscript.json'))) throw new Error(`${dir} has no appsscript.json`);
  return { scriptId: cfg.scriptId.trim(), deploymentId: cfg.deploymentId.trim() };
}

function stage(dir, outDir) {
  const { scriptId } = readConfig(dir);
  const copied = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && isDeployableFile(e.name)).map((e) => e.name);
  for (const f of copied) fs.copyFileSync(path.join(dir, f), path.join(outDir, f));
  fs.writeFileSync(path.join(outDir, '.clasp.json'), JSON.stringify({ scriptId, rootDir: '.' }));
  return copied;
}

// changedPaths: repo-relative paths. hasDeployJson(folder) -> bool.
function changedAutomations(changedPaths, hasDeployJson) {
  const out = new Set();
  for (const p of changedPaths) {
    const parts = p.split('/');
    // An automation folder is <name>/ or <group>/<name>/ (max 2 levels deep).
    for (const depth of [1, 2]) {
      if (parts.length <= depth) break;
      const folder = parts.slice(0, depth).join('/');
      const rel = parts.slice(depth).join('/');
      if ((rel === 'deploy.json' || isDeployableFile(rel)) && hasDeployJson(folder)) out.add(folder);
    }
  }
  return [...out].sort();
}

function claspCommands(cfg, sha) {
  return [['push', '--force'], ['redeploy', cfg.deploymentId, '-d', `ci ${sha}`]];
}

function claspRun(args, cwd) {
  const r = spawnSync('npx', ['--yes', `@google/clasp@${CLASP_VERSION}`, ...args], { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`clasp ${args[0]} failed (exit ${r.status})`);
}

function deployAutomation(dir, { sha, run = claspRun }) {
  const cfg = readConfig(dir);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-script-'));
  try {
    stage(dir, tmp);
    for (const args of claspCommands(cfg, sha)) run(args, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Automation folders: any folder up to 2 levels deep (<name>/ or <group>/<name>/) with a deploy.json.
function listAll(root) {
  const skip = (n) => n.startsWith('.') || n === 'node_modules';
  const subdirs = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !skip(e.name)).map((e) => e.name);
  const out = [];
  for (const a of subdirs(root)) {
    if (fs.existsSync(path.join(root, a, 'deploy.json'))) out.push(a);
    for (const b of subdirs(path.join(root, a))) {
      if (fs.existsSync(path.join(root, a, b, 'deploy.json'))) out.push(`${a}/${b}`);
    }
  }
  return out.sort();
}

function main(argv) {
  const [cmd, a, b] = argv;
  const root = process.cwd();
  const hasDeploy = (f) => fs.existsSync(path.join(root, f, 'deploy.json'));
  if (cmd === 'all') return console.log(listAll(root).join('\n'));
  if (cmd === 'changed') {
    if (isZeroSha(a)) return console.log(listAll(root).join('\n'));
    const r = spawnSync('git', ['diff', '--name-only', a, b], { encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
    return console.log(changedAutomations(r.stdout.split('\n').filter(Boolean), hasDeploy).join('\n'));
  }
  if (cmd === 'deploy' && a) {
    deployAutomation(path.join(root, a), { sha: process.env.GITHUB_SHA || 'manual' });
    return console.log(`deployed ${a}`);
  }
  console.error('usage: deploy-apps-script.js changed <before> <sha> | all | deploy <folder>');
  process.exit(2);
}

module.exports = { CLASP_VERSION, isZeroSha, isDeployableFile, readConfig, stage, changedAutomations, claspCommands, deployAutomation, listAll };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
}
