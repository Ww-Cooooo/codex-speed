'use strict';

const fs = require('node:fs');
const path = require('node:path');

function physicalPath(value) {
  let existing = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('路径不可用');
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...missing);
}

function pathsOverlap(first, second) {
  const a = physicalPath(first);
  const b = physicalPath(second);
  const within = (root, target) => {
    const relative = path.relative(root, target);
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  };
  return within(a, b) || within(b, a);
}

const STATUS_MESSAGES = Object.freeze({
  monitoring: '本地只读采集中',
  waiting: '等待下一次可计时的输出',
  unavailable: '暂未找到可用的本地记录',
  error: '采集暂不可用，请稍后重新打开',
});
const COLLECTION_ISSUE_MESSAGES = Object.freeze({
  catching_up: '正在补读记录，状态与统计尚未补齐',
  limited_discovery: '会话发现受限，可能未覆盖全部对话',
  state_unavailable: '会话索引暂不可用',
  logs_unavailable: '计时记录暂不可用',
  source_unavailable: '部分来源暂不可读',
  records_skipped: '部分记录未能解析，统计可能不完整',
});
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/ +()-]{0,79}$/;
const PROFILE_ID = /^[a-f0-9]{16,64}$/;
const CONVERSATION_ID = /^[a-f0-9]{64}$/;
const MAX_CONVERSATION_ORDER = 10512;
const MAX_PREFERENCES_BYTES = MAX_CONVERSATION_ORDER * 67 + 4096;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const TIERS = new Set(['auto', 'default', 'standard', 'fast', 'priority', 'ultrafast', 'flex', 'scale']);
const STATES = new Set(['generating', 'tool', 'waiting', 'idle', 'error', 'unknown']);
const UNSAFE_TITLE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const ownObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value, max) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const timestamp = (value) => typeof value === 'string' && value.length <= 40
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const tps = (value) => value === null || number(value, 1e7);
const exclusion = (value) => value === null ? null : '缺少可靠计时';

function sanitizeConversationOrder(value) {
  if (!Array.isArray(value) || value.length > MAX_CONVERSATION_ORDER) return null;
  const ids = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || !CONVERSATION_ID.test(id) || ids.has(id)) return null;
    ids.add(id);
  }
  return [...ids];
}

function sanitizeSample(value) {
  if (!ownObject(value) || typeof value.profileId !== 'string' || !PROFILE_ID.test(value.profileId)
    || typeof value.conversationId !== 'string' || !CONVERSATION_ID.test(value.conversationId)
    || !tps(value.tps) || !timestamp(value.completedAt)
    || !Number.isInteger(value.outputTokens) || !number(value.outputTokens, 1e9)
    || !number(value.durationSeconds, 86400)
    || (value.exclusion !== null && typeof value.exclusion !== 'string')) return undefined;
  return {
    profileId: value.profileId,
    conversationId: value.conversationId,
    tps: value.tps,
    completedAt: value.completedAt,
    outputTokens: value.outputTokens,
    durationSeconds: value.durationSeconds,
    exclusion: exclusion(value.exclusion),
  };
}

