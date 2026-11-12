# services/llm

Provider-agnostic LLM interface (`docs/INTERFACES.md` section 7), the router, the Settlement Agent proposal call and the agent eval runner. Test data only.

Commands: `npm run typecheck`, `npm test`, `npm run eval:agent`.

## Environment variables (names only)

- `LLM_PROVIDER_ORDER` (for example `groq,gemini`; optional third `nvidia`; `fake` is accepted by the eval runner only)
- `GROQ_API_KEY`, `GROQ_MODEL`
- `GEMINI_API_KEY`, `GEMINI_MODEL`
- `NVIDIA_API_KEY`, `NVIDIA_MODEL`
- `LLM_TIMEOUT_MS` (optional, default 30000)
- `OPIK_API_KEY` (optional, enables Opik tracing; the Opik client also reads its own workspace and URL variables)

A provider listed in the order but missing its key or model is skipped. Model names are never defaulted in code.

## What was verified, and how

- Verified offline only, with an injected fake `fetch`: request shape of each adapter, response mapping, error sanitising, router rules (retry, fall-through, 429 back-off, 3-attempt cap), schema validation, the agent's safe-failure shape, redaction, the eval runner with the built-in fake provider.
- Not verified at all: the real Groq, Gemini and NVIDIA endpoints (request and response shapes are written from the public API descriptions), the real model names, free-tier limits, the quality of the agent's answers on the nine scenarios, and the Opik adapter against a real Opik account.
- `eval:agent` with `LLM_PROVIDER_ORDER=fake` only proves the runner works. It says nothing about any model.

## Router rules as implemented

Per provider: first try, then one retry (invalid JSON, schema mismatch, provider error). Then the next provider. At most 3 attempts in total across all providers, so a provider that uses both of its tries leaves one attempt for the next. A 429 backs off (Retry-After, capped at 5 s, default 1 s, no sleep after the last attempt) and goes straight to the next provider without a same-provider retry.
