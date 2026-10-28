const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { renderMarkdown } = require('../dist/render.js');

test('TOC links navigate within the rendered document', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdview-test-'));
  const sourceDir = path.join(dir, 'source');
  fs.mkdirSync(sourceDir);
  const fixture = process.env.MDVIEW_TEST_FILE;
  const file = fixture || path.join(sourceDir, 'doc.md');
  if (!fixture) fs.writeFileSync(file, '[Section](#section)\n\n![Image](image.png)\n\n' + 'Paragraph\n\n'.repeat(100) + '## Section\n');
  const fragment = fixture ? 'overview' : 'section';
  const html = path.join(dir, 'preview.html');
  fs.writeFileSync(html, renderMarkdown(file, {}).html);
  const browser = spawn('chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, pathToFileURL(html).href], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => { browser.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  let stderr = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Chromium did not start: ${stderr}`)), 10000);
    browser.stderr.on('data', (data) => {
      stderr += data;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    browser.on('error', reject);
  });
  const origin = endpoint.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
  const pages = await (await fetch(`${origin}/json`)).json();
  const page = pages.find((entry) => entry.type === 'page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  t.after(() => socket.close());
  let id = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== requestId) return;
      socket.removeEventListener('message', listener);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    };
    socket.addEventListener('message', listener);
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  if (!fixture) {
    const image = await call('Runtime.evaluate', { expression: 'document.querySelector("img").src', returnByValue: true });
    assert.equal(image.result.value, pathToFileURL(path.join(sourceDir, 'image.png')).href);
  }
  await call('Runtime.evaluate', { expression: `document.querySelector('a[href$="#${fragment}"]').click()` });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const result = await call('Runtime.evaluate', { expression: `({url: location.href, scroll: scrollY, heading: !!document.getElementById("${fragment}")})`, returnByValue: true });
  assert.equal(result.result.value.url, `${pathToFileURL(html).href}#${fragment}`);
  assert.equal(result.result.value.heading, true);
  assert.ok(result.result.value.scroll > 0);
});
