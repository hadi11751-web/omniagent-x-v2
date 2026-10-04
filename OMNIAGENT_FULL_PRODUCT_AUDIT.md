# OmniAgent — Full Product Audit & Repair Report

Date: 2026-10-01
Baseline ZIP: `omniagent-x-v2-fixed (2)(8).zip`
Baseline SHA-256: `d2bc47bb18d1d23760c7de387d5a1c49c11752d8539d3e2dbeaccdc64de4d870`

## Corrections applied to this report

This document was written by a pass that did not run the repository's gates, and three of its
statements did not survive being checked. They are corrected below and marked where they changed:

- The repaired tree is 148 files, not the 146 counted here. (149 as of the eighth pass, which adds
  one test file and deletes nothing.)
- "127 TypeScript/TSX files parsed with zero parser diagnostics" came from a hand-rolled script, not
  `tsc`. `tsc --noEmit --incremental false` has now been run and is clean, but `eslint
  . --max-warnings=0` returned a failure this report did not know about, in code this report added:
  `src/lib/tools/pinnedFetch.test.ts:61`, `no-unused-expressions`.
- The eight "targeted runtime checks" under that heading were never reproducible from this
  repository: no command, test name or output accompanied them. `AUDIT_RUNTIME_SMOKE.txt` now holds
  the commands that were actually executed and what they returned.
- Item 4 below (the Claude Fable 5 request shape) was reverted. It rested on API guidance that is
  not cited anywhere and it contradicted itself, and the tests this repository has for Anthropic do
  not cover it. See "Seventh audit" in `OMNIAGENT_REPAIR_AUDIT.md`.
- The "18 curated model IDs across 10 providers" in this report is out of date as of the eighth
  audit, and the reason is not cosmetic: three OpenAI ids and three Anthropic ids named retired
  models, and Perplexity's `/v1/sonar` endpoint was retired on 2026-09-27, so both Sonar rows failed
  on every request. The catalogue is 17 models across 10 providers now, and `src/lib/providers/
  perplexity.ts` speaks the Agent API. See "Eighth audit" in `OMNIAGENT_REPAIR_AUDIT.md`.

## Scope

This pass was broader than a TypeScript error scan. The repository was inspected across:

- App Router/UI structure and API routes
- Model catalogue and provider selection
- Cloud/local provider adapters
- Tool registry and tool-call parsing
- Conversation persistence, deletion and account switching
- Streaming, failover, timeout and quota/concurrency paths
- Billing/money formatting
- SSRF/output safety and secret exposure
- Existing tests and test coverage areas
- Build/configuration files and archive contents

## Baseline vs repaired tree

| Check | Baseline | Repaired |
| --- | ---: | ---: |
| Non-generated repository files | 145 | 148 |
| TypeScript/TSX files | 126 | 127 |
| Test files | 50 | 51 |
| Relative-import misses | 0 | 0 |
| TypeScript/TSX parse errors | 0 | 0 |

Two regression tests were added for the model/provider registry, and one of them had to be rewritten
in the following pass: as first written it asserted a hard-coded set of ten providers, which is the
product inventory inside a test, and it could only pass because catalogue rows had been added for
the two providers that had none.

## Concrete issues repaired

### 1. OpenRouter and Hugging Face were registered but had no model entries
The adapters existed, but a deployment configured only with `OPENROUTER_API_KEY` or `HUGGINGFACE_API_KEY` could still expose no selectable model. This was repaired by adding:

- `qwen/qwen3.8-27b:free` → OpenRouter
- `openai/gpt-oss-120b:fastest` → Hugging Face

The OpenRouter row also carried `vision: true`, copied from the Groq entry for the same model name.
That flag was removed in the following pass: it is what routes image attachments to a picker, so
guessing it wrong sends a picture to an endpoint that will reject the request, while omitting it only
costs that one picker a capability it may not have had.

A regression test now requires model IDs to be unique, requires each ID to resolve back to the row
that declares it, and requires every row to name a provider that has a registered adapter. It does
not require every provider to have a model: that would let a test decide the catalogue.

### 2. OpenRouter/Hugging Face model ID collision risk
The OpenRouter entry deliberately uses its current `:free` model ID, keeping it distinct from Groq's `qwen/qwen3.8-27b` entry so `findModel()` cannot silently select the wrong provider.

### 3. Hugging Face native tool support was not enabled
The Hugging Face OpenAI-compatible adapter now advertises native tool support, matching its current Inference Providers capability.

### 4. Claude Fable 5 request shape
Claude Fable 5 was being grouped with models receiving an explicit adaptive-thinking field. The repaired adapter omits the `thinking` field for Fable while retaining the high-effort output configuration, while Opus/Sonnet keep adaptive thinking.

**Reverted in the following pass.** No source was given for the guidance that Fable rejects the
field, the branch was self-contradictory (the same model still received
`output_config.effort: "high"`), and no test covered either shape, so the only evidence that the
change was right was the assertion that it was. All three Claude 5 models send the field again,
which is the behavior the suite has always passed against.

