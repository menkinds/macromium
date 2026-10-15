// 탭 클릭 후 닫기 - 서비스 워커
// 실행 상태는 chrome.storage.local 의 'run' 에 저장되어, 서비스 워커가 잠들었다 깨어나도 이어서 진행합니다.

const ALARM = 'tcc-step';
const DEFAULT_SETTINGS = {
  initialDelaySec: 0,   // 시작 후 첫 클릭 전에만 기다리는 시간
  delaySec: 5,          // 단계(탭) 사이 대기 시간
  afterClickSec: 1,     // 클릭 후 닫기 전 대기 시간
  order: 'current',     // 'current' = 현재 탭부터 오른쪽으로 / 'first' = 맨 왼쪽 탭부터
  clickMode: 'element', // 'element' | 'coords'
  coordFallback: true,  // 요소 모드에서 요소를 못 찾으면 좌표로 클릭
  onNotFound: 'stop',   // 'stop' | 'skip'
  findTimeoutSec: 5     // 요소가 나타날 때까지 기다리는 최대 시간
};

function secondsToMs(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n * 1000;
}

let timer = null;
let keepAlive = null;
let stepping = false;
let badgeTimer = null;
let badgeNextAt = 0;

// ---------- 저장소 헬퍼 ----------
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
async function getRun() {
  const { run } = await chrome.storage.local.get('run');
  return run || null;
}
async function setRun(run) {
  // 다른 곳(중지 버튼)에서 이미 중지된 실행을 오래된 객체가 다시 살리지 않도록 보호
  const stored = await getRun();
  if (stored && stored.startedAt === run.startedAt && stored.stopped && !run.stopped) {
    run.running = false;
    run.stopped = true;
  }
  await chrome.storage.local.set({ run });
  if (!run.running) clearBadge();
}
async function log(run, msg) {
  const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  const line = `[${t}] ${msg}`;
  console.log('[탭클릭닫기]', line);
  run.log = (run.log || []).concat(line).slice(-50);
  run.status = msg;
  await setRun(run);
}

// ---------- 아이콘 배지: 다음 실행까지 남은 초 ----------
// 1초마다 확장 API를 호출하므로 대기 중에도 서비스 워커가 잠들지 않습니다.
chrome.action.setBadgeBackgroundColor({ color: '#2F7A2C' });
if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#FFFFFF' });

function badgeText() {
  const sec = Math.ceil((badgeNextAt - Date.now()) / 1000);
  if (sec <= 0) return '…'; // 지금 클릭/닫기 중
  if (sec < 100) return String(sec);
  return Math.ceil(sec / 60) + 'm';
}
function startBadge(nextAt) {
  badgeNextAt = nextAt;
  chrome.action.setBadgeText({ text: badgeText() });
  if (!badgeTimer) badgeTimer = setInterval(() => chrome.action.setBadgeText({ text: badgeText() }), 1000);
}
function clearBadge() {
  if (badgeTimer) { clearInterval(badgeTimer); badgeTimer = null; }
  chrome.action.setBadgeText({ text: '' });
}

// 서비스 워커가 다시 깨어났을 때 배지 복구
getRun().then((run) => {
  if (run && run.running) startBadge(run.nextAt);
  else clearBadge();
});

// ---------- 스케줄링 ----------
// 30초 미만: setTimeout + keep-alive(20초마다 확장 API 호출) + 백업 알람
// 30초 이상: chrome.alarms 로 예약 (서비스 워커가 잠들어도 깨움)
function clearTimers() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
}

async function schedule(run, ms) {
  clearTimers();
  run.nextAt = Date.now() + ms;
  run.waitMs = ms; // 팝업의 진행 링 표시용
  await setRun(run);
  if (!run.running) return;
  startBadge(run.nextAt);
  if (ms >= 30000) {
    await chrome.alarms.create(ALARM, { when: run.nextAt });
  } else {
    // 서비스 워커가 종료된 경우를 대비한 백업 알람 (최소 30초)
    await chrome.alarms.create(ALARM, { when: Math.max(run.nextAt + 2000, Date.now() + 30000) });
    keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    timer = setTimeout(() => { timer = null; tick(); }, ms);
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) tick();
});

// 브라우저 재시작 시 이전 실행은 무효 (탭 ID가 바뀜)
chrome.runtime.onStartup.addListener(async () => {
  const run = await getRun();
  if (run && run.running) {
    run.running = false;
    await log(run, '브라우저가 다시 시작되어 실행이 중지되었습니다.');
  }
});

