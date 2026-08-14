importScripts('port.js');

let ws = null;

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket('ws://127.0.0.1:' + BRIDGE_PORT);
  } catch (err) {
    setTimeout(connect, 1000);
    return;
  }
  ws.onopen = () => {
    try {
      ws.send(JSON.stringify({ auth: BRIDGE_AUTH }));
    } catch (err) {}
  };
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    handle(msg);
  };
  ws.onclose = () => {
    setTimeout(connect, 1000);
  };
  ws.onerror = () => {};
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  connect();
});

chrome.runtime.onStartup.addListener(connect);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') connect();
});

connect();

function reply(id, result, error) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const msg = { id };
  if (error !== undefined) msg.error = String(error);
  else msg.result = result;
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {}
}

function tabInfo(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? tab.pendingUrl ?? '',
    active: tab.active,
  };
}

async function activeTabId(params) {
  if (params && params.tabId !== undefined && params.tabId !== null) return params.tabId;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length) throw new Error('no active tab');
  return tabs[0].id;
}

async function runContent(params, func) {
  const tabId = await activeTabId(params);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: [params ?? {}],
  });
  if (!results || !results.length) {
    throw new Error('script did not execute in tab ' + tabId + ' (tab may be closed or not ready)');
  }
  if (results[0].result === null || results[0].result === undefined) {
    throw new Error('script returned no result in tab ' + tabId + ': ' + JSON.stringify(results[0].error ?? null));
  }
  return results[0].result;
}

async function handle(msg) {
  try {
    switch (msg.method) {
      case 'tabs': {
        const tabs = await chrome.tabs.query({});
        reply(msg.id, { tabs: tabs.map(tabInfo) });
        break;
      }
      case 'go': {
        const tabId = await activeTabId(msg.params);
        await chrome.tabs.update(tabId, { url: msg.params.url });
        reply(msg.id, { ok: true });
        break;
      }
      case 'back':
        reply(msg.id, await runContent(msg.params, backContent));
        break;
      case 'forward':
        reply(msg.id, await runContent(msg.params, forwardContent));
        break;
      case 'reload': {
        await chrome.tabs.reload(await activeTabId(msg.params));
        reply(msg.id, { ok: true });
        break;
      }
      case 'newTab': {
        const tab = await chrome.tabs.create({ url: msg.params.url ?? 'about:blank' });
        reply(msg.id, tabInfo(tab));
        break;
      }
      case 'closeTab': {
        await chrome.tabs.remove(msg.params.tabId);
        reply(msg.id, { ok: true });
        break;
      }
      case 'screenshot': {
        const tabId = await activeTabId(msg.params);
        const tab = await chrome.tabs.get(tabId);
        await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.tabs.update(tabId, { active: true });
        await new Promise((r) => setTimeout(r, 150));
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        reply(msg.id, { dataUrl });
        break;
      }
      case 'snapshot':
        reply(msg.id, await runContent(msg.params, snapshotContent));
        break;
      case 'text':
        reply(msg.id, await runContent(msg.params, getTextContent));
        break;
      case 'html':
        reply(msg.id, await runContent(msg.params, getHtmlContent));
        break;
      case 'click':
        reply(msg.id, await runContent(msg.params, clickContent));
        break;
      case 'type':
        reply(msg.id, await runContent(msg.params, typeContent));
        break;
      case 'key':
        reply(msg.id, await runContent(msg.params, keyContent));
        break;
      case 'scroll':
        reply(msg.id, await runContent(msg.params, scrollContent));
        break;
      default:
        reply(msg.id, undefined, 'unknown browser method: ' + msg.method);
    }
  } catch (err) {
    reply(msg.id, undefined, String((err && err.message) || err));
  }
}

