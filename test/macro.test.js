const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const realSetInterval = setInterval;
const realClearInterval = clearInterval;
const realSetImmediate = setImmediate;
const RealDate = Date;

const TARGET = { selector: '#go', pageX: 10, pageY: 20, tag: 'button', text: 'go' };

function makeTabs(n, windowId = 1) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    index: i,
    windowId,
    status: 'complete',
    title: 'tab' + (i + 1),
    url: 'https://example.test/' + (i + 1)
  }));
}

function baseSettings(over = {}) {
  return {
    delaySec: 0,
    afterClickSec: 0,
    order: 'first',
    clickMode: 'element',
    coordFallback: true,
    onNotFound: 'stop',
    findTimeoutSec: 1,
    ...over
  };
}

function loadBackground({ tabs, settings, target = TARGET, instant = true }) {
  const store = { settings, target, run: null };
  const clicked = [];
  const removed = [];
  const windowsRemoved = [];
  const waits = [];
  let lastSig = '';
  const intervals = new Set();
  const timeouts = new Set();
  const timerApi = createTimerApi({ instant, timeouts, intervals });

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = typeof keys === 'string' ? [keys] : keys;
          const out = {};
          for (const key of list) {
            out[key] = store[key] === undefined ? undefined : structuredClone(store[key]);
          }
          return out;
        },
        async set(obj) {
          if (obj.run && obj.run.running && typeof obj.run.waitMs === 'number') {
            const sig = obj.run.index + ':' + obj.run.phase + ':' + obj.run.waitMs + ':' + obj.run.nextAt;
            if (sig !== lastSig) {
              lastSig = sig;
              waits.push({ index: obj.run.index, phase: obj.run.phase, waitMs: obj.run.waitMs });
            }
          }
          Object.assign(store, obj);
        },
        async remove() {}
      }
    },
    action: {
      setBadgeBackgroundColor() {},
      setBadgeTextColor() {},
      setBadgeText() {}
    },
    alarms: {
      async create() {},
      async clear() {},
      onAlarm: { addListener() {} }
    },
    runtime: {
      onStartup: { addListener() {} },
      onMessage: { addListener() {} },
      getPlatformInfo(cb) { if (cb) cb({}); }
    },
    tabs: {
      async query(q) {
        return tabs.filter((tab) => {
          if (removed.includes(tab.id)) return false;
          if (q && q.windowId != null && tab.windowId !== q.windowId) return false;
          return true;
        }).map((tab) => ({ ...tab }));
      },
      async get(id) {
        if (removed.includes(id) || !tabs.some((tab) => tab.id === id)) {
          throw new Error('No tab with id: ' + id);
        }
        return { ...tabs.find((tab) => tab.id === id) };
      },
      async update(id) { return { ...tabs.find((tab) => tab.id === id) }; },
      async remove(id) { removed.push(id); }
    },
    windows: {
      async update() {},
      async remove(id) { windowsRemoved.push(id); }
    },
    scripting: {
      async executeScript(details) {
        clicked.push(details.target.tabId);
        return [{ result: { ok: true, method: 'test' } }];
      }
    }
  };

  const context = {
    chrome,
    console,
    Date, Math, Number, String, Boolean, Array, Object, Promise,
    RegExp, Error, TypeError, JSON, Symbol, parseInt, parseFloat,
    isNaN, isFinite, NaN, Infinity, undefined, structuredClone, queueMicrotask,
    ...timerApi
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context, { filename: 'background.js' });

  return {
    context, store, clicked, removed, windowsRemoved, waits,
    cleanup() {
      timerApi.cleanup();
      for (const id of timeouts) realClearTimeout(id);
      for (const id of intervals) realClearInterval(id);
    }
  };
}

