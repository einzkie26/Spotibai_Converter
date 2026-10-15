'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.className = ''; this.children = [];
    this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map();
    this.textContent = ''; this.value = ''; this.hidden = false;
    this.paused = true; this.ended = false; this.currentTime = 0; this.duration = 7;
    this.playedSources = [];
    const change = (name, on) => {
      const classes = new Set(this.className.split(' ').filter(Boolean));
      on ? classes.add(name) : classes.delete(name); this.className = [...classes].join(' ');
    };
    this.classList = { add: name => change(name, true), remove: name => change(name, false),
      toggle: (name, on) => change(name, on), contains: name => this.className.split(' ').includes(name) };
  }
  append(...elements) { for (const element of elements) { element.parent = this; this.children.push(element); } }
  replaceChildren(...elements) { this.children.forEach(element => { element.parent = null; }); this.children = []; this.append(...elements); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(element => element !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  closest(selector) {
    if (selector.startsWith('.') && this.classList.contains(selector.slice(1))) return this;
    return this.parent?.closest(selector) || null;
  }
  focus() { this.focused = true; }
  async play() { this.paused = false; this.ended = false; this.playedSources.push(this.src); this.listeners.get('play')?.(); }
  pause() { this.paused = true; this.listeners.get('pause')?.(); }
  load() { this.currentTime = 0; this.ended = false; }
  querySelectorAll(selector) {
    const result = [];
    const visit = element => {
      if (selector.startsWith('.') && element.classList.contains(selector.slice(1))) result.push(element);
      element.children.forEach(visit);
    };
    this.children.forEach(visit); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function page(files, fetcher) {
  const elements = new Map(); const requests = []; const events = []; const clicks = [];
  const timers = new Map(); const revoked = []; const documentListeners = new Map(); let serial = 0;
  const body = new Element('body');
  const document = { body, documentElement: new Element('html'),
    querySelector(selector) {
      if (!elements.has(selector)) { const element = new Element(); elements.set(selector, element); body.append(element); }
      return elements.get(selector);
    },
    querySelectorAll: selector => body.querySelectorAll(selector),
    addEventListener(name, callback) { documentListeners.set(name, callback); },
    createElement(tag) { const element = new Element(tag); element.click = () => clicks.push(element); return element; },
  };
  const theme = document.querySelector('#theme-toggle');
  const icon = new Element('span'); icon.className = 'theme-icon';
  const label = new Element('span'); label.className = 'theme-label'; theme.append(icon, label);
  const context = vm.createContext({ document, Blob, ReadableStream, AbortController, Date, console,
    localStorage: { getItem() { return null; }, setItem() {} }, matchMedia: () => ({ matches: false }),
    URL: { createObjectURL: () => `blob:${++serial}`, revokeObjectURL: value => revoked.push(value) },
    setInterval(callback, delay) { const id = ++serial; timers.set(id, { callback, delay, type: 'interval' }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay, type: 'timeout' }); return id; },
    clearTimeout(id) { timers.delete(id); },
    EventSource: class {
      constructor(url) { this.url = url; events.push(this); }
      close() { this.closed = true; }
    },
    async fetch(url, options) { requests.push({ url, options }); return fetcher(url, options); },
  });
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', file), 'utf8'), context);
  return { context, body, elements, requests, events, clicks, timers, revoked, documentListeners,
    find: selector => body.querySelector(selector) };
}

module.exports = { page };
