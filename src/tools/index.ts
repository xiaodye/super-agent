import type { ToolDefinition } from './registry';
import { weatherTool, calculatorTool } from './utility-tools';
import { readFileTool, writeFileTool, editFileTool, listDirectoryTool } from './file-tools';
import { globTool, grepTool } from './search-tools';
import { bashTool } from './shell-tools';
import { pickSearchTool, webFetchTool } from './web-search';

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
    pickSearchTool(),
    webFetchTool,
];

export {
    weatherTool,
    calculatorTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirectoryTool,
    globTool,
    grepTool,
    bashTool,
};
