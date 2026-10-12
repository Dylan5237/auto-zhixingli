/*
 * auto-zhixingli 跨课程接力 v1（Issue #11，本地自用）
 * 授权边界见 #11 冻结：单页签、只点网站原生 UI 元素、默认学习模式不自动点击、
 * 不录音、不联网外传、不读写平台存储、不发平台 API、不伪造 ended/手势。
 * 遇到考试/验证码/在场确认/登录失效即停止并提示人工。
 */
'use strict';

const RELAY_VERSION = '0.1.0';

const DEFAULT_CONFIG = {
  autoClick: false,              // true 才允许真实元素点击；false = 学习模式只观察
  courseListUrl: '',             // 课程列表页地址，人工观察后填写，如 'https://u.exexm.com/...'
  nextChapterSelector: '',       // 课内“下一节/继续学习”控件的 CSS 选择器
  courseEntrySelector: '',       // 列表页课程条目的 CSS 选择器
  coursePickRule: 'first',       // first | index:N | contains:文本
  tickMs: 2000,
  endConfirmSeconds: 8,          // 全部媒体静止后确认自然结束的时长
  stallSeconds: 25,              // 活动媒体进度停滞判定时长
  playStartTimeoutSeconds: 20,   // 结束后等待平台自动连播的时长
  navCooldownSeconds: 20,        // 两次页面导航之间的最小间隔
  maxClicks: 20,                 // 单次加载累计点击上限，防跑飞
  haltKeywords: ['开始考试', '进入考试', '考试倒计时', '交卷', '验证码', '人脸', '拍照', '身份核验', '重新登录', '登录已过期'],
  candidateTextPattern: /下一|继续|next|学习|课程|章|节/i,
};

/* ---------- 纯逻辑（node 测试覆盖） ---------- */

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
    if (!descriptors.length) return false;
    const anyEnded = descriptors.some((d) => d.ended);
    const allPaused = descriptors.every((d) => d.paused || d.ended);
    if (!allPaused) return false;
    if (anyEnded) return allStillSeconds >= Math.min(cfg.endConfirmSeconds, 2);
    const allNearDuration = descriptors.every(
      (d) => Number.isFinite(d.duration) && d.duration > 0 && d.currentTime >= d.duration - 1
    );
    if (allNearDuration) return allStillSeconds >= Math.min(cfg.endConfirmSeconds, 2);
    return allStillSeconds >= cfg.endConfirmSeconds;
  },

  pickCourseIndex(entries, rule) {
    if (!entries.length) return -1;
    if (rule.startsWith('index:')) {
      const i = Number.parseInt(rule.slice(6), 10);
      return Number.isInteger(i) && i >= 0 && i < entries.length ? i : -1;
    }
    if (rule.startsWith('contains:')) {
      const needle = rule.slice(9);
      return entries.findIndex((e) => e.text.includes(needle));
    }
    return 0; // first
  },
};

/* ---------- DOM 侧控制器 ---------- */

