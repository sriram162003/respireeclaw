// browser_extension_control skill
// Sends commands to the Gary Browser Control Chrome extension via the REST API.
// The extension connects to ws://localhost:3002/webextension and forwards
// commands to the active browser tab.

import fs from 'fs';
import path from 'path';
import os from 'os';

const REST_BASE    = 'http://localhost:3002';
const SCREENSHOTS  = path.join(os.homedir(), '.aura', 'workspace', 'ext_screenshots');


async function extCmd(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`${REST_BASE}/api/extension/command`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
    body:    JSON.stringify({ command, ...args }),
  });
  const data = await res.json() as { success?: boolean; result?: unknown; error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.result;
}

export async function ext_status(_args: Record<string, unknown>, _ctx: unknown): Promise<unknown> {
  const res = await fetch(`${REST_BASE}/api/extension/status`, { headers: { 'Connection': 'close' } });
  return res.json();
}

export async function ext_navigate(args: Record<string, unknown>, _ctx: unknown): Promise<unknown> {
  return extCmd('navigate', { url: args['url'] });
}

export async function ext_click(args: Record<string, unknown>, _ctx: unknown): Promise<unknown> {
  return extCmd('click', { selector: args['selector'], wait: args['wait'] ?? 500 });
}

export async function ext_type(args: Record<string, unknown>, _ctx: unknown): Promise<unknown> {
  return extCmd('type', { selector: args['selector'], text: args['text'], clear: args['clear'] ?? true });
}

export async function ext_scroll(args: Record<string, unknown>, _ctx: unknown): Promise<unknown> {
  return extCmd('scroll', { direction: args['direction'] ?? 'down', amount: args['amount'] ?? 500 });
}

export async function ext_get_text(args: Record<string, unknown>, _ctx: unknown): Promise<unknown> {
  return extCmd('get_text', { selector: args['selector'] });
}

export async function ext_find_element(args: Record<string, unknown>, _ctx: unknown): Promise<unknown> {
  return extCmd('find_element', { selector: args['selector'] });
}

export async function ext_execute_js(args: Record<string, unknown>, _ctx: unknown): Promise<unknown> {
  return extCmd('execute_js', { code: args['code'] });
}

export async function ext_screenshot(_args: Record<string, unknown>, _ctx: unknown): Promise<unknown> {
  const raw = await extCmd('screenshot', {}) as { dataUrl?: string; tabUrl?: string; tabTitle?: string };
  if (!raw?.dataUrl) return { error: 'Extension returned no image data' };

  // Strip "data:image/png;base64," prefix and save to workspace
  const base64 = raw.dataUrl.replace(/^data:image\/\w+;base64,/, '');
  if (!fs.existsSync(SCREENSHOTS)) fs.mkdirSync(SCREENSHOTS, { recursive: true });
  const filename = `screenshot_${Date.now()}.png`;
  const filepath = path.join(SCREENSHOTS, filename);
  fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));

  return {
    saved: true,
    path: filepath,
    tab_url:   raw.tabUrl,
    tab_title: raw.tabTitle,
    note: `Screenshot saved. Use workspace_read or reference path directly.`,
  };
}
