import test from 'node:test';
import assert from 'node:assert/strict';
import { compactSpeed, countConversationActivity, deriveOverview, deriveScope, hasUnknownConfiguration, mergeConversationOrder, moveConversation, orderConversationRows, periodBounds, speedLabel, splitConversationRows } from './statistics.ts';
import type { ProfileView, SampleView, Snapshot } from './contracts';

const now = new Date(2026, 9, 13, 12, 0).getTime();
const p1: ProfileView = { id: 'a1'.repeat(16), model: 'same-model', effort: 'high', requestedTier: 'priority', submittedTier: null, actualTier: null };
const p2: ProfileView = { ...p1, id: 'b2'.repeat(16), effort: 'low', requestedTier: 'default' };
const unknown: ProfileView = { id: 'c3'.repeat(16), model: null, effort: null, requestedTier: null, submittedTier: null, actualTier: null };
const convA = 'ab'.repeat(32);
const convB = 'cd'.repeat(32);
const sample = (overrides: Partial<SampleView> = {}): SampleView => ({ profileId: p1.id, conversationId: convA, completedAt: new Date(now - 60_000).toISOString(), tps: 10, outputTokens: 100, durationSeconds: 10, exclusion: null, ...overrides });
const snapshot = (samples: SampleView[]): Snapshot => ({ schemaVersion: 3, mode: 'demo', status: 'monitoring', message: '', updatedAt: new Date(now).toISOString(), activeProfile: p1.id, profiles: [p1, p2, unknown], samples, conversations: [] });

test('weighted average uses only measurable samples in one conversation and configuration', () => {
  const result = deriveScope(snapshot([
    sample({ outputTokens: 100, durationSeconds: 1, tps: 100 }),
    sample({ outputTokens: 100, durationSeconds: 9, tps: 100 / 9 }),
    sample({ outputTokens: 9000, durationSeconds: 1, tps: 9000, exclusion: 'cancelled' }),
    sample({ outputTokens: 9000, durationSeconds: 1, tps: 9000, conversationId: convB }),
    sample({ outputTokens: 9000, durationSeconds: 1, tps: 9000, profileId: p2.id }),
  ]), convA, 'today', now, p1.id);
  assert.equal(result.average, 20);
  assert.equal(result.validCount, 2);
  assert.equal(result.excludedCount, 1);
  assert.equal(result.points.at(-1)?.tps, null);
  assert.equal(result.points.at(-1)?.exclusion, 'cancelled');
});

test('local calendar ranges include the boundary and prior days without including future records', () => {
  const [start, end] = periodBounds('7days', now);
  assert.equal(start, new Date(2026, 9, 7).getTime());
  assert.equal(end, now);
  assert.equal(periodBounds('30days', now)[0], new Date(2026, 8, 14).getTime());
  const data = snapshot([sample({ completedAt: new Date(start).toISOString() }), sample({ completedAt: new Date(start - 1).toISOString() }), sample({ completedAt: new Date(now + 1).toISOString() })]);
  assert.equal(deriveScope(data, null, '7days', now, null).validCount, 1);
  assert.equal(deriveScope(data, null, 'today', now, null).validCount, 0);
});

test('compact overview tier retains evidence and never confirms a requested Fast tier', () => {
  assert.deepEqual(compactSpeed(unknown), { label: '—', title: '本地记录未提供可识别档位，不代表未开启 Fast。', source: 'unknown' });
  assert.equal(compactSpeed().label, '—');
  assert.equal(compactSpeed(p1).label, 'Fast?');
  assert.equal(compactSpeed(p1).source, 'requested');
  assert.match(compactSpeed(p1).title, /实际处理：尚未确认；请求档位：Fast/);
  const submitted = compactSpeed({ ...p1, requestedTier: null, submittedTier: 'priority' });
  assert.equal(submitted.label, 'Fast?');
  assert.equal(submitted.source, 'submitted');
  assert.match(submitted.title, /提交设置：Fast/);
  assert.equal(compactSpeed({ ...p1, actualTier: 'priority' }).label, 'Fast');
  const differentActual = compactSpeed({ ...p1, actualTier: 'default' });
  assert.equal(differentActual.label, '标准');
  assert.equal(differentActual.source, 'actual');
  assert.match(differentActual.title, /实际处理：标准（已确认）；请求档位：Fast/);
  assert.equal(compactSpeed({ ...p1, actualTier: 'flex' }).label, 'Flex');
  assert.equal(compactSpeed({ ...p1, actualTier: 'burst-x' }).label, 'burst-x');
});

