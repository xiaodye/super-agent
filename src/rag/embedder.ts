const DIMS = 128;

/**
 * 将一批文本转换为向量的 embedding 函数接口。
 */
export type EmbeddingFn = (texts: string[]) => Promise<number[][]>;

/**
 * 创建本地 mock embedder，用于无外部 API key 的开发与测试。
 */
export function createMockEmbedder(): EmbeddingFn {
    return async (texts: string[]) => texts.map(mockEmbed);
}

/**
 * 创建 DashScope 兼容 OpenAI embeddings 接口的远程 embedder。
 */
export function createDashScopeEmbedder(apiKey: string): EmbeddingFn {
    return async (texts: string[]) => {
        const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'text-embedding-v3',
                input: texts,
                dimensions: DIMS,
            }),
        });
        if (!resp.ok) {
            throw new Error(`Embedding API error: ${resp.status} ${await resp.text()}`);
        }
        const data = (await resp.json()) as any;
        return data.data.map((d: any) => d.embedding as number[]);
    };
}

const embedCache = new Map<string, number[]>();

/**
 * 批量生成 embedding，并用文本内容作为 key 复用已计算向量。
 */
export async function embed(fn: EmbeddingFn, texts: string[]): Promise<number[][]> {
    const results: number[][] = new Array(texts.length);
    const uncached: { idx: number; text: string }[] = [];

    for (let i = 0; i < texts.length; i++) {
        const cached = embedCache.get(texts[i]);
        if (cached) {
            results[i] = cached;
        } else {
            uncached.push({ idx: i, text: texts[i] });
        }
    }

    if (uncached.length > 0) {
        const vectors = await fn(uncached.map((u) => u.text));
        for (let i = 0; i < uncached.length; i++) {
            results[uncached[i].idx] = vectors[i];
            embedCache.set(uncached[i].text, vectors[i]);
        }
    }

    return results;
}

/**
 * 使用确定性哈希方式生成归一化向量，模拟语义 embedding 的调用形态。
 */
function mockEmbed(text: string): number[] {
    const vec = new Array(DIMS).fill(0);
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        vec[i % DIMS] += code;
        vec[(i * 7 + 13) % DIMS] += code * 0.3;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
}

/**
 * 计算两个向量的 cosine similarity，用于衡量语义相似度。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0,
        normA = 0,
        normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export { DIMS };
