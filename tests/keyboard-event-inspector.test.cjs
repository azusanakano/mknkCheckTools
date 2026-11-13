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
  const now = new Date(2026, 10, 13, 8, 5, 9, 7).getTime();
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    document, window, Element, HTMLElement: Element, console, Blob, Date: FixedDate,
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
  assert.match(log.value, /^#1 \[2026-11-13 08:05:09\.007\] 押下 \(keydown\)\r\n  キー: "a"/);
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

test('function key logs explain the action and retain diagnostic properties', () => {
  const page = loadInspector();
  const log = page.get('logContainer');
  page.key('F2', 'F2', { repeat: true, keyCode: 113, which: 113, shiftKey: true });
  assert.equal(page.get('downKey').textContent, 'F2');
  assert.equal(page.get('downCode').textContent, 'F2');
  assert.equal(log.value,
    '#1 [2026-11-13 08:05:09.007] 押下 (keydown)\r\n' +
    '  キー: "F2" | 物理キー (code): "F2" | 位置: 標準 (0)\r\n' +
    '  修飾キー: Shift | 長押し反復: あり\r\n' +
    '  発生元: ブラウザー (isTrusted=true) | keyCode=113 | which=113');
});

test('event blocks are newest first, include every phase, and restart numbering after clear', () => {
  const page = loadInspector();
  const log = page.get('logContainer');
  page.key('a', 'KeyA');
  page.key('a', 'KeyA', { type: 'keypress' });
  page.key('a', 'KeyA', { type: 'keyup' });
  const blocks = log.value.split('\r\n\r\n');
  assert.equal(blocks.length, 3);
  assert.match(blocks[0], /^#3 \[2026-11-13 08:05:09\.007\] 解放 \(keyup\)/);
  assert.match(blocks[1], /^#2 \[2026-11-13 08:05:09\.007\] 文字キー \(keypress\)/);
  assert.match(blocks[2], /^#1 \[2026-11-13 08:05:09\.007\] 押下 \(keydown\)/);
  assert.match(blocks[2], /修飾キー: なし \| 長押し反復: なし/);
  page.click('clearLog');
  assert.equal(log.value, '');
  page.key('PrintScreen', 'PrintScreen', { type: 'keyup' });
  assert.match(log.value, /^#1 \[2026-11-13 08:05:09\.007\] 解放 \(keyup\)/);
  assert.match(log.value, /キー: "PrintScreen"/);
});

test('logs distinguish key locations, active modifiers, and synthetic events', () => {
  const page = loadInspector();
  for (const [location, label] of [[0, '標準'], [1, '左'], [2, '右'], [3, 'テンキー'], [9, '不明']]) {
    page.click('clearLog');
    page.key('Enter', 'NumpadEnter', {
      location, ctrlKey: true, altKey: true, metaKey: true, isTrusted: false
    });
    const log = page.get('logContainer').value;
    assert.ok(log.includes(`位置: ${label} (${location})`));
    assert.match(log, /修飾キー: Ctrl \+ Alt \+ Meta \| 長押し反復: なし/);
    assert.match(log, /発生元: スクリプト \(isTrusted=false\) \| keyCode=0 \| which=0/);
  }
});

test('space and missing keys are readable and control characters cannot split event blocks', () => {
  const page = loadInspector();
  const log = page.get('logContainer');
  page.key(' ', 'Space');
  assert.match(log.value, /キー: スペース \(" "\) \| 物理キー \(code\): "Space"/);
  page.click('clearLog');
  page.key(null, null, { location: undefined });
  assert.match(log.value, /キー: 未取得 \(""\) \| 物理キー \(code\): "" \| 位置: 標準 \(0\)/);
  page.click('clearLog');
  page.key('"\r\n\t\\', 'Key"\n\\', { isTrusted: false });
  assert.equal(log.value.split('\r\n').length, 4);
  assert.ok(log.value.includes('キー: "\\\"\\r\\n\\t\\\\"'));
  assert.ok(log.value.includes('物理キー (code): "Key\\\"\\n\\\\"'));
});

test('download preserves readable event blocks with a version header, BOM and CRLF', async () => {
  const page = loadInspector();
  const log = page.get('logContainer');
  page.key(' ', 'Space');
  page.key(' ', 'Space', { type: 'keyup' });
  const expectedLog = log.value;
  // Browsers normalize textarea values to LF; the download restores CRLF.
  log.value = log.value.replace(/\r\n/g, '\n');
  page.click('downloadLog');
  const bytes = new Uint8Array(await page.downloadedLog().arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /^# mknkCheckTools v\S+ \/ Keyboard v\S+\r\n/);
  assert.ok(text.includes('# キーボードイベントログ（最新が上 / 時刻は端末のローカル時刻）\r\n\r\n'));
  assert.ok(text.endsWith(expectedLog));
  assert.doesNotMatch(text, /(?<!\r)\n/);
});
