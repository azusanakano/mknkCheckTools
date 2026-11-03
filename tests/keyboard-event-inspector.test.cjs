const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Run the shipped inline scripts. Only browser DOM/event delivery is substituted;
// key interpretation, filtering, capture, and status updates use production code.
function loadInspector() {
  const html = fs.readFileSync(path.join(__dirname, '../tools/keyboard_event_inspector_local.html'), 'utf8');
  class Element {
    constructor(tagName, attributes = '', text = '') {
      this.nodeName = tagName.toUpperCase();
      this.textContent = text;
      this.value = '';
      this.checked = /\bchecked\b/.test(attributes);
      this.disabled = /\bdisabled\b/.test(attributes);
      this.type = /\btype="([^"]+)"/.exec(attributes)?.[1] || '';
      this.dataset = {};
      this.listeners = {};
      const classes = new Set((/\bclass="([^"]+)"/.exec(attributes)?.[1] || '').split(/\s+/));
      this.classList = {
        contains: name => classes.has(name),
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
      };
    }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    emit(type, event = {}) { for (const callback of this.listeners[type] || []) callback(event); }
    focus() { document.activeElement = this; }
    closest(selector) {
      if (selector === '.package-nav') return null;
      return ['BUTTON', 'SUMMARY'].includes(this.nodeName) || this.type === 'checkbox' ? this : null;
    }
    click() { this.emit('click'); }
  }
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>([^<]*)/gi)) {
    elements.set(match[3], new Element(match[1], match[2], match[4]));
  }
  const document = {
    hidden: false,
    getElementById: id => elements.get(id),
    addEventListener() {},
    createElement: tagName => new Element(tagName)
  };
  const window = new Element('window');
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    document, window, Element, HTMLElement: Element, console, Blob, URL,
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }
  });
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    vm.runInContext(match[1], context, { filename: 'keyboard_event_inspector_local.html' });
  }
  const get = id => elements.get(id);
  return {
    get,
    control: [...elements.values()].find(element => element.type === 'checkbox'),
    key(key, code = key, options = {}) {
      const event = {
        type: 'keydown', key, code, location: 0, repeat: false,
        isTrusted: true, isComposing: false,
        shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        target: get('inputArea'), defaultPrevented: false,
        getModifierState: () => false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {}, stopImmediatePropagation() {},
        ...options
      };
      window.emit(event.type, event);
      return event;
    },
    click: id => get(id).click(),
    blur: () => window.emit('blur'),
    expire() {
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    }
  };
}

test('blocking starts ON and suppresses special keys without suppressing printable keys', () => {
  const page = loadInspector();
  assert.equal(page.control.checked, true);
  assert.equal(page.get('filterStatus').textContent, 'ブロック中');
  for (const key of ['Tab', 'Enter', 'Backspace', 'PrintScreen', 'KanaMode', 'Convert']) {
    assert.equal(page.key(key).defaultPrevented, true, key);
  }
  assert.equal(page.key('a', 'KeyA').defaultPrevented, false);
});

test('switch OFF permits special keys and switching ON blocks them again', () => {
  const page = loadInspector();
  page.control.checked = false;
  page.control.emit('change');
  assert.equal(page.get('filterStatus').textContent, 'ブロック解除');
  assert.equal(page.get('filterStatus').classList.contains('bg-success'), true);
  for (const key of ['Tab', 'Enter', 'Backspace', 'PrintScreen', 'KanaMode', 'Convert']) {
    assert.equal(page.key(key).defaultPrevented, false, key);
  }
  page.control.checked = true;
  page.control.emit('change');
  assert.equal(page.get('filterStatus').textContent, 'ブロック中');
  assert.equal(page.get('filterStatus').classList.contains('bg-danger'), true);
  assert.equal(page.key('Tab').defaultPrevented, true);
});

test('blocking leaves keyboard activation of the switch and capture controls available', () => {
  const page = loadInspector();
  assert.equal(page.key(' ', 'Space', { target: page.control }).defaultPrevented, false);
  assert.equal(page.key('Enter', 'Enter', { target: page.get('captureNormal') }).defaultPrevented, false);
});

test('copy shortcuts in the log leave its contents unchanged through every keyboard phase', () => {
  const page = loadInspector();
  const log = page.get('logContainer');
  log.value = 'Existing event log';
  for (const type of ['keydown', 'keypress', 'keyup']) {
    for (const key of ['Control', 'a', 'c']) {
      const event = page.key(key, key, { type, target: log, ctrlKey: true });
      assert.equal(event.defaultPrevented, false);
      assert.equal(log.value, 'Existing event log', `${type}: ${key}`);
    }
  }
  page.key('a', 'KeyA');
  assert.match(log.value, /keydown \(0\): key="a"/);
});

