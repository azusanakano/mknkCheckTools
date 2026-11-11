const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Run the shipped inline scripts. Only browser DOM/event delivery is substituted;
// key interpretation, filtering, logging, and status updates use production code.
function loadInspector() {
  const html = fs.readFileSync(path.join(__dirname, '../tools/keyboard_event_inspector_local.html'), 'utf8');
  class Element {
    constructor(tagName, attributes = '', text = '') {
      this.nodeName = tagName.toUpperCase();
      this.textContent = text;
      this.value = '';
      this.checked = /\bchecked\b/.test(attributes);
      this.type = /\btype="([^"]+)"/.exec(attributes)?.[1] || '';
      this.listeners = {};
      const classes = new Set((/\bclass="([^"]+)"/.exec(attributes)?.[1] || '').split(/\s+/));
      this.classList = {
        contains: name => classes.has(name),
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
      };
    }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    emit(type, event = {}) { for (const callback of this.listeners[type] || []) callback(event); }
    closest(selector) {
      if (selector === '.package-nav') return null;
      return this.nodeName === 'BUTTON' || this.type === 'checkbox' ? this : null;
    }
    click() { this.emit('click'); }
  }
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>([^<]*)/gi)) {
    elements.set(match[3], new Element(match[1], match[2], match[4]));
  }
  const document = {
    getElementById: id => elements.get(id),
    createElement: tagName => new Element(tagName)
  };
  const window = new Element('window');
  let downloadedLog;
  const context = vm.createContext({
    document, window, Element, HTMLElement: Element, console, Blob,
    URL: {
      createObjectURL(blob) { downloadedLog = blob; return 'blob:keyboard-log'; },
      revokeObjectURL() {}
    },
    setTimeout() {}
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
        isTrusted: true,
        shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        target: get('inputArea'), defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {}, stopImmediatePropagation() {},
        ...options
      };
      window.emit(event.type, event);
      return event;
    },
    click: id => get(id).click(),
    downloadedLog: () => downloadedLog
  };
}

test('blocking starts ON and suppresses special keys without suppressing printable keys', () => {
  const page = loadInspector();
  assert.equal(page.control.checked, true);
  assert.equal(page.get('filterStatus').textContent, 'ブロック中');
  for (const key of ['Tab', 'Enter', 'Backspace', 'PrintScreen', 'KanaMode', 'Convert', 'F2']) {
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
  for (const key of ['Tab', 'Enter', 'Backspace', 'PrintScreen', 'KanaMode', 'Convert', 'F2']) {
    assert.equal(page.key(key).defaultPrevented, false, key);
  }
  page.control.checked = true;
  page.control.emit('change');
  assert.equal(page.get('filterStatus').textContent, 'ブロック中');
  assert.equal(page.get('filterStatus').classList.contains('bg-danger'), true);
  assert.equal(page.key('Tab').defaultPrevented, true);
});

test('blocking leaves keyboard activation of the switch and log controls available', () => {
  const page = loadInspector();
  assert.equal(page.key(' ', 'Space', { target: page.control }).defaultPrevented, false);
  assert.equal(page.key('Enter', 'Enter', { target: page.get('downloadLog') }).defaultPrevented, false);
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

test('function keys are logged using general event properties', () => {
  const page = loadInspector();
  const log = page.get('logContainer');
  page.key('F2', 'F2', { repeat: true, keyCode: 113, which: 113, shiftKey: true });
  assert.equal(page.get('downKey').textContent, 'F2');
  assert.equal(page.get('downCode').textContent, 'F2');
  assert.equal(log.value,
    'keydown (0): key="F2" code="F2" location=0 repeat=true keyCode=113 which=113 shift=true ctrl=false alt=false meta=false isTrusted=true');
});

test('downloaded log contains a version header and event lines with Windows line endings', async () => {
  const page = loadInspector();
  const log = page.get('logContainer');
  log.value = 'First event\nSecond event';
  page.click('downloadLog');
  const bytes = new Uint8Array(await page.downloadedLog().arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(new TextDecoder().decode(bytes),
    /^# mknkCheckTools v\S+ \/ Keyboard v\S+\r\nFirst event\r\nSecond event$/);
});