test('automatic selection follows newest scoped profile while an existing manual selection stays stable', () => {
  const data = snapshot([sample(), sample({ profileId: p2.id, conversationId: convB, completedAt: new Date(now - 1000).toISOString() })]);
  assert.equal(deriveScope(data, null, 'today', now, null).profile?.id, p2.id);
  assert.equal(deriveScope(data, null, 'today', now, p1.id).profile?.id, p1.id);
  assert.equal(deriveScope(data, convA, 'today', now, null).profile?.id, p1.id);
  const empty = deriveScope(data, 'ef'.repeat(32), 'today', now, p1.id);
  assert.equal(empty.profile, undefined);
  assert.equal(empty.latest, undefined);
  assert.equal(empty.average, null);
});

test('unknown configuration stays separate and request tier is never described as confirmed', () => {
  assert.equal(speedLabel(p1), 'Fast请求');
  assert.equal(speedLabel(unknown), '速度档位未知');
  assert.equal(hasUnknownConfiguration(p1), false);
  assert.equal(hasUnknownConfiguration(unknown), true);
  assert.equal(speedLabel({ ...p1, actualTier: 'default' }), '标准已确认 / Fast请求');
  assert.equal(speedLabel({ ...p1, requestedTier: null, submittedTier: 'priority' }), 'Fast提交');
  assert.equal(hasUnknownConfiguration({ ...p1, requestedTier: null, submittedTier: 'priority' }), false);
  const result = deriveScope(snapshot([sample({ profileId: unknown.id })]), null, 'today', now, null);
  assert.equal(result.unknownCount, 1);
  assert.equal(result.profile?.id, unknown.id);
});

test('overview keeps each conversation and latest output configuration averages separate', () => {
  const data = snapshot([
    sample({ outputTokens: 100, durationSeconds: 1, tps: 100 }),
    sample({ outputTokens: 100, durationSeconds: 9, tps: 100 / 9 }),
    sample({ outputTokens: 9000, durationSeconds: 1, tps: 9000, exclusion: 'cancelled' }),
    sample({ outputTokens: 9000, durationSeconds: 1, tps: 9000, profileId: p2.id, completedAt: new Date(now - 120_000).toISOString() }),
    sample({ outputTokens: 500, durationSeconds: 10, tps: 50, conversationId: convB }),
  ]);
  data.conversations = [{ id: convA, title: '同名测试', state: 'generating', updatedAt: new Date(now).toISOString(), profileId: p2.id, isSubagent: false },
    { id: convB, title: '同名测试', state: 'tool', updatedAt: new Date(now).toISOString(), profileId: p1.id, isSubagent: false }];
  const rows = deriveOverview(data, 'today', now);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, convA);
  assert.equal(rows[0].average, 20);
  assert.equal(rows[0].validCount, 2);
  assert.equal(rows[0].excludedCount, 1);
  assert.equal(rows[0].latest?.exclusion, 'cancelled');
  assert.equal(rows[0].outputProfile?.id, p1.id);
  assert.equal(rows[0].currentProfile?.id, p2.id);
  assert.equal(rows[1].average, 50);
  assert.notEqual(rows[0].label, rows[1].label);
  assert.ok(rows[0].label.startsWith('同名测试'));
});

