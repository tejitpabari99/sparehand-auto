'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCodeGs, loadIndexScript, makeSheet, makeSpreadsheet, makeDraft } = require('./helpers');

const vm = require('node:vm');
const setRandom = (ctx, v) => { ctx.__r = v; vm.runInContext('Math.random = () => __r', ctx); };
const QUOTA = 'Service invoked too many times for one day: email.';
const STOP_MSG = 'Too many emails sent in a day via automation. Try again in 24 hours';

function fixture(rows) {
  const sheet = makeSheet('S', [['Email', 'Name', 'Notes', 'Done'], ...(rows || [['a@x.org', 'Ann', '', ''], ['b@x.org', 'Bo', '', '']])]);
  const ss = makeSpreadsheet([sheet]);
  const h = loadCodeGs({ spreadsheets: { S1: ss }, drafts: [makeDraft('Hello', '<p>Hi {{Name}}</p>')], props: { usage_org: 'Test Org' } });
  const sleeps = [];
  h.ctx.Utilities.sleep = (ms) => sleeps.push(ms);
  return { sheet, sleeps, ...h };
}
const single = (ctx, row, jr) => ctx.sendSingleEmail('S1', 'Hello', 'Email', row, 5, 6, true, null, 'S', jr);

// ---------- jitter ----------
test('jitter: successful send sleeps random 500-1000 ms', () => {
  const { ctx, sleeps } = fixture();
  setRandom(ctx, 0);
  single(ctx, 1);
  setRandom(ctx, 0.9999);
  single(ctx, 2);
  assert.strictEqual(sleeps.length, 2);
  assert.strictEqual(sleeps[0], 500);
  assert.ok(sleeps[1] >= 500 && sleeps[1] <= 1000, String(sleeps[1]));
});

test('jitter: already raised -> 1000-2000 ms', () => {
  const { ctx, sleeps } = fixture();
  setRandom(ctx, 0);
  const r = single(ctx, 1, true);
  assert.strictEqual(sleeps[0], 1000);
  assert.strictEqual(r.jitterRaised, true);
  setRandom(ctx, 0.9999);
  single(ctx, 2, true);
  assert.ok(sleeps[1] >= 1000 && sleeps[1] <= 2000);
});

test('jitter: normal send does not report jitterRaised', () => {
  const { ctx } = fixture();
  assert.ok(!single(ctx, 1).jitterRaised);
});

test('quota error once: jitter raised, same row retried and sent', () => {
  const { ctx, sent, sleeps } = fixture();
  let n = 0;
  const real = ctx.GmailApp.sendEmail;
  ctx.GmailApp.sendEmail = (...a) => { if (n++ === 0) throw new Error(QUOTA); return real(...a); };
  setRandom(ctx, 0);
  const r = single(ctx, 1);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.jitterRaised, true);
  assert.strictEqual(n, 2, 'retried once');
  assert.strictEqual(sent.length, 1);
  assert.ok(sleeps.every(ms => ms >= 1000), 'raised range: ' + sleeps);
});

test('quota error again after raise (in retry): quotaStop with exact message', () => {
  const { ctx, sheet } = fixture();
  ctx.GmailApp.sendEmail = () => { throw new Error(QUOTA); };
  const r = single(ctx, 1);
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.quotaStop, true);
  assert.strictEqual(r.error, STOP_MSG);
});

test('quota error when jitter already raised: stops immediately, no retry', () => {
  const { ctx } = fixture();
  let n = 0;
  ctx.GmailApp.sendEmail = () => { n++; throw new Error(QUOTA); };
  const r = single(ctx, 1, true);
  assert.strictEqual(r.quotaStop, true);
  assert.strictEqual(r.error, STOP_MSG);
  assert.strictEqual(n, 1);
});

test('other send errors are normal row errors (no quotaStop, no retry)', () => {
  const { ctx } = fixture();
  let n = 0;
  ctx.GmailApp.sendEmail = () => { n++; throw new Error('boom'); };
  const r = single(ctx, 1);
  assert.strictEqual(r.success, false);
  assert.ok(!r.quotaStop);
  assert.strictEqual(r.error, 'boom');
  assert.strictEqual(n, 1);
});

// ---------- review round 1 ----------
const singleP = (ctx, row, sentPicked, errPicked) =>
  ctx.sendSingleEmail('S1', 'Hello', 'Email', row, 4, 3, true, null, 'S', false, sentPicked, errPicked);

test('blank email: picked existing columns are left untouched', () => {
  const { ctx, sheet } = fixture([['', 'Ann', 'keep', 'keep']]);
  const r = singleP(ctx, 1, true, true);
  assert.strictEqual(r.noEmail, true);
  assert.strictEqual(sheet.writes.length, 0);
  assert.deepStrictEqual([sheet.cells[1][2], sheet.cells[1][3]], ['keep', 'keep']);
});

