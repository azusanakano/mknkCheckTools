"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../tools/mknk-lcd-tester.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Run the production inline script; only the DOM/event surface it uses is stubbed.
function createTester() {
  class Element {
    constructor(tagName = "div", parentElement = null) {
      this.tagName = tagName.toUpperCase();
      this.parentElement = parentElement;
      this.dataset = {};
      this.style = {};
      this.textContent = "";
      this.listeners = new Map();
      this.classes = new Set();
      this.classList = {
        add: name => this.classes.add(name),
        remove: name => this.classes.delete(name),
        contains: name => this.classes.has(name),
        toggle: (name, force) => {
          const enabled = force === undefined ? !this.classes.has(name) : force;
          if (enabled) this.classes.add(name);
          else this.classes.delete(name);
          return enabled;
        }
      };
    }
    get className() { return [...this.classes].join(" "); }
    set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    closest(selector) {
      for (let element = this; element; element = element.parentElement) {
        if (selector === "button" && element.tagName === "BUTTON") return element;
        if (selector === ".package-menu" && element.classes.has("package-menu")) return element;
      }
      return null;
    }
  }

  const ids = Object.fromEntries(
    ["stage", "modeName", "centerLabel", "autoBtn", "fullBtn", "resolution", "help", "hud"]
      .map(id => [id, new Element(id.endsWith("Btn") ? "button" : "div")])
  );
  const modeButtons = [...html.matchAll(/<button data-index="(\d+)"/g)].map(match => {
    const button = new Element("button");
    button.dataset.index = match[1];
    return button;
  });
  const document = {
    body: new Element("body"),
    documentElement: new Element("html"),
    fullscreenElement: null,
    listeners: new Map(),
    getElementById: id => ids[id],
    querySelectorAll: selector => {
      assert.equal(selector, "[data-index]");
      return modeButtons;
    },
    addEventListener: Element.prototype.addEventListener
  };
  const window = {
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    listeners: new Map(),
    addEventListener: Element.prototype.addEventListener
  };
  const timers = new Map();
  let timerId = 0;
  let fullscreenRequests = 0;
  let fullscreenExits = 0;
  const fullscreenChanged = () => {
    for (const listener of document.listeners.get("fullscreenchange") || []) listener();
  };
  document.documentElement.requestFullscreen = () => {
    fullscreenRequests++;
    document.fullscreenElement = document.documentElement;
    fullscreenChanged();
    return Promise.resolve();
  };
  document.exitFullscreen = () => {
    fullscreenExits++;
    document.fullscreenElement = null;
    fullscreenChanged();
    return Promise.resolve();
  };
  vm.runInNewContext(script, {
    document,
    window,
    Element,
    setInterval: callback => { timers.set(++timerId, callback); return timerId; },
    clearInterval: id => timers.delete(id),
    alert: message => assert.fail(message)
  }, { filename: "mknk-lcd-tester.html" });

  return {
    ids, modeButtons, document, timers,
    childOf: parent => new Element("span", parent),
    packageMenu: () => {
      const link = new Element("a");
      link.classList.add("package-menu");
      return link;
    },
    get fullscreenRequests() { return fullscreenRequests; },
    get fullscreenExits() { return fullscreenExits; },
    key(key, target = ids.stage) {
      const event = { key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const listener of window.listeners.get("keydown") || []) listener(event);
      return event;
    }
  };
}

for (const key of ["Enter", " "]) {
  test(`${JSON.stringify(key)} preserves activation on every toolbar button and its descendants`, () => {
    const tester = createTester();
    const buttons = [...tester.modeButtons, tester.ids.autoBtn, tester.ids.fullBtn];
    assert.equal(buttons.length, 10);
    for (const button of buttons) {
      for (const target of [button, tester.childOf(button)]) {
        const event = tester.key(key, target);
        // Native default activation belongs to the browser; this stub does not synthesize clicks.
        assert.deepEqual({
          defaultPrevented: event.defaultPrevented,
          modeName: tester.ids.modeName.textContent
        }, {
          defaultPrevented: false,
          modeName: "黒 / BLACK"
        }, "allow native activation without advancing through the global shortcut");
        assert.equal(tester.timers.size, 0);
        assert.equal(tester.fullscreenRequests, 0);
      }
    }
  });
}

test("stage and body retain Enter, Space, and arrow navigation", () => {
  const tester = createTester();
  assert.equal(tester.key("ArrowLeft").defaultPrevented, true);
  assert.equal(tester.ids.modeName.textContent, "シマシマ確認 / STRIPES");
  assert.equal(tester.key("ArrowRight").defaultPrevented, true);
  assert.equal(tester.ids.modeName.textContent, "黒 / BLACK");
  assert.equal(tester.key("Enter").defaultPrevented, true);
  assert.equal(tester.ids.modeName.textContent, "白 / WHITE");
  assert.equal(tester.key(" ", tester.document.body).defaultPrevented, true);
  assert.equal(tester.ids.modeName.textContent, "赤 / RED");
});

test("focused toolbar buttons retain the other global shortcuts", () => {
  const tester = createTester();
  const target = tester.ids.autoBtn;
  assert.equal(tester.key("ArrowRight", target).defaultPrevented, true);
  assert.equal(tester.ids.modeName.textContent, "白 / WHITE");
  assert.equal(tester.key("ArrowLeft", target).defaultPrevented, true);
  assert.equal(tester.ids.modeName.textContent, "黒 / BLACK");
  for (const [key, name] of [
    ["1", "黒 / BLACK"], ["2", "白 / WHITE"], ["3", "赤 / RED"],
    ["4", "緑 / GREEN"], ["5", "青 / BLUE"], ["6", "黄変チェック / YELLOWING"],
    ["M", "ムラ確認 / MURA"], ["S", "シマシマ確認 / STRIPES"]
  ]) {
    assert.equal(tester.key(key, target).defaultPrevented, false);
    assert.equal(tester.ids.modeName.textContent, name);
  }
  tester.key("A", target);
  assert.equal(tester.timers.size, 1);
  tester.key("Escape", target);
  assert.equal(tester.timers.size, 0);
  tester.key("H", target);
  assert.equal(tester.document.body.classList.contains("hidden-ui"), true);
  tester.key("h", target);
  assert.equal(tester.document.body.classList.contains("hidden-ui"), false);
  assert.equal(tester.key("F", target).defaultPrevented, true);
  assert.equal(tester.fullscreenRequests, 1);
  assert.equal(tester.key("f", target).defaultPrevented, true);
  assert.equal(tester.fullscreenExits, 1);
});

test("package-menu links and their descendants remain excluded from all shortcuts", () => {
  const tester = createTester();
  const link = tester.packageMenu();
  for (const target of [link, tester.childOf(link)]) {
    for (const key of ["Enter", " ", "ArrowLeft", "ArrowRight", "1", "6", "M", "S", "A", "H", "F", "Escape"]) {
      assert.equal(tester.key(key, target).defaultPrevented, false);
      assert.equal(tester.ids.modeName.textContent, "黒 / BLACK");
      assert.equal(tester.timers.size, 0);
      assert.equal(tester.fullscreenRequests, 0);
      assert.equal(tester.document.body.classList.contains("hidden-ui"), false);
    }
  }
});
