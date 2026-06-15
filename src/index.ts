import 'dotenv/config';
import process from 'node:process';
import { createOpenAI } from '@ai-sdk/openai';

import { createInterface } from 'node:readline';
import { allTools } from './tools';
import { agentLoop } from './agent/agent-loop';
import { ToolDefinition, ToolRegistry } from './tools/registry';
import { createMockModel, setCacheEnabled } from './mock-model';
import { MCPClient, MockMCPClient } from './tools/mcp-client';
import { SessionStore } from './session/store';
import {
    coreRules,
    deferredTools,
    PromptBuilder,
    PromptContext,
    sessionContext,
    toolGuide,
} from './context/prompt-builder';
import { estimateTokens, microcompact, summarize } from './context/compressor';
import { estimateMessageTokens, applyDefense } from './context/defense';
import { buildContextSnapshot, renderContextView, renderUsageView } from './context/view';
import { UsageTracker } from './usage/tracker';
import { ModelMessage } from 'ai';
import { CommandContext, createDispatcher } from './commands';
import { createMemoryTool } from './tools/memory-tools';
import { MemoryStore } from './memory/store';
import { contextCommands } from './commands/context';
import { debugCommands } from './commands/debug';
import { memoryCommands } from './commands/memory';
import { createToolSearchTool } from './tools/tool-search';

const deepSeek = createOpenAI({
    baseURL: process.env.LLM_API_BASE,
    apiKey: process.env.LLM_API_KEY,
});

const model = deepSeek.chat(process.env.LLM_MODEL ?? 'deepseek-v4-flash');

// mock
// const model = createMockModel();

// ── Registry ────────────────────────────────
const registry = new ToolRegistry();
registry.register(...allTools);
registry.register(createToolSearchTool(registry));

// ── Memory ────────────────────────────────
const memoryStore = new MemoryStore('.');
memoryStore.init();
registry.register(createMemoryTool(memoryStore));

async function connectMCP() {
    const mockClient = new MockMCPClient();
    const tools = await registry.registerMCPServer('github', mockClient);
    console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

// ── Commands ────────────────────────────────
const dispatch = createDispatcher([...debugCommands, ...contextCommands, ...memoryCommands]);

async function main() {
    await connectMCP();

    const store = new SessionStore('default');
    let messages: ModelMessage[] = [];
    const timestamps = new Map<number, number>();
    const tracker = new UsageTracker('.usage/today.jsonl');

    const builder = new PromptBuilder()
        .pipe('coreRules', coreRules())
        .pipe('toolGuide', toolGuide())
        .pipe('deferredTools', deferredTools())
        .pipe('memoryContext', () => memoryStore.buildPromptSection())
        .pipe('sessionContext', sessionContext());

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    function makePromptCtx(): PromptContext {
        return {
            toolCount: registry.getActiveTools().length,
            deferredToolSummary: registry.getDeferredToolSummary(),
            sessionMessageCount: messages.length,
            sessionId: 'default',
        };
    }

    function ask() {
        rl.question('\nYou: ', async (input) => {
            const trimmed = input.trim();
            if (!trimmed || trimmed === 'exit') {
                console.log('Bye!');
                rl.close();
                return;
            }

            const ctx: CommandContext = {
                messages,
                timestamps,
                registry,
                builder,
                tracker,
                sessionStore: store,
                model,
                makePromptCtx,
                ask,
                memoryStore,
            };
            const handled = dispatch(trimmed, ctx);
            if (handled === 'async') return;
            if (handled) {
                ask();
                return;
            }

            const userMsg: ModelMessage = { role: 'user', content: trimmed };
            messages.push(userMsg);
            timestamps.set(messages.length - 1, Date.now());
            store.append(userMsg);

            const currentSystem = builder.build(makePromptCtx());
            const beforeLen = messages.length;
            await agentLoop(model, registry, messages, currentSystem, tracker);

            const newMessages = messages.slice(beforeLen);
            const now = Date.now();
            for (let i = beforeLen; i < messages.length; i++) timestamps.set(i, now);
            store.appendAll(newMessages);

            console.log(`  [Token] ~${estimateMessageTokens(messages)} tokens`);
            ask();
        });
    }

    console.log('Super Agent v0.11 — Memory System (type "exit" to quit)');
    console.log('快捷命令：');
    console.log('  /memory         — 查看所有记忆');
    console.log('  /memory search  — 搜索记忆');
    console.log('  /context        — 终端里看 context 占用矩阵');
    console.log('  /usage          — 累计 token 用量和成本');
    console.log('  status          — 当前消息数、token 和记忆数');
    console.log('');
    console.log(`  已加载 ${memoryStore.list().length} 条历史记忆`);
    console.log('');

    ask();
}

main().catch(console.error);
