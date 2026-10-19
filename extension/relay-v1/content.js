'use strict';

const RELAY_VERSION = '0.2.0';
const DEFAULT_CONFIG = {
  autoClick: false,
  courseEntrySelector: 'ion-card.course-list ion-item.exe-learn-course-pic',
  coursePickRule: '',
  courseIdAttribute: '',
  courseTitleSelector: '',
  courseStartSelector: '',
  courseStartText: '',
  targetDetailsUrl: '',
  targetPlaybackUrl: '',
  courseCompleteSelector: '',
  courseCompleteText: '',
  completionUrl: '',
  learnNavText: '学习',
  tickMs: 1000,
  endConfirmSeconds: 2,
  playStartTimeoutSeconds: 30,
  navigationTimeoutSeconds: 30,
  completionTimeoutSeconds: 120,
  maxClicks: 3,
  haltKeywords: ['开始考试', '进入考试', '考试倒计时', '交卷', '验证码', '人脸', '拍照', '身份核验', '重新登录', '登录已过期'],
};

const RelayLogic = {
  pickActive(descriptors) {
    let best = null;
    for (const d of descriptors) {
      if (d.paused || d.ended || d.readyState < 2 || !Number.isFinite(d.currentTime)) continue;
      if (!best || d.currentTime > best.currentTime) best = d;
    }
    return best ? best.id : null;
  },

  isNaturalEnd(descriptors, allStillSeconds, cfg) {
    return descriptors.some((d) => d.ended) &&
      descriptors.every((d) => d.paused || d.ended) &&
      allStillSeconds >= Math.min(cfg.endConfirmSeconds, 2);
  },

  pickCourseIndex(entries, rule = '') {
    const prefix = rule.startsWith('id:') ? 'id:' : rule.startsWith('text:') ? 'text:' : '';
    if (!prefix || !rule.slice(prefix.length).trim()) return -1;
    const key = prefix === 'id:' ? 'id' : 'text';
    const matches = entries.map((entry, i) => entry[key] === rule.slice(prefix.length) ? i : -1)
      .filter((i) => i >= 0);
    return matches.length === 1 ? matches[0] : -1;
  },

  isCompletionText(text) {
    return /已完成|学习完成|完成学习|已学完|全部学完|全部完成/.test(text) &&
      !/未|章节|本节|时长|学时/.test(text);
  },

  canRelay({ naturalEnd, courseComplete, waited }) {
    return naturalEnd === true && courseComplete === true && waited === true;
  },

  playbackAdvanced(before, after) {
    return Boolean(before && after && before.id === after.id && before.source === after.source &&
      (after.playingSeen || after.timeupdateSeen) && !after.paused && !after.ended && after.readyState >= 2 &&
      after.currentTime - before.currentTime >= 0.5);
  },
};

