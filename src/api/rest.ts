import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import fs from 'fs';
import nodePath from 'path';
import os from 'os';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import type { GatewayConfig } from '../config/loader.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { SkillsEngine } from '../skills/engine.js';
import type { MemoryManager } from '../memory/manager.js';
import type { CanvasRenderer } from '../canvas/renderer.js';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import { authenticateRequest, addApiKey, listApiKeys, revokeApiKey, loadKeysFile } from '../security/auth.js';

function checkDashboardAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const keys = loadKeysFile();
  if (keys.keys.length === 0) return true;
  
  const auth = authenticateRequest(req.headers.authorization);
  if (!auth.authorized) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: auth.error }));
    return false;
  }
  return true;
}

export interface HeartbeatLogEntry {
  ts:          number;
  result:      string;
  duration_ms: number;
}

export interface TokenCallEntry {
  ts:           number;
  node_id:      string;
  tier:         string;
  model:        string;
  input_tokens: number;
  output_tokens:number;
}

export interface TokenStats {
  total_input:  number;
  total_output: number;
  calls:        TokenCallEntry[];
}

// In-memory workflow state store for dashboard2 (with SQLite persistence)
const workflowUpdates = new Map<string, { workflow_id: string; status: string; data: unknown; timestamp: string }>();
const workflowEvents: Array<{ workflow_id: string; status: string; data: unknown; timestamp: string }> = [];

// ── Dashboard2: SQLite-backed workflow storage ──────────────────────────────────
const WF2_DB_PATH = nodePath.join(os.homedir(), '.aura', 'memory', 'dashboard2.db');