test('blank email: new (not picked) columns still get "No email address"', () => {
  const { ctx, sheet } = fixture([['', 'Ann', '', '']]);
  singleP(ctx, 1, false, false);
  assert.deepStrictEqual(sheet.writes.map(w => [w.col, w.value]), [[4, false], [3, 'No email address']]);
});

test('blank email: mixed picked/new writes only the new column', () => {
  const { ctx, sheet } = fixture([['', 'Ann', 'keep', 'keep']]);
  singleP(ctx, 1, true, false);
  assert.deepStrictEqual(sheet.writes.map(w => [w.col, w.value]), [[3, 'No email address']]);
});

test('batchInfo reports which result columns were picked', () => {
  let { ctx } = fixture();
  let info = batch(ctx, 'Done', '');
  assert.strictEqual(info.sentColSelected, true);
  assert.strictEqual(info.errorColSelected, false);
  ({ ctx } = fixture());
  info = batch(ctx, '', '');
  assert.strictEqual(info.sentColSelected, false);
  assert.strictEqual(info.errorColSelected, false);
});

test('picked headers resolve by display value (date header)', () => {
  const sheet = makeSheet('S', [['Email', 'Name', new Date('2024-01-05'), 'Done'], ['a@x.org', 'Ann', '', '']]);
  const h = loadCodeGs({ spreadsheets: { S1: makeSpreadsheet([sheet]) }, drafts: [makeDraft('Hello', '<p>Hi {{Name}}</p>')], props: { usage_org: 'Test Org' } });
  const info = batch(h.ctx, '2024-01-05', 'Done');
  assert.deepStrictEqual([info.sentColIndex, info.errorColIndex], [3, 4]);
});

test('Conditional Column resolves by display value (date / boolean headers)', () => {
  for (const [hdr, shown] of [[new Date('2026-01-01'), '2026-01-01'], [true, 'TRUE']]) {
    const sheet = makeSheet('S', [['Email', 'Name', hdr, 'Done'], ['a@x.org', 'Ann', '', '']]);
    const h = loadCodeGs({ spreadsheets: { S1: makeSpreadsheet([sheet]) }, drafts: [makeDraft('Hello', '<p>Hi {{Name}}</p>')], props: { usage_org: 'Test Org' } });
    const info = h.ctx.sendEmailBatch('S1', 'Hello', 'Email', 1, null, false, shown, 'S');
    assert.strictEqual(info.conditionalColIndex, 3, shown);
  }
});

test('Email Error == Conditional Column rejected when header is a date', () => {
  const sheet = makeSheet('S', [['Email', 'Name', new Date('2026-01-01'), 'Done'], ['a@x.org', 'Ann', '', '']]);
  const h = loadCodeGs({ spreadsheets: { S1: makeSpreadsheet([sheet]) }, drafts: [makeDraft('Hello', '<p>Hi {{Name}}</p>')], props: { usage_org: 'Test Org' } });
  assert.throws(() => h.ctx.sendEmailBatch('S1', 'Hello', 'Email', 1, null, true, '2026-01-01', 'S', null, '', '2026-01-01'), /Conditional Column/);
});

test('jitter: failed (non-quota) send also pauses once', () => {
  const { ctx, sleeps } = fixture();
  ctx.GmailApp.sendEmail = () => { throw new Error('boom'); };
  setRandom(ctx, 0);
  const r = single(ctx, 1);
  assert.strictEqual(r.success, false);
  assert.deepStrictEqual(sleeps, [500]);
});

test('jitter: no pause for rows that never attempted a send (invalid / blank)', () => {
  const { ctx, sleeps } = fixture([['', 'A', '', ''], ['nope', 'B', '', '']]);
  single(ctx, 1); single(ctx, 2);
  assert.deepStrictEqual(sleeps, []);
});

test('jitter: quotaStop does not pause', () => {
  const { ctx, sleeps } = fixture();
  ctx.GmailApp.sendEmail = () => { throw new Error(QUOTA); };
  single(ctx, 1, true);
  assert.deepStrictEqual(sleeps, []);
});

test('Email Error column equal to Conditional Column is rejected', () => {
  const { ctx, sheet } = fixture();
  assert.throws(() => ctx.sendEmailBatch('S1', 'Hello', 'Email', 1, null, true, 'Done', 'S', null, '', 'Done'), /Conditional Column/);
  assert.strictEqual(sheet.writes.length, 0);
});

test('UI: picked flags from batchInfo are passed back to sendSingleEmail', () => {
  const h = loadIndexScript({ values: BASE });
  h.ctx.startSending();
  h.run.state.ok({ org: 'Acme' });
  h.run.state.ok({ totalRows: 1, eligibleRowIndices: [1], sentColIndex: 4, errorColIndex: 5, conditionalColIndex: null, sentColSelected: true, errorColSelected: false });
  const a = h.run.state.calls.filter(c => c.name === 'sendSingleEmail')[0].args;
  assert.deepStrictEqual([a[10], a[11]], [true, false]);
});

