import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';

const SESSION_DIR = '.sessions';
const DEFAULT_SESSION = 'default';

export interface SessionEntry {
    /** JSONL 记录类型，目前仅持久化对话消息。 */
    type: 'message';

    /** 写入会话文件时的 ISO 时间戳。 */
    timestamp: string;

    /** 需要恢复到模型上下文中的消息内容。 */
    message: ModelMessage;
}

/**
 * 以 JSONL 文件持久化模型消息，支持按 sessionId 追加和恢复会话上下文。
 */
export class SessionStore {
    /** 存放会话 JSONL 文件的目录。 */
    private dir: string;

    /** 当前会话的文件名标识。 */
    private sessionId: string;

    /**
     * 初始化会话存储目录，并绑定当前会话标识。
     *
     * @param sessionId 会话标识，默认写入 default 会话文件。
     */
    constructor(sessionId: string = DEFAULT_SESSION) {
        this.sessionId = sessionId;
        this.dir = SESSION_DIR;
        if (!existsSync(this.dir)) {
            mkdirSync(this.dir, { recursive: true });
        }
    }

    /**
     * 计算当前 sessionId 对应的 JSONL 文件路径。
     *
     * @returns
     */
    private get filePath(): string {
        return join(this.dir, `${this.sessionId}.jsonl`);
    }

    /**
     * 将单条模型消息追加写入当前会话文件。
     *
     * @param message 待持久化的模型消息。
     */
    append(message: ModelMessage): void {
        const entry: SessionEntry = {
            type: 'message',
            timestamp: new Date().toISOString(),
            message,
        };
        appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    }

    /**
     * 按顺序追加多条模型消息，保持原始上下文顺序。
     *
     * @param messages 待写入当前会话的模型消息列表。
     */
    appendAll(messages: ModelMessage[]): void {
        for (const msg of messages) {
            this.append(msg);
        }
    }

    /**
     * 从当前会话文件恢复有效消息，忽略空行和损坏的 JSONL 记录。
     *
     * @returns
     */
    load(): ModelMessage[] {
        if (!existsSync(this.filePath)) return [];

        const content = readFileSync(this.filePath, 'utf-8').trim();
        if (!content) return [];

        const messages: ModelMessage[] = [];
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
                const entry: SessionEntry = JSON.parse(line);
                if (entry.type === 'message') {
                    messages.push(entry.message);
                }
            } catch {
                // 忽略损坏的历史记录，避免单行问题导致整个会话无法恢复。
            }
        }
        return messages;
    }

    /**
     * 判断当前会话文件是否已经存在。
     *
     * @returns
     */
    exists(): boolean {
        return existsSync(this.filePath);
    }

    /**
     * 统计当前会话可恢复的消息数量。
     *
     * @returns
     */
    getMessageCount(): number {
        return this.load().length;
    }
}
