'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadIndexScript } = require('./helpers');

const { html } = loadIndexScript();
const pos = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, s); return i; };

// ---------- layout ----------
test('layout: start/limit/stop-errors row comes before the store-results row', () => {
  assert.ok(pos('id="startRow"') < pos('id="limitEmails"'));
  assert.ok(pos('id="limitEmails"') < pos('id="maxConsecutiveErrors"'));
  assert.ok(pos('id="maxConsecutiveErrors"') < pos('id="storeResults"'));
  assert.ok(pos('id="advanceContent"') < pos('id="startRow"'));
});

test('layout: Stop After Errors label has no "(Optional)"', () => {
  assert.ok(!html.includes('Stop After Errors (Optional)'));
  assert.match(html, /Stop After Errors\s*<i/);
});

test('layout: storeResults + sent/error columns in col-md-8; conditionalColumn in col-md-4 of the same row', () => {
  const g8 = html.indexOf('<div class="col-md-8">');
  assert.ok(g8 >= 0);
  const g4 = html.indexOf('<div class="col-md-4 d-flex flex-column justify-content-center">', g8);
  assert.ok(g4 > g8);
  const group = html.slice(g8, g4);
  for (const id of ['storeResults', 'sentColumn', 'errorColumn']) assert.ok(group.includes(`id="${id}"`), id);
  assert.ok(!group.includes('id="conditionalColumn"'));
  assert.ok(html.indexOf('id="conditionalColumn"', g4) > g4);
  // same row: no other row-level opening between the col-md-8 and col-md-4 at the outer level
  const rowStart = html.lastIndexOf('<div class="row mb-3">', g8);
  assert.ok(rowStart > pos('id="maxConsecutiveErrors"'));
  assert.ok(html.indexOf('id="conditionalColumn"') < html.indexOf('<!-- 5. Run Buttons -->'));
  // sent and error side by side
  assert.match(group, /<div class="row mt-3">[\s\S]*col-md-6[\s\S]*id="sentColumn"[\s\S]*col-md-6[\s\S]*id="errorColumn"/);
  assert.match(html, /id="storeResults" checked onchange="updateResultColumnState\(\)"/);
  assert.match(html, /<select id="sentColumn" class="form-select" disabled>/);
});

test('layout: gap below Advanced header is scoped to the advanced section', () => {
  assert.match(html, /#advanceContent > \.advanced-first-row \{ margin-top: 12px; \}/);
});

// ---------- stop button ----------
const BASE = { sheetSelect: 'S1', draftSelect: 'D', emailColumn: 'Email', tabSelect: 'Vols', orgName: 'Acme' };
function startUi() {
  const h = loadIndexScript({ values: BASE });
  h.ctx.onSendBtnClick();
  h.run.state.ok({ org: 'Acme' });
  h.run.state.ok({ totalRows: 4, eligibleRowIndices: [2, 3, 5, 6], sentColIndex: 4, errorColIndex: 5, conditionalColIndex: null });
  return h;
}
const singles = (h) => h.run.state.calls.filter(c => c.name === 'sendSingleEmail');
const btn = (h) => h.el('sendBtn');

test('stop: during send the button is enabled, btn-danger, shows Stop (Sending x/y)', () => {
  const h = startUi();
  assert.strictEqual(btn(h).disabled, false);
  assert.match(btn(h).className, /btn-danger/);
  assert.ok(!/btn-primary/.test(btn(h).className));
  assert.ok(btn(h).innerHTML.includes('bi-stop-fill'));
  assert.ok(btn(h).innerHTML.includes('Stop (Sending 1/4)'));
  h.run.state.ok({ success: true });
  assert.ok(btn(h).innerHTML.includes('Stop (Sending 2/4)'));
});

test('stop: confirm=true finishes in-flight email, sends no more, restores button', () => {
  const h = startUi();
  h.run.state.ok({ success: true }); // row 2 done, row 3 in flight
  assert.strictEqual(singles(h).length, 2);
  let msg = '';
  h.ctx.confirm = (m) => { msg = m; return true; };
  h.ctx.onSendBtnClick(); // click during send: must not call saveOrganization again
  assert.match(msg, /Stop sending emails/);
  assert.strictEqual(h.run.state.calls.filter(c => c.name === 'saveOrganization').length, 1);
  h.run.state.ok({ success: true }); // in-flight finishes and is recorded
  assert.strictEqual(singles(h).length, 2, 'no further sends');
  const s = h.el('status').innerHTML;
  assert.ok(s.includes('Stopped'));
  assert.ok(s.includes('Sent: 2/4'));
  assert.ok(s.includes('Failed: 0'));
  assert.ok(s.includes('Restart from row 5'));
  const report = h.run.state.calls.find(c => c.name === 'reportBatch');
  assert.deepStrictEqual(report.args.slice(0, 3), [2, 0, true]);
  assert.strictEqual(btn(h).disabled, false);
  assert.match(btn(h).className, /btn-primary/);
  assert.strictEqual(btn(h).innerHTML, '<i class="bi bi-send-fill"></i> Send Emails');
});

test('stop: confirm=false keeps sending, nothing changes', () => {
  const h = startUi();
  h.ctx.confirm = () => false;
  h.ctx.onSendBtnClick();
  assert.match(btn(h).className, /btn-danger/);
  assert.strictEqual(btn(h).disabled, false);
  h.run.state.ok({ success: true });
  h.run.state.ok({ success: true });
  assert.strictEqual(singles(h).length, 3);
  assert.ok(!h.el('status').innerHTML.includes('Stopped'));
});

test('stop: after a run completes, the button restores and a new send starts normally', () => {
  const h = startUi();
  for (let i = 0; i < 4; i++) h.run.state.ok({ success: true });
  assert.ok(h.el('status').innerHTML.includes('Complete!'));
  assert.match(btn(h).className, /btn-primary/);
  assert.strictEqual(btn(h).innerHTML, '<i class="bi bi-send-fill"></i> Send Emails');
  const before = h.run.state.calls.filter(c => c.name === 'saveOrganization').length;
  h.ctx.onSendBtnClick();
  assert.strictEqual(h.run.state.calls.filter(c => c.name === 'saveOrganization').length, before + 1);
});

test('stop: after a user stop, next click starts a new send (not another stop)', () => {
  const h = startUi();
  h.ctx.confirm = () => true;
  h.ctx.onSendBtnClick();
  h.run.state.ok({ success: true });
  const before = h.run.state.calls.filter(c => c.name === 'saveOrganization').length;
  h.ctx.onSendBtnClick();
  assert.strictEqual(h.run.state.calls.filter(c => c.name === 'saveOrganization').length, before + 1);
});

test('stop: consecutive-error stop and init failure restore btn-primary', () => {
  const h = loadIndexScript({ values: Object.assign({ maxConsecutiveErrors: '1' }, BASE) });
  h.ctx.onSendBtnClick();
  h.run.state.ok({ org: 'Acme' });
  h.run.state.ok({ totalRows: 2, eligibleRowIndices: [2, 3] });
  h.run.state.ok({ success: false, error: 'x' });
  assert.match(btn(h).className, /btn-primary/);
  assert.strictEqual(btn(h).disabled, false);

  const g = loadIndexScript({ values: BASE });
  g.ctx.onSendBtnClick();
  g.run.state.ok({ org: 'Acme' });
  g.run.state.fail({ message: 'bad' });
  assert.match(g.el('sendBtn').className || 'btn-primary', /btn-primary/);
  assert.strictEqual(g.el('sendBtn').disabled, false);
});
