/**
 * The browser client (src/web/app.js) run for real in jsdom, against a scripted
 * server: the composer limit, draft restore after a failed send, IME Enter, the
 * per-tab session, and a duplicated tab forking its session. No network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

const HTML = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8').replace(/<script[^>]*src="\.\/app\.js"[^>]*><\/script>/, '');
const APP = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
const SESSION_KEY = 'scent-sommelier.sessionId';

type Handler = (path: string, body: Record<string, unknown> | undefined) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>;

/**
 * Every channel and window a page opened, closed after the suite. An open jsdom window keeps its
 * timers (app.js's 10 s health-check abort) alive, which would hold the test process open.
 */
const channels: BroadcastChannel[] = [];
const windows: Array<{ close(): void }> = [];
class TestChannel extends BroadcastChannel {
  constructor(name: string) {
    super(name);
    channels.push(this);
  }
}
after(() => {
  for (const c of channels) c.close();
  for (const w of windows) w.close();
});

const reply = (sessionId: string, text = 'Here are some ideas.') => ({
  json: { sessionId, mode: 'mock', reply: { text, recommendations: [], followUps: [] } },
});

/** Loads the page with `handler` answering /api/* and, optionally, a session id already in this tab's storage. */
function openPage(handler: Handler, sessionId?: string) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  const w = dom.window as unknown as Window & typeof globalThis & { eval(src: string): unknown };
  windows.push(dom.window);
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  Object.assign(w, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    scrollTo: () => {},
    BroadcastChannel: TestChannel,
    fetch: async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://localhost/').pathname;
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ path, body });
      if (path === '/api/health') return new Response(JSON.stringify({ ok: true, mode: 'mock', catalog: { source: 'seed', count: 186 } }));
      const r = await handler(path, body);
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    },
  });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  if (sessionId) w.sessionStorage.setItem(SESSION_KEY, sessionId);
  w.eval(APP);
  const $ = <T extends Element>(sel: string) => w.document.querySelector(sel) as unknown as T;
  const input = $<HTMLTextAreaElement>('#message');
  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  const press = (init: KeyboardEventInit) => input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
  const chats = () => calls.filter((c) => c.path === '/api/chat');
  return { w, $, input, type, press, calls, chats };
}

/** Lets the page's promises and timers run. */
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('web UI: composer', () => {
  it('shows the count near the 1,000-character limit and will not send past it', async () => {
    const p = openPage(() => reply('s1'));
    const count = p.$<HTMLElement>('#composer-count');
    const send = p.$<HTMLButtonElement>('#send');
    assert.equal(p.input.maxLength, 1000);
    p.type('x'.repeat(200));
    assert.equal(count.hidden, true);
    p.type('x'.repeat(850));
    assert.deepEqual([count.hidden, count.textContent], [false, '850 / 1,000']);
    p.type('x'.repeat(1000));
    assert.equal(count.textContent, '1,000 / 1,000 - limit reached');
    p.type('x'.repeat(1001));
    assert.equal(count.textContent, '1,001 / 1,000 - too long to send');
    assert.equal(send.disabled, true);
    p.press({});
    await settle();
    assert.equal(p.chats().length, 0);
  });

  it('Enter that confirms an IME conversion does not send; a plain Enter does', async () => {
    const p = openPage(() => reply('s1'));
    p.type('こんにちは');
    p.press({ isComposing: true });
    p.press({ keyCode: 229 });
    p.press({ shiftKey: true });
    await settle();
    assert.equal(p.chats().length, 0);
    p.press({});
    await settle(300);
    assert.equal(p.chats().length, 1);
    assert.equal(p.chats()[0]!.body!.message, 'こんにちは');
  });

  it('a refused message goes back in the box to edit, and leaves no bubble behind', async () => {
    const p = openPage(() => ({ status: 400, json: { error: 'message is too long (max 1000 characters)' } }));
    p.type('a perfume for my wife');
    p.press({});
    await settle(300);
    assert.equal(p.input.value, 'a perfume for my wife');
    assert.equal(p.w.document.querySelectorAll('.msg-user').length, 0);
    assert.match(p.$<HTMLElement>('.error-note').textContent ?? '', /Your message is back in the box below to edit/);
  });

  it('a failed send keeps the bubble with a retry and the draft; the retry takes the draft back', async () => {
    let fail = true;
    const p = openPage(() => (fail ? { status: 503, json: { error: 'Jev is busy right now' } } : reply('s1')));
    p.type('something woody');
    p.press({});
    await settle(300);
    assert.ok(p.$('.msg-user.failed'));
    assert.equal(p.input.value, 'something woody');
    fail = false;
    (p.$<HTMLButtonElement>('.error-note button')).click();
    await settle(300);
    assert.equal(p.w.document.querySelectorAll('.msg-user').length, 1, 'the retry reuses the bubble');
    assert.equal(p.input.value, '', 'the retried draft is taken back');
  });
});

describe('web UI: sessions per tab', () => {
  it('keeps the session id in this tab only, and sends it with the next message', async () => {
    const a = openPage(() => reply('sess-aaaa-1111'));
    a.type('party perfume');
    a.press({});
    await settle(300);
    assert.equal(a.w.sessionStorage.getItem(SESSION_KEY), 'sess-aaaa-1111');
    a.type('something cheaper');
    a.press({});
    await settle(300);
    assert.equal(a.chats()[1]!.body!.sessionId, 'sess-aaaa-1111');
    // A new tab has its own storage: it starts its own conversation.
    const b = openPage(() => reply('sess-bbbb-2222'));
    b.type('hello');
    b.press({});
    await settle(300);
    assert.equal(b.chats()[0]!.body!.sessionId, undefined);
  });

  it('a duplicated tab forks the session instead of sharing it; a lone reload keeps it', async () => {
    const original = openPage(() => reply('sess-orig-0001'), 'sess-orig-0001');
    await settle(400); // its own "who has it?" goes unanswered, so it keeps the id
    assert.equal(original.calls.filter((c) => c.path === '/api/fork').length, 0);

    const copy = openPage((path, body) => (path === '/api/fork'
      ? { json: { sessionId: 'sess-fork-0002' } }
      : reply(String(body?.sessionId ?? 'new'))), 'sess-orig-0001');
    await settle(400);
    assert.deepEqual(copy.calls.find((c) => c.path === '/api/fork')?.body, { sessionId: 'sess-orig-0001' });
    assert.equal(copy.w.sessionStorage.getItem(SESSION_KEY), 'sess-fork-0002');
    copy.type('why is #1 the top pick?');
    copy.press({});
    await settle(300);
    assert.equal(copy.chats()[0]!.body!.sessionId, 'sess-fork-0002', 'the copy never drives the original conversation');
    assert.equal(original.w.sessionStorage.getItem(SESSION_KEY), 'sess-orig-0001');
  });
});
