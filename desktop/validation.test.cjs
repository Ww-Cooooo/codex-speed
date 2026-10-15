'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSnapshot, sanitizeConversationOrder, sanitizeExpandedSize, clampExpandedSize, clampBounds, pathsOverlap,
  MAX_CONVERSATION_ORDER, MAX_PREFERENCES_BYTES } = require('./validation.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function sampleSnapshot() {
  return {
    schemaVersion: 3, mode: 'demo', status: 'monitoring', message: 'do not forward arbitrary worker text',
    updatedAt: '2026-10-13T10:20:30.000+00:00', activeProfile: 'a'.repeat(24),
    profiles: [{ id: 'a'.repeat(24), model: 'gpt-6.1-sol', effort: 'ultra', requestedTier: 'fast', submittedTier: null, actualTier: null }],
    conversations: [
      { id: 'b'.repeat(64), title: '开发窗口', state: 'generating', updatedAt: '2026-10-13T10:20:30.000Z', profileId: 'a'.repeat(24), isSubagent: false },
      { id: 'c'.repeat(64), title: null, state: 'unknown', updatedAt: null, profileId: null, isSubagent: null },
      { id: 'd'.repeat(64), title: '正在思考，还未完成输出', state: 'waiting', updatedAt: '2026-10-13T10:20:30.000Z', profileId: 'a'.repeat(24), isSubagent: true },
    ],
    samples: [{ profileId: 'a'.repeat(24), conversationId: 'b'.repeat(64),
      tps: 87.5, completedAt: '2026-10-13T10:20:20.000+00:00', outputTokens: 700, durationSeconds: 8,
      exclusion: null,
    }, { profileId: 'a'.repeat(24), conversationId: 'c'.repeat(64), tps: null,
      completedAt: '2026-10-13T10:15:20.000Z', outputTokens: 100, durationSeconds: 0, exclusion: 'untrusted text' }],
  };
}

test('worker data is rebuilt with a bounded allowlist before reaching the renderer', () => {
  const input = sampleSnapshot();
  input.secret = 'synthetic-secret';
  input.profiles[0].sourcePath = 'C:\\synthetic\\private.json';
  input.samples[0].conversation = 'synthetic content';
  input.conversations[0].rawBody = 'synthetic input body';
  const output = sanitizeSnapshot(input, 'demo');
  assert.equal(output.samples[0].tps, 87.5);
  assert.equal(output.message, '本地只读采集中');
  assert.equal(output.samples[1].exclusion, '缺少可靠计时');
  assert.equal(output.profiles[0].actualTier, null);
  assert.equal(output.profiles[0].requestedTier, 'fast');
  assert.equal(output.conversations[0].title, '开发窗口');
  assert.equal(output.conversations[2].state, 'waiting');
  const json = JSON.stringify(output);
  for (const text of ['synthetic-secret', 'private.json', 'synthetic content', 'synthetic input body', 'untrusted text', 'do not forward']) assert.ok(!json.includes(text));
});

test('invalid worker mode, text, dates, and numeric values are rejected', () => {
  assert.equal(sanitizeSnapshot(sampleSnapshot(), 'live'), null);
  for (const mutate of [
    (v) => { v.profiles[0].model = '<img onerror="bad">'; },
    (v) => { v.samples[0].tps = Infinity; },
    (v) => { v.samples[0].outputTokens = -1; },
    (v) => { v.profiles[0].effort = 'private arbitrary text'; },
    (v) => { v.profiles[0].actualTier = 'synthetic private text'; },
    (v) => { v.profiles[0].submittedTier = 'synthetic private text'; },
    (v) => { v.updatedAt = '2026-10-13T10:20:30.000Z hidden'; },
    (v) => { v.samples = Array(10001).fill(v.samples[0]); },
    (v) => { v.activeProfile = 'd'.repeat(24); },
    (v) => { v.samples[0].profileId = 'd'.repeat(24); },
    (v) => { v.samples[0].conversationId = 'raw-thread-id'; },
    (v) => { v.profiles.push(v.profiles[0]); },
    (v) => { v.conversations[0].title = 'bad\ncontrol'; },
    (v) => { v.conversations[0].title = '字'.repeat(161); },
    (v) => { v.conversations[0].profileId = 'missing'; },
    (v) => { v.conversations[0].state = 'untrusted'; },
    (v) => { v.conversations[0].isSubagent = 'not-boolean'; },
    (v) => { v.conversations.pop(); v.conversations.pop(); },
  ]) {
    const input = sampleSnapshot(); mutate(input);
    assert.equal(sanitizeSnapshot(input, 'demo'), null);
  }
});

test('unknown configuration stays unknown and old schemas are not silently reused', () => {
  const input = sampleSnapshot();
  Object.assign(input.profiles[0], { model: null, effort: null, requestedTier: null, submittedTier: null, actualTier: null });
  assert.deepEqual(sanitizeSnapshot(input, 'demo').profiles, input.profiles);
  input.schemaVersion = 1;
  assert.equal(sanitizeSnapshot(input, 'demo'), null);
  input.schemaVersion = 2;
  assert.equal(sanitizeSnapshot(input, 'demo'), null);
});

