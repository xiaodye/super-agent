import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';
import fg from 'fast-glob';
import type { ToolDefinition } from './tool-registry.js';

// ── 上一篇已有的工具 ─────────────────────────────

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
    maxResultChars: 3000,
    execute: async ({ path }: { path: string }) => {
        const resolved = resolve(path);
        if (!existsSync(resolved)) return `文件不存在: ${path}`;
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
        if (!existsSync(resolved)) return `目录不存在: ${path}`;
        return readdirSync(resolved)
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

// ── 本篇新增的工具 ─────────────────────────────

export const editFileTool: ToolDefinition = {
    name: 'edit_file',
    description:
        '精确替换文件中的指定内容。用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写——只改你指定的部分',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '文件路径' },
            old_string: { type: 'string', description: '要被替换的原始文本（必须精确匹配）' },
            new_string: { type: 'string', description: '替换后的新文本' },
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async ({
        path,
        old_string,
        new_string,
    }: {
        path: string;
        old_string: string;
        new_string: string;
    }) => {
        const resolved = resolve(path);
        if (!existsSync(resolved)) return `文件不存在: ${path}`;

        const content = readFileSync(resolved, 'utf-8');
        const count = content.split(old_string).length - 1;

        if (count === 0) {
            return `未找到匹配内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）`;
        }
        if (count > 1) {
            return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`;
        }

        const updated = content.replace(old_string, new_string);
        writeFileSync(resolved, updated, 'utf-8');
        return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`;
    },
};

export const globTool: ToolDefinition = {
    name: 'glob',
    description:
        '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: '搜索模式，如 "**/*.ts"、"src/*.json"' },
            path: { type: 'string', description: '搜索起始目录，默认当前目录' },
        },
        required: ['pattern'],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }) => {
        const results = await fg(pattern, {
            cwd: resolve(path),
            ignore: ['node_modules/**', '.git/**'],
            dot: false,
            onlyFiles: true,
            followSymbolicLinks: false,
        });
        if (results.length === 0) return `没有找到匹配 "${pattern}" 的文件`;
        return results.sort().join('\n');
    },
};

export const grepTool: ToolDefinition = {
    name: 'grep',
    description: '在文件中搜索匹配指定模式的内容。返回匹配的行号和内容',
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: '搜索模式（正则表达式）' },
            path: { type: 'string', description: '搜索路径（文件或目录），默认当前目录' },
        },
        required: ['pattern'],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 3000,
    execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }) => {
        const baseDir = resolve(path);
        const regex = new RegExp(pattern, 'i');
        const matches: string[] = [];
        const SKIP = new Set(['node_modules', '.git', 'dist']);
        const BIN_EXT = new Set(['.png', '.jpg', '.gif', '.woff', '.woff2', '.ico', '.lock']);

        function searchFile(filePath: string) {
            if (matches.length >= 50) return;
            const ext = filePath.slice(filePath.lastIndexOf('.'));
            if (BIN_EXT.has(ext)) return;

            let content: string;
            try {
                content = readFileSync(filePath, 'utf-8');
            } catch {
                return;
            }

            const lines = content.split('\n');
            const rel = relative(baseDir, filePath);
            for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                    matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`);
                    if (matches.length >= 50) return;
                }
            }
        }

        function walk(dir: string) {
            if (matches.length >= 50) return;
            let entries: string[];
            try {
                entries = readdirSync(dir);
            } catch {
                return;
            }

            for (const name of entries) {
                if (SKIP.has(name)) continue;
                const full = join(dir, name);
                try {
                    const stat = statSync(full);
                    if (stat.isDirectory()) walk(full);
                    else searchFile(full);
                } catch {
                    /* skip */
                }
            }
        }

        const stat = statSync(baseDir);
        if (stat.isFile()) {
            searchFile(baseDir);
        } else {
            walk(baseDir);
        }

        if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`;
        const suffix = matches.length >= 50 ? '\n... (结果已截断，共 50+ 条匹配)' : '';
        return matches.join('\n') + suffix;
    },
};

export const bashTool: ToolDefinition = {
    name: 'bash',
    description: '执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作',
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: '要执行的 shell 命令' },
        },
        required: ['command'],
        additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    maxResultChars: 3000,
    execute: async ({ command }: { command: string }) => {
        try {
            execSync('echo test', { stdio: 'ignore' });
        } catch {
            return `[bash 不可用] 当前环境（WebContainer）不支持 shell 命令。本地终端运行 pnpm start 可使用 bash 工具。`;
        }

        try {
            const output = execSync(command, {
                encoding: 'utf-8',
                timeout: 10000,
                maxBuffer: 1024 * 1024,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            return output || '(命令执行成功，无输出)';
        } catch (err: any) {
            const stderr = err.stderr || '';
            const stdout = err.stdout || '';
            return `命令执行失败 (exit ${err.status || 1}):\n${stderr || stdout || err.message}`;
        }
    },
};

export const allTools: ToolDefinition[] = [
    weatherTool,
    calculatorTool,
    readFileTool,
    writeFileTool,
    listDirectoryTool,
    editFileTool,
    globTool,
    grepTool,
    bashTool,
];
