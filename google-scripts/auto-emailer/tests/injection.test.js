'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCodeGs, makeSheet, makeSpreadsheet, makeDraft } = require('./helpers');

const BAD = 'Invalid email address';

function fixture(rows, draftHtml = '<p>Hi {{Name}}</p>') {
  const sheet = makeSheet('S', [['Email', 'Name', 'Sent', 'Err'], ...rows]);
  return { sheet, ...loadCodeGs({ spreadsheets: { S1: makeSpreadsheet([sheet]) }, drafts: [makeDraft('Hello', draftHtml)] }) };
}

for (const bad of ['Bob <a@x.com>', 'a@x', 'a@x.com b@y.com', 'a@x.com\nBcc: evil@z.com']) {
  test(`sendSingleEmail rejects "${JSON.stringify(bad)}"`, () => {
    const { ctx, sent, sheet } = fixture([[bad, 'Al']]);
    const res = ctx.sendSingleEmail('S1', 'Hello', 'Email', 1, 3, 4, true, null, 'S');
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, BAD);
    assert.strictEqual(sent.length, 0);
    assert.ok(sheet.writes.some(w => w.col === 4 && w.value === BAD));
    assert.ok(sheet.writes.some(w => w.col === 3 && w.value === false));
  });

  test(`processAndSend rejects "${JSON.stringify(bad)}"`, () => {
    const { ctx, sent, sheet } = fixture([[bad, 'Al'], ['ok@x.com', 'Bo']]);
    try { ctx.processAndSend('S1', 'Hello', 'Email', 1, 'S'); } catch (e) {}
    assert.deepStrictEqual(sent.map(s => s.to), ['ok@x.com']);
    assert.ok(sheet.writes.some(w => w.row === 2 && w.value === BAD));
  });
}

const MULTI = [
  ['a@x.com;b@y.com', 'a@x.com,b@y.com'],
  ['a@x.com, b@y.com', 'a@x.com,b@y.com'],
  ['a@x.com;b@y.com;', 'a@x.com,b@y.com'],
  ['a@x.com; A@X.com, b@y.com', 'a@x.com,b@y.com'],
];
for (const [cell, to] of MULTI) {
  test(`sendSingleEmail sends one email to "${cell}"`, () => {
    const { ctx, sent, sheet } = fixture([[cell, 'Al']]);
    const res = ctx.sendSingleEmail('S1', 'Hello', 'Email', 1, 3, 4, true, null, 'S');
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(sent.map(s => s.to), [to]);
    assert.ok(sheet.writes.some(w => w.col === 3 && w.value === true));
    assert.ok(!sheet.writes.some(w => w.col === 4 && w.value));
  });
  test(`processAndSend sends one email to "${cell}"`, () => {
    const { ctx, sent } = fixture([[cell, 'Al']]);
    ctx.processAndSend('S1', 'Hello', 'Email', 1, 'S');
    assert.deepStrictEqual(sent.map(s => s.to), [to]);
  });
}

test('sendSingleEmail partial invalid: sends valid, notes skipped, success', () => {
  const { ctx, sent, sheet } = fixture([['a@x.com;bad', 'Al']]);
  const res = ctx.sendSingleEmail('S1', 'Hello', 'Email', 1, 3, 4, true, null, 'S');
  assert.strictEqual(res.success, true);
  assert.deepStrictEqual(sent.map(s => s.to), ['a@x.com']);
  assert.ok(sheet.writes.some(w => w.col === 3 && w.value === true));
  assert.ok(sheet.writes.some(w => w.col === 4 && w.value === 'Sent; skipped invalid: bad'));
});

test('processAndSend partial invalid: sends valid, notes skipped', () => {
  const { ctx, sent, sheet } = fixture([['a@x.com;bad', 'Al']]);
  ctx.processAndSend('S1', 'Hello', 'Email', 1, 'S');
  assert.deepStrictEqual(sent.map(s => s.to), ['a@x.com']);
  assert.ok(sheet.writes.some(w => w.row === 2 && w.value === true));
  assert.ok(sheet.writes.some(w => w.row === 2 && w.value === 'Sent; skipped invalid: bad'));
});

test('header injection piece is skipped, never reaches To', () => {
  const { ctx, sent, sheet } = fixture([['a@x.com;b@y.com\nBcc: evil@z.com', 'Al']]);
  ctx.sendSingleEmail('S1', 'Hello', 'Email', 1, 3, 4, true, null, 'S');
  assert.deepStrictEqual(sent.map(s => s.to), ['a@x.com']);
  assert.ok(!/evil/.test(sent[0].to) && !sent[0].to.includes('\n'));
  assert.ok(sheet.writes.some(w => w.col === 4 && String(w.value).startsWith('Sent; skipped invalid:')));
});

test('skipped-invalid note cannot start with a formula char', () => {
  const { ctx, sheet } = fixture([['a@x.com;=cmd()', 'Al']]);
  ctx.sendSingleEmail('S1', 'Hello', 'Email', 1, 3, 4, true, null, 'S');
  const note = sheet.writes.find(w => w.col === 4 && w.value).value;
  assert.ok(/^Sent;/.test(note));
});

test('normal address is sent (trimmed)', () => {
  const { ctx, sent } = fixture([[' a@x.com ', 'Al']]);
  const res = ctx.sendSingleEmail('S1', 'Hello', 'Email', 1, 3, 4, true, null, 'S');
  assert.strictEqual(res.success, true);
  assert.strictEqual(sent[0].to, 'a@x.com');
});

test('cell html escaped in html, raw in text; newline -> <br>', () => {
  const { ctx, sent } = fixture([['a@x.com', '<img src=x>\nL2 & "q"']], '<p>Hi {{Name}}</p>');
  ctx.sendSingleEmail('S1', 'Hello', 'Email', 1, 3, 4, true, null, 'S');
  const m = sent[0];
  assert.ok(m.options.htmlBody.includes('&lt;img src=x&gt;<br>L2 &amp; &quot;q&quot;'), m.options.htmlBody);
  assert.ok(!m.options.htmlBody.includes('<img'));
  assert.ok(m.text.includes('<img src=x>\nL2 & "q"'), m.text);
});
