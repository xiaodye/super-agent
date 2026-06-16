import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client';

const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN! },
});

const client = new Client({ name: 'super-agent', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const result = await client.callTool({
    name: 'list_issues',
    arguments: { owner: 'vercel', repo: 'ai' },
});
