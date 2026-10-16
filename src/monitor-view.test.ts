import test from 'node:test';
import assert from 'node:assert/strict';
import type {ConversationState, Snapshot} from './contracts';
import {dismissPendingRunning, receiveMonitorView, type MonitorView} from './monitor-view.ts';

const stamp = (step: number) => new Date(1_800_000_000_000 + step * 2000).toISOString();
const make = (step: number, states: ConversationState[], status: Snapshot['status'] = 'monitoring'): Snapshot => ({
  schemaVersion: 3, mode: 'demo', status, message: '', updatedAt: stamp(step), activeProfile: null, profiles: [], samples: [],
  conversations: states.map((state, i) => ({id: String(i), title: `对话${i}`, state, updatedAt: stamp(0), profileId: null, isSubagent: false})),
});
const start = (): MonitorView => ({snapshot: make(0, ['generating', 'tool', 'waiting', 'generating']), pendingRunningIds: [], retainedUnknownIds: [], cached: false});

test('4→3→1→4 observations keep card identities while uncertain states stay truthful', () => {
  let view = start();
  for (const [step, states, pending] of [
    [1, ['generating','tool','unknown','generating'], ['2']],
    [2, ['unknown','unknown','unknown','generating'], ['2','0','1']],
    [3, ['generating','tool','waiting','generating'], []],
  ] as [number, ConversationState[], string[]][]) {
    view = receiveMonitorView(view, make(step, states));
    assert.deepEqual(view.snapshot.conversations.map(row => row.id), ['0','1','2','3']);
    assert.deepEqual(view.snapshot.conversations.map(row => row.state), states);
    assert.deepEqual(view.pendingRunningIds, pending);
  }
});

test('explicit completion or failure leaves the retained running placement immediately', () => {
  const lost = receiveMonitorView(start(), make(1, ['unknown','unknown','waiting','generating']));
  const ended = receiveMonitorView(lost, make(2, ['idle','error','waiting','generating']));
  assert.deepEqual(ended.pendingRunningIds, []);
  assert.deepEqual(ended.snapshot.conversations.slice(0,2).map(row => row.state), ['idle','error']);
});

test('one failed poll preserves last data without pretending it is fresh', () => {
  const old = start();
  old.snapshot.samples = [{conversationId:'0',profileId:'p',tps:80,outputTokens:800,durationSeconds:10,exclusion:null,completedAt:stamp(0)}];
  const failed = receiveMonitorView(old, make(1, [], 'error'));
  assert.equal(failed.cached, true);
  assert.equal(failed.snapshot.status, 'error');
  assert.equal(failed.snapshot.samples, old.snapshot.samples);
  assert.equal(failed.snapshot.samples[0].completedAt, stamp(0));
  assert.deepEqual(failed.pendingRunningIds, ['0','1','2','3']);
  assert.ok(failed.snapshot.conversations.every(row => row.state === 'unknown'));
  const recovered = receiveMonitorView(failed, make(2, ['generating','tool','waiting','generating']));
  assert.equal(recovered.cached, false);
  assert.deepEqual(recovered.pendingRunningIds, []);
});

test('missing known active row is retained; cold unknown rows never enter running placement', () => {
  const view = receiveMonitorView(start(), make(1, ['generating','tool']));
  assert.deepEqual(view.pendingRunningIds, ['2','3']);
  const cold: MonitorView = {snapshot:make(0,[]),pendingRunningIds:[],retainedUnknownIds:[],cached:false};
  assert.deepEqual(receiveMonitorView(cold, make(1,['unknown'])).pendingRunningIds, []);
});

test('manual transfer persists through unknown polls but new live evidence can reenter', () => {
  const pending = receiveMonitorView(start(), make(1, ['unknown','tool','waiting','generating']));
  const moved = dismissPendingRunning(pending, '0');
  const stillUnknown = receiveMonitorView(moved, make(2, ['unknown','tool','waiting','generating']));
  assert.deepEqual(stillUnknown.pendingRunningIds, []);
  const live = receiveMonitorView(stillUnknown, make(3,['generating','tool','waiting','generating']));
  assert.deepEqual(receiveMonitorView(live,make(4,['unknown','tool','waiting','generating'])).pendingRunningIds, ['0']);
});

test('stale callback and a different demo/live source do not carry obsolete placement', () => {
  const view = receiveMonitorView(start(),make(2,['unknown','tool','waiting','generating']));
  assert.equal(receiveMonitorView(view,make(1,['idle','tool','waiting','generating'])),view);
  assert.deepEqual(receiveMonitorView(view,{...make(3,['unknown']),mode:'live'}).pendingRunningIds,[]);
});

test('manually transferred missing rows stay in unknown placement on later missing polls', () => {
  const missing = receiveMonitorView(start(),make(1,[]));
  const moved = dismissPendingRunning(missing,'0');
  const next = receiveMonitorView(moved,make(2,[]));
  assert.equal(next.snapshot.conversations.find(row => row.id === '0')?.state,'unknown');
  assert.equal(next.pendingRunningIds.includes('0'),false);
  assert.equal(next.retainedUnknownIds.includes('0'),true);
});

test('retained incomplete cards keep referenced configuration without creating speed samples', () => {
  const old = start();
  old.snapshot.profiles = [{id:'p',model:'known-model',effort:'high',requestedTier:null,submittedTier:null,actualTier:null}];
  old.snapshot.conversations[0].profileId = 'p';
  const next = receiveMonitorView(old,make(1,[]));
  assert.equal(next.snapshot.conversations.find(row => row.id === '0')?.profileId,'p');
  assert.equal(next.snapshot.profiles.find(profile => profile.id === 'p')?.model,'known-model');
  assert.deepEqual(next.snapshot.samples,[]);
  assert.equal(next.snapshot.message.includes('正在重试'),false);
});
