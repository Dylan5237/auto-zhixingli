'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RelayLogic, DEFAULT_CONFIG, RELAY_VERSION } = require('../extension/relay-v1/content.js');

const V = (over) => ({ id: 'v', paused: true, ended: false, currentTime: 0, duration: 100, readyState: 4, playbackRate: 1, muted: false, ...over });

test('版本与配置常量存在', () => {
  assert.equal(typeof RELAY_VERSION, 'string');
  assert.equal(DEFAULT_CONFIG.autoClick, false);
  assert.ok(DEFAULT_CONFIG.endConfirmSeconds > 0);
});

test('pickActive 选择未暂停且可播放中 currentTime 最大者', () => {
  const list = [
    V({ id: 'a', paused: true, currentTime: 50 }),
    V({ id: 'b', paused: false, currentTime: 30, readyState: 4 }),
    V({ id: 'c', paused: false, currentTime: 80, readyState: 4 }),
    V({ id: 'd', paused: false, currentTime: 99, readyState: 1 }),
    V({ id: 'e', ended: true, paused: true, currentTime: 100 }),
  ];
  assert.equal(RelayLogic.pickActive(list), 'c');
  assert.equal(RelayLogic.pickActive([V({ paused: true }), V({ ended: true })]), null);
});

test('isNaturalEnd：出现 ended 后短确认即可判定', () => {
  const list = [V({ ended: true, paused: true, currentTime: 100 }), V({ paused: true, currentTime: 0 })];
  assert.equal(RelayLogic.isNaturalEnd(list, 3, DEFAULT_CONFIG), true);
});

test('暂停或贴近结尾都不能代替自然 ended', () => {
  const near = [V({ currentTime: 99.6, duration: 100 })];
  const paused = [V({ currentTime: 10, duration: 100 })];
  assert.equal(RelayLogic.isNaturalEnd(near, 60, DEFAULT_CONFIG), false);
  assert.equal(RelayLogic.isNaturalEnd(paused, 60, DEFAULT_CONFIG), false);
  assert.equal(RelayLogic.isNaturalEnd([V({ ended: true, currentTime: 100 })], 0, DEFAULT_CONFIG), false);
});

test('isNaturalEnd：任一媒体在播即不判定；空列表不判定', () => {
  const list = [V({ paused: false, currentTime: 10 }), V({ ended: true, currentTime: 100 })];
  assert.equal(RelayLogic.isNaturalEnd(list, 60, DEFAULT_CONFIG), false);
  assert.equal(RelayLogic.isNaturalEnd([], 60, DEFAULT_CONFIG), false);
});

test('未知时长和停滞不触发换课', () => {
  assert.equal(RelayLogic.isNaturalEnd([V({ currentTime: 42, duration: NaN })], 600, DEFAULT_CONFIG), false);
});

test('目标必须唯一明确，列表重排不改变目标', () => {
  const entries = [{ text: '课程 A', id: 'a' }, { text: '课程 B', id: 'b' }];
  assert.equal(RelayLogic.pickCourseIndex(entries, 'id:b'), 1);
  assert.equal(RelayLogic.pickCourseIndex([...entries].reverse(), 'id:b'), 0);
  assert.equal(RelayLogic.pickCourseIndex(entries, 'text:课程 B'), 1);
  for (const rule of ['', 'first', 'index:1', 'contains:课程', 'id:missing']) {
    assert.equal(RelayLogic.pickCourseIndex(entries, rule), -1);
  }
  assert.equal(RelayLogic.pickCourseIndex([...entries, { text: '课程 B', id: 'b' }], 'id:b'), -1);
  assert.equal(RelayLogic.pickCourseIndex([...entries, { text: '课程 B' }], 'text:课程 B'), -1);
});

test('点选配置不能把学习中、未完成、章节或时长当整课完成', () => {
  for (const text of ['学习中', '未完成', '未全部完成', '章节已完成', '学习时长100%', '100%']) {
    assert.equal(RelayLogic.isCompletionText(text), false);
  }
  assert.equal(RelayLogic.isCompletionText('整门课程已完成'), true);
  assert.equal(RelayLogic.isCompletionText('已学完'), true);
});

test('整课完成需要自然结束、课程级标志和等待连播同时成立', () => {
  assert.equal(RelayLogic.canRelay({ naturalEnd: true, courseComplete: true, waited: true }), true);
  for (const missing of ['naturalEnd', 'courseComplete', 'waited']) {
    assert.equal(RelayLogic.canRelay({ naturalEnd: true, courseComplete: true, waited: true, [missing]: false }), false);
  }
});

