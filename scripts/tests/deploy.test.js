'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const d = require('../deploy-apps-script.js');

function mkAutomation(files, cfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
  const dir = path.join(root, 'thing');
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  if (cfg !== undefined) fs.writeFileSync(path.join(dir, 'deploy.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  return dir;
}
const GOOD = { scriptId: 'S1', deploymentId: 'D1' };

test('readConfig accepts valid config', () => {
  const dir = mkAutomation(['appsscript.json', 'code.gs'], GOOD);
  assert.deepStrictEqual(d.readConfig(dir), GOOD);
});
test('readConfig rejects missing deploy.json', () => {
  const dir = mkAutomation(['appsscript.json']);
  assert.throws(() => d.readConfig(dir), /deploy\.json/);
});
test('readConfig rejects invalid JSON', () => {
  const dir = mkAutomation(['appsscript.json'], '{nope');
  assert.throws(() => d.readConfig(dir), /deploy\.json/);
});
for (const field of ['scriptId', 'deploymentId']) {
  for (const bad of [undefined, '', '   ', 5, null]) {
    test(`readConfig rejects ${field}=${JSON.stringify(bad)}`, () => {
      const cfg = { ...GOOD, [field]: bad };
      const dir = mkAutomation(['appsscript.json'], cfg);
      assert.throws(() => d.readConfig(dir), new RegExp(field));
    });
  }
}
test('readConfig rejects missing appsscript.json', () => {
  const dir = mkAutomation(['code.gs'], GOOD);
  assert.throws(() => d.readConfig(dir), /appsscript\.json/);
});

test('isDeployableFile allowlist', () => {
  for (const ok of ['code.gs', 'index.html', 'appsscript.json']) assert.ok(d.isDeployableFile(ok), ok);
  for (const no of ['deploy.json', 'package.json', 'README.md', 'INSTALLATION_GUIDE.md', 'tests/a.test.js', 'docs/x.png', 'docs/y.html', 'tests/x.gs', 'a.js']) {
    assert.ok(!d.isDeployableFile(no), no);
  }
});

test('stage copies only Apps Script source files', () => {
  const dir = mkAutomation(['appsscript.json', 'code.gs', 'index.html', 'README.md', 'INSTALLATION_GUIDE.md',
    'tests/a.test.js', 'tests/helpers.js', 'docs/pic.png', 'docs/page.html'], GOOD);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
  const copied = d.stage(dir, out);
  assert.deepStrictEqual(copied.sort(), ['appsscript.json', 'code.gs', 'index.html']);
  assert.deepStrictEqual(fs.readdirSync(out).sort(), ['.clasp.json', 'appsscript.json', 'code.gs', 'index.html']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(out, '.clasp.json'), 'utf8')), { scriptId: 'S1', rootDir: '.' });
});

test('changedAutomations: docs/tests/md-only change deploys nothing', () => {
  const has = () => true;
  assert.deepStrictEqual(d.changedAutomations(['auto-emailer/tests/a.test.js', 'auto-emailer/docs/x.png', 'auto-emailer/INSTALLATION_GUIDE.md', 'README.md'], has), []);
});
test('changedAutomations: deployable file change deploys that folder', () => {
  assert.deepStrictEqual(d.changedAutomations(['auto-emailer/code.gs', 'auto-emailer/tests/a.js'], () => true), ['auto-emailer']);
});
test('changedAutomations: deploy.json change deploys that folder', () => {
  assert.deepStrictEqual(d.changedAutomations(['other/deploy.json'], () => true), ['other']);
});
test('changedAutomations: skips folders without deploy.json, dedupes, sorts', () => {
  const has = (f) => f !== 'nodeploy';
  assert.deepStrictEqual(d.changedAutomations(['b/code.gs', 'nodeploy/code.gs', 'a/index.html', 'b/appsscript.json', 'top.gs'], has), ['a', 'b']);
});
test('isZeroSha', () => {
  assert.ok(d.isZeroSha('0000000000000000000000000000000000000000'));
  assert.ok(d.isZeroSha(''));
  assert.ok(!d.isZeroSha('abc123'));
});

test('claspCommands builds push --force and redeploy by id with SHA description', () => {
  const cmds = d.claspCommands(GOOD, 'abcdef1234567890');
  assert.strictEqual(d.CLASP_VERSION, '3.4.1');
  assert.deepStrictEqual(cmds, [
    ['push', '--force'],
    ['redeploy', 'D1', '-d', 'ci abcdef1234567890'],
  ]);
});

