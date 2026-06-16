export interface Chunk {
    /** chunk 的稳定标识，通常由 source 与序号组合生成。 */
    id: string;

    /** 当前片段的正文内容，会作为 embedding 与关键词检索的输入。 */
    text: string;

    /** 原始文档或知识来源，用于结果追踪与来源聚合。 */
    source: string;

    /** 当前 chunk 在 source 内的顺序索引。 */
    index: number;

    /** 基于字符数估算的 token 数，用于粗略控制上下文预算。 */
    tokenEstimate: number;
}

const TARGET_TOKENS = 256;
const CHARS_PER_TOKEN = 4;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;

/**
 * 将文档按段落和句子切分为适合 embedding 的稳定 chunk。
 */
export function chunkDocument(source: string, text: string): Chunk[] {
    const paragraphs = text.split(/\n{2,}/);
    const chunks: Chunk[] = [];
    let current = '';
    let idx = 0;

    for (const para of paragraphs) {
        const trimmed = para.trim();
        if (!trimmed) continue;

        if (current.length + trimmed.length + 2 > TARGET_CHARS && current.length > 0) {
            chunks.push(makeChunk(source, current.trim(), idx++));
            current = '';
        }

        if (trimmed.length > TARGET_CHARS) {
            if (current.length > 0) {
                chunks.push(makeChunk(source, current.trim(), idx++));
                current = '';
            }
            const sentences = trimmed.split(/(?<=[。！？.!?])\s*/);
            let sentBuf = '';
            for (const sent of sentences) {
                if (sentBuf.length + sent.length + 1 > TARGET_CHARS && sentBuf.length > 0) {
                    chunks.push(makeChunk(source, sentBuf.trim(), idx++));
                    sentBuf = '';
                }
                sentBuf += (sentBuf ? ' ' : '') + sent;
            }
            if (sentBuf.trim()) {
                current = sentBuf.trim();
            }
        } else {
            current += (current ? '\n\n' : '') + trimmed;
        }
    }

    if (current.trim()) {
        chunks.push(makeChunk(source, current.trim(), idx++));
    }

    return chunks;
}

/**
 * 构造带稳定 id 与 token 估算值的 chunk 记录。
 */
function makeChunk(source: string, text: string, index: number): Chunk {
    return {
        id: `${source}#${index}`,
        text,
        source,
        index,
        tokenEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
    };
}