// Rebuild the renderer-facing object. Bounded titles are authorized for local
// display; source paths, bodies and arbitrary worker text are never forwarded.
function sanitizeSnapshot(value, expectedMode) {
  if (!ownObject(value) || value.schemaVersion !== 3 || value.mode !== expectedMode
    || !Object.hasOwn(STATUS_MESSAGES, value.status) || !timestamp(value.updatedAt)
    || !Array.isArray(value.profiles) || value.profiles.length > 10512
    || !Array.isArray(value.samples) || value.samples.length > 10000
    || !Array.isArray(value.conversations) || value.conversations.length > 10512
    || (value.collectionIssues !== undefined && (!Array.isArray(value.collectionIssues) || value.collectionIssues.length > 32))
    || (value.activeProfile !== null && (typeof value.activeProfile !== 'string' || !PROFILE_ID.test(value.activeProfile)))) return null;
  const profiles = [];
  const ids = new Set();
  for (const profile of value.profiles) {
    if (!ownObject(profile) || typeof profile.id !== 'string' || !PROFILE_ID.test(profile.id) || ids.has(profile.id)
      || (profile.model !== null && (typeof profile.model !== 'string' || !SAFE_NAME.test(profile.model)))
      || (profile.effort !== null && !EFFORTS.has(profile.effort))
      || (profile.requestedTier !== null && !TIERS.has(profile.requestedTier))
      || (profile.submittedTier !== null && !TIERS.has(profile.submittedTier))
      || (profile.actualTier !== null && !TIERS.has(profile.actualTier))) return null;
    ids.add(profile.id);
    profiles.push({ id: profile.id, model: profile.model, effort: profile.effort,
      requestedTier: profile.requestedTier, submittedTier: profile.submittedTier, actualTier: profile.actualTier });
  }
  const samples = [];
  for (const item of value.samples) {
    const sample = sanitizeSample(item);
    if (sample === undefined || !ids.has(sample.profileId)) return null;
    samples.push(sample);
  }
  if (value.activeProfile !== null && !ids.has(value.activeProfile)) return null;
  const conversations = [];
  const conversationIds = new Set();
  for (const item of value.conversations) {
    if (!ownObject(item) || typeof item.id !== 'string' || !CONVERSATION_ID.test(item.id) || conversationIds.has(item.id)
      || (item.title !== null && (typeof item.title !== 'string' || Array.from(item.title).length > 160 || UNSAFE_TITLE.test(item.title)))
      || !STATES.has(item.state) || (item.updatedAt !== null && !timestamp(item.updatedAt))
      || (item.isSubagent !== null && typeof item.isSubagent !== 'boolean')
      || (item.discovered !== undefined && typeof item.discovered !== 'boolean')
      || (item.profileId !== null && (typeof item.profileId !== 'string' || !ids.has(item.profileId)))) return null;
    conversationIds.add(item.id);
    conversations.push({ id: item.id, title: item.title, state: item.state, updatedAt: item.updatedAt, profileId: item.profileId, isSubagent: item.isSubagent, discovered: item.discovered === true });
  }
  if (samples.some(sample => !conversationIds.has(sample.conversationId))) return null;
  const collectionIssues = [...new Set((value.collectionIssues || []).filter(code => typeof code === 'string' && Object.hasOwn(COLLECTION_ISSUE_MESSAGES, code)))];
  return {
    schemaVersion: 3,
    mode: expectedMode,
    status: value.status,
    message: [STATUS_MESSAGES[value.status], ...collectionIssues.map(code => COLLECTION_ISSUE_MESSAGES[code])].join('；'),
    updatedAt: value.updatedAt,
    activeProfile: value.activeProfile,
    profiles,
    samples,
    conversations,
    collectionIssues,
  };
}

const WINDOW_WIDTH = 600;
const EXPANDED_HEIGHT = 640;
const COLLAPSED_HEIGHT = 144;
const MIN_WINDOW_WIDTH = 520;
const MIN_EXPANDED_HEIGHT = 420;
const MAX_WINDOW_DIMENSION = 16384;

function sanitizeExpandedSize(value) {
  if (!ownObject(value) || !Number.isInteger(value.width) || !Number.isInteger(value.height)
    || value.width <= 0 || value.height <= 0
    || value.width > MAX_WINDOW_DIMENSION || value.height > MAX_WINDOW_DIMENSION) return null;
  return { width: value.width, height: value.height };
}

function clampExpandedSize(size, workArea) {
  return {
    width: Math.min(workArea.width, Math.max(MIN_WINDOW_WIDTH, size.width)),
    height: Math.min(workArea.height, Math.max(MIN_EXPANDED_HEIGHT, size.height)),
  };
}

function clampBounds(bounds, workArea, height = bounds.height) {
  const width = Math.min(bounds.width, workArea.width);
  const clampedHeight = Math.min(height, workArea.height);
  return {
    x: Math.round(Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - clampedHeight))),
    width,
    height: clampedHeight,
  };
}

module.exports = { sanitizeSnapshot, sanitizeConversationOrder, sanitizeExpandedSize, clampExpandedSize,
  clampBounds, STATUS_MESSAGES, pathsOverlap, WINDOW_WIDTH, EXPANDED_HEIGHT, COLLAPSED_HEIGHT,
  MIN_WINDOW_WIDTH, MIN_EXPANDED_HEIGHT, MAX_WINDOW_DIMENSION, MAX_CONVERSATION_ORDER, MAX_PREFERENCES_BYTES };