test('local display titles allow Unicode, including bounded emoji, without interpreting markup', () => {
  const input = sampleSnapshot();
  input.conversations[0].title = '🦊'.repeat(160);
  assert.equal(sanitizeSnapshot(input, 'demo').conversations[0].title, input.conversations[0].title);
  input.conversations[0].title = '<b>用户自定义名称</b>';
  assert.equal(sanitizeSnapshot(input, 'demo').conversations[0].title, input.conversations[0].title);
});

test('saved conversation ordering accepts only bounded unique anonymous IDs and returns a copy', () => {
  const input = ['b'.repeat(64), 'a'.repeat(64)];
  const output = sanitizeConversationOrder(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  input.reverse();
  assert.equal(output[0], 'b'.repeat(64));
  assert.deepEqual(sanitizeConversationOrder([]), []);
  for (const invalid of [null, undefined, {}, 'a'.repeat(64), ['raw-thread-id'], ['窗口标题'],
    ['A'.repeat(64)], ['a'.repeat(63)], ['a'.repeat(65)], ['a'.repeat(64), 'a'.repeat(64)],
    [null], Array(MAX_CONVERSATION_ORDER + 1).fill('a'.repeat(64))]) {
    assert.equal(sanitizeConversationOrder(invalid), null);
  }
  const maximum = Array.from({ length: MAX_CONVERSATION_ORDER }, (_, i) => i.toString(16).padStart(64, '0'));
  assert.equal(sanitizeConversationOrder(maximum).length, MAX_CONVERSATION_ORDER);
  assert.ok(Buffer.byteLength(JSON.stringify({ pinned: true, x: -1920, y: 24, conversationOrder: maximum })) < MAX_PREFERENCES_BYTES);
});

test('expansion preserves the top when possible and stays within the display otherwise', () => {
  const workArea = { x: -1920, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(clampBounds({ x: -620, y: 24, width: 600, height: 144 }, workArea, 640), {
    x: -620, y: 24, width: 600, height: 640,
  });
  assert.deepEqual(clampBounds({ x: 50, y: 920, width: 600, height: 144 }, workArea, 640), {
    x: -600, y: 400, width: 600, height: 640,
  });
  assert.deepEqual(clampBounds({ x: 100, y: 24, width: 600, height: 144 }, { x: 0, y: 0, width: 320, height: 500 }, 640), {
    x: 0, y: 0, width: 320, height: 500,
  });
});

test('saved window dimensions are bounded and do not import unrelated preference fields', () => {
  const value = { width: 900, height: 760, privateText: 'synthetic' };
  assert.deepEqual(sanitizeExpandedSize(value), { width: 900, height: 760 });
  assert.notEqual(sanitizeExpandedSize(value), value);
  for (const invalid of [null, [], 600, { width: '600', height: 640 }, { width: 600.5, height: 640 },
    { width: 0, height: 640 }, { width: -1, height: 640 }, { width: 600, height: Infinity },
    { width: 16385, height: 640 }, { width: 600, height: 16385 }]) assert.equal(sanitizeExpandedSize(invalid), null);
});

test('user width is preserved while bounds and restored size fit the available display', () => {
  const area = { x: 100, y: 50, width: 1200, height: 900 };
  assert.deepEqual(clampBounds({ x: 200, y: 100, width: 900, height: 760 }, area), { x: 200, y: 100, width: 900, height: 760 });
  assert.deepEqual(clampBounds({ x: 1000, y: 800, width: 900, height: 760 }, area, 144), { x: 400, y: 800, width: 900, height: 144 });
  assert.deepEqual(clampExpandedSize({ width: 100, height: 100 }, area), { width: 520, height: 420 });
  assert.deepEqual(clampExpandedSize({ width: 1600, height: 1200 }, area), { width: 1200, height: 900 });
  assert.deepEqual(clampExpandedSize({ width: 600, height: 640 }, { width: 320, height: 300 }), { width: 320, height: 300 });
});

test('source and application writes must be separate, including physical parent paths', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tps-path-check-'));
  try {
    assert.equal(pathsOverlap(temporary, path.join(temporary, 'data', 'uncreated')), true);
    assert.equal(pathsOverlap(path.join(temporary, 'source'), temporary), true);
    assert.equal(pathsOverlap(path.join(temporary, 'source'), path.join(temporary, 'data')), false);
    fs.mkdirSync(path.join(temporary, 'physical'));
    fs.symlinkSync(path.join(temporary, 'physical'), path.join(temporary, 'alias'), 'junction');
    assert.equal(pathsOverlap(path.join(temporary, 'physical'), path.join(temporary, 'alias', 'uncreated')), true);
    fs.unlinkSync(path.join(temporary, 'alias'));
    fs.rmdirSync(path.join(temporary, 'physical'));
  } finally {
    fs.rmdirSync(temporary);
  }
});