function snapshotContent(params) {
  function cssPath(el) {
    if (el.id && /^[a-zA-Z_][\w-]*$/.test(el.id)) return '#' + el.id;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== 'BODY' && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[a-zA-Z_][\w-]*$/.test(node.id)) {
        parts.unshift('#' + node.id);
        break;
      }
      const cls = Array.from(node.classList).filter((c) => /^[a-zA-Z_][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }
  const INTERACTIVE = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="combobox"]',
    '[contenteditable="true"]', '[contenteditable=""]', '[onclick]',
  ];
  const seen = new Set();
  const elements = [];
  for (const sel of INTERACTIVE) {
    let nodes = [];
    try {
      nodes = document.querySelectorAll(sel);
    } catch (err) {
      continue;
    }
    for (const el of nodes) {
      if (seen.has(el) || elements.length >= 200) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      if (!visible) continue;
      let text = '';
      if (el.tagName === 'INPUT') {
        text = el.type === 'submit' || el.type === 'button' ? el.value : el.placeholder || el.value || '';
        if (el.type === 'submit' || el.type === 'button') text = el.value || el.textContent || '';
      } else {
        text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      }
      if (text.length > 120) text = text.slice(0, 120) + '...';
      const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'BUTTON' ? 'button' : '');
      const index = elements.length;
      elements.push({
        index,
        tag: el.tagName.toLowerCase(),
        text,
        role,
        selector: cssPath(el),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        inputType: el.tagName === 'INPUT' ? el.type : undefined,
        inputValue: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? String(el.value).slice(0, 200) : undefined,
      });
    }
  }
  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
    elements,
  };
}

function getTextContent(params) {
  const text = (document.body ? document.body.innerText : '').trim();
  return { text: text.slice(0, 30000) };
}

function getHtmlContent(params) {
  const el = params.selector ? document.querySelector(params.selector) : document.body;
  if (!el) throw new Error('selector matched nothing: ' + params.selector);
  return { html: el.outerHTML.slice(0, 30000) };
}

function clickContent(params) {
  const el = document.querySelector(params.selector);
  if (!el) throw new Error('selector matched nothing: ' + params.selector);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.click();
  return { clicked: true, text: (el.innerText || el.value || '').trim().slice(0, 200) };
}

function typeContent(params) {
  const el = document.querySelector(params.selector);
  if (!el) throw new Error('selector matched nothing: ' + params.selector);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  const text = String(params.text ?? '');
  if (el.isContentEditable) {
    el.textContent = text;
  } else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, text);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { typed: true, value: String(el.value ?? el.textContent ?? '').slice(0, 200) };
}

function keyContent(params) {
  const el = params.selector ? document.querySelector(params.selector) : document.activeElement;
  if (!el) throw new Error('no element to send keys to');
  const key = String(params.key ?? '');
  const modifiers = params.modifiers ?? [];
  const keyEvent = (type) =>
    new KeyboardEvent(type, {
      key,
      bubbles: true,
      cancelable: true,
      ctrlKey: modifiers.includes('ctrl'),
      metaKey: modifiers.includes('cmd') || modifiers.includes('meta'),
      shiftKey: modifiers.includes('shift'),
      altKey: modifiers.includes('alt'),
    });
  el.focus();
  el.dispatchEvent(keyEvent('keydown'));
  el.dispatchEvent(keyEvent('keypress'));
  el.dispatchEvent(keyEvent('keyup'));
  if (key === 'Enter' && el.form) {
    try {
      el.form.requestSubmit();
    } catch (err) {}
  }
  return { pressed: true, key };
}

function backContent(params) {
  history.back();
  return { ok: true, url: location.href };
}

function forwardContent(params) {
  history.forward();
  return { ok: true, url: location.href };
}

function scrollContent(params) {
  const dx = Number(params.dx ?? 0);
  const dy = Number(params.dy ?? 0);
  if (params.selector) {
    const el = document.querySelector(params.selector);
    if (!el) throw new Error('selector matched nothing: ' + params.selector);
    el.scrollBy({ left: dx, top: dy });
  } else {
    window.scrollBy(dx, dy);
  }
  return { scrolled: true, dx, dy, scroll: { x: window.scrollX, y: window.scrollY } };
}
