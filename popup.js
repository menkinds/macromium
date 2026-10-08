const DEFAULTS = {
  delaySec: 5,
  afterClickSec: 1,
  order: 'current',
  clickMode: 'element',
  coordFallback: true,
  onNotFound: 'stop',
  findTimeoutSec: 5
};
const FIELDS = ['delaySec', 'afterClickSec', 'findTimeoutSec', 'order', 'clickMode', 'coordFallback', 'onNotFound'];
const $ = (id) => document.getElementById(id);

async function loadAll() {
  const { settings, target, run } = await chrome.storage.local.get(['settings', 'target', 'run']);
  const s = { ...DEFAULTS, ...(settings || {}) };
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = !!s[f];
    else el.value = s[f];
  }
  renderTarget(target);
  renderRun(run);
}

async function saveSettings() {
  const s = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') s[f] = el.checked;
    else if (el.type === 'number') {
      const n = parseFloat(el.value);
      s[f] = Number.isFinite(n) && n >= 0 ? n : DEFAULTS[f];
    } else s[f] = el.value;
  }
  await chrome.storage.local.set({ settings: s });
}

function renderTarget(t) {
  if (!t) { $('target').textContent = '저장된 위치 없음 — [위치 지정]을 눌러 페이지에서 클릭할 곳을 선택하세요.'; return; }
  const desc = t.text ? ` "${t.text}"` : '';
  $('target').textContent =
    `선택자: ${t.selector}\n좌표: (${t.pageX}, ${t.pageY})  <${t.tag}>${desc}`;
  $('target').style.whiteSpace = 'pre-wrap';
}

function renderRun(run) {
  const running = !!(run && run.running);
  $('start').disabled = running;
  $('stop').disabled = !running;
  if (!run) { $('progress').textContent = '대기 중'; $('status').textContent = ''; $('log').textContent = ''; return; }
  $('progress').textContent = `${run.done}/${run.total} 완료` + (running ? ' (실행 중)' : '');
  $('status').textContent = run.status || '';
  $('status').classList.remove('error');
  $('log').textContent = (run.log || []).join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}

function showError(msg) {
  $('status').textContent = msg;
  $('status').classList.add('error');
}

$('pick').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['picker.js'] });
    window.close(); // 페이지를 클릭할 수 있도록 팝업 닫기
  } catch (e) {
    showError('이 페이지에서는 위치를 지정할 수 없습니다. (' + (e.message || e) + ')');
  }
});

$('clearTarget').addEventListener('click', async () => {
  await chrome.storage.local.remove('target');
});

$('start').addEventListener('click', async () => {
  await saveSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await chrome.runtime.sendMessage({ type: 'start', windowId: tab.windowId, activeTabId: tab.id });
  if (!res || !res.ok) showError((res && res.error) || '시작하지 못했습니다.');
});

$('stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop' });
});

for (const f of FIELDS) $(f).addEventListener('change', saveSettings);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.target) renderTarget(changes.target.newValue);
  if (changes.run) renderRun(changes.run.newValue);
});

loadAll();