// ---------- 시작/중지 ----------
async function start(windowId, activeTabId) {
  const settings = await getSettings();
  const { target } = await chrome.storage.local.get('target');
  if (!target) return { ok: false, error: '먼저 [위치 지정]으로 클릭할 위치를 선택하세요.' };

  const tabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
  if (tabs.length < 2) return { ok: false, error: '탭이 2개 이상 있어야 합니다. (마지막 탭은 닫지 않습니다)' };

  let ordered = tabs;
  if (settings.order === 'current') {
    const i = Math.max(0, tabs.findIndex((t) => t.id === activeTabId));
    ordered = tabs.slice(i).concat(tabs.slice(0, i)); // 현재 탭 → 오른쪽 끝 → 맨 왼쪽부터 이어서
  }
  const queue = ordered.map((t) => t.id); // 마지막 탭까지 클릭하고, 그 탭만 닫지 않음
  const keepTabId = queue[queue.length - 1];

  clearTimers();
  await chrome.alarms.clear(ALARM);
  const run = {
    running: true,
    windowId,
    queue,
    keepTabId,
    index: 0,
    phase: 'click', // 'click' → (afterClick 대기) → 'close' → (delay 대기) → 다음 탭 'click'
    // 마지막 탭은 click 뒤 닫지 않고 끝낸다. 첫 click 전 대기는 initialDelaySec.
    done: 0,
    closed: 0,
    skipped: 0,
    total: queue.length,
    nextAt: 0,
    startedAt: Date.now(),
    log: []
  };
  await log(run, `시작: 탭 ${queue.length}개 모두 클릭, ${queue.length - 1}개 닫기 예정 (마지막 탭은 클릭 후 유지)`);
  await schedule(run, secondsToMs(settings.initialDelaySec));
  return { ok: true };
}

async function stop(reason) {
  clearTimers();
  await chrome.alarms.clear(ALARM);
  const run = await getRun();
  if (run) {
    const wasRunning = run.running;
    run.running = false;
    run.stopped = true;
    run.nextAt = 0;
    await log(run, reason || (wasRunning ? '사용자가 중지했습니다.' : '중지됨'));
  }
}

async function finish(run) {
  clearTimers();
  await chrome.alarms.clear(ALARM);
  run.running = false;
  run.nextAt = 0;
  const closed = run.closed || 0;
  await log(run, `완료: ${run.done}/${run.total} 처리, ${closed}개 닫음` + (run.skipped ? `, ${run.skipped}개 건너뜀` : '') + ' (마지막 탭은 닫지 않음)');
}

// ---------- 한 단계 실행 ----------
async function tick() {
  if (stepping) return;
  stepping = true;
  try {
    const run = await getRun();
    if (!run || !run.running) { clearTimers(); return; }
    if (Date.now() < run.nextAt - 100) {
      // 아직 시간이 안 됨 (중복 호출) → 남은 시간으로 재예약
      if (!timer) await schedule(run, run.nextAt - Date.now());
      return;
    }
    if (run.phase === 'close') await doClose(run);
    else await doClick(run);
  } catch (e) {
    const run = await getRun();
    if (run && run.running) {
      run.running = false;
      await log(run, '오류로 중지: ' + (e && e.message ? e.message : e));
    }
    clearTimers();
    await chrome.alarms.clear(ALARM);
  } finally {
    stepping = false;
  }
}

async function isStillRunning(run) {
  const cur = await getRun();
  return !!(cur && cur.running && cur.startedAt === run.startedAt);
}

async function tabExists(tabId) {
  try { return await chrome.tabs.get(tabId); } catch (e) { return null; }
}

async function waitForComplete(tabId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = await tabExists(tabId);
    if (!t) return false;
    if (t.status === 'complete') return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function advance(run, settings) {
  run.index += 1;
  run.phase = 'click';
  if (run.index >= run.queue.length) return finish(run);
  await schedule(run, secondsToMs(settings.delaySec));
}

async function doClick(run) {
  const settings = await getSettings();
  const { target } = await chrome.storage.local.get('target');
  const tabId = run.queue[run.index];
  const no = run.index + 1;

  const tab = await tabExists(tabId);
  if (!tab) {
    await log(run, `탭 ${no}: 이미 닫혀 있어 건너뜁니다.`);
    run.skipped += 1;
    return advance(run, { ...settings, delaySec: 0 });
  }

  // 탭 활성화 후 로딩 대기
  await chrome.tabs.update(tabId, { active: true });
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
  await waitForComplete(tabId, 30000);
  await new Promise((r) => setTimeout(r, 300));
  if (!(await isStillRunning(run))) return;

  let result;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: clickInPage,
      args: [target, settings.clickMode, settings.coordFallback, settings.findTimeoutSec * 1000]
    });
    result = res && res.result ? res.result : { ok: false, reason: '스크립트 결과 없음' };
  } catch (e) {
    result = { ok: false, reason: '스크립트 실행 불가 (' + (e.message || e) + ')' };
  }

  run = (await getRun()) || run; // 실행 중 중지되었는지 확인
  if (!run.running) return;

  const title = (tab.title || tab.url || '').slice(0, 40);
  if (!result.ok) {
    if (settings.onNotFound === 'skip') {
      run.skipped += 1;
      await log(run, `탭 ${no} "${title}": 대상 못 찾음 (${result.reason}) → 건너뜀 (탭 유지)`);
      return advance(run, settings);
    }
    run.running = false;
    clearTimers();
    await chrome.alarms.clear(ALARM);
    await log(run, `탭 ${no} "${title}": 대상 못 찾음 (${result.reason}) → 중지`);
    return;
  }

  const isLast = run.index === run.queue.length - 1;
  await log(run, `탭 ${no} "${title}": 클릭 완료 (${result.method})` + (isLast ? ' — 마지막 탭이라 닫지 않음' : ''));
  if (isLast) {
    run.done += 1;
    return finish(run);
  }
  run.phase = 'close';
  await schedule(run, secondsToMs(settings.afterClickSec));
}

