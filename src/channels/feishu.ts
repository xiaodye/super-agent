import type { ChannelDefinition, IncomingMessage, OutgoingMessage } from './types.js';

interface FeishuConfig {
    appId: string;
    appSecret: string;
    port: number;
}

export class FeishuChannel implements ChannelDefinition {
    name = 'feishu';
    description = '飞书 Bot 消息通道（长连接模式）';

    private config: FeishuConfig;
    private messageHandler?: (msg: IncomingMessage) => void;
    private httpServer?: any;
    private wsClient?: any;
    private larkClient?: any;

    constructor(config: FeishuConfig) {
        this.config = config;
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler;
    }

    async start(): Promise<void> {
        // 启动状态面板（不管有没有配飞书都起）
        await this.startDashboard();

        if (!this.config.appId || !this.config.appSecret) {
            console.log('    飞书未配置 APP_ID / APP_SECRET，仅启动 Dashboard');
            console.log('    用页面上的「发送测试消息」或 curl 测试 Channel 流程');
            return;
        }

        // 用飞书 SDK 的长连接模式
        const lark = await import('@larksuiteoapi/node-sdk');

        this.larkClient = new lark.Client({
            appId: this.config.appId,
            appSecret: this.config.appSecret,
        });

        const dispatcher = new lark.EventDispatcher({});

        dispatcher.register({
            'im.message.receive_v1': (data) => {
                if (data.message.message_type !== 'text') return;

                const content = JSON.parse(data.message.content);
                let text = content.text || '';
                // 去掉 @Bot 的 mention 标记
                if (data.message.mentions) {
                    for (const m of data.message.mentions) {
                        text = text.replace(m.key, '').trim();
                    }
                }

                if (text && this.messageHandler) {
                    this.messageHandler({
                        channelId: data.message.chat_id,
                        senderId: data.sender.sender_id?.open_id || 'unknown',
                        senderName: data.sender.sender_id?.open_id || 'unknown',
                        text,
                        raw: data,
                    });
                }
            },
        });

        this.wsClient = new lark.WSClient({
            appId: this.config.appId,
            appSecret: this.config.appSecret,
            loggerLevel: lark.LoggerLevel.warn,
        });

        await this.wsClient.start({ eventDispatcher: dispatcher });
        console.log('    飞书长连接已建立（无需 ngrok）');
    }

    async stop(): Promise<void> {
        if (this.httpServer) this.httpServer.close();
    }

    async send(message: OutgoingMessage): Promise<void> {
        if (!this.larkClient) {
            console.log(`    [feishu] 未配置飞书，跳过发送: ${message.text.slice(0, 50)}`);
            return;
        }

        try {
            await this.larkClient.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                    receive_id: message.channelId,
                    msg_type: 'text',
                    content: JSON.stringify({ text: message.text }),
                },
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`    [feishu] 发送失败: ${msg}`);
        }
    }

    private async startDashboard(): Promise<void> {
        const { Hono } = await import('hono');
        const { serve } = await import('@hono/node-server');

        const app = new Hono();

        // 模拟 webhook（Dashboard 测试用）
        app.post('/webhook/feishu', async (c) => {
            const body = await c.req.json();

            if (body.header?.event_type === 'im.message.receive_v1') {
                const event = body.event;
                if (event.message?.message_type === 'text') {
                    const content = JSON.parse(event.message.content);
                    const text = content.text?.replace(/@_user_\d+/g, '').trim();
                    if (text && this.messageHandler) {
                        this.messageHandler({
                            channelId: event.message.chat_id || 'web-test',
                            senderId: event.sender?.sender_id?.open_id || 'web-dashboard',
                            senderName: event.sender?.sender_id?.open_id || 'web-dashboard',
                            text,
                            raw: body,
                        });
                    }
                }
            }

            return c.json({ code: 0 });
        });

        // 状态面板
        app.get('/', (c) => {
            const feishuStatus = this.config.appId ? '已连接（长连接模式）' : '未配置';
            const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <title>Super Agent — Channel Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; min-height: 100vh; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: #94a3b8; margin-bottom: 2rem; }
    .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
    .card h2 { font-size: 1rem; color: #38bdf8; margin-bottom: 0.75rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
    .badge-ok { background: #065f46; color: #6ee7b7; }
    .badge-off { background: #78350f; color: #fcd34d; }
    .endpoint { font-family: monospace; background: #334155; padding: 4px 8px; border-radius: 4px; font-size: 0.85rem; }
    ul { list-style: none; }
    li { margin-bottom: 0.5rem; }
    textarea { width: 100%; background: #334155; border: 1px solid #475569; color: #e2e8f0; border-radius: 6px; padding: 0.75rem; font-family: monospace; font-size: 0.85rem; resize: vertical; min-height: 60px; }
    button { background: #2563eb; color: white; border: none; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; margin-top: 0.5rem; font-size: 0.9rem; }
    button:hover { background: #1d4ed8; }
    #result { margin-top: 0.75rem; padding: 0.75rem; background: #334155; border-radius: 6px; font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; display: none; }
  </style>
</head>
<body>
  <h1>Super Agent v0.16</h1>
  <p class="subtitle">Channel Dashboard</p>

  <div class="card">
    <h2>Channel 状态</h2>
    <ul>
      <li><span class="badge ${this.config.appId ? 'badge-ok' : 'badge-off'}">${feishuStatus}</span> feishu — 飞书 Bot 消息通道</li>
    </ul>
  </div>

  <div class="card">
    <h2>发送测试消息</h2>
    <p style="color: #94a3b8; font-size: 0.85rem; margin-bottom: 0.75rem;">通过模拟 webhook 发消息给 Agent，回复在终端查看</p>
    <textarea id="msg" placeholder="输入要发给 Agent 的消息...">你好</textarea>
    <button onclick="sendTest()">发送</button>
    <div id="result"></div>
  </div>

  <script>
    async function sendTest() {
      const text = document.getElementById('msg').value.trim();
      if (!text) return;
      const result = document.getElementById('result');
      result.style.display = 'block';
      result.textContent = '发送中...';
      try {
        const body = {
          header: { event_type: 'im.message.receive_v1' },
          event: {
            message: { message_type: 'text', content: JSON.stringify({ text }), chat_id: 'web-test' },
            sender: { sender_id: { open_id: 'web-dashboard' } }
          }
        };
        const res = await fetch('/webhook/feishu', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        result.textContent = 'OK — 查看终端输出';
      } catch (e) {
        result.textContent = e.message;
      }
    }
  </script>
</body>
</html>`;
            return c.html(html);
        });

        app.get('/health', (c) => c.text('OK'));

        this.httpServer = serve({ fetch: app.fetch, port: this.config.port });
        console.log(`    Dashboard: http://localhost:${this.config.port}`);
    }
}