test('UI: store-results helper text is the original wording', () => {
  assert.ok(html.includes("<small class=\"text-muted d-block\">Adds 'Email Sent' and 'Email Error' columns with timestamps to track progress</small>"));
});

// ---------- UI quota handling ----------
const BASE = { sheetSelect: 'S1', draftSelect: 'D', emailColumn: 'Email', tabSelect: 'Vols', orgName: 'Acme' };
function startUi(extra) {
  const h = loadIndexScript({ values: Object.assign({}, BASE, extra) });
  h.ctx.startSending();
  h.run.state.ok({ org: 'Acme' });
  h.run.state.ok({ totalRows: 5, eligibleRowIndices: [1, 2, 3, 4, 5], sentColIndex: 4, errorColIndex: 5, conditionalColIndex: null });
  return h;
}
const singles = (h) => h.run.state.calls.filter(c => c.name === 'sendSingleEmail');

test('UI: quotaStop ends run, shows exact message, not counted toward Stop After Errors', () => {
  const h = startUi({ maxConsecutiveErrors: '3' });
  h.run.state.ok({ success: true });
  h.run.state.ok({ success: false, quotaStop: true, error: STOP_MSG });
  assert.strictEqual(singles(h).length, 2, 'no further sends');
  const s = h.el('status').innerHTML;
  assert.ok(s.includes(STOP_MSG));
  assert.ok(!/consecutive errors/.test(s));
  const report = h.run.state.calls.find(c => c.name === 'reportBatch');
  assert.deepStrictEqual(report.args.slice(0, 3), [1, 0, true], 'quota stop is not a row failure');
});

test('UI: jitterRaised flag is sent on following sendSingleEmail calls', () => {
  const h = startUi({});
  assert.ok(!singles(h)[0].args[9]);
  h.run.state.ok({ success: true, jitterRaised: true });
  assert.strictEqual(singles(h)[1].args[9], true);
});

// ---------- result columns (server) ----------
const batch = (ctx, sentCol, errCol, store = true) =>
  ctx.sendEmailBatch('S1', 'Hello', 'Email', 1, null, store, '', 'S', null, sentCol, errCol);

test('default (blank/undefined) creates two new columns like before', () => {
  const { ctx, sheet } = fixture();
  const info = batch(ctx, '', '');
  assert.deepStrictEqual([info.sentColIndex, info.errorColIndex], [5, 6]);
  assert.match(sheet.cells[0][4], /^Email Sent /);
  assert.match(sheet.cells[0][5], /^Email Error /);
  // same-timestamp columns are reused (unchanged behaviour)
  const info2 = ctx.sendEmailBatch('S1', 'Hello', 'Email', 1, null, true, '', 'S');
  assert.deepStrictEqual([info2.sentColIndex, info2.errorColIndex], [5, 6]);
});

test('existing columns selected: no new columns, indices returned', () => {
  const { ctx, sheet } = fixture();
  const info = batch(ctx, 'Done', 'Notes');
  assert.deepStrictEqual([info.sentColIndex, info.errorColIndex], [4, 3]);
  assert.strictEqual(sheet.writes.length, 0);
  assert.strictEqual(sheet.cells[0].length, 4);
});

test('mixed: sent existing, error new', () => {
  const { ctx, sheet } = fixture();
  const info = batch(ctx, 'Done', '');
  assert.strictEqual(info.sentColIndex, 4);
  assert.strictEqual(info.errorColIndex, 5);
  assert.match(sheet.cells[0][4], /^Email Error /);
  assert.strictEqual(sheet.cells[0].length, 5);
});

test('selected existing columns: only rows that ran are written', () => {
  const { ctx, sheet } = fixture();
  const info = batch(ctx, 'Done', 'Notes');
  ctx.sendSingleEmail('S1', 'Hello', 'Email', 1, info.sentColIndex, info.errorColIndex, true, null, 'S');
  assert.deepStrictEqual(sheet.writes.map(w => [w.row, w.col, w.value]), [[2, 4, true], [2, 3, '']]);
  assert.strictEqual(sheet.cells[2][3], '');
});

test('invalid / injection column names rejected safely', () => {
  for (const bad of ['Nope', '=HYPERLINK("x")', '<img src=x onerror=1>', "'; DROP", '5', 'A']) {
    const { ctx, sheet } = fixture();
    assert.throws(() => batch(ctx, bad, ''), /Email Sent column .* not found/, bad);
    assert.throws(() => batch(ctx, '', bad), /Email Error column .* not found/, bad);
    assert.strictEqual(sheet.writes.length, 0, 'nothing written');
  }
  const { ctx } = fixture();
  assert.throws(() => batch(ctx, { a: 1 }, ''), /invalid/);
});

