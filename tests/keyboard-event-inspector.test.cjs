const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Run the shipped inline scripts. Only browser DOM/event delivery is substituted;
// key interpretation, filtering, logging, and status updates use production code.
function loadInspector(initialTime = new Date(2026, 10, 13, 8, 5, 9, 7).getTime()) {
  const html = fs.readFileSync(path.join(__dirname, '../tools/keyboard_event_inspector_local.html'), 'utf8');
  class Element {
    constructor(tagName, attributes = '', text = '') {
      this.nodeName = tagName.toUpperCase();
      this.childNodes = [];
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
    get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
    set textContent(text) {
      this.childNodes = String(text) ? [{ textContent: String(text) }] : [];
    }
    get firstChild() { return this.childNodes[0] || null; }
    get children() { return this.childNodes.filter(node => node instanceof Element); }
    append(...nodes) {
      for (const node of nodes) {
        const child = typeof node === 'string' ? { textContent: node } : node;
        child.parentElement = this;
        this.childNodes.push(child);
      }
    }
    prepend(...nodes) {
      const previous = this.childNodes;
      this.childNodes = [];
      this.append(...nodes);
      this.childNodes.push(...previous);
    }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    get value() { return this._value; }
    set value(value) {
      const text = String(value);
      this._value = this.nodeName === 'TEXTAREA' ? text.replace(/\r\n?/g, '\n') : text;
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
  let selectedNode;
  window.getSelection = () => ({ selectAllChildren(node) { selectedNode = node; } });
  let downloadedLog;
  let now = initialTime;
  let nextTimer = 0;
  const timers = new Map();
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
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
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
    downloadedLog: () => downloadedLog,
    selectedText: () => selectedNode?.textContent || '',
    advanceTime(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    }
  };
}

test('only Key values are highlighted for 500 ms after each event phase', () => {
  const page = loadInspector();
  for (const [type, phase] of [['keydown', 'down'], ['keypress', 'press'], ['keyup', 'up']]) {
    page.key('a', 'KeyA', { type });
    assert.equal(page.get(`${phase}Key`).classList.contains('key-highlight'), true);
    for (const id of [`${phase}Code`, `${phase}Shift`, `${phase}Ctrl`, 'charCell', 'targetCell']) {
      assert.equal(page.get(id).classList.contains('key-highlight'), false, id);
    }
    page.advanceTime(499);
    assert.equal(page.get(`${phase}Key`).classList.contains('key-highlight'), true);
    page.advanceTime(1);
    assert.equal(page.get(`${phase}Key`).classList.contains('key-highlight'), false);
    assert.equal(page.get(`${phase}Key`).textContent, 'a');
  }
});

test('rapid input restarts the Key highlight without an old timer ending it early', () => {
  const page = loadInspector();
  page.key('a', 'KeyA');
  page.key('a', 'KeyA', { type: 'keypress' });
  page.advanceTime(400);
  page.key('b', 'KeyB');
  assert.equal(page.get('pressKey').textContent, '—');
  assert.equal(page.get('pressKey').classList.contains('key-highlight'), false);
  page.advanceTime(100);
  assert.equal(page.get('downKey').textContent, 'b');
  assert.equal(page.get('downKey').classList.contains('key-highlight'), true);
  page.advanceTime(400);
  assert.equal(page.get('downKey').classList.contains('key-highlight'), false);
});

test('log highlights only each new key value and expires entries independently', () => {
  const page = loadInspector();
  const log = page.get('logContainer');
  page.key('<img src=x>', 'KeyA');
  const firstKey = log.firstChild?.children?.find(node => node.classList.contains('log-key'));
  assert.ok(firstKey, 'The key has a separately styled text span');
  assert.equal(firstKey.textContent, '"<img src=x>"');
  assert.equal(firstKey.children.length, 0, 'Key text is never parsed as HTML');
  assert.equal(firstKey.classList.contains('key-highlight'), true);
  assert.equal(log.firstChild.classList.contains('key-highlight'), false);
  page.advanceTime(400);
  page.key('b', 'KeyB', { type: 'keyup' });
  const nextKey = log.firstChild.children.find(node => node.classList.contains('log-key'));
  page.advanceTime(99);
  assert.equal(firstKey.classList.contains('key-highlight'), true);
  page.advanceTime(1);
  assert.equal(firstKey.classList.contains('key-highlight'), false);
  assert.equal(nextKey.classList.contains('key-highlight'), true);
  page.advanceTime(400);
  assert.equal(nextKey.classList.contains('key-highlight'), false);
  assert.equal(log.textContent.split('\n\n').length, 2);
});

test('clearing highlighted logs cannot affect a new entry when old timers expire', () => {
  const page = loadInspector();
  page.key('a', 'KeyA');
  page.advanceTime(400);
  page.click('clearLog');
  assert.equal(page.get('logContainer').textContent, '');
  page.key('b', 'KeyB');
  const entry = page.get('logContainer').firstChild;
  const key = entry?.children?.find(node => node.classList.contains('log-key'));
  assert.ok(key);
  page.advanceTime(100);
  assert.equal(key.classList.contains('key-highlight'), true);
  assert.match(page.get('logContainer').textContent, /^#1 .*\n  キー: "b"/);
  page.advanceTime(400);
  assert.equal(key.classList.contains('key-highlight'), false);
  assert.equal(page.get('logContainer').children.length, 1);
});

test('select all is scoped to the rich log and descendant key events are never recorded', () => {
  const page = loadInspector();
  page.key('a', 'KeyA');
  const log = page.get('logContainer');
  const before = log.textContent;
  const keySpan = log.firstChild?.children?.[0];
  assert.ok(keySpan);
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
    assert.equal(page.key('a', 'KeyA', { target: log, ...modifiers }).defaultPrevented, true);
    assert.equal(page.selectedText(), before);
  }
  for (const type of ['keydown', 'keypress', 'keyup']) {
    assert.equal(page.key('c', 'KeyC', { type, target: keySpan, ctrlKey: true }).defaultPrevented, false);
    assert.equal(log.textContent, before);
  }
});

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
  log.textContent = 'Existing event log';
  for (const type of ['keydown', 'keypress', 'keyup']) {
    for (const key of ['Control', 'a', 'c']) {
      const event = page.key(key, key, { type, target: log, ctrlKey: true });
      assert.equal(event.defaultPrevented, type === 'keydown' && key === 'a');
      assert.equal(log.textContent, 'Existing event log', `${type}: ${key}`);
    }
  }
  page.key('a', 'KeyA');
  assert.match(log.textContent, /^#1 \[2026-11-13 08:05:09\.007\] 押下 \(keydown\)\n  キー: "a"/);
});

test('log navigation is available while special-key blocking is ON', () => {
  const page = loadInspector();
  const log = page.get('logContainer');
  log.textContent = 'Existing event log';
  for (const key of ['Tab', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
    assert.equal(page.key(key, key, { target: log }).defaultPrevented, false, key);
  }
  assert.equal(log.textContent, 'Existing event log');
  assert.equal(page.key('Tab').defaultPrevented, true);
});

test('function key logs explain the action and retain diagnostic properties', () => {
  const page = loadInspector();
  const log = page.get('logContainer');
  page.key('F2', 'F2', { repeat: true, keyCode: 113, which: 113, shiftKey: true });
  assert.equal(page.get('downKey').textContent, 'F2');
  assert.equal(page.get('downCode').textContent, 'F2');
  assert.equal(log.textContent,
    '#1 [2026-11-13 08:05:09.007] 押下 (keydown)\n' +
    '  キー: "F2" | 物理キー (code): "F2" | 位置: 標準 (0)\n' +
    '  修飾キー: Shift | 長押し反復: あり\n' +
    '  発生元: ブラウザー (isTrusted=true) | keyCode=113 | which=113');
});

test('event blocks are newest first, include every phase, and restart numbering after clear', () => {
  const page = loadInspector();
  const log = page.get('logContainer');
  page.key('a', 'KeyA');
  page.key('a', 'KeyA', { type: 'keypress' });
  page.key('a', 'KeyA', { type: 'keyup' });
  const blocks = log.textContent.split('\n\n');
  assert.equal(blocks.length, 3);
  assert.match(blocks[0], /^#3 \[2026-11-13 08:05:09\.007\] 解放 \(keyup\)/);
  assert.match(blocks[1], /^#2 \[2026-11-13 08:05:09\.007\] キー入力通知 \(keypress\)/);
  assert.match(blocks[2], /^#1 \[2026-11-13 08:05:09\.007\] 押下 \(keydown\)/);
  assert.match(blocks[2], /修飾キー: なし \| 長押し反復: なし/);
  page.click('clearLog');
  assert.equal(log.textContent, '');
  page.key('PrintScreen', 'PrintScreen', { type: 'keyup' });
  assert.match(log.textContent, /^#1 \[2026-11-13 08:05:09\.007\] 解放 \(keyup\)/);
  assert.match(log.textContent, /キー: "PrintScreen"/);
});

test('Ctrl+Enter keypress is labelled as an input notification and retains the Enter key', () => {
  const page = loadInspector();
  const event = page.key('Enter', 'Enter', { type: 'keypress', ctrlKey: true, keyCode: 13, which: 13 });
  const log = page.get('logContainer').textContent;
  assert.equal(event.defaultPrevented, false);
  assert.match(log, /^#1 \[2026-11-13 08:05:09\.007\] キー入力通知 \(keypress\)\n/);
  assert.match(log, /キー: "Enter" \| 物理キー \(code\): "Enter"/);
  assert.match(log, /修飾キー: Ctrl \| 長押し反復: なし/);
});

test('each event records the current local time across midnight', () => {
  const page = loadInspector(new Date(2026, 11, 31, 23, 59, 59, 999).getTime());
  page.key('a', 'KeyA');
  page.advanceTime(2);
  page.key('a', 'KeyA', { type: 'keyup' });
  const blocks = page.get('logContainer').textContent.split('\n\n');
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /^#2 \[2027-01-01 00:00:00\.001\] 解放 \(keyup\)/);
  assert.match(blocks[1], /^#1 \[2026-12-31 23:59:59\.999\] 押下 \(keydown\)/);
});

test('logs distinguish key locations, active modifiers, and synthetic events', () => {
  const page = loadInspector();
  for (const [location, label] of [[0, '標準'], [1, '左'], [2, '右'], [3, 'テンキー'], [9, '不明']]) {
    page.click('clearLog');
    page.key('Enter', 'NumpadEnter', {
      location, ctrlKey: true, altKey: true, metaKey: true, isTrusted: false
    });
    const log = page.get('logContainer').textContent;
    assert.ok(log.includes(`位置: ${label} (${location})`));
    assert.match(log, /修飾キー: Ctrl \+ Alt \+ Meta \| 長押し反復: なし/);
    assert.match(log, /発生元: スクリプト \(isTrusted=false\) \| keyCode=0 \| which=0/);
  }
});

test('space and missing keys are readable and control characters cannot split event blocks', () => {
  const page = loadInspector();
  const log = page.get('logContainer');
  page.key(' ', 'Space');
  assert.match(log.textContent, /キー: スペース \(" "\) \| 物理キー \(code\): "Space"/);
  page.click('clearLog');
  page.key(null, null, { location: undefined });
  assert.match(log.textContent, /キー: 未取得 \(""\) \| 物理キー \(code\): "" \| 位置: 標準 \(0\)/);
  page.click('clearLog');
  page.key('"\r\n\t\\', 'Key"\n\\', { isTrusted: false });
  assert.equal(log.textContent.split('\n').length, 4);
  assert.ok(log.textContent.includes('キー: "\\\"\\r\\n\\t\\\\"'));
  assert.ok(log.textContent.includes('物理キー (code): "Key\\\"\\n\\\\"'));
});

test('Unicode line separators stay reversible in four-line event blocks and downloaded logs', async () => {
  const page = loadInspector();
  const key = 'A\u0085B\u2028C\u2029D';
  const code = 'Key\u2029X\u2028Y\u0085Z';
  page.key(key, code, { isTrusted: false });
  const displayed = page.get('logContainer').textContent;
  assert.equal(displayed.split('\n').length, 4);
  assert.doesNotMatch(displayed, /\r|[\u0085\u2028\u2029]/);

  page.click('downloadLog');
  const bytes = new Uint8Array(await page.downloadedLog().arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const downloaded = new TextDecoder().decode(bytes);
  assert.doesNotMatch(downloaded, /(?<!\r)\n|\r(?!\n)|[\u0085\u2028\u2029]/);
  assert.ok(downloaded.endsWith(displayed.replace(/\n/g, '\r\n')));

  for (const text of [displayed, downloaded]) {
    const fields = /^  キー: ("(?:\\.|[^"\\])*") \| 物理キー \(code\): ("(?:\\.|[^"\\])*") \| 位置:/m.exec(text);
    assert.ok(fields, 'Both fields remain complete JSON strings on one line');
    assert.equal(JSON.parse(fields[1]), key);
    assert.equal(JSON.parse(fields[2]), code);
    for (const field of fields.slice(1)) {
      for (const escape of ['\\u0085', '\\u2028', '\\u2029']) {
        assert.ok(field.includes(escape), `Expected reversible escape ${escape}`);
      }
    }
  }
});

test('download preserves readable event blocks with a version header, BOM and CRLF', async () => {
  const page = loadInspector();
  const log = page.get('logContainer');
  page.key(' ', 'Space');
  page.key(' ', 'Space', { type: 'keyup' });
  assert.doesNotMatch(log.textContent, /\r/);
  const expectedLog = log.textContent.replace(/\n/g, '\r\n');
  page.click('downloadLog');
  const bytes = new Uint8Array(await page.downloadedLog().arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /^# mknkCheckTools v\S+ \/ Keyboard v\S+\r\n/);
  assert.match(text, /^# Log format: 2\r$/m);
  assert.ok(text.includes('# キーボードイベントログ（最新が上 / 記録時刻は端末のローカル時刻）\r\n\r\n'));
  assert.ok(text.endsWith(expectedLog));
  assert.doesNotMatch(text, /(?<!\r)\n|\r(?!\n)/);
});
