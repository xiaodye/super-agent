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

const deepSeek = createOpenAI({
    baseURL: process.env.LLM_API_BASE,
    apiKey: process.env.LLM_API_KEY,
});

const model = deepSeek.chat(process.env.LLM_MODEL ?? 'deepseek-v4-flash');

// mock
// const model = createMockModel();

const registry = new ToolRegistry();
registry.register(...allTools);

const toolSearchTool: ToolDefinition = {
    name: 'tool_search',
    description: '获取延迟工具的完整定义',
    parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ query }: { query: string }) => {
        const results = registry.searchTools(query);
        if (results.length === 0) return `没有找到工具: ${query}`;
        return results.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        }));
    },
};
registry.register(toolSearchTool);

async function connectMCP() {
    const mockClient = new MockMCPClient();
    const tools = await registry.registerMCPServer('github', mockClient);
    console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

/** Inject fake history with timestamps to demo TTL pruning. */
function injectFakeHistory(messages: ModelMessage[], timestamps: Map<number, number>) {
    const now = Date.now();
    const fakeHistory: Array<{ msg: ModelMessage; ageMs: number }> = [
        // 12 minutes ago — will be hard pruned
        { ageMs: 12 * 60 * 1000, msg: { role: 'user', content: '帮我看看 package.json' } },
        {
            ageMs: 12 * 60 * 1000,
            msg: {
                role: 'assistant',
                content: [
                    {
                        type: 'tool-call' as const,
                        toolCallId: 'old-1',
                        toolName: 'read_file',
                        input: { path: 'package.json' },
                    },
                ],
            },
        },
        {
            ageMs: 12 * 60 * 1000,
            msg: {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result' as const,
                        toolCallId: 'old-1',
                        toolName: 'read_file',
                        output: '{\n  "name": "super-agent-09",\n  "version": "0.9.0",\n  "type": "module",\n  "scripts": { "start": "tsx src/index.ts" },\n  "dependencies": {\n    "ai": "5.0.98",\n    "@ai-sdk/openai": "2.0.44",\n    "zod": "3.25.76"\n  }\n}',
                    },
                ],
            },
        },
        {
            ageMs: 12 * 60 * 1000,
            msg: {
                role: 'assistant',
                content: [
                    {
                        type: 'text' as const,
                        text: 'package.json：项目名 super-agent-09，依赖 ai 和 @ai-sdk/openai。',
                    },
                ],
            },
        },

        // 7 minutes ago — will be soft pruned
        { ageMs: 7 * 60 * 1000, msg: { role: 'user', content: '搜索 src 目录里的 export' } },
        {
            ageMs: 7 * 60 * 1000,
            msg: {
                role: 'assistant',
                content: [
                    {
                        type: 'tool-call' as const,
                        toolCallId: 'mid-1',
                        toolName: 'grep',
                        input: { pattern: 'export', path: 'src' },
                    },
                ],
            },
        },
        {
            ageMs: 7 * 60 * 1000,
            msg: {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result' as const,
                        toolCallId: 'mid-1',
                        toolName: 'grep',
                        output: 'src/tools.ts:1: export const weatherTool = ...\nsrc/tools.ts:20: export const calculatorTool = ...\nsrc/tools.ts:40: export const readFileTool = ...\nsrc/tools.ts:60: export const writeFileTool = ...\nsrc/tools.ts:80: export const listDirectoryTool = ...\nsrc/tool-registry.ts:4: export interface ToolDefinition { ... }\nsrc/tool-registry.ts:18: export class ToolRegistry { ... }\nsrc/agent-loop.ts:7: export async function agentLoop(...) { ... }\nsrc/session-store.ts:8: export class SessionStore { ... }\nsrc/prompt-builder.ts:12: export class PromptBuilder { ... }\nsrc/context-defense.ts:5: export class TokenTracker { ... }\nsrc/context-defense.ts:50: export function estimateMessageTokens(...) { ... }\nsrc/context-defense.ts:70: export function truncateToolResults(...) { ... }\nsrc/context-defense.ts:110: export function ttlPrune(...) { ... }',
                    },
                ],
            },
        },
        {
            ageMs: 7 * 60 * 1000,
            msg: {
                role: 'assistant',
                content: [
                    {
                        type: 'text' as const,
                        text: 'src 目录里的主要导出：tools.ts 定义了各种工具，tool-registry.ts 导出 ToolRegistry 类，context-defense.ts 导出了 TokenTracker、truncateToolResults、ttlPrune 等。',
                    },
                ],
            },
        },

        // 1 minute ago — will NOT be pruned
        { ageMs: 1 * 60 * 1000, msg: { role: 'user', content: '读一下 sample-data.txt' } },
        {
            ageMs: 1 * 60 * 1000,
            msg: {
                role: 'assistant',
                content: [
                    {
                        type: 'tool-call' as const,
                        toolCallId: 'new-1',
                        toolName: 'read_file',
                        input: { path: 'sample-data.txt' },
                    },
                ],
            },
        },
        {
            ageMs: 1 * 60 * 1000,
            msg: {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result' as const,
                        toolCallId: 'new-1',
                        toolName: 'read_file',
                        output: 'Super Agent 工具系统设计文档\n=============================\n\n一、工具注册机制\n每个工具通过 ToolRegistry 统一注册。\n\n二、结果截断策略\nHead/Tail 60/40 分割。\n\n三、并发控制\n读写锁模式。\n\n四、最佳实践\n1. 工具描述要写"什么时候不该用"\n2. 参数描述要具体\n3. 错误信息要对模型友好\n4. 结果格式要结构化',
                    },
                ],
            },
        },
        {
            ageMs: 1 * 60 * 1000,
            msg: {
                role: 'assistant',
                content: [
                    {
                        type: 'text' as const,
                        text: 'sample-data.txt 是工具系统设计文档，包含注册机制、截断策略、并发控制和最佳实践四个部分。',
                    },
                ],
            },
        },
    ];

    for (let i = 0; i < fakeHistory.length; i++) {
        const { msg, ageMs } = fakeHistory[i];
        messages.push(msg);
        timestamps.set(messages.length - 1, now - ageMs);
    }
}