async function startRelay(userConfig) {
  const doc = window.document;
  const norm = (text) => (text || '').replace(/\s+/g, ' ').trim();
  const rpc = async (message) => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result || result.error) throw new Error(result?.error || 'extension-disconnected');
    return result;
  };
  const loaded = await rpc({ type: 'load' });
  let cfg = { ...DEFAULT_CONFIG, ...loaded.config, ...userConfig };
  let run = loaded.run;
  let capture = '';
  let busy = false;
  let destroyed = false;
  let cancelled = false;
  let operations = Promise.resolve();
  const enqueue = (action) => {
    const next = operations.then(() => destroyed ? undefined : action());
    operations = next.catch(fail);
    return next;
  };
  let lastSample = null;
  let lastHref = location.href;
  let mediaSequence = 0;
  let bannerText = '';
  const bindings = new Map();
  const host = doc.createElement('div');
  host.id = 'auto-zhixingli-relay';
  host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:360px';
  const panel = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = ':host{font:13px/1.5 system-ui;color:#fff}section{background:#202936;padding:12px;border:1px solid #526175;border-radius:8px}p{margin:0 0 8px;white-space:pre-wrap}button{font:inherit;margin:3px;padding:4px 8px;cursor:pointer}details{margin-top:8px}textarea{width:100%;height:170px;box-sizing:border-box}';
  panel.append(style);
  const section = doc.createElement('section');
  panel.append(section);
  const label = doc.createElement('p');
  label.setAttribute('role', 'status');
  label.setAttribute('aria-live', 'polite');
  section.append(label);
  const actions = doc.createElement('div');
  section.append(actions);
  const settings = doc.createElement('details');
  const summary = doc.createElement('summary');
  summary.textContent = '首次配置 / 一次正常操作采集';
  settings.append(summary);
  section.append(settings);
  const evidence = doc.createElement('textarea');
  evidence.readOnly = true;
  evidence.hidden = true;
  evidence.setAttribute('aria-label', '接力诊断报告');
  section.append(evidence);
  (doc.body || doc.documentElement).append(host);

  function show(text) {
    bannerText = text;
    label.textContent = `接力 ${RELAY_VERSION}\n${text}`;
  }

  function button(parent, text, action) {
    const el = doc.createElement('button');
    el.type = 'button';
    el.textContent = text;
    el.addEventListener('click', () => {
      if (action === stop) cancelPendingClicks();
      void enqueue(action).catch(fail);
    });
    parent.append(el);
  }

  function visible(el) {
    if (!el || !el.isConnected || host.contains(el)) return false;
    if (el.closest('[hidden],[inert],[aria-hidden="true"],.ion-page-hidden')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  }

  function matches(selector, root = doc) {
    return selector ? [...root.querySelectorAll(selector)].filter(visible) : [];
  }

  function unique(selector, text, root = doc) {
    const hits = matches(selector, root).filter((el) => !text || norm(el.innerText || el.textContent) === text);
    return hits.length === 1 ? hits[0] : null;
  }

  function selectorFor(el, root = doc) {
    let node = el;
    const parts = [];
    while (node && node !== root && node.nodeType === 1) {
      let part = node.localName;
      if (node.id) part += '#' + CSS.escape(node.id);
      else {
        const classes = [...node.classList].filter((c) => !/^(ng-|ion-activated|ion-focused)/.test(c));
        part += classes.map((c) => '.' + CSS.escape(c)).join('');
      }
      parts.unshift(part);
      if (root.querySelectorAll(parts.join(' > ')).length === 1) return parts.join(' > ');
      const siblings = node.parentElement ? [...node.parentElement.children].filter((s) => s.localName === node.localName) : [];
      if (siblings.length > 1) parts[0] += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      node = node.parentElement;
    }
    const selector = parts.join(' > ');
    if (!selector || root.querySelectorAll(selector).length !== 1) throw new Error('selector-not-unique');
    return selector;
  }

  function event(code, detail = {}) {
    if (!run) return;
    run.events.push({ at: new Date().toISOString(), code, ...detail });
    run.events = run.events.slice(-80);
  }

  async function persist() {
    if (run) run = (await rpc({ type: 'save', run })).run;
  }

  async function phase(value, code, detail) {
    run.phase = value;
    run.phaseAt = Date.now();
    event(code, detail);
    await persist();
  }

  async function halt(code, text) {
    if (run && run.phase !== 'halt') await phase('halt', code);
    show(`停止：${text}`);
  }

  function fail(error) {
    cancelled = true;
    if (run) { run.phase = 'halt'; event('EXTENSION_STATE_ERROR'); }
    void rpc({ type: 'stop' }).catch(() => {});
    show(`停止：扩展状态不可用（${error.message}）。请重新加载扩展并刷新本页。`);
  }

  async function configure(patch) {
    const result = await rpc({ type: 'configure', patch });
    cfg = { ...DEFAULT_CONFIG, ...result.config, ...userConfig };
  }

  function sensitive() {
    const text = doc.body?.innerText || '';
    return cfg.haltKeywords.some((word) => text.includes(word));
  }

  function scanMedia() {
    const elements = [];
    const walk = (root) => {
      elements.push(...root.querySelectorAll('video,audio'));
      root.querySelectorAll('*').forEach((el) => {
        if (el !== host && el.shadowRoot) walk(el.shadowRoot);
      });
    };
    walk(doc);
    for (const [el, binding] of bindings) {
      if (!el.isConnected) {
        for (const [name, listener] of Object.entries(binding.listeners)) el.removeEventListener(name, listener);
        bindings.delete(el);
      }
    }
    return elements.filter((el) => !el.closest('[hidden],[inert],[aria-hidden="true"],.ion-page-hidden')).map((el) => {
      if (!bindings.has(el)) {
        const binding = { id: ++mediaSequence, playingSeen: false, timeupdateSeen: false, progressed: false, source: el.currentSrc, listeners: {} };
        binding.listeners.playing = (e) => {
          if (e.isTrusted) { binding.source = el.currentSrc; binding.playingSeen = true; }
        };
        binding.listeners.timeupdate = (e) => {
          if (e.isTrusted && !el.paused && !el.ended) binding.timeupdateSeen = true;
        };
        binding.listeners.emptied = () => {
          binding.playingSeen = false; binding.timeupdateSeen = false; binding.progressed = false;
        };
        binding.listeners.ended = (e) => {
          if (!e.isTrusted || !binding.progressed || !run || !['watch', 'wait-auto', 'wait-complete'].includes(run.phase)) return;
          const endedAt = Date.now();
          const sourceUrl = location.href;
          void enqueue(async () => {
            if (!run || !['watch', 'wait-auto', 'wait-complete'].includes(run.phase)) return;
            run.naturalEnd = true;
            run.endedAt = endedAt;
            run.sourceUrl = sourceUrl;
            event('MEDIA_ENDED');
            await persist();
          }).catch(fail);
        };
        for (const [name, listener] of Object.entries(binding.listeners)) el.addEventListener(name, listener);
        bindings.set(el, binding);
      }
      const binding = bindings.get(el);
      if (binding.source !== el.currentSrc) {
        binding.source = el.currentSrc;
        binding.playingSeen = false;
        binding.timeupdateSeen = false;
        binding.progressed = false;
      }
      return { el, id: binding.id, source: el.currentSrc, paused: el.paused, ended: el.ended,
        currentTime: el.currentTime, duration: el.duration, readyState: el.readyState,
        playingSeen: binding.playingSeen, timeupdateSeen: binding.timeupdateSeen };
    });
  }

  function courseEntries() {
    return matches(cfg.courseEntrySelector).map((el) => ({
      el,
      id: cfg.courseIdAttribute ? el.getAttribute(cfg.courseIdAttribute) : '',
      text: norm((cfg.courseTitleSelector ? el.querySelector(cfg.courseTitleSelector) : el)?.textContent),
    }));
  }

  function learnNav() {
    const hits = matches('button,a,[role="button"],ion-tab-button').filter((el) => norm(el.innerText) === cfg.learnNavText);
    const outer = hits.filter((el) => !hits.some((other) => other !== el && other.contains(el)));
    return outer.length === 1 ? outer[0] : null;
  }

  async function click(el, nextPhase, code) {
    if (!cfg.autoClick) { show('学习模式：未点击。请在 A 页点击“启用 A → B”。'); return; }
    if (!visible(el) || el.matches(':disabled,[disabled],[aria-disabled="true"]')) {
      await halt('CONTROL_UNAVAILABLE', '原生入口不可用，请人工检查。'); return;
    }
    if (run.clicks >= cfg.maxClicks) { await halt('CLICK_LIMIT', '点击已达到本次接力上限。'); return; }
    if (sensitive()) { await halt('HUMAN_CHECK', '页面有考试、验证或登录环节，转人工。'); return; }
    run.clicks++;
    await phase(nextPhase, code);
    // Navigation can destroy this document, so checkpoint before the native click.
    if (destroyed || cancelled || !run || run.phase !== nextPhase || !visible(el) || sensitive()) return;
    el.click();
  }

  async function tick() {
    if (destroyed || busy) return;
    busy = true;
    try {
      if (location.href !== lastHref) {
        lastHref = location.href;
        lastSample = null;
      }
      const media = scanMedia();
      const active = media.find((m) => m.id === RelayLogic.pickActive(media));
      const advanced = RelayLogic.playbackAdvanced(lastSample, active);
      const advanceSeconds = advanced ? active.currentTime - lastSample.currentTime : 0;
      if (advanced) bindings.get(active.el).progressed = true;
      lastSample = active || null;
      if (cfg.capturePlayback && advanced) {
        await configure({ targetPlaybackUrl: location.href, capturePlayback: false });
        show('已记住 B 的真实播放页。回到 A，点击“启用 A → B”。');
      }
      if (!run || cancelled || ['halt', 'verified'].includes(run.phase)) return;
      if (sensitive()) { await halt('HUMAN_CHECK', '页面有考试、验证或登录环节，转人工。'); return; }
      const elapsed = (Date.now() - run.phaseAt) / 1000;
      if (['watch', 'wait-auto', 'wait-complete'].includes(run.phase)) {
        if (advanced) {
          if (!run.sourceProgress || run.phase !== 'watch') {
            run.sourceProgress = true;
            run.naturalEnd = false;
            await phase('watch', 'SOURCE_PLAYING');
          }
          show('A 正在播放；课内连播由平台原样处理。');
          return;
        }
        if (active) { show('媒体未暂停，等待实际进度推进；不据此判定完成。'); return; }
        if (!run.naturalEnd) {
          show('观察 A：暂停或停滞不会换课，等待自然 ended。');
          return;
        }
        if (run.phase === 'watch') await phase('wait-auto', 'WAIT_NATIVE_AUTOPLAY');
        const waited = Date.now() - run.endedAt >= cfg.playStartTimeoutSeconds * 1000;
        if (!waited) { show('章节结束：等待平台自动连播，不提前换课。'); return; }
        const complete = location.href === cfg.completionUrl && RelayLogic.isCompletionText(cfg.courseCompleteText) &&
          Boolean(unique(cfg.courseCompleteSelector, cfg.courseCompleteText));
        if (RelayLogic.canRelay({ naturalEnd: run.naturalEnd, courseComplete: complete, waited })) {
          event('COURSE_COMPLETE_CONFIRMED');
          const nav = learnNav();
          if (!nav) { await halt('LIST_NAV_UNKNOWN', '找不到唯一可见的“学习”导航。'); return; }
          await click(nav, 'goto-list', 'LIST_CLICKED');
          show('整课完成已确认，正在进入课程列表。');
          return;
        }
        if (run.phase !== 'wait-complete') await phase('wait-complete', 'COURSE_COMPLETE_UNKNOWN');
        show('无法确认整课完成：请在配置中点选 A 的“整门课程已完成”标志；章节完成不算。');
        if ((Date.now() - run.phaseAt) / 1000 > cfg.completionTimeoutSeconds) {
          await halt('COURSE_COMPLETE_TIMEOUT', '未取得 A 的课程级完成标志；没有换课。');
        }
        return;
      }
      if (run.phase === 'goto-list') {
        const entries = courseEntries();
        if (!entries.length) {
          if (elapsed > cfg.navigationTimeoutSeconds) await halt('LIST_TIMEOUT', '未到达可识别的课程列表。');
          return;
        }
        const index = RelayLogic.pickCourseIndex(entries, cfg.coursePickRule);
        if (index < 0) { await halt('TARGET_NOT_UNIQUE', '列表中找不到唯一的目标 B；不会按顺序猜选。'); return; }
        await click(entries[index].el, 'wait-detail', 'TARGET_CLICKED');
        show('已选中指定 B，等待详情页。');
        return;
      }
      if (run.phase === 'wait-detail') {
        if (location.href === cfg.targetDetailsUrl) {
          const start = unique(cfg.courseStartSelector, cfg.courseStartText);
          if (start) {
            bindings.forEach((binding) => { binding.playingSeen = false; binding.timeupdateSeen = false; });
            lastSample = null;
            await click(start, 'wait-play', 'START_CLICKED');
            show('已点击 B 的正常开始学习入口，等待 playing 和进度推进。');
            return;
          }
        }
        if (elapsed > cfg.navigationTimeoutSeconds) await halt('DETAIL_START_TIMEOUT', '详情页或已采集的开始入口不匹配；请重新点选真实入口。');
        return;
      }
      if (run.phase === 'wait-play') {
        if (location.href === cfg.targetPlaybackUrl && advanced) {
          await phase('verified', 'TARGET_PLAYING_CONFIRMED', { advancedSeconds: Number(advanceSeconds.toFixed(2)),
            playingEventSeen: active.playingSeen, timeupdateEventSeen: active.timeupdateSeen });
          show('本次接力完成：B 已有原生媒体事件且播放时间实际推进。不会再选下一门。');
          return;
        }
        if (elapsed > cfg.playStartTimeoutSeconds) {
          await halt(location.href !== cfg.targetPlaybackUrl ? 'TARGET_IDENTITY_UNKNOWN' : 'PLAYBACK_NOT_CONFIRMED',
            'B 未确认实际播放（页面身份不匹配、缓冲或自动播放受限）。请人工点击一次正常播放；本轮不记自动成功。');
        }
      }
    } catch (error) { fail(error); }
    finally { busy = false; }
  }

  async function selectCapture(kind) {
    if (run && !['halt', 'verified', 'wait-complete', 'watch', 'wait-auto'].includes(run.phase)) {
      show('接力导航中，请先停止再修改配置。'); return;
    }
    if (run && !['halt', 'verified'].includes(run.phase) && kind !== 'complete') {
      show('请先停止接力再修改目标 B。'); return;
    }
    capture = kind;
    const hints = {
      target: '请在列表中直接点击 B 的课程标题（不要点图片）。本次点击仍由网站正常处理。',
      start: '请直接点击 B 详情页正常的“开始学习 / 继续学习”入口。',
      complete: '请点击 A 的整门课程完成状态文字（不是章节完成）。仅采集，不修改平台状态。',
    };
    show(hints[kind]);
  }

  function onCapture(e) {
    if (!capture || !e.isTrusted || e.composedPath().includes(host)) return;
    const kind = capture;
    capture = '';
    const el = e.target.closest ? e.target : e.target.parentElement;
    try {
      let patch;
      if (kind === 'target') {
        const entry = el.closest(cfg.courseEntrySelector);
        if (!entry || !visible(entry)) throw new Error('请点列表中 B 的课程标题');
        const idAttr = [...entry.attributes].find((a) => /^(data-course-id|data-courseid|data-id)$/.test(a.name) && a.value);
        if (!idAttr && (el === entry || !norm(el.textContent))) throw new Error('请点 B 的标题文字，不要点卡片空白或图片');
        patch = {
          courseIdAttribute: idAttr?.name || '',
          courseTitleSelector: idAttr ? '' : selectorFor(el, entry),
          coursePickRule: idAttr ? 'id:' + idAttr.value : 'text:' + norm(el.textContent),
          targetDetailsUrl: '', targetPlaybackUrl: '', courseStartSelector: '', courseStartText: '', capturePlayback: false,
        };
      } else if (kind === 'start') {
        if (!cfg.coursePickRule) throw new Error('请先在列表中点选目标 B');
        const control = el.closest('button,a,[role="button"],ion-button') || el;
        patch = { courseStartSelector: selectorFor(control), courseStartText: norm(control.innerText || control.textContent),
          targetDetailsUrl: location.href, targetPlaybackUrl: '', capturePlayback: true };
      } else {
        const text = norm(el.innerText || el.textContent);
        if (!text || text.length > 100 || !RelayLogic.isCompletionText(text)) {
          throw new Error('请选择明确“已完成 / 已学完”的整课状态；章节或时长不算');
        }
        patch = { courseCompleteSelector: selectorFor(el), courseCompleteText: text, completionUrl: location.href };
      }
      // Send before the site's click handler can start a full-page navigation.
      void configure(patch).then(() => {
        show(kind === 'start' ? '已记住真实开始入口，等待 B 实际播放以记录页面身份。' : '已保存本机配置。');
      }).catch(fail);
    } catch (error) { show(`未采集：${error.message}`); }
  }

  async function arm() {
    if (busy) { show('正在保存状态，请稍后再点启用。'); return; }
    if (!cfg.coursePickRule || !cfg.courseStartSelector || !cfg.targetDetailsUrl || !cfg.targetPlaybackUrl) {
      show('先完成一次 B 的采集：列表点标题 → 详情点开始学习 → 等 B 实际播放。'); return;
    }
    if (location.href === cfg.targetPlaybackUrl || location.href === cfg.targetDetailsUrl) {
      show('当前是 B，请回到 A 的播放页再启用。'); return;
    }
    if (sensitive()) { show('页面有考试、验证或登录环节，请先人工处理。'); return; }
    cancelled = false;
    await configure({ autoClick: true });
    if (cancelled) return;
    run = (await rpc({ type: 'arm', sourceUrl: location.href })).run;
    lastSample = null;
    event('ARMED');
    await persist();
    show('已启用一次 A → B；等待 A 正常结束和明确课程完成标志。');
  }

  function cancelPendingClicks() {
    cancelled = true;
    capture = '';
    show('已停止后续点击，正在保存停止状态。');
  }

  async function stop() {
    capture = '';
    if (run) {
      event('MANUAL_STOP');
      evidence.value = JSON.stringify(report(false), null, 2);
    }
    await rpc({ type: 'stop' });
    run = null;
    await configure({ autoClick: false, capturePlayback: false });
    show('已停止自动接力；平台播放不受影响。');
  }

  function report(privateDetails) {
    const result = {
      version: RELAY_VERSION,
      phase: run?.phase || 'learning',
      clicks: run?.clicks || 0,
      configured: { target: Boolean(cfg.coursePickRule), start: Boolean(cfg.courseStartSelector),
        playback: Boolean(cfg.targetPlaybackUrl), completion: Boolean(cfg.courseCompleteSelector) },
      events: run?.events || [],
    };
    if (privateDetails) result.localConfig = cfg;
    return result;
  }

  function exportReport(privateDetails) {
    evidence.hidden = false;
    evidence.value = JSON.stringify(report(privateDetails), null, 2);
    evidence.focus();
    evidence.select();
    show(privateDetails ? '本机诊断含真实选择器/页面地址/课程文字：只私下提供，勿贴公开 Issue。' : '脱敏报告已选中，可复制回传；不含课程名、地址或媒体内容。');
  }

  button(actions, '启用 A → B', arm);
  button(actions, '停止接力', stop);
  button(actions, '复制脱敏结果', () => exportReport(false));
  button(settings, '1. 选取目标 B', () => selectCapture('target'));
  button(settings, '2. 记住开始入口', () => selectCapture('start'));
  button(settings, '3. 绑定整课完成标志', () => selectCapture('complete'));
  button(settings, '取消点选', () => { capture = ''; show('已取消点选。'); });
  button(settings, '本机诊断（含页面信息）', () => exportReport(true));
  const onPlaying = (event) => {
    if (!event.isTrusted) return;
    scanMedia();
    const binding = bindings.get(event.target);
    if (binding) { binding.source = event.target.currentSrc; binding.playingSeen = true; }
  };
  doc.addEventListener('playing', onPlaying, true);
  doc.addEventListener('click', onCapture, true);
  const interval = setInterval(() => { if (!busy) void enqueue(tick).catch(fail); }, cfg.tickMs);
  function dispose() {
    destroyed = true;
    clearInterval(interval);
    doc.removeEventListener('playing', onPlaying, true);
    doc.removeEventListener('click', onCapture, true);
    for (const [el, binding] of bindings) {
      for (const [name, listener] of Object.entries(binding.listeners)) el.removeEventListener(name, listener);
    }
    bindings.clear();
    host.remove();
    window.removeEventListener('pagehide', dispose);
    delete window.__RELAY_V1__;
  }
  window.addEventListener('pagehide', dispose);
  window.__RELAY_V1__ = { version: RELAY_VERSION, status: () => ({ ...report(false), banner: bannerText }),
    arm: () => enqueue(arm), stop: () => { cancelPendingClicks(); return enqueue(stop); }, dispose };
  show(run ? `恢复本页签接力：${run.phase}` : '学习模式：展开首次配置，点选真实 B 和开始入口。');
  await enqueue(tick);
  return window.__RELAY_V1__;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RelayLogic, DEFAULT_CONFIG, RELAY_VERSION, startRelay };
} else {
  const boot = () => startRelay().catch((error) => console.error('[RELAY v1] 启动失败：', error.message));
  boot();
  window.addEventListener('pageshow', (event) => { if (event.persisted) boot(); });
}
