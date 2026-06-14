import 'dotenv/config';
import process from 'node:process';
import { createOpenAI } from '@ai-sdk/openai';
import type { ModelMessage } from 'ai';
import { createInterface } from 'node:readline';
import { allTools } from './tools';
import { agentLoop, type BudgetState } from './agent-loop';
import { ToolRegistry } from './tool-registry';
import { createMockModel } from './mock-model';
import { MCPClient, MockMCPClient } from './mcp-client';

const deepSeek = createOpenAI({
    baseURL: process.env.LLM_API_BASE,
    apiKey: process.env.LLM_API_KEY,
});

const model = deepSeek.chat(process.env.LLM_MODEL ?? 'deepseek-v4-flash');

// mock
// const model = createMockModel();

const registry = new ToolRegistry();
registry.register(...allTools);

// 预算由调用方持有，跨轮持续累计——agentLoop 只负责消费它
const budget: BudgetState = { used: 0, limit: 150000 };

console.log(`已注册 ${registry.getAll().length} 个工具：`);
for (const tool of registry.getAll()) {
    const flags = [
        tool.isConcurrencySafe ? '可并发' : '串行',
        tool.isReadOnly ? '只读' : '读写',
    ].join(', ');
    console.log(`  - ${tool.name}（${flags}）`);
}

const messages: ModelMessage[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有以下工具可用：get_weather, calculator, read_file, write_file, list_directory。
需要查询信息或操作文件时，主动使用工具，不要编造数据。
可以同时调用多个互不冲突的工具来提高效率。
回答要简洁直接。`;

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

    console.log(`\n已注册 ${registry.getAll().length} 个工具：`);
    for (const tool of registry.getAll()) {
        const isMCP = tool.name.startsWith('mcp__');
        const flags = [isMCP ? 'MCP' : '内置', tool.isConcurrencySafe ? '可并发' : '串行'].join(
            ', ',
        );
        console.log(`  - ${tool.name}（${flags}）`);
    }

    const messages: ModelMessage[] = [];
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有内置工具和 MCP 工具可用。MCP 工具以 mcp__ 开头，如 mcp__github__list_issues。
需要查询 GitHub 信息时，使用 mcp__github__ 前缀的工具。
需要操作本地文件时，使用内置工具。
回答要简洁直接。`;

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
            await agentLoop(model, registry, messages, SYSTEM, budget);
            ask();
        });
    }

    console.log('\nSuper Agent v0.5 — MCP (type "exit" to quit)');
    console.log('试试："查看 vercel/ai 的 issues"、"搜索 MCP 相关的仓库"\n');
    ask();
}

main().catch(console.error);