async function main() {
    await connectMCP();

    const store = new SessionStore('default');
    let messages: ModelMessage[] = [];
    const timestamps = new Map<number, number>();
    const tracker = new UsageTracker('.usage/today.jsonl');

    // sa-10 主题是 cache 和成本，启动时直接进入空对话
    // 上一节的三层即时防线还在 context-defense.ts 里，每轮 apply 不变

    const builder = new PromptBuilder()
        .pipe('coreRules', coreRules())
        .pipe('toolGuide', toolGuide())
        .pipe('deferredTools', deferredTools())
        .pipe('sessionContext', sessionContext());

    const promptCtx: PromptContext = {
        toolCount: registry.getActiveTools().length,
        deferredToolSummary: registry.getDeferredToolSummary(),
        sessionMessageCount: messages.length,
        sessionId: 'default',
    };

    const SYSTEM = builder.build(promptCtx);
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    // Quick triggers for demo
    function handleQuickTrigger(cmd: string): boolean {
        const now = Date.now();

        if (cmd === '模拟长对话' || cmd === 'sim') {
            console.log('\n[模拟] 注入 20 条历史消息（含大量工具结果）...');
            for (let i = 0; i < 5; i++) {
                const age = (20 - i * 4) * 60 * 1000;
                const userIdx = messages.length;
                messages.push({ role: 'user', content: `第 ${i + 1} 轮：帮我读文件 file-${i}.ts` });
                timestamps.set(userIdx, now - age);
                messages.push({
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool-call' as const,
                            toolCallId: `sim-${i}`,
                            toolName: 'read_file',
                            input: { path: `file-${i}.ts` },
                        },
                    ],
                });
                timestamps.set(userIdx + 1, now - age);
                const bigContent =
                    `// file-${i}.ts\n` + 'export function handler() {\n  // ...\n}\n'.repeat(200);
                messages.push({
                    role: 'tool',
                    content: [
                        {
                            type: 'tool-result' as const,
                            toolCallId: `sim-${i}`,
                            toolName: 'read_file',
                            output: bigContent,
                        },
                    ],
                });
                timestamps.set(userIdx + 2, now - age);
                messages.push({
                    role: 'assistant',
                    content: [{ type: 'text' as const, text: `文件 file-${i}.ts 的内容已读取。` }],
                });
                timestamps.set(userIdx + 3, now - age);
            }
            const tokens = estimateMessageTokens(messages);
            console.log(`[模拟完成] ${messages.length} 条消息, ~${tokens} tokens\n`);
            return true;
        }

        if (cmd === '执行防线' || cmd === 'defend') {
            console.log('\n--- 执行三层防线 ---');
            const before = estimateMessageTokens(messages);
            const def = applyDefense(messages, timestamps);
            messages = def.messages;
            console.log(`  [Layer 2] 截断: ${def.truncated} 条, 预算清理: ${def.compacted} 条`);
            console.log(`  [Layer 3] 软修剪: ${def.softPruned}, 硬清除: ${def.hardPruned}`);
            console.log(
                `  [结果] ~${before} → ~${def.tokenEstimate} tokens (节省 ${before - def.tokenEstimate})\n`,
            );
            return true;
        }

        if (cmd === '查看状态' || cmd === 'status') {
            const tokens = estimateMessageTokens(messages);
            const toolMsgs = messages.filter((m) => m.role === 'tool').length;
            console.log(
                `\n[状态] ${messages.length} 条消息 (${toolMsgs} 条工具结果), ~${tokens} tokens\n`,
            );
            return true;
        }

        // /context: 终端可视化的 context 占用，参考 Claude Code 的 /context
        if (cmd === '/context' || cmd === 'context') {
            const snapshot = buildContextSnapshot({
                modelName: process.env.DASHSCOPE_API_KEY ? 'Qwen Plus' : 'Mock Model (开发用)',
                modelId: process.env.DASHSCOPE_API_KEY ? 'qwen3-6-plus' : 'mock-model',
                windowTokens: 1_000_000,
                systemPromptChars: SYSTEM.length,
                toolDescriptionChars: registry
                    .getActiveTools()
                    .reduce(
                        (a, t) =>
                            a +
                            t.name.length +
                            (t.description?.length || 0) +
                            JSON.stringify(t.parameters || {}).length,
                        0,
                    ),
                memoryChars: 0,
                skillsChars: 0,
                messages,
            });
            console.log(renderContextView(snapshot));
            return true;
        }

        if (cmd === '/usage' || cmd === 'usage') {
            console.log(renderUsageView(tracker));
            return true;
        }

        if (cmd === '/cache off' || cmd === 'cache off') {
            setCacheEnabled(false);
            console.log(
                '\n  \x1b[38;5;220m⚠ 已关闭 cache 模拟\x1b[0m  接下来每次请求都按 cache miss 计算\n',
            );
            return true;
        }
        if (cmd === '/cache on' || cmd === 'cache on') {
            setCacheEnabled(true);
            console.log('\n  \x1b[38;5;36m✓ 已开启 cache 模拟\x1b[0m\n');
            return true;
        }

        return false;
    }

    function ask() {
        rl.question('\nYou: ', async (input) => {
            const trimmed = input.trim();
            if (!trimmed || trimmed === 'exit') {
                console.log('Bye!');
                rl.close();
                return;
            }

            if (handleQuickTrigger(trimmed)) {
                ask();
                return;
            }

            const userMsg: ModelMessage = { role: 'user', content: trimmed };
            messages.push(userMsg);
            timestamps.set(messages.length - 1, Date.now());
            store.append(userMsg);

            const beforeLen = messages.length;
            await agentLoop(model, registry, messages, SYSTEM, tracker);

            const newMessages = messages.slice(beforeLen);
            const now = Date.now();
            for (let i = beforeLen; i < messages.length; i++) {
                timestamps.set(i, now);
            }
            store.appendAll(newMessages);

            // Apply defense after each turn
            const status = estimateMessageTokens(messages);
            console.log(`  [Token] ~${status} tokens`);

            ask();
        });
    }

    console.log('Super Agent v0.10 — Cache & Cost (type "exit" to quit)');
    console.log('快捷命令：');
    console.log('  /context    — 终端里看 context 占用矩阵（参考 Claude Code）');
    console.log('  /usage      — 累计 token 用量、cache 命中率、节省金额');
    console.log('  /cache off  — 关闭 cache 模拟，对比开 vs 关的成本差');
    console.log('  /cache on   — 重新开启 cache 模拟');
    console.log('  status      — 当前消息数和 token 估算');

    // 启动时直接秀一次 /context，让用户立刻看到初始上下文构成
    const startupSnapshot = buildContextSnapshot({
        modelName: process.env.DASHSCOPE_API_KEY ? 'Qwen Plus' : 'Mock Model (开发用)',
        modelId: process.env.DASHSCOPE_API_KEY ? 'qwen3-6-plus' : 'mock-model',
        windowTokens: 1_000_000,
        systemPromptChars: SYSTEM.length,
        toolDescriptionChars: registry
            .getActiveTools()
            .reduce(
                (a, t) =>
                    a +
                    t.name.length +
                    (t.description?.length || 0) +
                    JSON.stringify(t.parameters || {}).length,
                0,
            ),
        memoryChars: 0,
        skillsChars: 0,
        messages,
    });
    console.log(renderContextView(startupSnapshot));
    ask();
}

main().catch(console.error);