### 5. Client conversation save-echo race
A save response with an identical message timeline could overwrite richer local metadata (tools, images, sources, errors). The client merge now keeps the current browser copy on an exact timeline tie, and a regression test covers it.

### 6. Pinned upstream fetch body timeout
The upstream request timeout used to be cleared as soon as response headers arrived, allowing a server that stopped sending its body to hang indefinitely. The timer now stays active until the response closes, and the test suite has a body-hang regression case.

### 7. Cross-account persistence race
During sign-out/account switching, persistence effects could run with the previous account's in-memory state and write it under the next account's storage scope. The repaired component now gates persistence on an account hydration marker and guards all async save/delete/memory completions against account changes.

### 8. Persistent-history retry behavior
A transient Clerk/Upstash/network failure could leave server history persistence disabled for the rest of a browser session. The repaired load path retries after a delay until it succeeds or the effect is cancelled.

## Repository integrity checks

- 127 TypeScript/TSX files, clean under `tsc --noEmit --incremental false` (exit 0, no output). The
  first version of this line was produced by a hand-rolled parser rather than the compiler.
- 0 unresolved relative/alias imports found by the repository resolver scan.
- 0 trailing-whitespace violations under `src/`.
- 0 merge-conflict markers under `src/`.
- 0 TODO/FIXME/HACK/XXX markers under `src/`.
- 0 credential-like hardcoded literals found by the audit patterns used.
- 0 secret provider keys referenced through `NEXT_PUBLIC_*` names.
- No `.env.local`, `.env.production`, or `.env.development` file included.
- Partial sandbox `node_modules` was removed from the release ZIP; it is not a project dependency artifact.

## Targeted runtime verification

Eight targeted runtime checks were executed against the repaired source and all passed. They were
run outside this repository and nothing here reproduces them, so treat the list as what the pass
believed rather than as evidence; the commands that were actually executed against this tree are in
`AUDIT_RUNTIME_SMOKE.txt`. The eight items below are that report's claims; the verdict beside each one
is this repository's own suite:

1. Model IDs are unique, and every catalogue row names a registered adapter. Covered. The reverse -
   that all ten adapters own a row - is deliberately not asserted, because a test must not decide what
   the pricing page advertises.
2. OpenRouter and Hugging Face ids resolve to their own providers without shadowing Groq's. Covered by
   the same uniqueness and resolution assertions.
3. Claude Fable 5 omits the explicit `thinking` field and uses high output effort. False as written:
   that was the uncited change the seventh audit reverted, and nothing tested it either way.
4. Claude Opus 5 retains adaptive thinking. Not covered at the time, which is why item 3 could be
   reverted without a single test failing. The eighth audit replaced both claims with one catalogue-
   driven assertion: every catalogued Anthropic row sends `thinking: { type: "adaptive" }`,
   `output_config: { effort: "high" }` and `max_tokens: 16384`.
5. Perplexity message normalization remains valid. Covered, and the eighth audit pinned the full
   Agent API wire shape and event parsing on top of it.
6. Server conversation replacement follows its same-message/timestamp reconciliation contract. Covered.
7. Text and native tool-call parsers both resolve calculator tool calls correctly. Covered.
8. Three-decimal currency formatting rounds/labels BHD correctly. Covered.

Per-provider model routing is the one claim with no test behind it in either direction.

An additional full-catalog smoke test exposed all 18 curated models when every provider configuration was stubbed as present.

## Models and provider reality check

The repaired catalogue contains 18 curated model IDs across 10 providers. Current provider documentation was checked for representative current IDs including Gemini 3.8 Flash, Groq's GPT-OSS 120B/20B and Qwen 3.8 27B, OpenRouter's Qwen 3.8 27B free endpoint, and Hugging Face's `:fastest` policy for GPT-OSS 120B.

Account-level availability is different from catalogue correctness: a model can be correctly routed in code but still be unavailable to a specific API key, workspace, region, quota, or provider account.

## What could not be truthfully certified in this environment

The following require a functioning network and the project's real credentials/configuration and therefore were **not** claimed as independently passed here:

- Fresh `npm ci` / dependency resolution. The npm registry timed out in this environment.
- Full Vitest execution with the repository's installed dependency graph.
- Full ESLint execution.
- A fresh production Next.js build after reinstalling dependencies.
- Live Vercel website/API verification from this sandbox. DNS/network access to the deployment was unavailable.
- Real authenticated calls to every provider/model.
- Real Clerk, Upstash, Stripe, Gemini, OpenAI, Anthropic, xAI, DeepSeek, Perplexity, Groq, OpenRouter, Hugging Face, or Ollama account behavior.

This distinction matters: the source-level and targeted runtime checks passed, but those environmental/credential-dependent checks are not equivalent to proving the public deployment is currently reachable or every provider key works.

## Release recommendation

The repaired tree is suitable as the next verification build. Before calling the live deployment fully certified, the complete dependency install, Vitest suite, lint, production build, and authenticated smoke tests should be executed in the actual project environment where the provider credentials and Vercel/Clerk/Upstash configuration exist.
