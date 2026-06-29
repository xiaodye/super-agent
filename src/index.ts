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
import { SkillLoader } from './skills/loader';
import { createSkillCommands } from './commands/skill';
import { PluginManager } from './plugins/manager';
import { PluginDefinition } from './plugins/types';
import { createPluginCommands } from './commands/plugin';
import { supabasePlugin } from './plugins/supabase-plugin';

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

// ── Skills ────────────────────────────────
const skillLoader = new SkillLoader('.');
const loadedSkills = skillLoader.load();
const activeSkills = new Set<string>();

// ── Plugins ────────────────────────────────
const pluginManager = new PluginManager(registry);
const availablePlugins = new Map<string, PluginDefinition>([['supabase', supabasePlugin]]);

// ── Commands ────────────────────────────────
const dispatch = createDispatcher([
    ...debugCommands,
    ...contextCommands,
    ...memoryCommands,
    ...ragCommands,
    ...dreamCommands,
    ...createSkillCommands(skillLoader, activeSkills),
    ...createPluginCommands(pluginManager, availablePlugins),
]);

async function main() {
    await connectMCP();

    // 启动时自动加载插件
    console.log('  加载插件...');
    for (const [name, def] of availablePlugins) {
        try {
            const tools = await pluginManager.load(def);
            console.log(`  ✓ ${name} — ${tools.length} 个工具`);
        } catch {
            console.log(`  ✗ ${name} — 加载失败`);
        }
    }

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
        .pipe('skillContext', () => skillLoader.buildPromptSection(activeSkills))
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
                await pluginManager.unloadAll();
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

    console.log('Super Agent v0.15 — Plugins (type "exit" to quit)');
    console.log('快捷命令：');
    console.log('  /plugin          — 查看插件状态');
    console.log('  /plugin load X   — 加载插件');
    console.log('  /plugin unload X — 卸载插件');
    console.log('  /skill           — 查看 skills');
    console.log('  /memory          — 查看记忆');
    console.log('  /context         — context 占用矩阵');
    console.log('  status           — 当前状态');
    console.log('');

    const pluginList = pluginManager.list();
    if (pluginList.length > 0) {
        console.log(`  已加载 ${pluginList.length} 个插件：`);
        for (const p of pluginList) {
            console.log(`    ${p.name} — ${p.tools.join(', ')}`);
        }
        console.log('');
    }

    if (loadedSkills.length > 0) {
        console.log(`  发现 ${loadedSkills.length} 个 skill：`);
        for (const s of loadedSkills) console.log(`    /${s.name} — ${s.description}`);
        console.log('');
    }

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
