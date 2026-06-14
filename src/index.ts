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

const deepSeek = createOpenAI({
    baseURL: process.env.LLM_API_BASE,
    apiKey: process.env.LLM_API_KEY,
});

const model = deepSeek.chat(process.env.LLM_MODEL ?? 'deepseek-v4-flash');

// mock
// const model = createMockModel();

const registry = new ToolRegistry();

registry.register(...allTools);

// 注册 tool_search 元工具
const toolSearchTool: ToolDefinition = {
    name: 'tool_search',
    description:
        '获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名',
            },
        },
        required: ['query'],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ query }: { query: string }) => {
        const results = registry.searchTools(query);
        if (results.length === 0) {
            return `没有找到匹配 "${query}" 的工具`;
        }
        return results.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        }));
    },
};

registry.register(toolSearchTool);

// 模拟额外的 MCP 工具（演示工具膨胀问题）
function registerSimulatedTools() {
    const simulatedTools: ToolDefinition[] = [
        // Notion MCP 模拟
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
            name: 'mcp__notion__list_databases',
            description: '[MCP:notion] 列出 Notion 数据库',
            parameters: { type: 'object', properties: {}, required: [] },
            shouldDefer: true,
            searchHint: 'notion list databases tables',
            isConcurrencySafe: true,
            isReadOnly: true,
            execute: async () =>
                JSON.stringify([
                    { title: '项目追踪', id: 'db-001' },
                    { title: '知识库', id: 'db-002' },
                ]),
        },

        // Playwright MCP 模拟
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
            name: 'mcp__browser__click',
            description: '[MCP:browser] 点击页面元素',
            parameters: {
                type: 'object',
                properties: { selector: { type: 'string' } },
                required: ['selector'],
            },
            shouldDefer: true,
            searchHint: 'browser click element button',
            isConcurrencySafe: false,
            isReadOnly: false,
            execute: async ({ selector }: any) => `已点击 ${selector}`,
        },
        {
            name: 'mcp__browser__fill',
            description: '[MCP:browser] 在输入框中填写内容',
            parameters: {
                type: 'object',
                properties: { selector: { type: 'string' }, value: { type: 'string' } },
                required: ['selector', 'value'],
            },
            shouldDefer: true,
            searchHint: 'browser fill input form text',
            isConcurrencySafe: false,
            isReadOnly: false,
            execute: async ({ selector, value }: any) => `已在 ${selector} 填写 ${value}`,
        },
        {
            name: 'mcp__browser__get_text',
            description: '[MCP:browser] 获取页面文本内容',
            parameters: {
                type: 'object',
                properties: { selector: { type: 'string' } },
                required: ['selector'],
            },
            shouldDefer: true,
            searchHint: 'browser get text content extract',
            isConcurrencySafe: true,
            isReadOnly: true,
            execute: async ({ selector }: any) => `Mock text content of ${selector}`,
        },

        // Supabase MCP 模拟
        {
            name: 'mcp__supabase__query',
            description: '[MCP:supabase] 执行 SQL 查询',
            parameters: {
                type: 'object',
                properties: { sql: { type: 'string' } },
                required: ['sql'],
            },
            shouldDefer: true,
            searchHint: 'database sql query select',
            isConcurrencySafe: true,
            isReadOnly: true,
            execute: async ({ sql }: any) => JSON.stringify([{ id: 1, name: 'mock_row', sql }]),
        },
        {
            name: 'mcp__supabase__list_tables',
            description: '[MCP:supabase] 列出数据库所有表',
            parameters: { type: 'object', properties: {} },
            shouldDefer: true,
            searchHint: 'database list tables schema',
            isConcurrencySafe: true,
            isReadOnly: true,
            execute: async () => JSON.stringify(['users', 'orders', 'products']),
        },
        {
            name: 'mcp__supabase__describe_table',
            description: '[MCP:supabase] 查看表结构',
            parameters: {
                type: 'object',
                properties: { table: { type: 'string' } },
                required: ['table'],
            },
            shouldDefer: true,
            searchHint: 'database describe table columns schema',
            isConcurrencySafe: true,
            isReadOnly: true,
            execute: async ({ table }: any) =>
                JSON.stringify({
                    table,
                    columns: [
                        { name: 'id', type: 'integer' },
                        { name: 'name', type: 'text' },
                    ],
                }),
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
    console.log(`  已注册 ${simCount} 个模拟 MCP 工具（Notion/Browser/Supabase）`);

    const allCount = registry.getAll().length;
    const activeTools = registry.getActiveTools();
    const estimate = registry.countTokenEstimate();

    console.log(`\n=== 工具统计 ===`);
    console.log(`  全部工具: ${allCount} 个`);
    console.log(`  活跃工具: ${activeTools.length} 个（非延迟）`);
    console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
    console.log(`  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`);

    const deferredSummary = registry.getDeferredToolSummary();

    const messages: ModelMessage[] = [];
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有内置工具和 MCP 工具可用。
如果你需要的工具不在当前列表中，使用 tool_search 工具搜索可用工具。
回答要简洁直接。${deferredSummary}`;

    function ask() {
        rl.question('\nYou: ', async (input) => {
            const trimmed = input.trim();
            if (!trimmed || trimmed === 'exit') {
                console.log('Bye!');
                await registry.closeAllMCP();
                rl.close();
                return;
            }

            messages.push({ role: 'user', content: trimmed });
            await agentLoop(model, registry, messages, SYSTEM);
            ask();
        });
    }

    console.log('\nSuper Agent v0.6 — Dynamic Tools (type "exit" to quit)');
    console.log('试试："查看 vercel/ai 的 issues"（会触发 tool_search）\n');
    ask();
}

main().catch(console.error);
