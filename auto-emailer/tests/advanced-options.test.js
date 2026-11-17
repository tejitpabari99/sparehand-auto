'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCodeGs, loadIndexScript, makeSheet, makeSpreadsheet, makeDraft } = require('./helpers');

const BASE = { sheetSelect: 'S1', draftSelect: 'D', emailColumn: 'Email', tabSelect: 'Vols', orgName: 'Acme' };

// Starts a send through the UI; returns the harness after sendEmailBatch resolved.
function start(extra, rows = 10) {
  const h = loadIndexScript({ values: Object.assign({}, BASE, extra) });
  h.ctx.startSending();
  h.run.state.ok({ org: 'Acme' });
  return h;
}
function begin(h, rows = 10) {
  h.run.state.ok({ totalRows: rows, eligibleRowIndices: Array.from({ length: rows }, (_, i) => i + 1), sentColIndex: 4, errorColIndex: 5, conditionalColIndex: null });
}
const singles = (h) => h.run.state.calls.filter(c => c.name === 'sendSingleEmail');

// ---------- structure ----------
test('Advanced section: maxConsecutiveErrors input sits beside Conditional Column, min 1 step 1', () => {
  const { html } = loadIndexScript();
  const input = html.match(/<input[^>]*id="maxConsecutiveErrors"[^>]*>/);
  assert.ok(input, 'input exists');
  assert.match(input[0], /type="number"/);
  assert.match(input[0], /min="1"/);
  assert.match(input[0], /step="1"/);
  assert.match(input[0], /placeholder="Default: 5"/);
  assert.match(html, /Stop After Errors \(Optional\)/);
  const i = html.indexOf('id="conditionalColumn"');
  const j = html.indexOf('id="maxConsecutiveErrors"');
  const rowStart = html.lastIndexOf('<div class="row mb-3">', i);
  const nextBlock = html.indexOf('<!-- Store Results -->');
  assert.ok(rowStart > html.indexOf('id="limitEmails"'), 'own row after the limit row');
  assert.ok(j > rowStart && j < nextBlock, 'in the same row as conditional column');
});

test('startRow and limitEmails inputs have min=1 step=1', () => {
  const { html } = loadIndexScript();
  for (const id of ['startRow', 'limitEmails']) {
    const m = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    assert.match(m[0], /min="1"/, id);
    assert.match(m[0], /step="1"/, id);
  }
});

// ---------- frontend validation ----------
for (const field of ['startRow', 'limitEmails', 'maxConsecutiveErrors']) {
  for (const bad of ['0', '-1', '2.5', 'abc', '5abc', '1e1x']) {
    test(`frontend rejects ${field}="${bad}"`, () => {
      const h = start({ [field]: bad });
      assert.strictEqual(h.alerts.length, 1, 'alerted');
      assert.ok(!h.run.state.calls.some(c => c.name === 'sendEmailBatch'));
    });
  }
  test(`frontend accepts ${field} blank and positive int`, () => {
    let h = start({ [field]: '' });
    assert.strictEqual(h.alerts.length, 0);
    assert.ok(h.run.state.calls.some(c => c.name === 'sendEmailBatch'));
    h = start({ [field]: ' 3 ' });
    assert.strictEqual(h.alerts.length, 0);
    assert.ok(h.run.state.calls.some(c => c.name === 'sendEmailBatch'));
  });
}

test('frontend passes numeric startRow/limit to sendEmailBatch', () => {
  const h = start({ startRow: '2', limitEmails: '4' });
  const c = h.run.state.calls.find(x => x.name === 'sendEmailBatch');
  assert.strictEqual(c.args[3], 2);
  assert.strictEqual(c.args[4], 4);
});

// ---------- configurable stop ----------
test('custom limit 2 stops after 2 consecutive failures', () => {
  const h = start({ maxConsecutiveErrors: '2' });
  begin(h);
  h.run.state.ok({ success: false, error: 'boom' });
  assert.strictEqual(singles(h).length, 2, 'second send queued');
  h.run.state.ok({ success: false, error: 'boom' });
  assert.strictEqual(singles(h).length, 2, 'stopped, no third send');
  assert.match(h.el('status').innerHTML, /Stopped/);
  assert.match(h.el('status').innerHTML, /2 consecutive errors/);
});

test('blank limit defaults to 5', () => {
  const h = start({});
  begin(h);
  for (let i = 0; i < 4; i++) h.run.state.ok({ success: false, error: 'x' });
  assert.strictEqual(singles(h).length, 5);
  h.run.state.ok({ success: false, error: 'x' });
  assert.strictEqual(singles(h).length, 5, 'stopped at 5');
  assert.match(h.el('status').innerHTML, /5 consecutive errors/);
});

test('custom limit applies to the failure handler too', () => {
  const h = start({ maxConsecutiveErrors: '1' });
  begin(h);
  h.run.state.fail(new Error('net'));
  assert.strictEqual(singles(h).length, 1);
  assert.match(h.el('status').innerHTML, /1 consecutive errors/);
});

