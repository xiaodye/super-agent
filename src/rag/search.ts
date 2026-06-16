import { cosineSimilarity } from './embedder.js';
import type { StoredChunk } from './store.js';
import type { VectorStore } from './store.js';
import type { EmbeddingFn } from './embedder.js';
import { embed } from './embedder.js';

export interface SearchResult {
    /** 命中的知识片段，包含原文、来源与 embedding。 */
    chunk: StoredChunk;

    /** 向量分与关键词分加权后的最终排序分。 */
    score: number;

    /** 归一化后的向量相似度分，用于解释语义匹配贡献。 */
    vectorScore: number;

    /** 归一化后的关键词匹配分，用于解释词面匹配贡献。 */
    keywordScore: number;
}

const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;
const CANDIDATE_MULTIPLIER = 4;
const MMR_LAMBDA = 0.7;

/**
 * 混合执行向量检索与关键词检索，并通过 MMR 降低结果重复度。
 */
export async function hybridSearch(
    store: VectorStore,
    embedFn: EmbeddingFn,
    query: string,
    topK: number = 5,
): Promise<SearchResult[]> {
    const all = store.getAll();
    if (all.length === 0) return [];

    const candidateCount = Math.min(topK * CANDIDATE_MULTIPLIER, all.length);

    // Path 1: Vector search
    const [queryVec] = await embed(embedFn, [query]);
    const vectorResults = all
        .map((chunk) => ({ chunk, score: cosineSimilarity(queryVec, chunk.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, candidateCount);

    // Path 2: Keyword search (BM25-like TF-IDF scoring)
    const queryTerms = tokenize(query);
    const docCount = all.length;
    const keywordResults = all
        .map((chunk) => ({ chunk, score: bm25Score(queryTerms, chunk.text, docCount, all) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, candidateCount);

    // Normalize scores to [0, 1]
    const vecNorm = normalizeMinMax(vectorResults.map((r) => r.score));
    const kwNorm = normalizeViaSigmoid(keywordResults.map((r) => r.score));

    // Merge into unified candidate set
    const candidates = new Map<string, SearchResult>();

    for (let i = 0; i < vectorResults.length; i++) {
        const id = vectorResults[i].chunk.id;
        candidates.set(id, {
            chunk: vectorResults[i].chunk,
            score: vecNorm[i] * VECTOR_WEIGHT,
            vectorScore: vecNorm[i],
            keywordScore: 0,
        });
    }

    for (let i = 0; i < keywordResults.length; i++) {
        const id = keywordResults[i].chunk.id;
        const existing = candidates.get(id);
        if (existing) {
            existing.keywordScore = kwNorm[i];
            existing.score += kwNorm[i] * KEYWORD_WEIGHT;
        } else {
            candidates.set(id, {
                chunk: keywordResults[i].chunk,
                score: kwNorm[i] * KEYWORD_WEIGHT,
                vectorScore: 0,
                keywordScore: kwNorm[i],
            });
        }
    }

    // Sort by combined score
    const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);

    // MMR deduplication
    return mmrSelect(sorted, topK);
}

// ── BM25 scoring ──────────────────────────

/**
 * 将查询或文档切成检索词，兼容英文单词与中文字符范围。
 */
function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^\w一-鿿]+/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1);
}

/**
 * 使用简化 BM25 公式计算查询词与单个文档的关键词相关性。
 */
function bm25Score(
    queryTerms: string[],
    docText: string,
    N: number,
    allDocs: StoredChunk[],
): number {
    const k1 = 1.2;
    const b = 0.75;
    const docTokens = tokenize(docText);
    const avgDl = allDocs.reduce((s, d) => s + tokenize(d.text).length, 0) / (N || 1);
    const dl = docTokens.length;
    let score = 0;

    for (const term of queryTerms) {
        const tf = docTokens.filter((t) => t === term).length;
        const df = allDocs.filter((d) => tokenize(d.text).includes(term)).length;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDl)));
        score += idf * tfNorm;
    }

    return score;
}

// ── Normalization ──────────────────────────

/**
 * 将一组分数按 min-max 映射到 0 到 1，保留相对排序差异。
 */
function normalizeMinMax(scores: number[]): number[] {
    if (scores.length === 0) return [];
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min || 1;
    return scores.map((s) => (s - min) / range);
}

/**
 * 用 sigmoid 压缩无界分数，避免关键词分极值主导混合排序。
 */
function normalizeViaSigmoid(scores: number[]): number[] {
    return scores.map((s) => 1 / (1 + Math.exp(-s)));
}

// ── MMR deduplication ──────────────────────

/**
 * 在高相关候选中选择多样化结果，减少内容高度相似的 chunk 扎堆。
 */
function mmrSelect(results: SearchResult[], topK: number): SearchResult[] {
    if (results.length <= topK) return results;

    const selected: SearchResult[] = [results[0]];
    const remaining = results.slice(1);

    while (selected.length < topK && remaining.length > 0) {
        let bestIdx = 0;
        let bestMmr = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const relevance = remaining[i].score;
            const maxSim = Math.max(
                ...selected.map((s) => jaccardSimilarity(s.chunk.text, remaining[i].chunk.text)),
            );
            const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;
            if (mmr > bestMmr) {
                bestMmr = mmr;
                bestIdx = i;
            }
        }

        selected.push(remaining[bestIdx]);
        remaining.splice(bestIdx, 1);
    }

    return selected;
}

/**
 * 基于分词集合计算 Jaccard 相似度，作为 MMR 的文本重复度指标。
 */
function jaccardSimilarity(a: string, b: string): number {
    const setA = new Set(tokenize(a));
    const setB = new Set(tokenize(b));
    const intersection = [...setA].filter((t) => setB.has(t)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
}
