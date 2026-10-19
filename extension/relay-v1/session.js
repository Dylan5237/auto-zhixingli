'use strict';

function createSessionHandler(storage) {
  let queue = Promise.resolve();
  return (message, sender) => {
    const task = queue.then(async () => {
      if (!sender.tab || sender.frameId !== 0 ||
          !/^https?:\/\/u\.exexm\.com\//.test(sender.url || '')) throw new Error('invalid-sender');
      const tabId = sender.tab.id;
      const { relayConfig = {} } = await storage.local.get('relayConfig');
      const { relaySession = null } = await storage.session.get('relaySession');
      let { relayCapture = null } = await storage.session.get('relayCapture');
      const owned = relaySession?.tabId === tabId;
      const viewConfig = (config) => ({ ...config, capturePlayback: Boolean(config.capturePlayback && relayCapture?.tabId === tabId) });
      if (message.type === 'load') return { config: viewConfig(relayConfig), run: owned ? relaySession.run : null };
      if (message.type === 'configure') {
        if (relaySession && !owned) throw new Error('another-tab');
        if (message.patch.targetPlaybackUrl && message.patch.capturePlayback === false && relayCapture?.tabId !== tabId) {
          throw new Error('capture-not-owned');
        }
        if (message.patch.capturePlayback !== undefined) {
          relayCapture = message.patch.capturePlayback ? { tabId } : null;
          await storage.session.set({ relayCapture });
        }
        const config = { ...relayConfig, ...message.patch };
        await storage.local.set({ relayConfig: config });
        return { config: viewConfig(config) };
      }
      if (message.type === 'arm') {
        if (relaySession && !owned) throw new Error('another-tab');
        const run = {
          id: crypto.randomUUID(), revision: 0, phase: 'watch', clicks: 0,
          sourceUrl: message.sourceUrl, startedAt: Date.now(), phaseAt: Date.now(),
          naturalEnd: false, sourceProgress: false, events: [],
        };
        await storage.session.set({ relaySession: { tabId, run } });
        return { run };
      }
      if (message.type === 'save') {
        if (!owned || message.run.id !== relaySession.run.id ||
            message.run.revision !== relaySession.run.revision) throw new Error('stale-run');
        const run = { ...message.run, revision: message.run.revision + 1 };
        await storage.session.set({ relaySession: { tabId, run } });
        return { run };
      }
      if (message.type === 'stop') {
        if (owned) await storage.session.set({ relaySession: null });
        if (relayCapture?.tabId === tabId) await storage.session.set({ relayCapture: null });
        return { run: null };
      }
      throw new Error('invalid-message');
    });
    queue = task.catch(() => {});
    return task;
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createSessionHandler };
} else {
  const handle = createSessionHandler(chrome.storage);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    handle(message, sender).then(respond, (error) => respond({ error: error.message }));
    return true;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    handle({ type: 'stop' }, { tab: { id: tabId }, frameId: 0, url: 'https://u.exexm.com/' });
  });
}