function startRelay(userConfig) {
  const cfg = { ...DEFAULT_CONFIG, ...(userConfig || {}) };
  const TAG = `[RELAY v1]`;
  const doc = window.document;
  const state = {
    phase: 'watch',               // watch|ended|wait-auto|click-next|goto-list|pick-course|wait-play|halt
    lastActiveId: null,
    lastAdvanceAt: 0,
    allStillSince: 0,
    endedAt: 0,
    lastNavAt: 0,
    clicks: 0,
    reported: new Set(),
    warned: new Set(),
    endedFlags: new WeakSet(),
  };
  let stopped = false;
  let banner = null;
  let bannerText = '';
  const timers = [];

  const now = () => performance.now();
  const log = (...a) => console.log(TAG, ...a);
  const boundEnded = new Set();

  function setBanner(text, halted) {
    if (!banner) {
      banner = doc.createElement('div');
      banner.style.cssText =
        'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 12px;' +
        'font:13px/1.5 sans-serif;color:#fff;background:rgba(30,30,30,.88);border-radius:8px;' +
        'box-shadow:0 2px 10px rgba(0,0,0,.35);max-width:46vw;white-space:pre-wrap;';
      const label = doc.createElement('span');
      banner.appendChild(label);
      const stopBtn = doc.createElement('button');
      stopBtn.textContent = '停止接力';
      stopBtn.style.cssText = 'margin-left:8px;padding:2px 8px;border:0;border-radius:4px;cursor:pointer;';
      stopBtn.addEventListener('click', () => stop('人工点击停止'));
      banner.appendChild(stopBtn);
      (doc.body || doc.documentElement).appendChild(banner);
    }
    bannerText = text;
    banner.firstChild.textContent = text + '　';
    banner.style.background = halted ? 'rgba(150,30,30,.92)' : 'rgba(30,30,30,.88)';
  }

  function halt(reason) {
    if (state.phase === 'halt') return;
    state.phase = 'halt';
    log('HALT:', reason);
    setBanner(`接力已停止：${reason}\n关闭此提示可停用本页接力。`, true);
  }

  function stop(reason) {
    if (stopped) return;
    stopped = true;
    timers.forEach(clearInterval);
    if (banner) banner.remove();
    log('STOPPED:', reason || 'by page/script');
    delete window.__RELAY_V1__;
  }

  function scanMedia() {
    const out = [];
    const seen = new Set();
    const walk = (root, depth) => {
      if (!root || depth > 3) return;
      root.querySelectorAll('video,audio').forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        out.push({
          el,
          id: el.tagName.toLowerCase() + '-' + out.length,
          paused: el.paused,
          ended: el.ended || state.endedFlags.has(el),
          currentTime: el.currentTime,
          duration: el.duration,
          readyState: el.readyState,
          playbackRate: el.playbackRate,
          muted: el.muted,
        });
      });
      root.querySelectorAll('*').forEach((node) => {
        if (node.shadowRoot) walk(node.shadowRoot, depth + 1);
      });
    };
    walk(doc, 0);
    out.forEach((d) => {
      if (!boundEnded.has(d.el)) {
        try {
          d.el.addEventListener('ended', () => state.endedFlags.add(d.el));
          boundEnded.add(d.el);
        } catch {}
      }
    });
    return out;
  }

  function describeClickable(el) {
    const text = (el.innerText || el.textContent || '').trim().slice(0, 40);
    const idPart = el.id ? '#' + el.id : '';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return { tag: el.tagName.toLowerCase(), text, selector: el.tagName.toLowerCase() + idPart + cls };
  }

  function reportCandidates(kind) {
    if (state.reported.has(kind)) return;
    state.reported.add(kind);
    const cands = [...doc.querySelectorAll('a,button,[role="button"],li,div,span')]
      .filter((el) => {
        const t = (el.innerText || '').trim();
        return t.length >= 2 && t.length <= 30 && cfg.candidateTextPattern.test(t);
      })
      .slice(0, 12)
      .map(describeClickable);
    log(`学习模式候选(${kind})：`, JSON.stringify(cands, null, 1));
    return cands;
  }

  function clickEl(el, why) {
    if (!cfg.autoClick) {
      log(`学习模式：观察到可点击目标(${why})，未点击：`, describeClickable(el));
      halt(`学习模式：请人工点击“${why}”，或编辑配置打开 autoClick`);
      return false;
    }
    if (state.clicks >= cfg.maxClicks) { halt('点击次数达到上限'); return false; }
    state.clicks += 1;
    el.scrollIntoView({ block: 'center' });
    el.click();
    log(`已点击(${why})：`, describeClickable(el));
    return true;
  }

  function navTo(url, why) {
    if (now() - state.lastNavAt < cfg.navCooldownSeconds * 1000) return false;
    state.lastNavAt = now();
    log(`导航(${why}) → ${url}`);
    window.location.href = url;
    return true;
  }

  function onCoursePage() {
    return !cfg.courseListUrl || !location.href.startsWith(cfg.courseListUrl.split('#')[0]);
  }

  function haltIfSensitive() {
    const bodyText = (doc.body && doc.body.innerText) || '';
    const hit = cfg.haltKeywords.find((k) => bodyText.includes(k));
    if (!hit) return false;
    if (cfg.autoClick) { halt(`页面出现敏感环节关键词：“${hit}”，转人工`); return true; }
    if (!state.warned.has(hit)) {
      state.warned.add(hit);
      log(`学习模式提示：页面含“${hit}”，不停止（autoClick=false 不上手）`);
    }
    return false;
  }

  function tick() {
    if (stopped || state.phase === 'halt') return;
    if (haltIfSensitive()) return;

    const media = scanMedia();
    const desc = media.map(({ el, ...rest }) => rest);
    const activeId = RelayLogic.pickActive(desc);
    const active = media.find((m) => m.id === activeId) || null;

    if (active) {
      if (activeId !== state.lastActiveId) log('活动媒体：', activeId, 'currentTime=', active.currentTime.toFixed(1));
      state.lastActiveId = activeId;
      state.allStillSince = 0;
      if (state.phase !== 'watch') {
        log('检测到播放恢复 → 继续观察');
        state.phase = 'watch';
        state.reported.delete('ended');
      }
      setBanner(`接力观察中：活动媒体 ${activeId}`);
      return;
    }

    if (!state.allStillSince) state.allStillSince = now();
    const stillFor = (now() - state.allStillSince) / 1000;
    const naturalEnd = RelayLogic.isNaturalEnd(desc, stillFor, cfg);

    if (state.phase === 'wait-auto') {
      if (now() - state.endedAt > cfg.playStartTimeoutSeconds * 1000) {
        state.phase = 'ended';
      } else {
        setBanner('等待平台自动连播…');
        return;
      }
    }

    if (state.phase === 'wait-play') {
      if (now() - state.endedAt > cfg.playStartTimeoutSeconds * 1000) {
        halt('新页面媒体未开始播放：可能需人工点击播放（自动播放策略）');
      } else {
        setBanner('等待新页面开始播放…');
      }
      return;
    }

    if (!naturalEnd) {
      setBanner('接力观察中：未检测到活动媒体');
      return;
    }

    if (state.phase === 'watch') {
      state.phase = 'ended';
      state.endedAt = now();
      log('检测到媒体自然结束，等待平台自动连播', JSON.stringify(desc.map((d) => ({ id: d.id, ct: d.currentTime, dur: d.duration, paused: d.paused, ended: d.ended }))));
      reportCandidates('ended');
      setBanner('媒体已结束：等待平台自动连播');
      state.phase = 'wait-auto';
      return;
    }

    if (state.phase === 'ended') {
      const nextBtn = cfg.nextChapterSelector ? doc.querySelector(cfg.nextChapterSelector) : null;
      if (nextBtn) {
        state.phase = 'click-next';
        if (clickEl(nextBtn, '课内下一节')) {
          state.endedAt = now();
          state.phase = 'wait-play';
        }
        return;
      }
      reportCandidates('no-next');
      if (cfg.courseListUrl) {
        state.phase = 'goto-list';
        navTo(cfg.courseListUrl, '课程结束去列表');
        setBanner('课程结束：前往课程列表');
      } else {
        halt('课程结束：未配置 courseListUrl，转人工');
      }
      return;
    }

    if (state.phase === 'goto-list') {
      onListPage();
    }
  }

  function onListPage() {
    if (!location.href.startsWith(cfg.courseListUrl.split('#')[0])) return;
    if (state.phase === 'goto-list') state.phase = 'pick-course';
    const entries = cfg.courseEntrySelector
      ? [...doc.querySelectorAll(cfg.courseEntrySelector)].map((el, i) => ({ el, i, text: (el.innerText || '').trim().slice(0, 60) }))
      : [];
    if (!entries.length) {
      reportCandidates('list');
      halt('列表页：未配置 courseEntrySelector 或无匹配条目，转人工');
      return;
    }
    const idx = RelayLogic.pickCourseIndex(entries, cfg.coursePickRule);
    if (idx < 0) { halt('coursePickRule 未匹配任何条目，转人工'); return; }
    if (clickEl(entries[idx].el, `选择课程[${idx}]`)) {
      state.endedAt = now();
      state.phase = 'wait-play';
      setBanner('已选择课程：等待播放');
    }
  }

  const boot = () => {
    if (window.__RELAY_V1__) { window.__RELAY_V1__.stop('重复加载，重启'); }
    window.__RELAY_V1__ = {
      version: RELAY_VERSION,
      config: cfg,
      logic: RelayLogic,
      status: () => ({ phase: state.phase, clicks: state.clicks, banner: bannerText }),
      stop,
    };
    state.lastNavAt = 0;
    if (cfg.courseListUrl && location.href.startsWith(cfg.courseListUrl.split('#')[0])) {
      state.phase = 'pick-course';
      onListPage();
    }
    log(`已启动 relay v${RELAY_VERSION}，autoClick=${cfg.autoClick}，phase=${state.phase}`);
    setBanner(`接力 v1 已启动（autoClick=${cfg.autoClick}）`);
    timers.push(setInterval(tick, cfg.tickMs));
    timers.push(setInterval(() => {
      if (cfg.courseListUrl && location.href.startsWith(cfg.courseListUrl.split('#')[0]) && state.phase === 'watch') {
        state.phase = 'pick-course';
        onListPage();
      }
    }, cfg.tickMs * 3));
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  return { stop };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RelayLogic, DEFAULT_CONFIG, RELAY_VERSION };
} else {
  startRelay(window.__RELAY_V1_CONFIG__);
}
