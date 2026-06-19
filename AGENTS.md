# Project Instructions

## Documentation Lookup

Use Context7 MCP to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service, even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when the answer seems familiar, because local knowledge may be stale. Prefer Context7 over web search for library docs.

Do not use Context7 for refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

When using Context7:

1. Start with `resolve-library-id` using the library name and the user's question, unless the user provides an exact library ID in `/org/project` format.
2. Pick the best match by exact name match, description relevance, code snippet count, source reputation, and benchmark score. If results look wrong, try alternate names or rephrased queries.
3. Query docs with the selected library ID and the user's full question.
4. Answer using the fetched docs.

## TypeScript TSDoc

When adding or changing TypeScript or TSX code in this project, follow the local skill at `.agent/skills/add-tsdoc-comments/SKILL.md` and add concise Chinese TSDoc for newly introduced or materially changed functions, methods, class members, interface fields, and object-like type members.