test('B 的播放必须有原生媒体信号和同一媒体实际进度推进', () => {
  const before = V({ id: 'b', paused: false, currentTime: 4, source: 'B', playingSeen: true });
  assert.equal(RelayLogic.playbackAdvanced(before, { ...before, currentTime: 5 }), true);
  assert.equal(RelayLogic.playbackAdvanced(before, { ...before }), false);
  assert.equal(RelayLogic.playbackAdvanced(before, { ...before, currentTime: 5, paused: true }), false);
  assert.equal(RelayLogic.playbackAdvanced(before, { ...before, currentTime: 5, source: 'A' }), false);
  assert.equal(RelayLogic.playbackAdvanced(before, { ...before, currentTime: 5, playingSeen: false }), false);
  assert.equal(RelayLogic.playbackAdvanced(before, { ...before, currentTime: 5, playingSeen: false, timeupdateSeen: true }), true);
  assert.equal(RelayLogic.playbackAdvanced(before, { ...before, playingSeen: false, timeupdateSeen: true }), false);
  assert.equal(RelayLogic.playbackAdvanced(null, before), false);
});

async function sessionFixture() {
  const { createSessionHandler } = require('../extension/relay-v1/session.js');
  const area = () => {
    const data = {};
    return {
      get: async (key) => ({ [key]: structuredClone(data[key]) }),
      set: async (values) => Object.assign(data, structuredClone(values)),
    };
  };
  const storage = { local: area(), session: area() };
  return { storage, handle: createSessionHandler(storage) };
}

const sender = (id) => ({ tab: { id }, frameId: 0, url: 'https://u.exexm.com/course' });

test('硬导航后同页签恢复状态，其他页签不会接管自动点击', async () => {
  const { handle, storage } = await sessionFixture();
  const armed = await handle({ type: 'arm', sourceUrl: 'https://u.exexm.com/course' }, sender(7));
  assert.equal(armed.run.phase, 'watch');
  assert.equal((await handle({ type: 'load' }, sender(8))).run, null);
  await assert.rejects(handle({ type: 'arm', sourceUrl: 'x' }, sender(8)), /another-tab/);
  const { createSessionHandler } = require('../extension/relay-v1/session.js');
  const restarted = createSessionHandler(storage);
  assert.equal((await restarted({ type: 'load' }, sender(7))).run.id, armed.run.id);
});

test('过期页面不能覆盖新状态，停止后旧页面不能恢复点击', async () => {
  const { handle } = await sessionFixture();
  const { run } = await handle({ type: 'arm', sourceUrl: 'https://u.exexm.com/course' }, sender(7));
  const saved = await handle({ type: 'save', run: { ...run, phase: 'goto-list' } }, sender(7));
  assert.equal(saved.run.revision, 1);
  await assert.rejects(handle({ type: 'save', run }, sender(7)), /stale-run/);
  await handle({ type: 'stop' }, sender(7));
  await assert.rejects(handle({ type: 'save', run: saved.run }, sender(7)), /stale-run/);
});

test('B 播放页采集只允许发起采集的页签完成', async () => {
  const { handle } = await sessionFixture();
  await handle({ type: 'configure', patch: { capturePlayback: true } }, sender(7));
  assert.equal((await handle({ type: 'load' }, sender(7))).config.capturePlayback, true);
  assert.equal((await handle({ type: 'load' }, sender(8))).config.capturePlayback, false);
  await assert.rejects(handle({ type: 'configure', patch: { targetPlaybackUrl: 'wrong', capturePlayback: false } }, sender(8)), /capture-not-owned/);
  await handle({ type: 'configure', patch: { targetPlaybackUrl: 'correct', capturePlayback: false } }, sender(7));
  assert.equal((await handle({ type: 'load' }, sender(7))).config.targetPlaybackUrl, 'correct');
});

test('扩展配置持久保存但不写入网站存储，非目标来源拒绝', async () => {
  const { handle } = await sessionFixture();
  await handle({ type: 'configure', patch: { coursePickRule: 'id:b' } }, sender(7));
  assert.equal((await handle({ type: 'load' }, sender(8))).config.coursePickRule, 'id:b');
  await assert.rejects(handle({ type: 'load' }, { ...sender(7), url: 'https://untrusted.invalid/' }), /sender/);
});