function createTimerApi({ instant, timeouts, intervals }) {
  if (!instant) {
    return {
      setTimeout(fn, ms, ...args) {
        const id = realSetTimeout(fn, ms, ...args);
        timeouts.add(id);
        return id;
      },
      clearTimeout(id) {
        timeouts.delete(id);
        return realClearTimeout(id);
      },
      setInterval(fn, ms, ...args) {
        const id = realSetInterval(fn, ms, ...args);
        intervals.add(id);
        return id;
      },
      clearInterval(id) {
        intervals.delete(id);
        return realClearInterval(id);
      },
      cleanup() {}
    };
  }

  let now = RealDate.now();
  let seq = 1;
  let pumping = false;
  let stopped = false;
  let fired = 0;
  const queue = [];

  function FakeDate(...args) {
    if (!new.target) return RealDate(...args);
    if (args.length === 0) return new RealDate(now);
    return new RealDate(...args);
  }
  FakeDate.now = () => now;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;

  async function pump() {
    if (pumping || stopped) return;
    pumping = true;
    let idle = 0;
    try {
      while (!stopped && idle < 40) {
        if (queue.length) {
          idle = 0;
          queue.sort((a, b) => a.at - b.at);
          const next = queue.shift();
          if (++fired > 10000) throw new Error('too many timers');
          now = Math.max(now, next.at);
          next.fn();
        } else {
          idle += 1;
        }
        await new Promise((resolve) => realSetImmediate(resolve));
      }
    } finally {
      pumping = false;
      if (!stopped && queue.length) pump();
    }
  }

  return {
    Date: FakeDate,
    setTimeout(fn, ms) {
      const id = seq++;
      queue.push({ id, fn, at: now + Math.max(0, Number(ms) || 0) });
      pump();
      return id;
    },
    clearTimeout(id) {
      const index = queue.findIndex((item) => item.id === id);
      if (index >= 0) queue.splice(index, 1);
    },
    setInterval() { return seq++; },
    clearInterval() {},
    cleanup() {
      stopped = true;
      queue.length = 0;
    }
  };
}

async function waitUntil(fn, label, ms = 4000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timeout: ' + label);
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
}

function loadPopup(settings) {
  const store = { settings: settings || {}, target: null, run: null };
  const elements = {};
  const intervals = new Set();
  function make(id, type) {
    elements[id] = {
      id,
      type,
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      style: {},
      scrollTop: 0,
      scrollHeight: 0,
      classList: { add() {}, remove() {} },
      listeners: {},
      addEventListener(event, fn) { this.listeners[event] = fn; }
    };
  }
  for (const id of ['delaySec', 'afterClickSec', 'findTimeoutSec', 'initialDelaySec']) make(id, 'number');
  for (const id of ['order', 'clickMode', 'onNotFound']) make(id, 'select');
  make('coordFallback', 'checkbox');
  for (const id of ['target', 'start', 'stop', 'progress', 'progressBar', 'status', 'log', 'countdown', 'countLabel', 'ringBar', 'pick', 'clearTarget']) {
    make(id, 'text');
  }

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) out[key] = store[key];
          return out;
        },
        async set(obj) { Object.assign(store, obj); },
        async remove(key) { delete store[key]; }
      },
      onChanged: { addListener() {} }
    },
    tabs: { async query() { return []; } },
    scripting: { async executeScript() {} },
    runtime: { async sendMessage() { return { ok: true }; } }
  };

  const context = {
    chrome,
    console,
    document: { getElementById: (id) => elements[id] },
    Date, Math, Number, parseFloat, parseInt, Object, Array, Promise, isFinite,
    setInterval(fn, ms, ...args) {
      const id = realSetInterval(fn, ms, ...args);
      intervals.add(id);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
      return realClearInterval(id);
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'popup.js'), 'utf8'), context, { filename: 'popup.js' });
  return {
    context, elements, store,
    cleanup() { for (const id of intervals) realClearInterval(id); }
  };
}

test('click every open tab and leave only the last one open', async (t) => {
  for (const count of [2, 6]) {
    await t.test(count + ' tabs', async () => {
      const tabs = makeTabs(count);
      const env = loadBackground({ tabs, settings: baseSettings({ initialDelaySec: 0, order: 'first' }) });
      t.after(() => env.cleanup());
      try {
        const started = await env.context.start(1, 1);
        assert.equal(started.ok, true);
        await waitUntil(() => env.store.run && env.store.run.running === false, count + ' tabs did not finish');
        assert.deepEqual(env.clicked, tabs.map((tab) => tab.id));
        assert.deepEqual(env.removed, tabs.slice(0, -1).map((tab) => tab.id));
        assert.equal(env.windowsRemoved.length, 0);
        assert.equal(env.store.run.total, count);
        assert.equal(env.store.run.done, count);
        const stillOpen = tabs.filter((tab) => !env.removed.includes(tab.id)).map((tab) => tab.id);
        assert.deepEqual(stillOpen, [tabs[tabs.length - 1].id]);
      } finally {
        env.cleanup();
      }
    });
  }
});

