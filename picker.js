// 페이지에 주입되어 사용자가 클릭한 요소의 선택자와 좌표를 저장합니다.
(() => {
  if (window.__tccPickerActive) return;
  window.__tccPickerActive = true;

  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #dc2626;' +
    'background:rgba(220,38,38,0.12);border-radius:2px;transition:all 40ms;display:none;';
  const tip = document.createElement('div');
  tip.textContent = '클릭할 위치를 선택하세요 (Esc: 취소)';
  tip.style.cssText =
    'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
    'background:#111827;color:#fff;font:13px/1.4 sans-serif;padding:6px 12px;border-radius:6px;' +
    'pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.3);';
  document.documentElement.appendChild(box);
  document.documentElement.appendChild(tip);

  function isUnique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }

  function buildSelector(el) {
    if (!(el instanceof Element)) return null;
    const tag = el.tagName.toLowerCase();
    // 1) id
    if (el.id) {
      const s = '#' + CSS.escape(el.id);
      if (isUnique(s)) return s;
    }
    // 2) 고유한 속성
    const attrs = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-id', 'name',
      'aria-label', 'title', 'alt', 'href', 'value', 'type', 'role', 'placeholder'];
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v == null || v === '' || v.length > 200) continue;
      const s = `${tag}[${a}="${CSS.escape(v)}"]`;
      if (isUnique(s)) return s;
    }
    // 3) nth-of-type 경로 (고유 id를 가진 조상이 있으면 거기서 시작)
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      if (cur !== el && cur.id && isUnique('#' + CSS.escape(cur.id))) {
        parts.unshift('#' + CSS.escape(cur.id));
        break;
      }
      const t = cur.tagName.toLowerCase();
      let part = t;
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      const sel = parts.join(' > ');
      if (isUnique(sel) && document.querySelector(sel) === el) return sel;
      cur = parent;
    }
    const sel = parts.join(' > ');
    return sel || tag;
  }

  function onMove(e) {
    const el = e.target;
    if (!(el instanceof Element)) return;
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }

  function block(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function cleanup() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('mousedown', block, true);
    window.removeEventListener('mouseup', block, true);
    window.removeEventListener('pointerdown', block, true);
    window.removeEventListener('pointerup', block, true);
    window.removeEventListener('keydown', onKey, true);
    box.remove();
    tip.remove();
    window.__tccPickerActive = false;
  }

  function onClick(e) {
    block(e);
    const el = e.target;
    const selector = buildSelector(el);
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 60);
    const target = {
      selector,
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      text,
      clientX: Math.round(e.clientX),
      clientY: Math.round(e.clientY),
      pageX: Math.round(e.clientX + window.scrollX),
      pageY: Math.round(e.clientY + window.scrollY),
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      url: location.href,
      pickedAt: Date.now()
    };
    cleanup();
    chrome.runtime.sendMessage({ type: 'pickResult', target });
    const done = document.createElement('div');
    done.textContent = '위치가 저장되었습니다: ' + selector;
    done.style.cssText = tip.style.cssText + 'background:#065f46;';
    document.documentElement.appendChild(done);
    setTimeout(() => done.remove(), 2000);
  }

  function onKey(e) {
    if (e.key === 'Escape') { block(e); cleanup(); }
  }

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('mousedown', block, true);
  window.addEventListener('mouseup', block, true);
  window.addEventListener('pointerdown', block, true);
  window.addEventListener('pointerup', block, true);
  window.addEventListener('keydown', onKey, true);
})();
