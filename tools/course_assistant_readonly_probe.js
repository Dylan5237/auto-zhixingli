/*
 * AI 课程托管助手 · M0 只读播放器诊断探针 v1.1
 * 使用场景：在当前课程的真实播放页面打开 DevTools → Console，粘贴运行。
 * 不发起网络请求、不读写 Cookie/LocalStorage/SessionStorage、不调用任何课程平台接口、
 * 不自动播放/暂停/跳转视频、不更改学习进度。不采集视频或音频本身。
 * 仅观察本页可访问的 video/iframe DOM、媒体事件和路由变化。
 * 不适用于跨域 iframe 内的 DOM；需在 DevTools 的对应 frame 上下文另行运行。
 * 同页签发生硬导航后，此脚本会随旧文档退出；启用 DevTools Preserve log 保留之前的日志。
 */
(() => {
  const TAG = '[COURSE_M0]';
  if (window.__COURSE_M0_PROBE__?.stop) window.__COURSE_M0_PROBE__.stop();

  const rows = [];
  const maxRows = 500;
  const videoSet = new Set();
  const handlers = new Map();
  let currentRoute = '';
  let scanTimer = null;
  let interval = null;
  let stopped = false;
  const cleanups = [];

  const now = () => Math.round(performance.now());
  const safePath = (value) => {
    try {
      const url = new URL(value || location.href, location.href);
      // 有意省略 query/hash，避免意外输出带凭据的参数。
      return `${url.origin}${url.pathname}`;
    } catch {
      return '(invalid-url)';
    }
  };
  const rounded = (value) => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
  function log(type, data = {}) {
    if (stopped) return;
    const row = {atMs: now(), type, ...data};
    rows.push(row);
    if (rows.length > maxRows) rows.shift();
    console.log(TAG, row);
  }
  function details(video) {
    return {
      currentTime: rounded(video.currentTime),
      duration: rounded(video.duration),
      paused: Boolean(video.paused),
      ended: Boolean(video.ended),
      readyState: video.readyState,
      muted: Boolean(video.muted),
      playbackRate: rounded(video.playbackRate),
      hasAudioTracksApi: 'audioTracks' in video,
    };
  }
  function collect(root, selector, results = [], visited = new WeakSet()) {
    if (!root || visited.has(root)) return results;
    visited.add(root);
    try {
      for (const node of root.querySelectorAll(selector)) results.push(node);
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) collect(element.shadowRoot, selector, results, visited);
      }
    } catch (error) {
      log('scan_exception', {name: error?.name || 'Error'});
    }
    return results;
  }
  function inspect() {
    if (stopped) return;
    const route = safePath(location.href);
    if (route !== currentRoute) {
      currentRoute = route;
      log('route', {route});
    }
    const videos = collect(document, 'video');
    for (const video of videos) {
      if (videoSet.has(video)) continue;
      videoSet.add(video);
      const id = `video-${videoSet.size}`;
      const fn = (event) => {
        // 不监听高频 timeupdate，避免产生过量日志。
        log('media_event', {id, event: event.type, ...details(video)});
      };
      const types = ['loadedmetadata', 'play', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'ended', 'error', 'emptied'];
      for (const type of types) video.addEventListener(type, fn, {passive: true});
      handlers.set(video, {types, fn});
      log('video_found', {id, ...details(video)});
    }
    const iframes = collect(document, 'iframe');
    const frameLocations = [...new Set(iframes.map(f => safePath(f.src)))].slice(0, 10);
    const descriptor = `${videos.length}:${iframes.length}:${frameLocations.join('|')}`;
    if (inspect.lastFrames !== descriptor) {
      inspect.lastFrames = descriptor;
      log('dom_summary', {videoCount: videos.length, iframeCount: iframes.length, iframePaths: frameLocations});
    }
  }
  const scheduleScan = () => {
    if (scanTimer !== null || stopped) return;
    scanTimer = setTimeout(() => { scanTimer = null; inspect(); }, 300);
  };
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {subtree: true, childList: true});
  cleanups.push(() => observer.disconnect());
  const visibility = () => log('visibility', {hidden: document.hidden, visibilityState: document.visibilityState});
  const pagehide = (event) => log('pagehide', {persisted: event.persisted, route: safePath(location.href)});
  document.addEventListener('visibilitychange', visibility, {passive:true});
  window.addEventListener('pagehide', pagehide, {passive:true});
  cleanups.push(() => document.removeEventListener('visibilitychange', visibility));
  cleanups.push(() => window.removeEventListener('pagehide', pagehide));
  interval = setInterval(() => {
    if (stopped) return;
    const route = safePath(location.href);
    if (route !== currentRoute) log('route', {route, previous: currentRoute});
    currentRoute = route;
    for (const [video, meta] of handlers) {
      if (!video.isConnected) continue;
      log('media_sample', {id: `video-${[...videoSet].indexOf(video) + 1}`, ...details(video)});
    }
  }, 5000);
  cleanups.push(() => clearInterval(interval));
  window.__COURSE_M0_PROBE__ = {
    report() {
      const copy = rows.slice();
      console.log(TAG, 'report', copy);
      return copy;
    },
    stop() {
      if (stopped) return;
      log('stop', {sampleCount: rows.length});
      stopped = true;
      if (scanTimer !== null) clearTimeout(scanTimer);
      for (const [video, {types, fn}] of handlers) {
        for (const type of types) video.removeEventListener(type, fn);
      }
      handlers.clear();
      for (const cleanup of cleanups) cleanup();
      console.log(TAG, 'probe stopped; no player changes made');
    }
  };
  log('start', {
    siteOrigin: location.origin,
    route: safePath(location.href),
    chromeVersionHint: navigator.userAgent.match(/(?:Chrome|Edg)\/(\d+)/)?.[0] || 'unknown'
  });
  inspect();
  console.log(TAG, '诊断运行中。先正常播放，切到后台，再返回；完成后输入 __COURSE_M0_PROBE__.report() 查看事件；停止使用 __COURSE_M0_PROBE__.stop()。');
})();