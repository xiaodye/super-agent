import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { Chunk } from './chunker';
import type { StoredChunk } from './store';

/**
 * 基于 SQLite、sqlite-vec 与 FTS 的持久化向量存储。
 */
export class SqliteVectorStore {
    private db: Database.Database;

    /**
     * 打开或创建知识库数据库，并初始化向量与全文检索表。
     */
    constructor(dbPath: string = 'knowledge.db') {
        this.db = new Database(dbPath);
        sqliteVec.load(this.db); // 加载向量搜索扩展
        this.createTables();
    }

    /**
     * 创建 chunk 元数据、向量索引和 FTS 索引三类表结构。
     */
    private createTables() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        embedding TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'text-embedding-v3',
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[128]
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text, id UNINDEXED, source UNINDEXED
      );
    `);
    }

    /**
     * 将 chunk 同步写入元数据表、向量表和全文索引表。
     */
    add(chunk: Chunk, embedding: number[]): void {
        const now = Date.now();
        // 三表联动写入
        this.db
            .prepare(
                `INSERT OR REPLACE INTO chunks
      (id, text, source, chunk_index, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(chunk.id, chunk.text, chunk.source, chunk.index, JSON.stringify(embedding), now);

        this.db
            .prepare(
                `INSERT OR REPLACE INTO chunks_vec (id, embedding)
      VALUES (?, ?)`,
            )
            .run(chunk.id, Buffer.from(new Float32Array(embedding).buffer));

        this.db
            .prepare(
                `INSERT OR REPLACE INTO chunks_fts (id, text, source)
      VALUES (?, ?, ?)`,
            )
            .run(chunk.id, chunk.text, chunk.source);
    }

    /**
     * 在单个事务中批量写入 chunk，减少 SQLite 提交开销。
     */
    addBatch(items: Array<{ chunk: Chunk; embedding: number[] }>): void {
        const tx = this.db.transaction(() => {
            for (const { chunk, embedding } of items) this.add(chunk, embedding);
        });
        tx(); // 事务批量写入，比逐条快很多
    }

    /**
     * 使用 sqlite-vec 按 query embedding 检索最相近的 chunk。
     */
    vectorSearch(
        queryEmbedding: number[],
        topK: number,
    ): Array<{ chunk: StoredChunk; score: number }> {
        const buf = Buffer.from(new Float32Array(queryEmbedding).buffer);
        const rows = this.db
            .prepare(
                `
      SELECT v.id, v.distance, c.text, c.source, c.chunk_index, c.embedding
      FROM chunks_vec v
      JOIN chunks c ON c.id = v.id
      WHERE v.embedding MATCH ?
      ORDER BY v.distance
      LIMIT ?
    `,
            )
            .all(buf, topK) as any[];

        return rows.map((r) => ({
            chunk: {
                id: r.id,
                text: r.text,
                source: r.source,
                index: r.chunk_index,
                tokenEstimate: Math.ceil(r.text.length / 4),
                embedding: JSON.parse(r.embedding),
                addedAt: 0,
            },
            score: 1 - r.distance, // cosine distance → similarity
        }));
    }

    /**
     * 使用 FTS5 对 chunk 文本执行关键词检索，并转换 bm25 rank 为相似度分。
     */
    keywordSearch(query: string, topK: number): Array<{ chunk: StoredChunk; score: number }> {
        const rows = this.db
            .prepare(
                `
      SELECT f.id, bm25(chunks_fts) AS rank, c.text, c.source, c.chunk_index, c.embedding
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.id
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `,
            )
            .all(query, topK) as any[];

        return rows.map((r) => ({
            chunk: {
                id: r.id,
                text: r.text,
                source: r.source,
                index: r.chunk_index,
                tokenEstimate: Math.ceil(r.text.length / 4),
                embedding: JSON.parse(r.embedding),
                addedAt: 0,
            },
            score: r.rank < 0 ? -r.rank / (1 - r.rank) : 1 / (1 + r.rank),
        }));
    }

    /**
     * 返回持久化知识库中的 chunk 总数。
     */
    size(): number {
        return (this.db.prepare('SELECT COUNT(*) as n FROM chunks').get() as any).n;
    }

    /**
     * 查询当前知识库中所有去重后的文档来源。
     */
    sources(): string[] {
        return (this.db.prepare('SELECT DISTINCT source FROM chunks').all() as any[]).map(
            (r) => r.source,
        );
    }
}