test('same column for both is rejected with clear message', () => {
  const { ctx, sheet } = fixture();
  assert.throws(() => batch(ctx, 'Notes', 'Notes'), /different columns/);
  assert.strictEqual(sheet.writes.length, 0);
});

test('result column equal to the email column is rejected', () => {
  const { ctx } = fixture();
  assert.throws(() => batch(ctx, 'Email', ''), /email column/i);
});

test('storeResults off: selections ignored, no columns, no validation', () => {
  const { ctx, sheet } = fixture();
  const info = batch(ctx, 'Nope', 'Nope', false);
  assert.strictEqual(info.sentColIndex, null);
  assert.strictEqual(sheet.writes.length, 0);
});

// ---------- UI layout / wiring ----------
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const pos = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, s); return i; };

test('layout: Stop After Errors shares the row with Start from Row and Limit Emails', () => {
  const a = pos('id="startRow"'), b = pos('id="limitEmails"'), c = pos('id="maxConsecutiveErrors"');
  const rowStart = html.lastIndexOf('<div class="row mb-3">', a);
  const between = html.slice(rowStart, c);
  assert.strictEqual((between.match(/<div class="row mb-3">/g) || []).length, 1, 'single row');
  assert.ok(a < b && b < c);
  assert.match(html, /Stop After Errors \(Optional\)/);
  assert.match(html, /col-md-4/);
});

test('Advanced title is "Advanced (Optional)"; individual advanced labels lose "(Optional)"', () => {
  assert.match(html, /<i class="bi bi-gear"><\/i> Advanced \(Optional\)/);
  assert.ok(!/Start from Row \(Optional\)/.test(html));
  assert.ok(!/Limit Emails \(Optional\)/.test(html));
  assert.ok(!/Conditional Column \(Optional\)/.test(html));
});

test('Store results is first in Advanced with Conditional Column beside it; result dropdowns follow', () => {
  const store = pos('id="storeResults"'), cond = pos('id="conditionalColumn"');
  const sentSel = pos('id="sentColumn"'), errSel = pos('id="errorColumn"');
  const start = pos('id="startRow"');
  assert.ok(store < cond && cond < sentSel && sentSel < errSel && errSel < start);
  const rowStart = html.lastIndexOf('<div class="row', store);
  assert.ok(rowStart > pos('id="advanceContent"') && rowStart < store);
  assert.ok(cond > store && html.slice(store, cond).indexOf('<div class="row') === -1, 'same row');
  assert.match(html, /Email Sent column/);
  assert.match(html, /Email Error column/);
  assert.match(html, /<option value="">-- New Column --<\/option>/);
});

test('result dropdowns disabled unless storeResults is checked', () => {
  const sent = html.match(/<select[^>]*id="sentColumn"[^>]*>/)[0];
  assert.match(sent, /\bdisabled\b/);
  const h = loadIndexScript();
  h.el('storeResults').checked = false;
  h.ctx.updateResultColumnState();
  assert.strictEqual(h.el('sentColumn').disabled, true);
  assert.strictEqual(h.el('errorColumn').disabled, true);
  h.el('storeResults').checked = true;
  h.ctx.updateResultColumnState();
  assert.strictEqual(h.el('sentColumn').disabled, false);
  assert.strictEqual(h.el('errorColumn').disabled, false);
});

test('populateColumnDropdowns fills result dropdowns with headers', () => {
  const h = loadIndexScript();
  h.ctx.populateColumnDropdowns(['Email', 'Name']);
  for (const id of ['sentColumn', 'errorColumn']) {
    assert.match(h.el(id).innerHTML, /-- New Column --/);
    assert.match(h.el(id).innerHTML, /value="Name"/);
  }
});

test('UI passes selected result columns to sendEmailBatch (only when storing)', () => {
  let h = loadIndexScript({ values: Object.assign({}, BASE, { sentColumn: 'Done', errorColumn: 'Notes' }) });
  h.ctx.startSending(); h.run.state.ok({ org: 'Acme' });
  let c = h.run.state.calls.find(x => x.name === 'sendEmailBatch');
  assert.deepStrictEqual(c.args.slice(9, 11), ['Done', 'Notes']);
  h = loadIndexScript({ values: Object.assign({}, BASE, { sentColumn: 'Done', errorColumn: 'Notes' }) });
  h.el('storeResults').checked = false;
  h.ctx.startSending(); h.run.state.ok({ org: 'Acme' });
  c = h.run.state.calls.find(x => x.name === 'sendEmailBatch');
  assert.deepStrictEqual(c.args.slice(9, 11), ['', '']);
});