async function doClose(run) {
  const settings = await getSettings();
  const tabId = run.queue[run.index];
  const no = run.index + 1;

  if (tabId === run.keepTabId || run.index === run.queue.length - 1) {
    await log(run, '마지막 탭은 닫지 않고 종료합니다.');
    return finish(run);
  }

  const tab = await tabExists(tabId);
  if (tab) {
    // 안전장치: 창에 탭이 1개만 남았다면 절대 닫지 않음
    const remaining = await chrome.tabs.query({ windowId: tab.windowId });
    if (remaining.length <= 1) {
      run.running = false;
      await log(run, '창에 탭이 1개만 남아 닫지 않고 종료합니다.');
      clearTimers();
      await chrome.alarms.clear(ALARM);
      return;
    }
    if (!(await isStillRunning(run))) return;
    await chrome.tabs.remove(tabId);
    run.done += 1;
    run.closed = (run.closed || 0) + 1;
    await log(run, `탭 ${no} 닫음 — ${run.done}/${run.total} 완료`);
  } else {
    run.done += 1;
    run.closed = (run.closed || 0) + 1;
    await log(run, `탭 ${no}: 이미 닫혀 있음 — ${run.done}/${run.total} 완료`);
  }
  return advance(run, settings);
}

// ---------- 페이지 안에서 실행되는 클릭 함수 (executeScript 로 주입) ----------
// 주의: 이 함수는 직렬화되어 페이지에서 실행되므로 외부 변수를 참조하면 안 됩니다.
async function clickInPage(target, mode, coordFallback, timeoutMs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fire(el, x, y) {
    const base = { bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
    const P = window.PointerEvent || MouseEvent;
    try { el.dispatchEvent(new P('pointerover', { ...base, pointerType: 'mouse', isPrimary: true })); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mouseover', base));
    try { el.dispatchEvent(new P('pointerdown', { ...base, pointerType: 'mouse', isPrimary: true, buttons: 1 })); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    if (typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch (e) {} }
    try { el.dispatchEvent(new P('pointerup', { ...base, pointerType: 'mouse', isPrimary: true })); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mouseup', base));
    if (typeof el.click === 'function') el.click(); // click 이벤트는 여기서 1회 발생
    else el.dispatchEvent(new MouseEvent('click', base));
  }

  async function byElement() {
    if (!target.selector) return null;
    const end = Date.now() + timeoutMs;
    let el = null;
    while (true) {
      try { el = document.querySelector(target.selector); } catch (e) { return null; }
      if (el) break;
      if (Date.now() >= end) return null;
      await sleep(250);
    }
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(100);
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    // 요소 위에 다른 요소가 덮고 있으면 그 지점의 실제 요소(자식 등)에 이벤트 발생
    const hit = document.elementFromPoint(x, y);
    const dest = hit && (hit === el || el.contains(hit)) ? hit : el;
    fire(dest, x, y);
    return { ok: true, method: '요소: ' + target.selector };
  }

  async function byCoords() {
    if (typeof target.pageX !== 'number') return null;
    window.scrollTo(target.scrollX || 0, target.scrollY || 0);
    await sleep(100);
    let x = target.pageX - window.scrollX;
    let y = target.pageY - window.scrollY;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
      window.scrollTo(target.pageX - window.innerWidth / 2, target.pageY - window.innerHeight / 2);
      await sleep(100);
      x = target.pageX - window.scrollX;
      y = target.pageY - window.scrollY;
    }
    const end = Date.now() + timeoutMs;
    let el = null;
    while (!(el = document.elementFromPoint(x, y))) {
      if (Date.now() >= end) return null;
      await sleep(250);
    }
    fire(el, x, y);
    return { ok: true, method: `좌표 (${target.pageX}, ${target.pageY}) → <${el.tagName.toLowerCase()}>` };
  }

  if (!target) return { ok: false, reason: '저장된 대상 없음' };
  let res = null;
  if (mode === 'coords') {
    res = await byCoords();
    if (!res) return { ok: false, reason: '좌표 위치에 요소 없음' };
    return res;
  }
  res = await byElement();
  if (res) return res;
  if (coordFallback) {
    res = await byCoords();
    if (res) { res.method += ' (요소를 못 찾아 좌표로 대체)'; return res; }
  }
  return { ok: false, reason: '선택자에 맞는 요소 없음: ' + target.selector };
}

// ---------- 메시지 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'start') {
      sendResponse(await start(msg.windowId, msg.activeTabId));
    } else if (msg.type === 'stop') {
      await stop();
      sendResponse({ ok: true });
    } else if (msg.type === 'pickResult') {
      await chrome.storage.local.set({ target: msg.target });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false });
    }
  })();
  return true;
});
