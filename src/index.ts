import 'dotenv/config';
import process from 'node:process';
import { createOpenAI } from '@ai-sdk/openai';
import fs from 'node:fs';

import { createInterface } from 'node:readline';
import { allTools } from './tools';
import { agentLoop } from './agent/loop';
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
import { memoryContext, ragContext } from './context/prompt-pipes';
import { chunkDocument } from './rag/chunker';
import { createDashScopeEmbedder, createMockEmbedder, embed } from './rag/embedder';
import { VectorStore } from './rag/store';
import { SqliteVectorStore } from './rag/sqlite-store';
import { createRagTools } from './tools/rag-tools';
import { ragCommands } from './commands/rag';
import { dreamCommands } from './commands/dream';

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

// ── RAG ────────────────────────────────
const vectorStore = new VectorStore();
const embedFn = process.env.DASHSCOPE_API_KEY
    ? createDashScopeEmbedder(process.env.DASHSCOPE_API_KEY)
    : createMockEmbedder();
registry.register(...createRagTools(vectorStore, embedFn));

async function connectMCP() {
    const mockClient = new MockMCPClient();
    const tools = await registry.registerMCPServer('github', mockClient);
    console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

// ── Commands ────────────────────────────────
const dispatch = createDispatcher([
    ...debugCommands,
    ...contextCommands,
    ...memoryCommands,
    ...ragCommands,
    ...dreamCommands,
]);

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
        .pipe('memoryContext', memoryContext(memoryStore))
        .pipe('ragContext', ragContext(vectorStore))
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
                vectorStore,
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

    console.log('Super Agent v0.13 — Memory Maintenance (type "exit" to quit)');
    console.log('快捷命令：');
    console.log('  ingest <path>   — 导入文档到知识库');
    console.log('  /rag            — 查看知识库状态');
    console.log('  /memory         — 查看记忆（带 ⚠️ 标记）');
    console.log('  /lint           — 扫描记忆库');
    console.log('  /dream          — 记忆整理（lint → 清理 → 合并 → 报告）');
    console.log('  /context        — context 占用矩阵');
    console.log('  status          — 当前状态');
    console.log('');

    if (fs.existsSync('docs')) {
        const files = fs.readdirSync('docs').filter((f) => f.endsWith('.md'));
        if (files.length > 0) {
            console.log(`  发现 ${files.length} 个文档，自动导入知识库...`);
            for (const f of files) {
                const path = `docs/${f}`;
                const text = fs.readFileSync(path, 'utf-8');
                const chunks = chunkDocument(path, text);
                const embeddings = await embed(
                    embedFn,
                    chunks.map((c) => c.text),
                );
                vectorStore.addBatch(
                    chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })),
                );
                console.log(`    ${f} → ${chunks.length} 个片段`);
            }
            console.log(`  知识库就绪，共 ${vectorStore.size()} 个片段\n`);
        }
    }

    ask();
}

main().catch(console.error);
