import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import type { ChannelAdapter, ChannelConfig, OutboundMessage } from './interface.js';
import type { GatewayEvent, UtterancePayload, IncomingAttachment } from './types.js';
import { validateApiKey, loadKeysFile } from '../security/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class WebChatAdapter implements ChannelAdapter {
  readonly channel_id = 'browser';

  private server:   http.Server      | null = null;
  private wss:      WebSocketServer  | null = null;
  private sessions  = new Map<string, WebSocket>();
  private handlers: Array<(event: GatewayEvent) => void> = [];

  private canvasPort  = 3001;
  private restPort    = 3002;
  private agentName   = 'RespireeClaw';
  private bindAddress = '127.0.0.1';

  /** Inject gateway metadata before init(). */
  setMeta(canvasPort: number, restPort: number, agentName: string, bindAddress: string): void {
    this.canvasPort  = canvasPort;
    this.restPort    = restPort;
    this.agentName   = agentName;
    this.bindAddress = bindAddress;
  }

  async init(config: ChannelConfig): Promise<void> {
    const port = (config['port'] as number | undefined) ?? 3000;
    const host = this.bindAddress;

    // Read the HTML template and inject config values
    const htmlPath = path.join(__dirname, 'webchat.html');
    const raw = fs.readFileSync(htmlPath, 'utf8');
    const html = raw
      .replace(/__CANVAS_PORT__/g, String(this.canvasPort))
      .replace(/__REST_PORT__/g,   String(this.restPort))
      .replace(/__AGENT_NAME_JSON__/g, JSON.stringify(this.agentName))
      .replace(/__AGENT_NAME__/g, this.agentName);   // <title> tag

    // HTTP server: serve the UI at GET /
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, {
          'Content-Type':  'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    // WebSocket server attached to the same HTTP server
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws, req) => {
      // Check for API key in query parameter or header
      // Auth is optional - only required if keys exist in keys.yaml
      const url = new URL(req.url ?? '/', 'http://localhost');
      const token = url.searchParams.get('token');
      
      if (token) {
        const validated = validateApiKey(token);
        if (!validated) {
          ws.close(4001, 'Invalid API key');
          return;
        }
      } else {
        // Also check Authorization header
        const authHeader = req.headers.authorization;
        if (authHeader) {
          const parts = authHeader.split(' ');
          if (parts.length === 2 && parts[0]?.toLowerCase() === 'bearer') {
            const validated = validateApiKey(parts[1]);
            if (!validated) {
              ws.close(4001, 'Invalid API key');
              return;
            }
          }
        }
        // No token provided - check if auth is required
        const keys = loadKeysFile();
        if (keys.keys.length > 0) {
          // Keys exist - require authentication
          ws.close(4001, 'API key required');
          return;
        }
      }

      const node_id = `browser_${crypto.randomUUID()}`;
      const session_id = node_id; // Use node_id as session_id for persistent conversation
      this.sessions.set(node_id, ws);

      // Greet the browser with identity info
      ws.send(JSON.stringify({
        type:       'connected',
        node_id,
        session_id,
        agent_name: this.agentName,
      }));

      ws.on('message', (data: Buffer) => {
        try {
          const msg  = JSON.parse(data.toString()) as Record<string, unknown>;
          const text = msg['text'] as string | undefined;
          const files = msg['files'] as Array<{ name: string; type: string; data: string }> | undefined;
          
          const hasImage = files && files.length > 0 && files.some(f => f.type.startsWith('image/'));
          if (!text && !hasImage) return;
          
          const payload: UtterancePayload = { 
            text: text || '[Image attached]',
            routing_hint: hasImage ? 'vision' : 'simple'
          };
          
          if (hasImage) {
            const firstImage = files!.find(f => f.type.startsWith('image/'));
            if (firstImage) payload.image_b64 = firstImage.data;
          }
          
          payload.attachments = files as IncomingAttachment[];

          const event: GatewayEvent = {
            type:      'event',
            event:     'utterance',
            node_id,
            session_id,
            ts:        Date.now(),
            payload,
          };
          for (const h of this.handlers) h(event);
        } catch { /* ignore malformed messages */ }
      });

      ws.on('close', () => this.sessions.delete(node_id));
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => resolve());
      this.server!.once('error', reject);
    });

    console.log(`[WebChat] UI ready → http://${host}:${port}`);
  }

  onMessage(handler: (event: GatewayEvent) => void): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<void> {
    const ws = this.sessions.get(message.node_id);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'message', text: message.text }));
    }
  }

  async isHealthy(): Promise<boolean> {
    return this.server !== null;
  }

  async destroy(): Promise<void> {
    for (const ws of this.sessions.values()) ws.close();
    this.sessions.clear();
    this.wss?.close();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
