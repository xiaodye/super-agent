import 'dotenv/config';
import process from 'node:process';
import { createOpenAI } from '@ai-sdk/openai';
import type { ModelMessage } from 'ai';
import { createInterface } from 'node:readline';
import { allTools } from './tools';
import { agentLoop } from './agent/agent-loop';
import { ToolDefinition, ToolRegistry } from './tools/registry';
import { createMockModel } from './mock-model';
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

const deepSeek = createOpenAI({
    baseURL: process.env.LLM_API_BASE,
    apiKey: process.env.LLM_API_KEY,
});

const model = deepSeek.chat(process.env.LLM_MODEL ?? 'deepseek-v4-flash');

// mock
// const model = createMockModel();

const registry = new ToolRegistry();
registry.register(...allTools);

// tool_search 元工具
const toolSearchTool: ToolDefinition = {
    name: 'tool_search',
    description:
        '获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个',
            },
        },
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

// 模拟 MCP 工具
function registerSimulatedTools() {
    const simulatedTools: ToolDefinition[] = [
        {
            name: 'mcp__notion__search_pages',
            description: '[MCP:notion] 搜索 Notion 页面',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
            },
            shouldDefer: true,
            searchHint: 'notion search pages documents',
            isConcurrencySafe: true,
            isReadOnly: true,
            execute: async ({ query }: any) =>
                JSON.stringify([{ title: `Mock: ${query}`, id: 'page-001' }]),
        },
        {
            name: 'mcp__notion__create_page',
            description: '[MCP:notion] 创建 Notion 页面',
            parameters: {
                type: 'object',
                properties: { title: { type: 'string' }, content: { type: 'string' } },
                required: ['title'],
            },
            shouldDefer: true,
            searchHint: 'notion create page document write',
            isConcurrencySafe: false,
            isReadOnly: false,
            execute: async ({ title }: any) => `已创建页面: ${title}`,
        },
        {
            name: 'mcp__browser__navigate',
            description: '[MCP:browser] 导航到指定 URL',
            parameters: {
                type: 'object',
                properties: { url: { type: 'string' } },
                required: ['url'],
            },
            shouldDefer: true,
            searchHint: 'browser navigate open url webpage',
            isConcurrencySafe: false,
            isReadOnly: false,
            execute: async ({ url }: any) => `已导航到 ${url}`,
        },
        {
            name: 'mcp__browser__screenshot',
            description: '[MCP:browser] 对当前页面截图',
            parameters: { type: 'object', properties: {} },
            shouldDefer: true,
            searchHint: 'browser screenshot capture page',
            isConcurrencySafe: true,
            isReadOnly: true,
            execute: async () => '[screenshot data]',
        },
        {
            name: 'mcp__supabase__query',
            description: '[MCP:supabase] 执行 SQL 查询',
            parameters: {
                type: 'object',
                properties: { sql: { type: 'string' } },
                required: ['sql'],
            },
            shouldDefer: true,
            searchHint: 'supabase database sql query select',
            isConcurrencySafe: true,
            isReadOnly: true,
            execute: async ({ sql }: any) => JSON.stringify([{ id: 1, name: 'mock_row', sql }]),
        },
        {
            name: 'mcp__supabase__list_tables',
            description: '[MCP:supabase] 列出数据库所有表',
            parameters: { type: 'object', properties: {} },
            shouldDefer: true,
            searchHint: 'supabase database list tables schema',
            isConcurrencySafe: true,
            isReadOnly: true,
            execute: async () => JSON.stringify(['users', 'orders', 'products']),
        },
    ];
    registry.register(...simulatedTools);
    return simulatedTools.length;
}

async function connectMCP() {
    const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

    let canSpawn = true;
    try {
        const { execSync } = await import('node:child_process');
        execSync('echo test', { stdio: 'ignore' });
    } catch {
        canSpawn = false;
    }

    if (githubToken && canSpawn) {
        console.log('\n连接 GitHub MCP Server...');
        try {
            const client = new MCPClient('npx', ['-y', '@modelcontextprotocol/server-github'], {
                GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
            });
            const tools = await registry.registerMCPServer('github', client);
            console.log(`  已注册 ${tools.length} 个 MCP 工具`);
            return;
        } catch (err) {
            console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`);
            console.log('  降级为 Mock MCP...');
        }
    }

    if (!githubToken) {
        console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP');
    }

    const mockClient = new MockMCPClient();
    const tools = await registry.registerMCPServer('github', mockClient);
    console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

async function main() {
    await connectMCP();
    const simCount = registerSimulatedTools();
    console.log(`  已注册 ${simCount} 个模拟 MCP 工具`);

    // Session 持久化
    const isContinue = process.argv.includes('--continue');
    const sessionId = 'default';
    const store = new SessionStore(sessionId);

    let messages: ModelMessage[] = [];
    if (isContinue && store.exists()) {
        messages = store.load();
        console.log(`\n[Session] 恢复会话 "${sessionId}"，${messages.length} 条历史消息`);
    } else {
        console.log(`\n[Session] 新会话 "${sessionId}"`);
    }

    // Prompt Pipe 组装 system prompt
    const builder = new PromptBuilder()
        .pipe('coreRules', coreRules())
        .pipe('toolGuide', toolGuide())
        .pipe('deferredTools', deferredTools())
        .pipe('sessionContext', sessionContext());

    const promptCtx: PromptContext = {
        toolCount: registry.getActiveTools().length,
        deferredToolSummary: registry.getDeferredToolSummary(),
        sessionMessageCount: messages.length,
        sessionId,
    };

    const SYSTEM = builder.build(promptCtx);

    // Debug: 显示 Prompt Pipe 各模块状态
    builder.debug(promptCtx);

    const activeTools = registry.getActiveTools();
    console.log(`活跃工具: ${activeTools.length} 个`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    function ask() {
        rl.question('\nYou: ', async (input) => {
            const trimmed = input.trim();
            if (!trimmed || trimmed === 'exit') {
                console.log('Bye!');
                await registry.closeAllMCP();
                rl.close();
                return;
            }

            const userMsg: ModelMessage = { role: 'user', content: trimmed };
            messages.push(userMsg);
            store.append(userMsg);

            const beforeLen = messages.length;
            await agentLoop(model, registry, messages, SYSTEM);

            // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
            const newMessages = messages.slice(beforeLen);
            store.appendAll(newMessages);

            ask();
        });
    }

    console.log('Super Agent v0.7 — Session + Prompt Pipe (type "exit" to quit)');
    console.log('对话会自动保存。用 pnpm run continue 恢复上次对话。\n');
    ask();
}

main().catch(console.error);