test('deployAutomation stages, runs clasp in staging dir in order, cleans up', () => {
  const dir = mkAutomation(['appsscript.json', 'code.gs', 'tests/a.test.js'], GOOD);
  const calls = [];
  const run = (args, cwd) => { calls.push({ args, cwd, files: fs.readdirSync(cwd).sort() }); };
  d.deployAutomation(dir, { sha: 'deadbeef', run });
  assert.deepStrictEqual(calls.map((c) => c.args), [['push', '--force'], ['redeploy', 'D1', '-d', 'ci deadbeef']]);
  assert.deepStrictEqual(calls[0].files, ['.clasp.json', 'appsscript.json', 'code.gs']);
  assert.ok(!fs.existsSync(calls[0].cwd), 'staging dir removed');
});
test('deployAutomation does not redeploy if push fails', () => {
  const dir = mkAutomation(['appsscript.json'], GOOD);
  const calls = [];
  const run = (args) => { calls.push(args); throw new Error('push failed'); };
  assert.throws(() => d.deployAutomation(dir, { sha: 's', run }), /push failed/);
  assert.strictEqual(calls.length, 1);
});
test('deployAutomation validates before running anything', () => {
  const dir = mkAutomation(['code.gs'], GOOD);
  let ran = false;
  assert.throws(() => d.deployAutomation(dir, { sha: 's', run: () => { ran = true; } }), /appsscript\.json/);
  assert.strictEqual(ran, false);
});

test('workflow YAML parses and is safe (if pyyaml available)', (t) => {
  const { spawnSync } = require('node:child_process');
  const wf = path.join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml');
  const py = 'import yaml,sys,json;d=yaml.safe_load(open(sys.argv[1]));print(json.dumps(d))';
  const r = spawnSync('python3', ['-c', py, wf], { encoding: 'utf8' });
  if (r.status !== 0) return t.skip('pyyaml unavailable');
  const doc = JSON.parse(r.stdout);
  const on = doc.on || doc.true;
  assert.ok('workflow_dispatch' in on);
  const job = doc.jobs.deploy;
  assert.deepStrictEqual(job.needs, 'check');
  assert.match(job.if, /github\.event_name == 'push'.*refs\/heads\/main|workflow_dispatch/);
  assert.match(job.if, /refs\/heads\/main/);
  assert.ok(!/pull_request/.test(job.if));
  assert.ok(job.concurrency);
  assert.strictEqual(job.permissions.contents, 'read');
});

test('changedAutomations: nested group/name folders map to group/name', () => {
  const has = (f) => f === 'google-scripts/auto-emailer';
  assert.deepStrictEqual(d.changedAutomations(['google-scripts/auto-emailer/code.gs', 'google-scripts/auto-emailer/index.html'], has), ['google-scripts/auto-emailer']);
  assert.deepStrictEqual(d.changedAutomations(['google-scripts/auto-emailer/deploy.json'], has), ['google-scripts/auto-emailer']);
  assert.deepStrictEqual(d.changedAutomations(['google-scripts/auto-emailer/tests/a.js', 'google-scripts/auto-emailer/docs/x.html', 'google-scripts/auto-emailer/INSTALLATION_GUIDE.md', 'google-scripts/README.md'], has), []);
});
test('listAll finds top-level and nested (2 levels) automations, ignores others', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listall-'));
  const mk = (p) => { fs.mkdirSync(path.join(root, p), { recursive: true }); fs.writeFileSync(path.join(root, p, 'deploy.json'), '{}'); };
  mk('top'); mk('google-scripts/a'); mk('google-scripts/b');
  fs.mkdirSync(path.join(root, 'auto-emailer'));
  fs.mkdirSync(path.join(root, 'google-scripts/nodeploy'));
  fs.mkdirSync(path.join(root, 'node_modules/x/y'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/x/deploy.json'), '{}');
  assert.deepStrictEqual(d.listAll(root), ['google-scripts/a', 'google-scripts/b', 'top']);
});
test('real repo: google-scripts/auto-emailer is discovered', () => {
  const list = d.listAll(path.join(__dirname, '..', '..'));
  assert.ok(list.includes('google-scripts/auto-emailer'), list.join(','));
});
