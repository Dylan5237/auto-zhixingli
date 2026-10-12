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

test('isNaturalEnd：全部贴近时长可判定，未到确认时长不判定', () => {
  const list = [V({ currentTime: 99.6, duration: 100 }), V({ currentTime: 59.2, duration: 60 })];
  assert.equal(RelayLogic.isNaturalEnd(list, 3, DEFAULT_CONFIG), true);
  const far = [V({ currentTime: 10, duration: 100 })];
  assert.equal(RelayLogic.isNaturalEnd(far, 3, DEFAULT_CONFIG), false);
  assert.equal(RelayLogic.isNaturalEnd(far, DEFAULT_CONFIG.endConfirmSeconds + 1, DEFAULT_CONFIG), true);
});

test('isNaturalEnd：任一媒体在播即不判定；空列表不判定', () => {
  const list = [V({ paused: false, currentTime: 10 }), V({ ended: true, currentTime: 100 })];
  assert.equal(RelayLogic.isNaturalEnd(list, 60, DEFAULT_CONFIG), false);
  assert.equal(RelayLogic.isNaturalEnd([], 60, DEFAULT_CONFIG), false);
});

test('isNaturalEnd：duration 未知(NaN)时靠停滞时长判定', () => {
  const list = [V({ currentTime: 42, duration: NaN })];
  assert.equal(RelayLogic.isNaturalEnd(list, DEFAULT_CONFIG.endConfirmSeconds - 1, DEFAULT_CONFIG), false);
  assert.equal(RelayLogic.isNaturalEnd(list, DEFAULT_CONFIG.endConfirmSeconds, DEFAULT_CONFIG), true);
});

test('pickCourseIndex：first / index / contains 规则', () => {
  const entries = [{ text: '安全生产' }, { text: '消防安全' }, { text: '急救常识' }];
  assert.equal(RelayLogic.pickCourseIndex(entries, 'first'), 0);
  assert.equal(RelayLogic.pickCourseIndex(entries, 'index:2'), 2);
  assert.equal(RelayLogic.pickCourseIndex(entries, 'contains:消防'), 1);
  assert.equal(RelayLogic.pickCourseIndex(entries, 'index:9'), -1);
  assert.equal(RelayLogic.pickCourseIndex(entries, 'contains:不存在'), -1);
  assert.equal(RelayLogic.pickCourseIndex([], 'first'), -1);
});
