import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ToolDefinition } from './tool-registry';

export const weatherTool: ToolDefinition = {
    name: 'get_weather',
    description: '查询指定城市的天气信息',
    parameters: {
        type: 'object',
        properties: {
            city: { type: 'string', description: '城市名称，如"北京"、"上海"' },
        },
        required: ['city'],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ city }: { city: string }) => {
        const data: Record<string, string> = {
            北京: '晴，15-25°C，东南风 2 级',
            上海: '多云，18-22°C，西南风 3 级',
            深圳: '阵雨，22-28°C，南风 2 级',
            广州: '多云转晴，20-28°C，东风 3 级',
            杭州: '晴，14-24°C，北风 2 级',
            成都: '阴，16-22°C，微风',
        };
        return data[city] || `${city}：暂无数据`;
    },
};

export const calculatorTool: ToolDefinition = {
    name: 'calculator',
    description: '计算数学表达式的结果。当用户提问涉及数学运算时使用',
    parameters: {
        type: 'object',
        properties: {
            expression: { type: 'string', description: '数学表达式，如 "2 + 3 * 4"' },
        },
        required: ['expression'],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ expression }: { expression: string }) => {
        try {
            const result = new Function(`return ${expression}`)();
            return `${expression} = ${result}`;
        } catch {
            return `无法计算: ${expression}`;
        }
    },
};

export const readFileTool: ToolDefinition = {
    name: 'read_file',
    description: '读取指定路径的文件内容',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '文件路径' },
        },
        required: ['path'],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 500,
    execute: async ({ path }: { path: string }) => {
        const resolved = resolve(path);
        return readFileSync(resolved, 'utf-8');
    },
};

export const writeFileTool: ToolDefinition = {
    name: 'write_file',
    description: '写入内容到指定文件。如果文件已存在则覆盖',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '文件路径' },
            content: { type: 'string', description: '要写入的内容' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async ({ path, content }: { path: string; content: string }) => {
        const resolved = resolve(path);
        writeFileSync(resolved, content, 'utf-8');
        return `已写入 ${content.length} 字符到 ${path}`;
    },
};

export const listDirectoryTool: ToolDefinition = {
    name: 'list_directory',
    description: '列出指定目录下的文件和子目录',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '目录路径，默认为当前目录' },
        },
        required: [],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ path = '.' }: { path?: string }) => {
        const resolved = resolve(path);
        const entries = readdirSync(resolved);
        return entries
            .map((name) => {
                try {
                    const stat = statSync(join(resolved, name));
                    return `${stat.isDirectory() ? '[DIR]' : '[FILE]'} ${name}`;
                } catch {
                    return `[?] ${name}`;
                }
            })
            .join('\n');
    },
};

export const allTools: ToolDefinition[] = [
    weatherTool,
    calculatorTool,
    readFileTool,
    writeFileTool,
    listDirectoryTool,
];
