import type {ConversationView, Snapshot} from './contracts';
import {isRunning} from './statistics.ts';

export interface MonitorView {
  snapshot: Snapshot;
  pendingRunningIds: string[];
  retainedUnknownIds: string[];
  cached: boolean;
}

/** A missing observation is not a completed task. Keep its place, while the
 * actual unknown state and separate count remain visible. Never persist this
 * session-only placement or infer an active task from cold historical data. */
export function receiveMonitorView(previous: MonitorView, incoming: Snapshot): MonitorView {
  const before = previous.snapshot;
  if (incoming.mode !== before.mode && incoming.status !== 'error') return {snapshot: incoming, pendingRunningIds: [], retainedUnknownIds: [], cached: false};
  if ((before.conversations.length > 0 || before.samples.length > 0) && Date.parse(incoming.updatedAt) < Date.parse(before.updatedAt)) return previous;
  const cached = (incoming.status === 'error' || incoming.status === 'unavailable') && (before.conversations.length > 0 || before.samples.length > 0);
  const source = cached ? {...before, status: incoming.status, updatedAt: incoming.updatedAt,
    message: `${incoming.message || '监测暂时中断'}；已保留上次记录。`,
    conversations: before.conversations.map(row => isRunning(row.state) ? {...row, state: 'unknown' as const} : row)} : incoming;
  const known = new Map(before.conversations.map(row => [row.id, row]));
  const pending = new Set(previous.pendingRunningIds);
  const retainedUnknown = new Set(previous.retainedUnknownIds);
  const conversations: ConversationView[] = source.conversations.map(row => {
    const old = known.get(row.id);
    if (row.state === 'unknown' && (pending.has(row.id) || (old && isRunning(old.state)))) {
      pending.add(row.id);
      return {...row, title: row.title ?? old?.title ?? null, profileId: row.profileId ?? old?.profileId ?? null,
        updatedAt: row.updatedAt ?? old?.updatedAt ?? null, isSubagent: row.isSubagent ?? old?.isSubagent ?? null};
    } else if (row.state !== 'unknown') {pending.delete(row.id); retainedUnknown.delete(row.id);}
    return row;
  });
  const present = new Set(conversations.map(row => row.id));
  for (const old of before.conversations) {
    if (!present.has(old.id) && (isRunning(old.state) || pending.has(old.id) || retainedUnknown.has(old.id))) {
      if (isRunning(old.state)) pending.add(old.id);
      conversations.push({...old, state: 'unknown'});
    }
  }
  const profiles = [...source.profiles], profileIds = new Set(profiles.map(profile => profile.id));
  for (const row of conversations) {
    if (!row.profileId || profileIds.has(row.profileId)) continue;
    const oldProfile = before.profiles.find(profile => profile.id === row.profileId);
    if (oldProfile) {profiles.push(oldProfile); profileIds.add(oldProfile.id);}
  }
  return {snapshot: {...source, profiles, conversations}, pendingRunningIds: [...pending].filter(id => conversations.some(row => row.id === id)),
    retainedUnknownIds: [...retainedUnknown].filter(id => conversations.some(row => row.id === id)), cached};
}

export function dismissPendingRunning(view: MonitorView, id: string): MonitorView {
  return {...view, pendingRunningIds: view.pendingRunningIds.filter(value => value !== id),
    retainedUnknownIds: view.pendingRunningIds.includes(id) ? [...new Set([...view.retainedUnknownIds, id])] : view.retainedUnknownIds};
}