test('running conversations stay in overview without samples in the selected period', () => {
  const data = snapshot([sample({ completedAt: new Date(now - 2 * 86_400_000).toISOString() })]);
  data.conversations = [{ id: convA, title: '旧输出仍在运行', state: 'tool', updatedAt: new Date(now).toISOString(), profileId: p2.id, isSubagent: false },
    { id: convB, title: '尚未完成输出', state: 'generating', updatedAt: new Date(now - 1000).toISOString(), profileId: p1.id, isSubagent: false }];
  const rows = deriveOverview(data, 'today', now);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, convB);
  assert.equal(rows[0].latest, undefined);
  assert.equal(rows[0].average, null);
  assert.equal(rows[0].currentProfile?.id, p1.id);
  assert.equal(rows[1].latest?.profileId, p1.id);
  assert.equal(rows[1].average, null);
  assert.equal(rows[1].validCount, 0);
});

test('history-only overview rows use anonymous names and ignore invalid or future timestamps', () => {
  const data = snapshot([sample(), sample({ conversationId: convB, completedAt: new Date(now + 1).toISOString() }), sample({ conversationId: convB, completedAt: 'bad' })]);
  const rows = deriveOverview(data, 'today', now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'unknown');
  assert.equal(rows[0].label, `对话 ${convA.slice(-8)}`);
  assert.equal(deriveOverview(snapshot([]), 'today', now).length, 0);
});

test('overview hides only confirmed subagents and keeps per-conversation averages intact', () => {
  const convUnknown = 'ef'.repeat(32);
  const data = snapshot([sample({ outputTokens: 100, durationSeconds: 10, tps: 10 }),
    sample({ conversationId: convB, outputTokens: 900, durationSeconds: 10, tps: 90 }),
    sample({ conversationId: convUnknown, outputTokens: 200, durationSeconds: 10, tps: 20 })]);
  data.conversations = [
    { id: convA, title: '主对话', state: 'generating', updatedAt: new Date(now).toISOString(), profileId: p1.id, isSubagent: false },
    { id: convB, title: '子任务', state: 'tool', updatedAt: new Date(now).toISOString(), profileId: p1.id, isSubagent: true },
    { id: convUnknown, title: null, state: 'unknown', updatedAt: null, profileId: null, isSubagent: null },
  ];
  const visible = deriveOverview(data, 'today', now);
  assert.deepEqual(new Set(visible.map((row) => row.id)), new Set([convA, convUnknown]));
  assert.equal(visible.find((row) => row.id === convA)?.average, 10);
  assert.equal(visible.find((row) => row.id === convUnknown)?.average, 20);
  const all = deriveOverview(data, 'today', now, true);
  assert.equal(all.length, 3);
  assert.equal(all.find((row) => row.id === convB)?.average, 90);
});

test('overview omits history-only rows outside the period while preserving observed or running rows', () => {
  const old = sample({ completedAt: new Date(now - 2 * 86_400_000).toISOString() });
  const data = snapshot([old]);
  assert.equal(deriveOverview(data, 'today', now).length, 0);
  assert.equal(deriveOverview(data, '7days', now).length, 1);
  data.conversations = [{ id: convA, title: '正在运行', state: 'generating', updatedAt: null, profileId: p1.id, isSubagent: null }];
  assert.equal(deriveOverview(data, 'today', now).length, 1);
  data.conversations[0] = { ...data.conversations[0], state: 'idle', updatedAt: new Date(now).toISOString() };
  assert.equal(deriveOverview(data, 'today', now).length, 1);
});

test('discovered main conversations remain visible before state catch-up without reviving old history or hidden subagents', () => {
  const child = 'ef'.repeat(32);
  const data = snapshot([sample({conversationId:convB,completedAt:new Date(now - 2 * 86_400_000).toISOString()})]);
  data.conversations = [
    {id:convA,title:'仍在补读的主对话',state:'unknown',updatedAt:null,profileId:null,isSubagent:false,discovered:true},
    {id:convB,title:null,state:'unknown',updatedAt:null,profileId:null,isSubagent:null,discovered:false},
    {id:child,title:'明确子任务',state:'unknown',updatedAt:null,profileId:null,isSubagent:true,discovered:true},
  ];
  const rows = deriveOverview(data,'today',now);
  assert.deepEqual(rows.map(row=>row.id),[convA]);
  assert.equal(rows[0].state,'unknown');assert.equal(rows[0].latest,undefined);assert.equal(rows[0].average,null);
  assert.deepEqual(new Set(deriveOverview(data,'today',now,true).map(row=>row.id)),new Set([convA,child]));
  assert.ok(deriveOverview(data,'7days',now).some(row=>row.id===convB));
});