function wf2Db(): Database.Database {
  const dir = nodePath.dirname(WF2_DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(WF2_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      steps TEXT NOT NULL,
      created TEXT NOT NULL,
      schedule TEXT,
      enabled INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS workflow_runs (
      workflow_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      data TEXT,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      data TEXT,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wf_executions (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger_type TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT,
      completed_at TEXT,
      steps_done INTEGER DEFAULT 0,
      error TEXT
    );
  `);
  return db;
}

function loadSavedWorkflows(): Array<{ id: string; name: string; steps: WorkflowStep[]; created: string; schedule?: string; enabled?: number }> {
  try {
    const db = wf2Db();
    const rows = db.prepare('SELECT id, name, steps, created, schedule, enabled FROM saved_workflows ORDER BY created DESC').all() as Array<{ id: string; name: string; steps: string; created: string; schedule: string | null; enabled: number }>;
    db.close();
    return rows.map(r => ({ id: r.id, name: r.name, steps: JSON.parse(r.steps), created: r.created, schedule: r.schedule || undefined, enabled: r.enabled }));
  } catch { return []; }
}

function loadWorkflowEvents(): Array<{ workflow_id: string; status: string; data: unknown; timestamp: string }> {
  try {
    const db = wf2Db();
    const rows = db.prepare('SELECT workflow_id, status, data, timestamp FROM workflow_events ORDER BY id DESC LIMIT 100').all() as Array<{ workflow_id: string; status: string; data: string; timestamp: string }>;
    db.close();
    return rows.map(r => ({ workflow_id: r.workflow_id, status: r.status, data: JSON.parse(r.data || '{}'), timestamp: r.timestamp })).reverse();
  } catch { return []; }
}

function saveWorkflowRun(entry: { workflow_id: string; status: string; data: unknown; timestamp: string }): void {
  try {
    const db = wf2Db();
    db.prepare('INSERT OR REPLACE INTO workflow_runs (workflow_id, name, status, data, timestamp) VALUES (?, ?, ?, ?, ?)').run(
      entry.workflow_id, (entry.data as Record<string, unknown>)?.workflow_name ?? '', entry.status, JSON.stringify(entry.data), entry.timestamp
    );
    db.prepare('INSERT INTO workflow_events (workflow_id, status, data, timestamp) VALUES (?, ?, ?, ?)').run(
      entry.workflow_id, entry.status, JSON.stringify(entry.data), entry.timestamp
    );
    db.prepare('DELETE FROM workflow_events WHERE id NOT IN (SELECT id FROM workflow_events ORDER BY id DESC LIMIT 100)').run();
    db.close();
  } catch { /* non-fatal */ }
}

function saveSavedWorkflow(id: string, name: string, steps: WorkflowStep[], schedule?: string, enabled?: number): void {
  try {
    const db = wf2Db();
    db.prepare('INSERT OR REPLACE INTO saved_workflows (id, name, steps, created, schedule, enabled) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, JSON.stringify(steps), new Date().toISOString(), schedule || null, enabled ?? 0);
    db.close();
  } catch { /* non-fatal */ }
}

// Initialize persisted data
const savedWorkflows: Array<{ id: string; name: string; steps: WorkflowStep[]; created: string; schedule?: string; enabled?: number }> = loadSavedWorkflows();
const persistedRuns = loadWorkflowEvents();
for (const e of persistedRuns) {
  workflowUpdates.set(e.workflow_id, e);
  workflowEvents.push(e);
}
if (workflowEvents.length > 100) workflowEvents.splice(0, workflowEvents.length - 100);

// ── Dashboard4: Agent Teams — in-memory event store ──────────────────────────
const team4Events = new Map<string, Array<{ type: string; data: unknown; ts: number }>>();
const MAX_TEAM_EVENTS = 300;

function team4Push(sessionId: string, type: string, data: unknown, ts: number): void {
  const evts = team4Events.get(sessionId) ?? [];
  evts.push({ type, data, ts });
  if (evts.length > MAX_TEAM_EVENTS) evts.splice(0, evts.length - MAX_TEAM_EVENTS);
  team4Events.set(sessionId, evts);
}

// ── Dashboard3: Workflow Automation v2 — in-memory live event store ──────────
const wf3Events: Array<{ execution_id: string; workflow_name: string; status: string; data: unknown; timestamp: string }> = [];
const WORKFLOWS_DIR = nodePath.join(os.homedir(), '.aura', 'workflows');
const WF_DB_PATH    = nodePath.join(os.homedir(), '.aura', 'memory', 'aura.db');

function wf3Db() {
  if (!fs.existsSync(nodePath.dirname(WF_DB_PATH))) return null;
  try {
    const d = new Database(WF_DB_PATH);
    d.pragma('journal_mode = WAL');
    d.exec(`
      CREATE TABLE IF NOT EXISTS saved_workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        steps TEXT NOT NULL,
        created TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_runs (
        workflow_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wf_executions (
        id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger_type TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT,
        completed_at TEXT,
        steps_done INTEGER DEFAULT 0,
        error TEXT
      );
    `);
    return d;
  } catch { return null; }
}

const WF3_TEMPLATES = [
  {
    id: 'webhook_notify', name: 'Webhook → Notify',
    description: 'Receive a webhook and forward a message to another endpoint',
    definition: {
      name: 'webhook-notify', description: 'Forward an incoming webhook to a notification endpoint',
      trigger: { type: 'webhook', webhook_key: 'my-alerts' },
      steps: [
        { id: 'log_received', type: 'log', message: 'Webhook received: {{payload.event}}', on_success: 'notify' },
        { id: 'notify', type: 'webhook', url: 'https://hooks.example.com/notify', payload: { text: 'Alert: {{payload.event}} — {{payload.message}}' }, on_success: 'end' },
        { id: 'end', type: 'log', message: 'Done.' },
      ],
    },
  },
  {
    id: 'condition_branch', name: 'Condition → Branch',
    description: 'Check a value and take different actions based on the result',
    definition: {
      name: 'condition-branch', description: 'Branch on a payload value',
      trigger: { type: 'manual' },
      steps: [
        { id: 'check', type: 'condition', condition: { field: 'payload.value', operator: 'gt', value: 100 }, on_true: 'high_action', on_false: 'low_action' },
        { id: 'high_action', type: 'log', message: 'Value is HIGH: {{payload.value}}', on_success: 'end' },
        { id: 'low_action', type: 'log', message: 'Value is LOW: {{payload.value}}', on_success: 'end' },
        { id: 'end', type: 'log', message: 'Branch complete.' },
      ],
    },
  },
  {
    id: 'retry_webhook', name: 'Webhook with Retry',
    description: 'Send a webhook and retry up to 3 times on failure',
    definition: {
      name: 'retry-webhook', description: 'Reliable webhook delivery with retry',
      trigger: { type: 'manual' },
      steps: [
        { id: 'send', type: 'webhook', url: '{{payload.url}}', payload: { data: '{{payload.data}}' }, retry: { max_attempts: 3, delay_ms: 2000 }, on_success: 'done', on_failure: 'fail_log' },
        { id: 'done', type: 'log', message: 'Delivered successfully.' },
        { id: 'fail_log', type: 'log', message: 'Failed after 3 attempts: {{steps.send.output.error}}' },
      ],
    },
  },
  {
    id: 'multi_step', name: 'Multi-Step Pipeline',
    description: 'Fetch data, transform it, wait, then send results',
    definition: {
      name: 'multi-step-pipeline', description: 'Fetch → transform → wait → deliver',
      trigger: { type: 'manual' },
      steps: [
        { id: 'fetch', type: 'webhook', method: 'GET', url: '{{payload.source_url}}', payload: {}, on_success: 'transform' },
        { id: 'transform', type: 'transform', mappings: { summary: '{{steps.fetch.output.body}}', source: '{{payload.source_url}}' }, on_success: 'wait' },
        { id: 'wait', type: 'wait', duration_ms: 2000, on_success: 'deliver' },
        { id: 'deliver', type: 'webhook', url: '{{payload.dest_url}}', payload: { summary: '{{steps.transform.output.summary}}' }, on_success: 'end' },
        { id: 'end', type: 'log', message: 'Pipeline complete. Delivered to {{payload.dest_url}}' },
      ],
    },
  },
  {
    id: 'scheduled_report', name: 'Scheduled Report',
    description: 'Collect data and send a daily report on a schedule',
    definition: {
      name: 'scheduled-report', description: 'Daily report via webhook',
      trigger: { type: 'schedule', schedule: '0 9 * * 1-5' },
      steps: [
        { id: 'collect', type: 'skill', skill_name: 'web_search', tool_name: 'search', params: { query: 'daily summary {{env.workflow}}' }, on_success: 'format', on_failure: 'fail' },
        { id: 'format', type: 'transform', mappings: { report: '{{steps.collect.output}}', generated_at: '{{env.started_at}}' }, on_success: 'send' },
        { id: 'send', type: 'webhook', url: '{{payload.report_url}}', payload: { report: '{{steps.format.output.report}}', at: '{{steps.format.output.generated_at}}' }, on_success: 'end' },
        { id: 'end', type: 'log', message: 'Report sent.' },
        { id: 'fail', type: 'log', message: 'Report collection failed: {{steps.collect.output.error}}' },
      ],
    },
  },
];

interface WorkflowStep {
  operation: string;
  params: Record<string, string>;
}

interface SkillToolExecutor {
  execute(toolName: string, args: Record<string, unknown>, ctx: unknown): Promise<unknown>;
}

const OPERATION_TO_TOOL: Record<string, { tool: string; paramMap: (p: Record<string, string>) => Record<string, unknown> }> = {
  describe_instances: { tool: 'execute_ec2_operation', paramMap: p => ({ operation: 'describe', instance_ids: (p['instance_ids'] || '').split(',').filter(Boolean), region: p['region'] || 'us-east-1', workflow_id: '' }) },
  start_instances: { tool: 'execute_ec2_operation', paramMap: p => ({ operation: 'start', instance_ids: (p['instance_ids'] || '').split(',').filter(Boolean), region: p['region'] || 'us-east-1', workflow_id: '' }) },
  stop_instances: { tool: 'execute_ec2_operation', paramMap: p => ({ operation: 'stop', instance_ids: (p['instance_ids'] || '').split(',').filter(Boolean), region: p['region'] || 'us-east-1', workflow_id: '' }) },
  reboot_instances: { tool: 'execute_ec2_operation', paramMap: p => ({ operation: 'restart', instance_ids: (p['instance_ids'] || '').split(',').filter(Boolean), region: p['region'] || 'us-east-1', workflow_id: '' }) },
  scale_asg: { tool: 'spawn_agent_team', paramMap: p => ({ tasks: [{ task_type: 'scale_asg', asg_name: p['asg_name'], desired_capacity: parseInt(p['desired_capacity'] || '1'), region: p['region'] || 'us-east-1' }], workflow_id: '', concurrency_limit: 1 }) },
  check_health: { tool: 'execute_ec2_operation', paramMap: p => ({ operation: 'describe', instance_ids: (p['instance_ids'] || '').split(',').filter(Boolean), region: p['region'] || 'us-east-1', workflow_id: '' }) },
  run_ssm_command: { tool: 'spawn_agent_team', paramMap: p => ({ tasks: [{ task_type: 'run_ssm_command', instance_ids: (p['instance_ids'] || '').split(',').filter(Boolean), command: p['command'] || 'echo ok', region: p['region'] || 'us-east-1' }], workflow_id: '', concurrency_limit: 1 }) },
  get_metrics: { tool: 'spawn_agent_team', paramMap: p => ({ tasks: [{ task_type: 'get_metrics', instance_ids: (p['instance_ids'] || '').split(',').filter(Boolean), metric: p['metric'] || 'CPUUtilization', region: p['region'] || 'us-east-1' }], workflow_id: '', concurrency_limit: 1 }) },
  list_buckets: { tool: 'execute_s3_operation', paramMap: p => ({ operation: 'list_buckets', region: p['region'] || 'us-east-1', workflow_id: '' }) },
  get_object: { tool: 'execute_s3_operation', paramMap: p => ({ operation: 'get_object', bucket: p['bucket'], key: p['key'], region: p['region'] || 'us-east-1', workflow_id: '' }) },
  put_object: { tool: 'execute_s3_operation', paramMap: p => ({ operation: 'put_object', bucket: p['bucket'], key: p['key'], content: p['content'] || '', region: p['region'] || 'us-east-1', workflow_id: '' }) },
  invoke_lambda: { tool: 'execute_lambda_operation', paramMap: p => ({ operation: 'invoke', function_name: p['function_name'], payload: JSON.parse(p['payload'] || '{}'), region: p['region'] || 'us-east-1', workflow_id: '' }) },
  list_functions: { tool: 'execute_lambda_operation', paramMap: p => ({ operation: 'list', function_name: '', region: p['region'] || 'us-east-1', workflow_id: '' }) },
  start_rds: { tool: 'execute_rds_operation', paramMap: p => ({ operation: 'start', identifier: p['identifier'], region: p['region'] || 'us-east-1', workflow_id: '' }) },
  stop_rds: { tool: 'execute_rds_operation', paramMap: p => ({ operation: 'stop', identifier: p['identifier'], region: p['region'] || 'us-east-1', workflow_id: '' }) },
};

async function runWorkflowReal(workflowId: string, name: string, steps: WorkflowStep[], skillsEngine: SkillToolExecutor): Promise<void> {
  const post = (status: string, idx: number, extra: Record<string, unknown> = {}): void => {
    const entry = {
      workflow_id: workflowId,
      status,
      data: { step: steps[idx]?.operation ?? 'done', step_index: idx, total_steps: steps.length, workflow_name: name, ...extra },
      timestamp: new Date().toISOString(),
    };
    workflowUpdates.set(workflowId, entry);
    workflowEvents.push(entry);
    if (workflowEvents.length > 100) workflowEvents.splice(0, workflowEvents.length - 100);
    saveWorkflowRun(entry);
  };

  const ctx = { node_id: 'workflow-runner', session_id: `wf-${workflowId}`, agent_id: 'workflow', memory: { search: async () => [] }, channel: { send: async () => {} }, canvas: { append: () => {}, clear: () => {} } };

  post('running', 0);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    try {
      const op = OPERATION_TO_TOOL[step.operation];
      if (!op) {
        post('running', i + 1, { last_result: { error: `Unknown operation: ${step.operation}` } });
        continue;
      }
      const args = { ...op.paramMap(step.params), workflow_id: workflowId };
      const result = await skillsEngine.execute(op.tool, args, ctx);
      if (i < steps.length - 1) {
        post('running', i + 1, { last_result: result });
      } else {
        const entry = {
          workflow_id: workflowId,
          status: 'completed',
          data: { step: 'completed', step_index: i, total_steps: steps.length, workflow_name: name, last_result: result },
          timestamp: new Date().toISOString(),
        };
        workflowUpdates.set(workflowId, entry);
        workflowEvents.push(entry);
        if (workflowEvents.length > 100) workflowEvents.splice(0, workflowEvents.length - 100);
        saveWorkflowRun(entry);
      }
    } catch (err) {
      const entry = {
        workflow_id: workflowId,
        status: 'failed',
        data: { step: step.operation, step_index: i, total_steps: steps.length, workflow_name: name, error: String(err) },
        timestamp: new Date().toISOString(),
      };
      workflowUpdates.set(workflowId, entry);
      workflowEvents.push(entry);
      if (workflowEvents.length > 100) workflowEvents.splice(0, workflowEvents.length - 100);
      saveWorkflowRun(entry);
      return;
    }
  }
}

export interface RestAPIParams {
  config:           GatewayConfig;
  agentRegistry:    AgentRegistry;
  skillsEngine:     SkillsEngine;
  memoryManager:    MemoryManager;
  canvasRenderer:   CanvasRenderer;
  triggerHeartbeat: () => Promise<void>;
  heartbeatLog:     HeartbeatLogEntry[];
  startTime:        number;
  orchestrator:     AgentOrchestrator;
  tokenStats:       TokenStats;
}

const VERSION = '1.0.0';

/**
 * HTTP REST API server on port 3002.
 * All endpoints bound to 127.0.0.1 only.
 */
// ── Browser Extension WebSocket registry ──────────────────────────────────────
export const extensionClients  = new Map<string, WebSocket>();
export const extensionPending  = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

export class RestAPI {
  private server: ReturnType<typeof createServer>;
  private params: RestAPIParams;
  private wss:    WebSocketServer;

  constructor(params: RestAPIParams) {
    this.params = params;
    this.server = createServer((req, res) => this.handle(req, res));
    this.wss    = new WebSocketServer({ noServer: true });
  }

  private matchesCron(expr: string, date: Date): boolean {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const [min, hour, dom, mon, dow] = parts;
    const fieldMatch = (field: string | undefined, val: number): boolean => {
      if (!field || field === '*') return true;
      if (field.startsWith('*/')) {
        const step = parseInt(field.slice(2), 10);
        return step > 0 && val % step === 0;
      }
      return field.split(',').some(part => {
        if (part.includes('-')) {
          const [lo, hi] = part.split('-').map(Number);
          return val >= lo! && val <= hi!;
        }
        return parseInt(part, 10) === val;
      });
    };
    return fieldMatch(min, date.getMinutes()) &&
           fieldMatch(hour, date.getHours()) &&
           fieldMatch(dom, date.getDate()) &&
           fieldMatch(mon, date.getMonth() + 1) &&
           fieldMatch(dow, date.getDay());
  }

  private lastScheduleCheck = '';

  async start(): Promise<void> {
    const { bind_address, rest_port } = this.params.config.security;

    // WebSocket upgrade for browser extension at ws://host:3002/webextension
    this.server.on('upgrade', (req: IncomingMessage, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname !== '/webextension') { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const clientId = Date.now().toString(36);
        extensionClients.set(clientId, ws);
        console.log(`[Extension] Browser extension connected (id=${clientId})`);
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString()) as { id: string; result: unknown; error?: string };
            const pending = extensionPending.get(msg.id);
            if (pending) {
              extensionPending.delete(msg.id);
              msg.error ? pending.reject(new Error(msg.error)) : pending.resolve(msg.result);
            }
          } catch { /* ignore malformed */ }
        });
        ws.on('close', () => {
          extensionClients.delete(clientId);
          clearInterval(pingInterval);
          console.log(`[Extension] Browser extension disconnected (id=${clientId})`);
        });

        // Keepalive ping every 20s — prevents Chrome from killing the service worker
        const pingInterval = setInterval(() => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'ping', id: `ping-${Date.now()}` }));
          }
        }, 20_000);
      });
    });

    await new Promise<void>((resolve) => {
      this.server.listen(rest_port, bind_address, () => {
        console.log(`[REST] API listening on http://${bind_address}:${rest_port}`);
        resolve();
      });
    });

    // Schedule checker for dashboard2 workflows - runs every minute
    setInterval(() => {
      const now = new Date();
      const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
      if (this.lastScheduleCheck === minuteKey) return;
      this.lastScheduleCheck = minuteKey;

      for (const wf of savedWorkflows) {
        if (!wf.schedule || !wf.enabled) continue;
        if (!this.matchesCron(wf.schedule, now)) continue;
        const workflowId = `${wf.name.toLowerCase().replace(/\s+/g, '-')}-sched-${Date.now().toString(36)}`;
        console.log(`[REST] Running scheduled workflow: ${wf.name} (${wf.schedule})`);
        runWorkflowReal(workflowId, wf.name, wf.steps, this.params.skillsEngine).catch(err => console.error('[REST] Scheduled workflow error:', err));
      }
    }, 60_000);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS - allow specific origins
    const origin = req.headers.origin;
    const allowedOrigins: string[] = [
      'http://localhost:3000',
      'http://localhost:3002',
      'http://localhost:3002/dashboard',
      'http://localhost:3002/dashboard2',
      'http://localhost:3002/dashboard3',
      'http://localhost:3002/dashboard4',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3002',
      'http://127.0.0.1:3002/dashboard',
      'http://127.0.0.1:3002/dashboard2',
      'http://127.0.0.1:3002/dashboard3',
      'http://127.0.0.1:3002/dashboard4',
    ];
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? '/', `http://localhost`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Authenticate all /api/* endpoints (except /api/health and /api/auth/*)
    // Only require auth if API keys exist in keys.yaml
    // Supports both Authorization header and token query parameter (like WebSocket)
    const needsAuth = path.startsWith('/api/') && !path.startsWith('/api/health');
    if (needsAuth) {
      const keys = loadKeysFile();
      if (keys.keys.length > 0) {
        // Check Authorization header first
        let auth = authenticateRequest(req.headers.authorization);
        
        // If no header, also check query parameter (like WebSocket does)
        if (!auth.authorized) {
          const tokenParam = url.searchParams.get('token');
          if (tokenParam) {
            auth = authenticateRequest(`Bearer ${tokenParam}`);
          }
        }
        
        if (!auth.authorized) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: auth.error }));
          return;
        }
      }
    }

    try {
      // --- Health ---
      // --- Browser Extension ---
      if (method === 'GET' && path === '/api/extension/status') {
        return this.json(res, 200, { connected: extensionClients.size > 0, clients: extensionClients.size });
      }
      if (method === 'POST' && path === '/api/extension/command') {
        if (extensionClients.size === 0) return this.json(res, 503, { error: 'No browser extension connected' });
        const body = JSON.parse(await this.readBody(req)) as { command: string; [k: string]: unknown };
        const id    = Date.now().toString(36) + Math.random().toString(36).slice(2);
        const [, ws] = [...extensionClients.entries()][0]!;
        const result = await new Promise<unknown>((resolve, reject) => {
          extensionPending.set(id, { resolve, reject });
          setTimeout(() => { extensionPending.delete(id); reject(new Error('Extension command timeout (10s)')); }, 10_000);
          ws.send(JSON.stringify({ id, ...body }));
        });
        return this.json(res, 200, { success: true, result });
      }

      if (method === 'GET' && path === '/api/health') {
        return this.json(res, 200, {
          status: 'ok',
          uptime_s: Math.floor((Date.now() - this.params.startTime) / 1000),
          version: VERSION,
          agents_loaded: this.params.agentRegistry.getAll().length,
        });
      }

      // --- Agents ---
      if (method === 'GET' && path === '/api/agents') {
        return this.json(res, 200, this.params.agentRegistry.getAll());
      }

      const memSearchMatch = path.match(/^\/api\/agents\/(.+)\/memory\/search$/);
      if (method === 'GET' && memSearchMatch) {
        const agent_id = memSearchMatch[1];
        const q = url.searchParams.get('q') ?? '';
        const agent = this.params.agentRegistry.get(agent_id ?? '');
        if (!agent) return this.json(res, 404, { error: 'Agent not found' });
        const results = await this.params.memoryManager.search(agent.memory_ns, q);
        return this.json(res, 200, { results });
      }

      const memDateMatch = path.match(/^\/api\/agents\/(.+)\/memory\/(\d{4}-\d{2}-\d{2})$/);
      if (memDateMatch) {
        const [, agent_id, date] = memDateMatch;
        const agent = this.params.agentRegistry.get(agent_id ?? '');
        if (!agent) return this.json(res, 404, { error: 'Agent not found' });
        if (method === 'GET') {
          const content = await this.params.memoryManager.readEpisodic(agent.memory_ns, date ?? '');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(content); return;
        }
        if (method === 'DELETE') {
          await this.params.memoryManager.deleteEpisodic(agent.memory_ns, date ?? '');
          res.writeHead(204); res.end(); return;
        }
      }

      // --- Skills ---
      if (method === 'GET' && path === '/api/skills') {
        return this.json(res, 200, this.params.skillsEngine.listSkills());
      }

      const skillToggleMatch = path.match(/^\/api\/skills\/(.+)\/toggle$/);
      if (method === 'POST' && skillToggleMatch) {
        const name = skillToggleMatch[1];
        const skills = this.params.skillsEngine.listSkills();
        const skill = skills.find(s => s.name === name);
        if (!skill) return this.json(res, 404, { error: 'Skill not found' });
        skill.enabled = !skill.enabled;
        return this.json(res, 200, { enabled: skill.enabled });
      }

      // --- Canvas ---
      if (method === 'GET' && path === '/api/canvas') {
        return this.json(res, 200, this.params.canvasRenderer.getBlocks());
      }
      if (method === 'DELETE' && path === '/api/canvas') {
        this.params.canvasRenderer.clear();
        res.writeHead(204); res.end(); return;
      }

      // --- Heartbeat ---
      if (method === 'POST' && path === '/api/heartbeat/run') {
        this.params.triggerHeartbeat().catch(err => console.error('[Heartbeat] Manual run error:', err));
        return this.json(res, 200, { triggered: true });
      }
      if (method === 'GET' && path === '/api/heartbeat/log') {
        return this.json(res, 200, this.params.heartbeatLog.slice(-50));
      }

      // --- Webhooks ---
      const webhookGetMatch = path.match(/^\/api\/webhooks\/(.+)$/);
      if (webhookGetMatch) {
        const key = webhookGetMatch[1];
        if (method === 'GET') {
          const payloads = await this.params.memoryManager.getWebhooks(key ?? '');
          return this.json(res, 200, payloads);
        }
        if (method === 'DELETE') {
          await this.params.memoryManager.deleteWebhooks(key ?? '');
          res.writeHead(204); res.end(); return;
        }
      }

      // --- Inbound webhooks ---
      const inboundMatch = path.match(/^\/webhook\/(.+)$/);
      if (method === 'POST' && inboundMatch) {
        const key = inboundMatch[1] ?? '';
        const body = await this.readBody(req);
        await this.params.memoryManager.storeWebhook(key, body);

        // Fire any workflow_automation_v2 workflows whose trigger.webhook_key matches
        let wfPayload: unknown = {};
        try { wfPayload = JSON.parse(body); } catch { wfPayload = { raw: body }; }
        const wfCtx = {
          node_id: 'webhook', session_id: `wh-${Date.now()}`, agent_id: 'webhook',
          memory: { search: async () => [] },
          channel:{ send: async () => {} },
          canvas: { append: () => {}, clear: () => {} },
        };
        this.params.skillsEngine.execute('workflow_trigger_webhook', { webhook_key: key, payload: wfPayload } as Record<string, unknown>, wfCtx)
          .catch(err => console.error('[Webhook] workflow trigger error:', err));

        return this.json(res, 200, { received: true, webhook_key: key });
      }

      // --- LLM Config ---
      if (method === 'GET' && path === '/api/llm/config') {
        // Read live from disk so the dashboard reflects changes immediately after a switch
        let cfg = this.params.config;
        try {
          const raw = fs.readFileSync(nodePath.join(os.homedir(), '.aura', 'config.yaml'), 'utf8');
          const parsed = yaml.load(raw) as typeof cfg;
          if (parsed?.llm) cfg = { ...cfg, llm: parsed.llm };
        } catch { /* fall back to in-memory config */ }
        // Always return all four providers with live process.env key status (not cached config)
        const defaultModels: Record<string, string[]> = {
          claude:     ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4'],
          openai:     ['gpt-4o', 'gpt-4o-mini'],
          gemini:     ['gemini-1.5-pro', 'gemini-1.5-flash'],
          mistral:    ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-7b'],
          openrouter: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'meta-llama/llama-3.1-70b-instruct'],
        };
        const providers: Record<string, unknown> = {};
        for (const [name, envVar] of [
          ['claude',      'ANTHROPIC_API_KEY'],
          ['openai',      'OPENAI_API_KEY'],
          ['gemini',      'GOOGLE_API_KEY'],
          ['mistral',     'MISTRAL_API_KEY'],
          ['openrouter',  'OPENROUTER_API_KEY'],
        ] as [string, string][]) {
          const cfgProv = cfg.llm?.providers?.[name] as { models?: string[] } | undefined;
          providers[name] = {
            api_key_set: !!(process.env[envVar]),
            models: cfgProv?.models ?? defaultModels[name] ?? [],
          };
        }
        const ollamaCfg = cfg.llm?.providers?.['ollama'] as { base_url?: string; models?: string[] } | undefined;
        providers['ollama'] = {
          base_url: ollamaCfg?.base_url ?? 'http://localhost:11434',
          models:   ollamaCfg?.models  ?? [],
        };
        return this.json(res, 200, { routing: cfg.llm?.routing ?? {}, providers });
      }

      if (method === 'POST' && path === '/api/llm/config') {
        const body = await this.readBody(req);
        const { routing, api_key } = JSON.parse(body) as {
          routing?:  Record<string, string>;
          api_key?:  { provider: string; key: string };
        };

        const configPath = nodePath.join(os.homedir(), '.aura', 'config.yaml');
        let rawCfg: Record<string, unknown> = {};
        try {
          if (fs.existsSync(configPath)) {
            rawCfg = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown> ?? {};
          }
        } catch { /* start fresh */ }

        if (routing) {
          const llm = (rawCfg['llm'] as Record<string, unknown> | undefined) ?? {};
          const existing = (llm['routing'] as Record<string, string> | undefined) ?? {};
          llm['routing'] = { ...existing, ...routing };
          rawCfg['llm'] = llm;
          fs.writeFileSync(configPath, yaml.dump(rawCfg, { lineWidth: 120 }), 'utf8');
        }

        if (api_key) {
          const ENV_VARS: Record<string, string> = {
            claude: 'ANTHROPIC_API_KEY',
            openai: 'OPENAI_API_KEY',
            gemini: 'GOOGLE_API_KEY',
          };
          const envVar = ENV_VARS[api_key.provider];
          if (!envVar) return this.json(res, 400, { error: 'Unknown provider' });

          // Write to .env file for persistence
          const envPath = nodePath.join(process.cwd(), '.env');
          let envContent = '';
          try { envContent = fs.readFileSync(envPath, 'utf8'); } catch { /* new file */ }
          const lines = envContent.split('\n').filter(l => !l.startsWith(`${envVar}=`));
          lines.push(`${envVar}=${api_key.key}`);
          fs.writeFileSync(envPath, lines.filter(Boolean).join('\n') + '\n', 'utf8');

          // Update live process.env so GET reflects the change immediately (no restart needed to see status)
          process.env[envVar] = api_key.key;
        }

        return this.json(res, 200, { ok: true });
      }

      // --- Orchestrator ---
      if (method === 'GET' && path === '/api/orchestrator/sessions') {
        return this.json(res, 200, this.params.orchestrator.getSessions());
      }

      // --- Token usage ---
      if (method === 'GET' && path === '/api/usage') {
        return this.json(res, 200, this.params.tokenStats);
      }

      // --- Browser screenshots ---
      if (method === 'GET' && path === '/api/browser/screenshots') {
        const screenshotsDir = nodePath.join(os.homedir(), '.aura', 'screenshots');
        if (!fs.existsSync(screenshotsDir)) return this.json(res, 200, []);
        const files = fs.readdirSync(screenshotsDir)
          .filter(f => f.endsWith('.png'))
          .sort((a, b) => {
            const sa = fs.statSync(nodePath.join(screenshotsDir, a));
            const sb = fs.statSync(nodePath.join(screenshotsDir, b));
            return sb.mtimeMs - sa.mtimeMs;
          })
          .slice(0, 50)
          .map(f => ({
            name:     f,
            url:      `/api/browser/screenshots/${f}`,
            size_kb:  Math.round(fs.statSync(nodePath.join(screenshotsDir, f)).size / 1024),
            taken_at: fs.statSync(nodePath.join(screenshotsDir, f)).mtimeMs,
          }));
        return this.json(res, 200, files);
      }

      const screenshotFileMatch = path.match(/^\/api\/browser\/screenshots\/(.+\.png)$/);
      if (method === 'GET' && screenshotFileMatch) {
        const name = screenshotFileMatch[1];
        
        // Validate filename to prevent path traversal
        if (name.includes('..') || name.includes('/') || name.includes('\\')) {
          return this.json(res, 400, { error: 'Invalid filename' });
        }
        
        const screenshotsDir = nodePath.join(os.homedir(), '.aura', 'screenshots');
        const filepath = nodePath.join(screenshotsDir, name);
        
        // Ensure resolved path is still within screenshots directory
        if (!filepath.startsWith(screenshotsDir)) {
          return this.json(res, 403, { error: 'Access denied' });
        }
        
        if (!fs.existsSync(filepath)) return this.json(res, 404, { error: 'Not found' });
        const buf = fs.readFileSync(filepath);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
        res.end(buf);
        return;
      }

      // --- Dashboard2: EC2 Workflow UI ---
      if (method === 'GET' && (path === '/dashboard2' || path === '/dashboard2/')) {
        const htmlPath = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'dashboard2.html');
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // POST from ec2_workflow_automation skill — receives live workflow updates
      if (method === 'POST' && path === '/dashboard2/api/workflow-update') {
        if (!checkDashboardAuth(req, res)) return;
        const body = await this.readBody(req);
        const update = JSON.parse(body) as { workflow_id: string; status: string; data?: unknown; timestamp?: string };
        const entry = { ...update, data: update.data ?? {}, timestamp: update.timestamp ?? new Date().toISOString() };
        workflowUpdates.set(update.workflow_id, entry);
        workflowEvents.push(entry);
        if (workflowEvents.length > 100) workflowEvents.splice(0, workflowEvents.length - 100);
        saveWorkflowRun(entry);
        return this.json(res, 200, { ok: true });
      }

      // GET — frontend polls this for workflow state
      if (method === 'GET' && path === '/dashboard2/api/workflows') {
        if (!checkDashboardAuth(req, res)) return;
        const workflows = Array.from(workflowUpdates.values());
        const stats = {
          total:     workflows.length,
          completed: workflows.filter(w => w.status === 'completed').length,
          running:   workflows.filter(w => w.status === 'running').length,
          failed:    workflows.filter(w => w.status === 'failed').length,
        };
        return this.json(res, 200, { workflows, events: workflowEvents, stats });
      }

      // DELETE a workflow card from the board
      const wfDeleteMatch = path.match(/^\/dashboard2\/api\/workflows\/(.+)$/);
      if (method === 'DELETE' && wfDeleteMatch) {
        if (!checkDashboardAuth(req, res)) return;
        workflowUpdates.delete(wfDeleteMatch[1]!);
        res.writeHead(204); res.end(); return;
      }

      // GET EC2 workflow templates
      if (method === 'GET' && path === '/dashboard2/api/templates') {
        if (!checkDashboardAuth(req, res)) return;
        return this.json(res, 200, [
          { id: 'backup', name: 'Full Backup', steps: [
            { operation: 'describe_instances', params: { region: 'us-east-1', filter_state: 'running' } },
            { operation: 'create_snapshot',    params: { instance_id: 'i-0abc1234', description: 'Auto backup' } },
            { operation: 'check_health',       params: { instance_ids: 'i-0abc1234', region: 'us-east-1' } },
          ]},
          { id: 'rolling_restart', name: 'Rolling Restart', steps: [
            { operation: 'describe_instances', params: { region: 'us-east-1' } },
            { operation: 'stop_instances',     params: { instance_ids: 'i-0abc1234', region: 'us-east-1' } },
            { operation: 'start_instances',    params: { instance_ids: 'i-0abc1234', region: 'us-east-1' } },
            { operation: 'check_health',       params: { instance_ids: 'i-0abc1234', region: 'us-east-1' } },
          ]},
          { id: 'scale_up', name: 'Scale Up', steps: [
            { operation: 'describe_instances', params: { region: 'us-east-1' } },
            { operation: 'scale_asg',          params: { asg_name: 'my-asg', desired_capacity: '5', region: 'us-east-1' } },
            { operation: 'check_health',       params: { instance_ids: 'i-0abc1234', region: 'us-east-1' } },
          ]},
          { id: 'deploy', name: 'Deploy & Verify', steps: [
            { operation: 'deploy_application', params: { app_name: 'myapp', version: '2.0.0', environment: 'production' } },
            { operation: 'check_health',       params: { instance_ids: 'i-0abc1234', region: 'us-east-1' } },
            { operation: 'run_ssm_command',    params: { instance_ids: 'i-0abc1234', command: 'systemctl status myapp', region: 'us-east-1' } },
          ]},
          { id: 'health_check', name: 'Health Check', steps: [
            { operation: 'describe_instances', params: { region: 'us-east-1' } },
            { operation: 'check_health',       params: { instance_ids: 'i-0abc1234', region: 'us-east-1' } },
          ]},
        ]);
      }

      // GET saved custom workflows
      if (method === 'GET' && path === '/dashboard2/api/saved') {
        if (!checkDashboardAuth(req, res)) return;
        return this.json(res, 200, savedWorkflows);
      }

      // POST save a custom workflow config
      if (method === 'POST' && path === '/dashboard2/api/save') {
        if (!checkDashboardAuth(req, res)) return;
        const body = await this.readBody(req);
        const wf = JSON.parse(body) as { name: string; steps: WorkflowStep[]; schedule?: string; enabled?: number };
        const id = `wf-${Date.now().toString(36)}`;
        const enabled = wf.enabled ?? (wf.schedule ? 1 : 0);
        savedWorkflows.push({ id, name: wf.name, steps: wf.steps, created: new Date().toISOString(), schedule: wf.schedule, enabled });
        saveSavedWorkflow(id, wf.name, wf.steps, wf.schedule, enabled);
        return this.json(res, 200, { id });
      }

      // POST run a workflow — executes real AWS operations via skill
      if (method === 'POST' && path === '/dashboard2/api/run') {
        if (!checkDashboardAuth(req, res)) return;
        const body = await this.readBody(req);
        const wf = JSON.parse(body) as { name: string; steps: WorkflowStep[] };
        const workflowId = `${wf.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now().toString(36)}`;
        runWorkflowReal(workflowId, wf.name, wf.steps, this.params.skillsEngine).catch(console.error);
        return this.json(res, 200, { workflow_id: workflowId, started: true });
      }

      // POST toggle schedule for a workflow
      const scheduleToggleMatch = path.match(/^\/dashboard2\/api\/workflows\/(.+)\/schedule$/);
      if (method === 'POST' && scheduleToggleMatch) {
        if (!checkDashboardAuth(req, res)) return;
        const id = decodeURIComponent(scheduleToggleMatch[1]!);
        const body = await this.readBody(req);
        const { enabled } = JSON.parse(body) as { enabled: number };
        const wf = savedWorkflows.find(w => w.id === id);
        if (!wf) return this.json(res, 404, { error: 'Workflow not found' });
        wf.enabled = enabled;
        try {
          const db = wf2Db();
          db.prepare('UPDATE saved_workflows SET enabled = ? WHERE id = ?').run(enabled, id);
          db.close();
        } catch { /* non-fatal */ }
        return this.json(res, 200, { enabled });
      }

      // --- Dashboard UI ---
      if (method === 'GET' && (path === '/dashboard' || path === '/dashboard/')) {
        const htmlPath = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'dashboard.html');
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // ── Generic skill tool executor (used by workflow_automation_v2 skill steps) ──
      // POST /api/skills/:skillName/tools/:toolName  { ...args }
      const skillToolMatch = path.match(/^\/api\/skills\/([^/]+)\/tools\/([^/]+)$/);
      if (method === 'POST' && skillToolMatch) {
        const [, , toolName] = skillToolMatch;
        const body = await this.readBody(req);
        const args = body ? JSON.parse(body) : {};
        const result = await this.params.skillsEngine.execute(toolName!, args as Record<string, unknown>, {
          node_id: 'rest-api', session_id: `rest-${Date.now()}`, agent_id: 'rest',
          memory: { search: async () => [] },
          channel:{ send: async () => {} },
          canvas: { append: () => {}, clear: () => {} },
        });
        return this.json(res, 200, result);
      }

      // ── GitHub Skill Installer API ───────────────────────────────────────────
      // POST /api/skills/install/github { repo: "owner/repo", branch?: "main", skill_path?: "skills" }
      if (method === 'POST' && path === '/api/skills/install/github') {
        const body = await this.readBody(req);
        const args = body ? JSON.parse(body) : {};
        const result = await this.params.skillsEngine.execute('install_skill_from_github', args as Record<string, unknown>, {
          node_id: 'rest-api', session_id: `rest-${Date.now()}`, agent_id: 'rest',
          memory: { search: async () => [] },
          channel:{ send: async () => {} },
          canvas: { append: () => {}, clear: () => {} },
        });
        return this.json(res, 200, result);
      }

      // GET /api/skills/github/search?q=query
      const githubSearchMatch = path.match(/^\/api\/skills\/github\/search\?q=(.+)$/);
      if (method === 'GET' && githubSearchMatch) {
        const query = decodeURIComponent(githubSearchMatch[1]!);
        const result = await this.params.skillsEngine.execute('search_github_skills', { query, per_page: 10 }, {
          node_id: 'rest-api', session_id: `rest-${Date.now()}`, agent_id: 'rest',
          memory: { search: async () => [] },
          channel:{ send: async () => {} },
          canvas: { append: () => {}, clear: () => {} },
        });
        return this.json(res, 200, result);
      }

      // ── Dashboard3: Workflow Automation v2 ───────────────────────────────────

      // Serve HTML
      if (method === 'GET' && (path === '/dashboard3' || path === '/dashboard3/')) {
        const htmlPath = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'dashboard3.html');
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // Receive live step updates from the skill (fire-and-forget POSTs)
      if (method === 'POST' && path === '/dashboard3/api/workflow-update') {
        if (!checkDashboardAuth(req, res)) return;
        const body = await this.readBody(req);
        const update = JSON.parse(body) as { execution_id: string; workflow_name: string; status: string; data?: unknown; timestamp?: string };
        wf3Events.push({ ...update, data: update.data ?? {}, timestamp: update.timestamp ?? new Date().toISOString() });
        if (wf3Events.length > 200) wf3Events.splice(0, wf3Events.length - 200);
        return this.json(res, 200, { ok: true });
      }

      // List executions from SQLite + live events
      if (method === 'GET' && path === '/dashboard3/api/executions') {
        if (!checkDashboardAuth(req, res)) return;
        const d = wf3Db();
        let executions: unknown[] = [];
        if (d) {
          executions = d.prepare(`SELECT id, workflow_name, status, trigger_type, started_at, updated_at, completed_at, steps_done, error FROM wf_executions ORDER BY started_at DESC LIMIT 100`).all();
          d.close();
        }
        const stats = {
          total:     (executions as { status: string }[]).length,
          running:   (executions as { status: string }[]).filter(e => e.status === 'running').length,
          completed: (executions as { status: string }[]).filter(e => e.status === 'completed').length,
          failed:    (executions as { status: string }[]).filter(e => e.status === 'failed').length,
        };
        return this.json(res, 200, { executions, events: wf3Events.slice(-100).reverse(), stats });
      }

      // Delete an execution card from the board (marks as archived in-memory only)
      const wf3ExecDeleteMatch = path.match(/^\/dashboard3\/api\/executions\/(.+)$/);
      if (method === 'DELETE' && wf3ExecDeleteMatch) {
        if (!checkDashboardAuth(req, res)) return;
        // Remove from live events list
        const id = decodeURIComponent(wf3ExecDeleteMatch[1]!);
        const idx = wf3Events.findIndex(e => e.execution_id === id);
        if (idx !== -1) wf3Events.splice(idx, 1);
        res.writeHead(204); res.end(); return;
      }

      // List workflow definitions from ~/.aura/workflows/
      if (method === 'GET' && path === '/dashboard3/api/definitions') {
        if (!checkDashboardAuth(req, res)) return;
        fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
        const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => /\.(yaml|json)$/.test(f));
        const definitions = files.map(f => {
          const name = f.replace(/\.(yaml|json)$/, '');
          try {
            const raw = fs.readFileSync(nodePath.join(WORKFLOWS_DIR, f), 'utf8');
            const def = (f.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw)) as Record<string, unknown>;
            const trigger = def['trigger'] as Record<string, unknown> | undefined;
            return { name, description: (def['description'] as string) ?? '', steps: ((def['steps'] as unknown[]) ?? []).length, trigger: trigger?.['type'] ?? 'manual', schedule: trigger?.['schedule'] ?? null, webhook_key: trigger?.['webhook_key'] ?? null };
          } catch { return { name, error: 'parse error' }; }
        });
        return this.json(res, 200, { definitions });
      }

      // Save a workflow definition
      if (method === 'POST' && path === '/dashboard3/api/definitions') {
        if (!checkDashboardAuth(req, res)) return;
        const body = await this.readBody(req);
        const { name, definition } = JSON.parse(body) as { name: string; definition: unknown };
        fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
        const fp = nodePath.join(WORKFLOWS_DIR, `${name}.yaml`);
        const out = typeof definition === 'string' ? definition : yaml.dump(definition, { lineWidth: 120 });
        fs.writeFileSync(fp, out, 'utf8');
        return this.json(res, 200, { saved: true, name });
      }

      // Delete a workflow definition
      const wf3DefDeleteMatch = path.match(/^\/dashboard3\/api\/definitions\/(.+)$/);
      if (method === 'DELETE' && wf3DefDeleteMatch) {
        if (!checkDashboardAuth(req, res)) return;
        const name = decodeURIComponent(wf3DefDeleteMatch[1]!);
        let deleted = false;
        for (const ext of ['yaml', 'json']) {
          const fp = nodePath.join(WORKFLOWS_DIR, `${name}.${ext}`);
          if (fs.existsSync(fp)) { fs.unlinkSync(fp); deleted = true; }
        }
        if (!deleted) return this.json(res, 404, { error: `Workflow not found: ${name}` });
        res.writeHead(204); res.end(); return;
      }

      // Run a workflow (async — dashboard polls for updates)
      if (method === 'POST' && path === '/dashboard3/api/run') {
        if (!checkDashboardAuth(req, res)) return;
        const body = await this.readBody(req);
        const { name, payload } = JSON.parse(body) as { name: string; payload?: unknown };
        const result = await this.params.skillsEngine.execute('workflow_run', { name, payload: payload ?? {}, async: true } as Record<string, unknown>, {
          node_id: 'dashboard3', session_id: `dash-${Date.now()}`, agent_id: 'dashboard3',
          memory: { search: async () => [] },
          channel:{ send: async () => {} },
          canvas: { append: () => {}, clear: () => {} },
        });
        return this.json(res, 200, result);
      }

      // Trigger a webhook key (fires matching workflows)
      if (method === 'POST' && path === '/dashboard3/api/trigger') {
        if (!checkDashboardAuth(req, res)) return;
        const body = await this.readBody(req);
        const { webhook_key, payload } = JSON.parse(body) as { webhook_key: string; payload?: unknown };
        const result = await this.params.skillsEngine.execute('workflow_trigger_webhook', { webhook_key, payload: payload ?? {} } as Record<string, unknown>, {
          node_id: 'dashboard3', session_id: `dash-${Date.now()}`, agent_id: 'dashboard3',
          memory: { search: async () => [] },
          channel:{ send: async () => {} },
          canvas: { append: () => {}, clear: () => {} },
        });
        return this.json(res, 200, result);
      }

      // Workflow templates
      if (method === 'GET' && path === '/dashboard3/api/templates') {
        if (!checkDashboardAuth(req, res)) return;
        return this.json(res, 200, WF3_TEMPLATES);
      }

      // ── Dashboard4: Agent Teams ───────────────────────────────────────────────

      // Serve HTML
      if (method === 'GET' && (path === '/dashboard4' || path === '/dashboard4/')) {
        const htmlPath = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'dashboard4.html');
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // Receive live events from orchestrator
      if (method === 'POST' && path === '/dashboard4/api/event') {
        if (!checkDashboardAuth(req, res)) return;
        const body = await this.readBody(req);
        const evt = JSON.parse(body) as { type: string; data: Record<string, unknown>; ts: number };
        const sessionId = (evt.data['session_id'] as string) ?? 'unknown';
        team4Push(sessionId, evt.type, evt.data, evt.ts ?? Date.now());
        return this.json(res, 200, { ok: true });
      }

      // Get all sessions with their events
      if (method === 'GET' && path === '/dashboard4/api/sessions') {
        if (!checkDashboardAuth(req, res)) return;
        const sessions = this.params.orchestrator.getSessions();
        const enriched = sessions.map(s => ({
          ...s,
          events: team4Events.get(s.id) ?? [],
        }));
        return this.json(res, 200, enriched);
      }

      // Spawn a new team asynchronously from the dashboard
      if (method === 'POST' && path === '/dashboard4/api/spawn') {
        if (!checkDashboardAuth(req, res)) return;
        const body = await this.readBody(req);
        const args = JSON.parse(body) as Record<string, unknown>;
        const sessionId = this.params.orchestrator.spawnTeamAsync(args, 'dashboard4');
        return this.json(res, 200, { session_id: sessionId, started: true });
      }

      // --- API Key Management ---
      if (method === 'GET' && path === '/api/keys') {
        const keys = listApiKeys();
        return this.json(res, 200, { keys: keys.map(k => ({ name: k.name, created: k.created, last_used: k.last_used })) });
      }

      const keyCreateMatch = path.match(/^\/api\/keys$/);
      if (method === 'POST' && keyCreateMatch) {
        const body = await this.readBody(req);
        const { name } = JSON.parse(body) as { name: string };
        if (!name) return this.json(res, 400, { error: 'Missing name' });
        const newKey = addApiKey(name);
        return this.json(res, 200, { name: newKey.name, key: newKey.key, created: newKey.created });
      }

      const keyDeleteMatch = path.match(/^\/api\/keys\/(.+)$/);
      if (method === 'DELETE' && keyDeleteMatch) {
        const name = decodeURIComponent(keyDeleteMatch[1]!);
        const deleted = revokeApiKey(name);
        if (!deleted) return this.json(res, 404, { error: 'Key not found' });
        return this.json(res, 200, { deleted: true });
      }

      // 404
      return this.json(res, 404, { error: 'Not found' });

    } catch (err) {
      console.error('[REST] Handler error:', err);
      this.json(res, 500, { error: String(err) });
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
}
