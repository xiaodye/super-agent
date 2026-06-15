import type { ToolRegistry, ToolDefinition } from './registry.js';

export function createToolSearchTool(registry: ToolRegistry): ToolDefinition {
    return {
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
}