// ---------- blank-email rows ----------
test('UI: noEmail result is skipped: not sent, not failed, counter untouched', () => {
  const h = start({ maxConsecutiveErrors: '2' });
  begin(h, 4);
  h.run.state.ok({ success: false, error: 'x' });          // 1 failure
  h.run.state.ok({ success: true, skipped: true, noEmail: true }); // neither resets nor increments
  h.run.state.ok({ success: false, error: 'x' });          // 2nd consecutive failure -> stop
  assert.match(h.el('status').innerHTML, /Stopped/);
  assert.strictEqual(singles(h).length, 3);
  const report = h.run.state.calls.find(c => c.name === 'reportBatch');
  assert.deepStrictEqual(report.args.slice(0, 3), [0, 2, true]);
});

test('UI: finish line shows skipped (no email) and report excludes it', () => {
  const h = start({});
  begin(h, 2);
  h.run.state.ok({ success: true, skipped: true, noEmail: true });
  h.run.state.ok({ success: true });
  const s = h.el('status').innerHTML;
  assert.match(s, /Complete/);
  assert.match(s, /Skipped \(no email\): 1/);
  const report = h.run.state.calls.find(c => c.name === 'reportBatch');
  assert.deepStrictEqual(report.args.slice(0, 3), [1, 0, false]);
});

function fixture(rows, sendThrows) {
  const sheet = makeSheet('S', [['Email', 'Name'], ...rows]);
  const ss = makeSpreadsheet([sheet]);
  const h = loadCodeGs({ spreadsheets: { S1: ss }, drafts: [makeDraft('Hello', '<p>Hi {{Name}}</p>')], props: { usage_org: 'Test Org' } });
  if (sendThrows) h.ctx.GmailApp.sendEmail = () => { throw new Error('quota'); };
  return { sheet, ...h };
}

test('sendSingleEmail: blank email -> skipped noEmail, not a failure, sheet note kept', () => {
  const { ctx, sheet } = fixture([['', 'Dan']]);
  const r = ctx.sendSingleEmail('S1', 'Hello', 'Email', 1, 3, 4, true, null, 'S');
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.noEmail, true);
  assert.ok(sheet.writes.some(w => w.col === 4 && w.value === 'No email address'));
  assert.ok(sheet.writes.some(w => w.col === 3 && w.value === false));
});

test('sendSingleEmail: invalid non-blank address is still a failure', () => {
  const { ctx } = fixture([['nope', 'Dan']]);
  const r = ctx.sendSingleEmail('S1', 'Hello', 'Email', 1, 3, 4, true, null, 'S');
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, 'Invalid email address');
});

// ---------- backend validation ----------
test('sendEmailBatch rejects invalid startRow / limit (0, -1, 2.5)', () => {
  const { ctx } = fixture([['a@x.org', 'A']]);
  for (const bad of [0, -1, 2.5]) {
    assert.throws(() => ctx.sendEmailBatch('S1', 'Hello', 'Email', bad, null, true, '', 'S'), /positive integer/);
    assert.throws(() => ctx.sendEmailBatch('S1', 'Hello', 'Email', 1, bad, true, '', 'S'), /positive integer/);
  }
});

test('processAndSend rejects invalid maxConsecutiveErrors', () => {
  const { ctx } = fixture([['a@x.org', 'A']]);
  for (const bad of [0, -1, 2.5, 'abc']) {
    assert.throws(() => ctx.processAndSend('S1', 'Hello', 'Email', 1, 'S', bad), /positive integer/);
  }
});

test('processAndSend: custom limit 2 stops after 2 consecutive send errors', () => {
  const { ctx } = fixture([['a@x.org', 'A'], ['b@x.org', 'B'], ['c@x.org', 'C']], true);
  assert.throws(() => ctx.processAndSend('S1', 'Hello', 'Email', 1, 'S', 2), /Stopped after 2 consecutive errors/);
});

test('processAndSend: default limit is 5', () => {
  const rows = Array.from({ length: 6 }, (_, i) => [`a${i}@x.org`, 'A']);
  const { ctx } = fixture(rows, true);
  assert.throws(() => ctx.processAndSend('S1', 'Hello', 'Email', 1, 'S'), /Stopped after 5 consecutive errors/);
});

test('processAndSend: blank-email rows do not count toward the consecutive limit', () => {
  const { ctx } = fixture([['a@x.org', 'A'], ['', 'B'], ['c@x.org', 'C'], ['', 'D']], true);
  // 2 send errors separated by blank rows; blank rows neither add nor reset. limit 3 -> no stop
  const r = ctx.processAndSend('S1', 'Hello', 'Email', 1, 'S', 3);
  assert.strictEqual(r.emailsSent, 0);
  // with limit 2 the two real failures are consecutive despite the blank between -> stops
  const f = fixture([['a@x.org', 'A'], ['', 'B'], ['c@x.org', 'C'], ['d@x.org', 'D']], true);
  assert.throws(() => f.ctx.processAndSend('S1', 'Hello', 'Email', 1, 'S', 2), /Stopped after 2/);
});
