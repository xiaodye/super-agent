---
name: add-tsdoc-comments
description: Add concise Chinese TSDoc comments to TypeScript or TSX code. Use when Codex needs to document functions, methods, class members, interface fields, type members, exported APIs, hooks, utilities, services, or complex TypeScript declarations so readers can understand intent without changing behavior.
---

# Add TSDoc Comments

## Overview

Add useful TSDoc to TypeScript code while preserving behavior, formatting, and the project's style. Prefer comments that explain intent, contracts, side effects, and domain meaning rather than restating names or types.

## Workflow

1. Inspect the surrounding code before editing. Understand naming conventions, existing TSDoc style, domain terms, and whether the file uses semicolons, decorators, overloads, or generated-code markers.
2. Add or improve TSDoc for every function and method in the requested scope, including exported functions, local helper functions, arrow functions assigned to variables, class methods, object-literal methods, hooks, callbacks with meaningful behavior, and overloaded implementations.
3. Add TSDoc for interface fields and object-like type members in the requested scope. Include type aliases with object members when they serve the same role as interfaces.
4. Preserve existing useful comments. Improve stale, vague, or English-only comments when the user asked for Chinese comments, but do not duplicate TSDoc blocks.
5. Do not change runtime behavior, public signatures, imports, exports, formatting unrelated to comments, or generated files unless the user explicitly asks.

## Comment Style

- Write comments in Chinese. Keep accepted professional terms in English when they are clearer, such as cache, payload, token, stream, debounce, schema, middleware, or endpoint.
- Keep comments concise but informative: usually 1 short summary sentence. For functions and methods, include `@param` for each named parameter by default, and include `@returns` when the function returns a meaningful value. Leave `@returns` without a description by default; add a short description only when the return contract, ordering, fallback, or boundary behavior is important. Add `@throws` or `@remarks` only when they add meaning.
- Explain why the code exists, what contract it provides, what assumptions it makes, and any important side effects. Avoid simply translating identifiers or repeating TypeScript types.
- Prefer neutral, precise wording. Avoid marketing tone, long background explanations, and obvious statements such as "设置 name 字段" for a field named `name`.
- For complex functions, use a summary plus the necessary parameter and return tags. If a function is trivial but still must be documented, use a compact purpose statement plus concise `@param` entries when it has parameters. Do not repeat the summary after `@returns`.
- For interface fields, use short member comments that clarify domain meaning, units, lifecycle, optionality, or constraints.

## TSDoc Patterns

Use standard TSDoc blocks:

```ts
/**
 * 根据当前会话构建请求上下文，供下游 API 复用认证与租户信息。
 *
 * @param session 当前用户会话，必须已完成认证。
 * @returns
 */
function buildRequestContext(session: Session): RequestContext {
    // ...
}
```

For interface fields:

```ts
interface JobConfig {
    /** 任务的唯一标识，用于日志关联与幂等校验。 */
    id: string;

    /** 重试次数上限；超过后交由 dead letter queue 处理。 */
    maxRetries: number;
}
```

For arrow functions assigned to variables, place TSDoc before the declaration:

```ts
/**
 * 将服务端错误归一化为 UI 可展示的消息结构。
 *
 * @param error 待归一化的未知错误对象。
 * @returns
 */
const normalizeError = (error: unknown): DisplayError => {
    // ...
};
```

For functions with parameters, keep the summary concise and add `@param` entries. Parameter descriptions should clarify source, unit, constraints, or role when possible; if no useful extra context exists, use a short neutral phrase instead of omitting the tag:

```ts
/**
 * 将文档按段落和句子切分为适合 embedding 的稳定 chunk。
 *
 * @param source 源文档标识，用于追踪 chunk 来源。
 * @param text 待切分的完整文档内容。
 * @returns
 */
export function chunkDocument(source: string, text: string): Chunk[] {
    // ...
}
```

For overloads, document the public overload signatures or the group once above the overload set. Include `@param` for shared parameters and `@returns` when the overloads return a meaningful value. Add a description after `@returns` only when overloads have non-obvious return differences. Avoid conflicting comments between overload signatures and implementation.

## Coverage Rules

- Cover all functions and methods in the user-requested files or selection unless the code is generated, vendored, or explicitly excluded. For each documented function or method, verify that every named parameter has a matching `@param` tag unless it is an unused rest/destructure placeholder where a tag would be misleading.
- Cover interface fields and object-like type members that are part of the requested scope.
- Keep private helpers documented too when the user asks for every function or method. Make their comments shorter when the intent is obvious from nearby code.
- Do not add TSDoc to inline callbacks that are only tiny adapters unless the user explicitly requires literal exhaustive callback coverage; prefer documenting the outer function or named helper.
- If the scope is large, work file by file and verify no requested function, method, or interface field was skipped.

## Quality Check

Before finishing, scan the diff and verify:

- Comments are Chinese with only helpful English technical terms.
- Function and method comments include `@param` for every named parameter, and include bare `@returns` for meaningful non-void return values unless a return description is genuinely useful.
- Each comment adds understanding beyond the symbol name and type annotation.
- Comment length is balanced: not a paragraph for simple code, not a vague phrase for complex code.
- Existing formatting and behavior remain unchanged.
- No stale claims were introduced about side effects, async behavior, errors, permissions, or performance.
