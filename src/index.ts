import 'dotenv/config';
import process from 'node:process';
import { generateText, streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel, ModelMessage } from 'ai';
import { createInterface } from 'node:readline';
import { calculatorTool, weatherTool } from './tools';
import { agentLoop } from './agent-loop';

const deepSeek = createOpenAI({
    baseURL: process.env.LLM_API_BASE,
    apiKey: process.env.LLM_API_KEY,
});

const model = deepSeek.chat(process.env.LLM_MODEL ?? 'deepseek-v4-flash');

const tools = { get_weather: weatherTool, calculator: calculatorTool };
const messages: ModelMessage[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;

function ask() {
    rl.question('\nYou: ', async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed === 'exit') {
            console.log('Bye!');
            rl.close();
            return;
        }

        messages.push({ role: 'user', content: trimmed });

        await agentLoop(model, tools, messages, SYSTEM);

        ask();
    });
}

console.log('Super Agent v0.2 — Agent Loop (type "exit" to quit)\n');
ask();