test('log navigation is available while special-key blocking is ON', () => {
  const page = loadInspector();
  const log = page.get('logContainer');
  log.value = 'Existing event log';
  for (const key of ['Tab', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
    assert.equal(page.key(key, key, { target: log }).defaultPrevented, false, key);
  }
  assert.equal(log.value, 'Existing event log');
  assert.equal(page.key('Tab').defaultPrevented, true);
});

function compareInputs(page, normal = ['F2', 'F2'], fn = ['AudioVolumeDown', 'AudioVolumeDown']) {
  page.click('captureNormal');
  page.key(...normal);
  page.click('captureFn');
  page.key(...fn);
}

test('Fn comparison exposes changed input in the Fn status without claiming direct detection', () => {
  const page = loadInspector();
  compareInputs(page);
  assert.equal(page.get('compareMessage').dataset.result, 'changed');
  assert.equal(page.get('fnStatus').dataset.comparison, 'changed');
  assert.match(page.get('fnStatus').textContent, /比較/);
  assert.equal(page.get('fnStatus').dataset.seen, undefined);
});

test('starting a new comparison and resetting discard the previous comparison indication', () => {
  const page = loadInspector();
  compareInputs(page);
  page.click('captureNormal');
  assert.notEqual(page.get('fnStatus').dataset.comparison, 'changed');
  page.key('F2');
  page.click('captureFn');
  page.key('Home');
  assert.equal(page.get('fnStatus').dataset.comparison, 'changed');
  page.click('resetFn');
  assert.notEqual(page.get('fnStatus').dataset.comparison, 'changed');
  assert.equal(page.get('fnStatus').dataset.seen, undefined);
  assert.equal(page.get('normalSample').textContent, '未記録');
});

test('direct Fn notification takes precedence over comparison and remains through recapture', () => {
  const page = loadInspector();
  compareInputs(page);
  page.key('Fn');
  assert.equal(page.get('fnStatus').dataset.seen, 'true');
  assert.notEqual(page.get('fnStatus').dataset.comparison, 'changed');
  assert.match(page.get('fnEvidence').textContent, /キー通知/);
  page.click('captureNormal');
  assert.equal(page.get('fnStatus').dataset.seen, 'true');
});

test('ordinary function keys and synthetic Fn events do not establish Fn detection', () => {
  const page = loadInspector();
  page.key('F2');
  page.key('AudioVolumeDown');
  page.key('Fn', 'Fn', { isTrusted: false });
  assert.equal(page.get('fnStatus').dataset.seen, undefined);
  page.click('captureNormal');
  page.key('F2', 'F2', { isTrusted: false });
  assert.equal(page.get('normalSample').textContent, '未記録');
});

test('modifier-state notifications are detected independently for Fn and FnLock', () => {
  const page = loadInspector();
  page.key('F2', 'F2', { getModifierState: name => name === 'Fn' });
  assert.equal(page.get('fnStatus').dataset.seen, 'true');
  assert.equal(page.get('fnLockStatus').dataset.seen, undefined);
  page.key('FnLock');
  assert.equal(page.get('fnLockStatus').dataset.seen, 'true');
});

test('identical input and timeouts never claim a changed or detected Fn', () => {
  const page = loadInspector();
  compareInputs(page, ['F2', 'F2'], ['F2', 'F2']);
  assert.equal(page.get('compareMessage').dataset.result, 'same');
  assert.notEqual(page.get('fnStatus').dataset.comparison, 'changed');
  assert.equal(page.get('fnStatus').dataset.seen, undefined);
  page.click('captureFn');
  page.expire();
  assert.equal(page.get('compareMessage').dataset.result, 'unknown');
  assert.notEqual(page.get('fnStatus').dataset.comparison, 'changed');
});

test('keyup-only inputs remain comparable and focus loss cancels capture', () => {
  const page = loadInspector();
  page.click('captureNormal');
  page.key('PrintScreen', 'PrintScreen', { type: 'keyup' });
  assert.match(page.get('normalSample').textContent, /PrintScreen/);
  page.click('captureFn');
  page.blur();
  assert.equal(page.get('compareMessage').dataset.result, 'cancelled');
  page.expire();
  assert.equal(page.get('compareMessage').dataset.result, 'cancelled');
});
