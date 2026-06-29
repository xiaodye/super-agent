import type { Chunk } from './chunker';

export interface StoredChunk extends Chunk {
    /** 当前 chunk 的向量表示，用于相似度检索与排序。 */
    embedding: number[];

    /** 写入内存 store 的时间戳，便于后续判断数据新旧。 */
    addedAt: number;
}

/**
 * 提供进程内的轻量向量存储，适合临时知识库或测试场景。
 */
export class VectorStore {
    private chunks: StoredChunk[] = [];

    /**
     * 写入或覆盖指定 chunk 的向量，保证相同 id 只保留最新版本。
     *
     * @param chunk 待存储的知识片段元数据。
     * @param embedding 与 chunk 文本对应的向量表示。
     */
    add(chunk: Chunk, embedding: number[]): void {
        const existing = this.chunks.findIndex((c) => c.id === chunk.id);
        if (existing >= 0) {
            this.chunks[existing] = { ...chunk, embedding, addedAt: Date.now() };
        } else {
            this.chunks.push({ ...chunk, embedding, addedAt: Date.now() });
        }
    }

    /**
     * 批量写入 chunk 与 embedding，复用单条写入的去重逻辑。
     *
     * @param items 待写入的 chunk 与 embedding 配对列表。
     */
    addBatch(items: Array<{ chunk: Chunk; embedding: number[] }>): void {
        for (const { chunk, embedding } of items) {
            this.add(chunk, embedding);
        }
    }

    /**
     * 返回当前所有已存储 chunk，供检索流程读取完整候选集。
     *
     * @returns
     */
    getAll(): StoredChunk[] {
        return this.chunks;
    }

    /**
     * 返回 store 中 chunk 的数量，用于状态展示或空库判断。
     *
     * @returns
     */
    size(): number {
        return this.chunks.length;
    }

    /**
     * 清空内存中的全部向量数据，常用于重建知识库。
     */
    clear(): void {
        this.chunks = [];
    }

    /**
     * 汇总当前知识库包含的 source 列表，去除重复来源。
     *
     * @returns
     */
    sources(): string[] {
        return [...new Set(this.chunks.map((c) => c.source))];
    }
}