test('explicit session-retained IDs survive period filtering without promoting unrelated cold history', () => {
  const data=snapshot([]);
  data.conversations=[convA,convB].map(id=>({id,title:null,state:'unknown',updatedAt:null,profileId:null,isSubagent:false,discovered:false}));
  assert.equal(deriveOverview(data,'today',now).length,0);
  assert.deepEqual(deriveOverview(data,'today',now,false,null,new Set([convA])).map(row=>row.id),[convA]);
});

test('activity counts separate uncertainty from confirmed work, including after selecting one row', () => {
  const data=snapshot([]);
  data.conversations=['generating','tool','waiting','unknown'].map((state,index)=>({id:String(index),title:null,state:state as 'generating'|'tool'|'waiting'|'unknown',updatedAt:null,profileId:null,isSubagent:false}));
  const pending=new Set(['3','0']); // A stale placement marker must not double-count live work.
  assert.deepEqual(countConversationActivity(data.conversations,pending),{running:3,waitingRecords:1});
  assert.deepEqual(countConversationActivity(data.conversations.filter(row=>row.id!=='0'),pending),{running:2,waitingRecords:1});
  data.conversations[3].state='generating';
  assert.deepEqual(countConversationActivity(data.conversations,pending),{running:4,waitingRecords:0});
});

test('monitor groups retain stable row order through phase and timestamp updates', () => {
  const data = snapshot([]);
  data.conversations = [
    { id: '30', title: '生成', state: 'generating', updatedAt: new Date(now).toISOString(), profileId: p1.id, isSubagent: false },
    { id: '10', title: '工具', state: 'tool', updatedAt: new Date(now - 1000).toISOString(), profileId: p1.id, isSubagent: false },
    { id: '20', title: '等待', state: 'waiting', updatedAt: new Date(now - 2000).toISOString(), profileId: p1.id, isSubagent: false },
    { id: '50', title: '空闲', state: 'idle', updatedAt: new Date(now).toISOString(), profileId: p1.id, isSubagent: false },
    { id: '40', title: '异常', state: 'error', updatedAt: new Date(now).toISOString(), profileId: p1.id, isSubagent: false },
    { id: '60', title: '未知', state: 'unknown', updatedAt: new Date(now).toISOString(), profileId: p1.id, isSubagent: false },
  ];
  const rows = deriveOverview(data, 'today', now);
  const before = rows.map((row) => row.id);
  const order = mergeConversationOrder([], rows.map((row) => row.id));
  const grouped = splitConversationRows(rows, order);
  assert.deepEqual(grouped.running.map((row) => row.id), ['10', '20', '30']);
  assert.deepEqual(grouped.idle.map((row) => row.id), ['40', '50']);
  assert.deepEqual(grouped.unknown.map((row) => row.id), ['60']);
  assert.deepEqual(rows.map((row) => row.id), before);

  data.conversations = data.conversations.reverse().map((conversation) => conversation.id === '30'
    ? { ...conversation, state: 'tool', updatedAt: new Date(now - 10_000).toISOString() }
    : conversation.id === '20' ? { ...conversation, state: 'generating', updatedAt: new Date(now).toISOString() } : conversation);
  const updated = deriveOverview(data, 'today', now);
  assert.deepEqual(splitConversationRows(updated, order).running.map((row) => row.id), ['10', '20', '30']);
  assert.deepEqual(orderConversationRows(updated, order).map((row) => row.id), order);

  data.conversations = data.conversations.map((conversation) => conversation.id === '20' ? { ...conversation, state: 'idle' } : conversation);
  const crossed = deriveOverview(data, 'today', now);
  const moved = splitConversationRows(crossed, order);
  assert.deepEqual(moved.running.map((row) => row.id), ['10', '30']);
  assert.deepEqual(moved.idle.map((row) => row.id), ['20', '40', '50']);
  assert.deepEqual(orderConversationRows(crossed, order).map((row) => row.id), order);
});