test('current-tab order clicks the wrapped last tab and does not close it', async () => {
  const tabs = makeTabs(6);
  const env = loadBackground({ tabs, settings: baseSettings({ order: 'current', initialDelaySec: 0 }) });
  try {
    const started = await env.context.start(1, 4);
    assert.equal(started.ok, true);
    await waitUntil(() => env.store.run && env.store.run.running === false, 'rotated run did not finish');
    assert.deepEqual(env.clicked, [4, 5, 6, 1, 2, 3]);
    assert.deepEqual(env.removed, [4, 5, 6, 1, 2]);
    assert.equal(env.windowsRemoved.length, 0);
  } finally {
    env.cleanup();
  }
});

test('initial delay is configurable and defaults to no wait before the first click', async () => {
  const tabs = makeTabs(6);

  const custom = loadBackground({
    tabs,
    settings: baseSettings({ initialDelaySec: 2.5, delaySec: 8, afterClickSec: 2 }),
    instant: false
  });
  try {
    const started = await custom.context.start(1, 1);
    assert.equal(started.ok, true);
    assert.equal(custom.clicked.length, 0);
    assert.equal(custom.store.run.phase, 'click');
    assert.equal(custom.store.run.index, 0);
    assert.deepEqual(custom.store.run.queue, [1, 2, 3, 4, 5, 6]);
    assert.equal(custom.store.run.waitMs, 2500);
    const remaining = custom.store.run.nextAt - Date.now();
    assert.ok(remaining >= 2000 && remaining <= 3000, 'remaining was ' + remaining);
  } finally {
    await custom.context.stop();
    custom.cleanup();
  }

  const defaults = loadBackground({
    tabs,
    settings: baseSettings(),
    instant: false
  });
  try {
    await defaults.context.start(1, 1);
    assert.equal(defaults.clicked.length, 0);
    assert.equal(defaults.store.run.waitMs, 0);
    assert.deepEqual(defaults.store.run.queue, [1, 2, 3, 4, 5, 6]);
  } finally {
    await defaults.context.stop();
    defaults.cleanup();
  }

  const negative = loadBackground({
    tabs,
    settings: baseSettings({ initialDelaySec: -4 }),
    instant: false
  });
  try {
    await negative.context.start(1, 1);
    assert.equal(negative.store.run.waitMs, 0);
  } finally {
    await negative.context.stop();
    negative.cleanup();
  }
});

test('initial delay is only before the first click; later tabs use the between-tab delay', async () => {
  const tabs = makeTabs(6);
  const env = loadBackground({
    tabs,
    settings: baseSettings({ initialDelaySec: 4, delaySec: 8, afterClickSec: 2 })
  });
  try {
    const started = await env.context.start(1, 1);
    assert.equal(started.ok, true);
    await waitUntil(() => env.store.run && env.store.run.running === false, 'timed run did not finish');
    assert.deepEqual(env.waits, [
      { index: 0, phase: 'click', waitMs: 4000 },
      { index: 0, phase: 'close', waitMs: 2000 },
      { index: 1, phase: 'click', waitMs: 8000 },
      { index: 1, phase: 'close', waitMs: 2000 },
      { index: 2, phase: 'click', waitMs: 8000 },
      { index: 2, phase: 'close', waitMs: 2000 },
      { index: 3, phase: 'click', waitMs: 8000 },
      { index: 3, phase: 'close', waitMs: 2000 },
      { index: 4, phase: 'click', waitMs: 8000 },
      { index: 4, phase: 'close', waitMs: 2000 },
      { index: 5, phase: 'click', waitMs: 8000 }
    ]);
    assert.equal(env.waits.some((wait) => wait.index === 5 && wait.phase === 'close'), false);
    assert.deepEqual(env.clicked, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(env.removed, [1, 2, 3, 4, 5]);
  } finally {
    env.cleanup();
  }
});

test('settings popup has a first-click delay field defaulting to 0 seconds', async () => {
  const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
  assert.match(html, /첫 클릭 전 대기[\s\S]{0,160}id="initialDelaySec"/);

  const env = loadPopup({});
  try {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    assert.equal(env.elements.initialDelaySec.value, 0);
    env.elements.initialDelaySec.value = '1.5';
    await env.context.saveSettings();
    assert.equal(env.store.settings.initialDelaySec, 1.5);
    env.elements.initialDelaySec.value = '-2';
    await env.context.saveSettings();
    assert.equal(env.store.settings.initialDelaySec, 0);
  } finally {
    env.cleanup();
  }
});