test('global order survives hidden rows, reordered sources, new discoveries and saved-state readback', () => {
  const discovered = ['30', '10', '20', '10'];
  const initial = mergeConversationOrder([], discovered);
  assert.deepEqual(initial, ['10', '20', '30']);
  assert.deepEqual(discovered, ['30', '10', '20', '10']);

  const manual = ['30', '10', '20'];
  const readBack = JSON.parse(JSON.stringify(manual)) as string[];
  const merged = mergeConversationOrder(readBack, ['20', '05', '30', '05', '40']);
  assert.deepEqual(merged, ['30', '10', '20', '05', '40']);
  assert.deepEqual(readBack, manual);
  assert.deepEqual(mergeConversationOrder(merged, ['40', '20', '30']), merged);
  assert.deepEqual(mergeConversationOrder(merged, []), merged);

  const rows = deriveOverview(snapshot(['20', '40', '10'].map((conversationId) => sample({ conversationId }))), 'today', now);
  const sourceOrder = rows.map((row) => row.id);
  assert.deepEqual(orderConversationRows(rows, merged).map((row) => row.id), ['10', '20', '40']);
  assert.deepEqual(rows.map((row) => row.id), sourceOrder);
  assert.deepEqual(splitConversationRows(rows, ['40', '20', '10']).unknown.map((row) => row.id), ['40', '20', '10']);
});

test('one move preserves every other ID including hidden rows, and cancelled or unknown drops are no-ops', () => {
  const order = ['a', 'hidden-1', 'b', 'hidden-2', 'c'];
  assert.deepEqual(moveConversation(order, 'a', 'b', 'after'), ['hidden-1', 'b', 'a', 'hidden-2', 'c']);
  assert.deepEqual(moveConversation(order, 'c', 'b', 'before'), ['a', 'hidden-1', 'c', 'b', 'hidden-2']);
  for (const [source, target] of [['missing', 'b'], ['a', 'missing'], ['a', 'a'], ['a', null]] as const) {
    assert.deepEqual(moveConversation(order, source, target, 'before'), order);
  }
  assert.deepEqual(order, ['a', 'hidden-1', 'b', 'hidden-2', 'c']);
});

test('in-session merging keeps established IDs even beyond the desktop persistence limit', () => {
  const existing = Array.from({ length: 10_512 }, (_, index) => index.toString(16).padStart(64, '0'));
  const newest = 'f'.repeat(64);
  const merged = mergeConversationOrder(existing, [newest]);
  assert.equal(merged.length, existing.length + 1);
  assert.deepEqual(merged.slice(0, existing.length), existing);
  assert.equal(merged.at(-1), newest);
});

test('selected history row survives a period change without leaking old statistics or hidden subagents', () => {
  const old = new Date(now - 2 * 86_400_000).toISOString();
  const data = snapshot([sample({ completedAt: old }), sample({ conversationId: convB, completedAt: old })]);
  assert.equal(deriveOverview(data, '7days', now).length, 2);
  const retained = deriveOverview(data, 'today', now, false, convA);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].id, convA);
  assert.equal(retained[0].state, 'unknown');
  assert.equal(retained[0].latest?.completedAt, old);
  assert.equal(retained[0].average, null);
  assert.equal(retained[0].validCount, 0);
  assert.equal(deriveScope(data, convA, 'today', now, p1.id).points.length, 0);
  assert.equal(deriveOverview(data, 'today', now, false, 'missing-source').length, 0);

  data.conversations = [{ id: convA, title: '子任务', state: 'idle', updatedAt: null, profileId: p1.id, isSubagent: true }];
  assert.equal(deriveOverview(data, 'today', now, false, convA).length, 0);
  assert.equal(deriveOverview(data, 'today', now, true, convA).length, 1);
});
