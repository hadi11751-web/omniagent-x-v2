# OmniAgent X v2 — Repair Audit

This package contains a deep source-level repair pass over the uploaded OmniAgent X v2 project.

Rounds are appended below rather than rewritten, so an earlier verdict stays readable as what was
believed at the time. The newest section, "Eighth audit", is the current state; anything in
an earlier section that has since been superseded is called out where it changed.

## Repairs included

- Added ordered web-search failover: Tavily -> Brave -> DuckDuckGo.
- Added empty-provider-response detection so blank completions can trigger retry/failover.
- Added native OpenAI-compatible tool definitions for compatible providers, while preserving the existing text tool protocol as a fallback.
- Preserved the successful fallback provider/model for subsequent tool steps instead of resetting to the original provider.
- Made research mode stop with an explicit error when live search fails instead of silently answering from stale model knowledge.
- Hardened public URL fetching with DNS/IP validation, redirect re-validation, credential/port restrictions, content-type checks, and a response byte limit.
- Added chat, image, and transcription input limits plus defense-in-depth authentication on image/transcription routes.
- Added server conversation size and data-URL validation.
- Corrected history loading so server persistence is only activated when the user's save-history setting allows it.
- Added quota refunds for requests that produce no usable output and reordered concurrency/quota checks so rejected concurrency does not consume quota.
- Tightened agent verification to require an exact `VERIFIED` response.
- Improved planner/recovery JSON extraction.
- Added current, documented model entries for Claude Fable 5 and Qwen 3.8 27B on Groq.
- Added regression tests for search-provider failover and empty provider responses.
- Removed stale TypeScript build cache from the deliverable.

## Verification completed in this environment

- All 72 TypeScript/TSX files parsed with zero syntax diagnostics.
- 128 local source imports were checked; zero missing local imports were found.
- package.json and package-lock.json both parse as valid JSON.
- Focused production/backend TypeScript typecheck passed using minimal external API stubs.

## Environment limitation

> **Superseded.** The limitation below describes the sandbox that wrote this section. `npm ci`,
> `npm run typecheck`, `npm run lint` and `npm test` have since been run by the project owner on an
> extracted copy and pass, and `npm run build` has been run here against the installed dependencies —
> exit 0, "Compiled successfully", with `/api/memory` and `/api/transcribe` in the route list. The
> checklist under this section is still the right thing to run after extracting the ZIP; it is no
> longer an unmet obligation.

A full `npm ci` could not complete because the package registry connection timed out in the execution environment. Because the ZIP did not contain a usable completed dependency installation, a full `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` could not be truthfully reported as executed here.

`node_modules` is not the only thing the ZIP leaves out. `.npmrc` sets `legacy-peer-deps=true`, and
that line is load-bearing rather than tidiness: `@clerk/nextjs@7.8.0` declares
`react: ^18.0.0 || ~19.0.3 || ~19.1.4 || ~19.2.3 || ~19.3.0-0` while this project pins `react` and
`react-dom` at exactly `19.1.0`, which is below its `~19.1.4` floor. Without the flag `npm ci` stops
with `ERESOLVE ... Conflicting peer dependency: react@19.1.0`. So the installed tree pairs Clerk 7.8.0
with a React it does not claim to support — which is a known trade, not an unnoticed one. Removing the
flag means raising `react`/`react-dom` into one of those ranges — `19.1.9` is the newest release still
inside `~19.1.4`, so the change can stay a patch-line bump — and re-running the whole chain
afterwards; it is not a manifest cleanup.

The repaired source is therefore intentionally delivered without node_modules. After extraction in a normal development environment, run:

- `npm ci`
- `npm run typecheck`
- `npm test`
- `npm run lint`
- `npm run build`

The repair does not include any API keys or production secrets.

## Follow-up verification pass

This package was later checked in an environment with the real dependencies installed, which is what the limitation above prevented. Four defects surfaced and were fixed:

- `src/lib/tools/fetchUrl.test.ts` stubbed `node:dns/promises` to return `127.0.0.1` for every hostname except `good.example`, so the three `fetchReadableText` cases that use `example.com` URLs failed on the new `assertPublicResolvedHost` check rather than on fetch logic. The stub now returns a public address by default and loopback only for `rebind.*` hostnames.
- `src/lib/tools/fetchUrl.ts` evaluated the port restriction before the host restriction, so `http://localhost:3000` was reported as a port problem instead of a loopback address. The private/loopback check now runs first; both still reject before any network access.
- The new port, embedded-credential and DNS-rebinding rules had no tests. Coverage was added, including an assertion that `fetch` is never called when a public hostname resolves to loopback.
- `src/lib/stream.ts` imported `ToolDefinition` without using it, which failed `eslint --max-warnings=0`.

### Checks executed with real dependencies

- `tsc --noEmit --incremental false` — zero errors, after deleting any build cache
- `eslint . --max-warnings=0` — zero errors, zero warnings
- `vitest run` — 16 files, 97 tests passed
- `next build` — succeeded, all routes compiled

Runtime paths that need credentials remain unverified: live provider calls, Clerk auth, Stripe webhook signature checking, and Upstash quota/concurrency behaviour.

## Second follow-up pass

A manual line-by-line review (independent of the automated tsc/eslint/vitest/build checks above, which do not catch either of these) found two further defects:

- `src/lib/tools/generatePdf.ts`: `deriveTitle()` sliced the **raw** input using the **trimmed** first line's length (`input.slice(firstLine.length)`), instead of the actual newline position. Whenever the first line had leading or trailing whitespace, this cut the body string at the wrong index and silently corrupted the start of the generated PDF's body text. Fixed to slice at `input.indexOf("\n") + 1`. `deriveTitle` is now exported and covered by dedicated regression tests, including one for the whitespace case.
- `src/app/api/chat/route.ts` / `src/lib/tools/webSearch.ts`: `runResearch()` received an `AbortSignal` but never used it — the only reference to it was a `void signal;` statement placed *after* the function's try/catch, which always returns before reaching it, making the statement unreachable dead code. As a result, cancelling a research-mode request (the "Stop" button) never actually cancelled the in-flight web search call; it kept running server-side after the client gave up. `searchWeb()` and its three provider functions (`tavily`, `brave`, `duckDuckGo`) now accept an optional `signal` and forward it to `requestJson`, and `runResearch` passes its signal through. A regression test in `webSearch.test.ts` asserts that aborting the caller's signal aborts the underlying request.

### Checks executed after this pass

- `tsc --noEmit` — zero errors
- `eslint .` — zero errors, zero warnings
- `vitest run` — 16 files, 101 tests passed (4 new regression tests added)


## Product identity pass (public page, limits, vision-input roles)

This pass adds the public product/features/plans page and the supporting single
source of truth for limits. Nothing in the billing flow was replaced: `/api/stripe/checkout`
still creates the same subscription session for `STRIPE_PRICE_ID`, and the webhook
still flips `publicMetadata.plan`.

### Added

- `src/app/pricing/page.tsx` — public page: hero, real-time search explainer, the ten
  Omni capabilities, how a request is decided, the four modes, two plan cards, an
  exact-limits comparison table, what both plans include, and an FAQ. Static with
  `revalidate = 3600`.
- `src/lib/limits.ts` — every enforced ceiling in one place (`FREE_DAILY_LIMIT`,
  `MAX_TOOL_STEPS`, `MAX_AGENT_STEPS`, `MAX_HISTORY_MESSAGES`, `MAX_IMAGES_PER_MESSAGE`,
  `MAX_IMAGE_DATA_CHARS`, `MAX_IMAGE_BYTES`, `MAX_MEMORIES`, `MAX_CONVERSATIONS`,
  `MAX_MESSAGES`, `MAX_CONCURRENT_PER_USER`). The code that enforces each one now
  imports it instead of keeping its own copy, so the page cannot drift from the server.
  Wired into `api/chat/route.ts`, `lib/agent.ts`, `lib/quota.ts`, `lib/concurrency.ts`,
  `lib/server/conversations.ts`, `lib/server/memory.ts` and `components/Composer.tsx`.
  Values are unchanged, so behaviour is unchanged.
- `src/lib/product.ts` — the page's copy and plan table, derived from `src/lib/limits.ts`,
  `src/lib/models.ts` and `src/lib/providers`, including model/provider counts.
- `src/lib/money.ts` — Stripe `unit_amount` formatting, including zero-decimal currencies.
- `src/lib/server/price.ts` — reads the amount of the already-configured `STRIPE_PRICE_ID`
  so the page shows the real price. Returns `null` when billing keys are absent, when the
  price is archived or metered, or when Stripe is unreachable; the page then says
  "Shown at checkout" rather than inventing a figure. The checkout route is untouched.
- `src/middleware.ts` — `/pricing` joins sign-in, sign-up and the webhook as a public
  route. Everything else still requires a session.
- `src/components/Sidebar.tsx` — the plan label becomes a link to `/pricing`.

### Restored

Three earlier fixes for generated-image follow-ups were missing from this tree and were
re-ported: only `role: "user"` attachments travel as vision input (`providers/anthropic.ts`,
`providers/openaiCompatible.ts`, `providers/gemini.ts`), the assistant turn's images are no
longer echoed back in the request payload (`components/OmniAgentApp.tsx`), and GIF is
accepted by the Gemini part builder. `providers/openai.ts` already gated on role. New
regression cover: `providers/image-role-gating.test.ts` (asserts the wire shape for both a
user attachment and an assistant-generated image), plus two added Gemini cases.

The two defects found in the second follow-up pass above (the `deriveTitle` body slice and
the unused `AbortSignal` in `runResearch`) are present as fixed in this tree and were left
as they are.

### Behaviour change: live search without picking Research

`api/chat/route.ts` now searches before answering when a Chat request is auto-routed to the
`research` capability (`classify()` already matched news/latest/current/today/who won/cite/
search wording) and tools are enabled. `runResearch()` gained a `hardFail` argument: Research
mode still stops with an error when the search finds nothing, while a speculative Chat search
that comes back empty or fails emits a status line and answers unsearched. Pinning a model,
turning tools off, and every other mode behave exactly as before.

### Checks executed after this pass

- `tsc --noEmit --incremental false` — zero errors
- `eslint .` — zero errors, zero warnings
- `vitest run` — 20 files, 130 tests passed (29 added since the previous pass)
- `next build` — succeeded; `/pricing` prerenders as static with a 1h revalidate window, and
  the emitted HTML was checked for each capability, the plan cards, the limits table and the
  derived "16 models across 8 providers" line. (As originally written this line said
  "10 providers", which confused the ten registered adapters in `src/lib/providers/index.ts`
  with the eight providers the catalogue actually had a model for; `/pricing` renders the
  latter. Corrected during the seventh audit, which is also when the catalogue grew to ten.)

Still unverifiable here for the same reason as before: this environment has no Clerk,
Stripe, Upstash or provider keys. A local `next start` returns Clerk's missing-secret-key
error for every route, including public ones, so the page was verified through the build's
prerendered output rather than a browser.

## Plan-aware pricing pass (current plan + customer portal)

### Added

- `src/lib/server/portal.ts` — `createPortalUrl(email, returnUrl)` opens a Stripe
  **customer portal** session for the signed-in user's existing customer, so a subscriber can
  change card details, switch or cancel. Read-only with respect to billing: it creates no
  price, product or subscription, and reuses the same `STRIPE_SECRET_KEY` as checkout. It
  returns a typed failure instead of throwing — 503 when billing is unconfigured, 400 when the
  Clerk user has no email to match a customer on, 404 when Stripe has no customer for that
  email, 502 when Stripe rejects the request.
- `src/app/api/stripe/portal/route.ts` — `POST` only, requires a session (`auth()` → 401),
  reads the email from `currentUser()`, builds `return_url` from the request origin plus
  `/pricing`, and forwards to `createPortalUrl`. There is no customer ID in Clerk's metadata,
  so the customer is looked up by email — the same identity Stripe already keys on.
- `src/components/PricingPlanControls.tsx` — client-side plan awareness for the two cards:
  `CurrentPlanFlag` labels the card matching `publicMetadata.plan` ("Your active plan" /
  "You're on this plan"), and `PlanCallToAction` shows the matching action — sign-up while
  anonymous, "Upgrade now" through the existing `/api/stripe/checkout` for a free user on the
  paid card, "Manage subscription" via `/api/stripe/portal` for a subscriber, "Open the app"
  on the free card. `/pricing` stays a static (ISR) route: the page body never reads the
  session, only this component does.

### Behaviour detail: no-JS and hydration

`useUser()` reports `isLoaded: false` while the page is being prerendered, so the first cut of
those buttons emitted a skeleton and the real links appeared only after hydration — the
prerendered HTML contained no call to action at all. The component now renders the signed-out
link markup until it has mounted (`mounted` flag set in `effect`), which keeps the server HTML
and the first client render identical (no hydration mismatch), leaves anonymous visitors with
working links in the static output, and personalizes on the paint after that.

### Checks executed after this pass

- `tsc --noEmit --incremental false` — zero errors
- `eslint . --max-warnings=0` — zero errors, zero warnings
- `vitest run` — 21 files, 135 tests passed (the new `src/lib/server/portal.test.ts` covers
  all five return branches; `price.test.ts` covers the lookup fallbacks)
- `next build` — succeeded; `/api/stripe/portal` listed as a dynamic route, `/pricing` still
  `○ (Static)` with 1h revalidate. `.next/server/app/pricing.html` was grepped and now
  contains "Create a free account" and "Start free, upgrade any time", while "Your active
  plan", "You're on this plan", "Upgrade now" and "Manage subscription" stay out of the
  static HTML — they exist only once a session is known.

Still unverifiable here: a real portal session. Stripe's customer portal must be enabled for
the account and the return URL must be allow-listed there, which cannot be checked without
live keys; the route's failure branches are covered by tests instead.

## Dependency security pass

Reported by an external audit of the delivered zip and confirmed here against the npm
registry before anything was changed. `npm audit` was not part of the previous verification
chain, which is why these reached a hand-off: a stale `next` compiles, lints, tests and builds
without complaint.

### Confirmed findings

- `next` was pinned to **15.5.23** (`package.json`, lockfile and installed copy all agreed).
  Two **critical** advisories cover it: unauthenticated RCE on windows-hosted servers
  (`>=13.4.0 <15.5.24`) and unauthenticated RCE in the Image Optimization API when AVIF files
  are used (`>=10.0.0 <15.5.24`). Registry `backport` tag at check time: **15.5.26**.
- Two findings the external audit did not mention, both reachable through `next`: **high**
  `postcss` advisories (XSS in the CSS stringify output, arbitrary `.map` read and path
  traversal via `sourceMappingURL`) — Next 15.5 pins `postcss@8.4.31` exactly — and **high**
  `sharp` advisories for inherited libvips CVEs and libheif GHSAs (`<=0.35.4-rc.0`), pulled in
  as `next` depends on `^0.34.3 || ^0.35.x`.
- Dev-only tree additionally reported `js-yaml` **high** (CWE-400 unbounded merge-key CPU,
  `<4.3.2`).

### Changes

- `package.json` — `next` raised to the exact patched `15.5.26` (stayed on the 15.5 line
  rather than jumping to `16.3.6`, which `npm audit fix --force` wants and which is a major
  upgrade), `eslint-config-next` matched to `15.5.26`, `js-yaml` fixed by `npm audit fix`, and
  a new `overrides` block pinning `postcss` `^8.5.26` and `sharp` `^0.35.4`. The overrides are
  load-bearing: they clear advisories inside ranges Next itself declares, and removing them
  re-introduces both.
- `package-lock.json` — regenerated for the above.
- `src/lib/server/price.ts` — `readPlanPrice()` now requires `price.recurring`. Previously a
  one-off Stripe price produced `{ interval: null }` and `/pricing` printed an amount with no
  interval, while `/api/stripe/checkout` creates the session with `mode: "subscription"` —
  which Stripe rejects for a one-off price. A price the upgrade path cannot charge is now
  treated as "no price to show" instead. `PlanPrice.interval` is now `string`.
- `src/lib/server/price.test.ts` — the case that asserted "a one-off price has no interval"
  asserted the defective behaviour and now asserts `null` for the same input.
- `AGENTS.md` — `npm audit --omit=dev` added as a fifth mandatory check, with the reason; the
  `overrides` block and the "never `npm install` over a junctioned `node_modules`" rule are
  documented so the next pass does not undo them.

### Checks executed after this pass

- `npm audit --omit=dev` — **0 vulnerabilities**; `npm audit` including dev dependencies —
  **0 vulnerabilities**
- `tsc --noEmit --incremental false` — zero errors
- `eslint . --max-warnings=0` — zero errors, zero warnings
- `vitest run` — 21 files, 135 tests passed
- `next build` — succeeded on 15.5.26 with the `postcss` override active. Because that
  override changes the CSS pipeline, the emitted stylesheet was inspected rather than just
  the exit code: the `--surface` / `--accent2` custom properties and the utilities the pricing
  page uses are present, and `/pricing` still prerenders with both call-to-action links in
  the static HTML.

### From the same audit, not acted on

- `gpt-6-astra` in `src/lib/models.ts` cannot be validated from documentation alone, and no
  model ID in the catalog can: the authoritative check is one live request per entry with a
  real key. An unknown ID fails at request time with a provider 4xx, and
  `provider-resilience` fails over to another provider rather than crashing, so this is a
  catalog-accuracy question rather than a stability defect. Left for a credentials run.

## Abuse-limit hardening (two findings raised after the security pass)

### Fixed

- `src/lib/concurrency.ts` — the acquire Lua script now calls `EXPIRE` on **every** successful
  acquire instead of only when the counter went 0→1. `SLOT_TTL_SECONDS` is 120, the same as the
  chat route's `maxDuration`, so a slot stamped by the first request of a busy window could
  lapse while that request was still streaming; the next acquire then read the user as idle and
  let them exceed `MAX_CONCURRENT_PER_USER`. Refreshing per acquire guarantees each holder a
  window at least as long as the longest request it can be running. Also dropped the local
  `next` variable, which shadowed nothing useful and read like the language keyword.
- `src/lib/quota.ts` — an unconfigured Upstash no longer means "unlimited". Previously
  `checkAndConsumeQuota()` returned `allowed: true` with a full `remaining` whenever
  `UPSTASH_REDIS_REST_URL/TOKEN` were absent, so a deployment that forgot its Redis variables
  served unlimited free messages silently. It now counts in a per-instance `Map`, the same
  fallback shape `concurrency.ts` already used: weaker than Redis (per instance, not global)
  but a real ceiling. `refundQuota()` refunds that counter too, and `resetLocalQuota()` is
  exported for tests. A paid plan is unaffected: plan comes from Clerk metadata, not Redis.
- `src/lib/quota.test.ts` (new, 9 tests) — paid bypass, Redis `EXPIRE` on the first message of
  the day, blocking past the limit, per-user isolation, the no-Redis ceiling holding at the
  21st message (this is the regression test: it fails against the old fail-open branch), local
  refund, refund never going below zero, and Redis refund/paid-refund paths.
- `README.md` — the Upstash paragraph said the daily quota "fails open". That was accurate
  before this pass and wrong after it, so it now describes per-instance counting instead.
- `AGENTS.md` — records both invariants so the next pass does not re-introduce them.

### Checks executed after this pass

- `tsc --noEmit --incremental false` — zero errors
- `eslint . --max-warnings=0` — zero errors, zero warnings
- `vitest run` — 22 files, **144 tests** passed
- `next build` — succeeded; `/pricing` still prerendered static
- `npm audit --omit=dev` and `npm audit` — 0 vulnerabilities

### Not unit-testable here

The concurrency fix lives inside a Lua script that Redis executes server-side. Vitest mocks
`eval`, so no test in this repo can observe `EXPIRE` firing; the local-fallback tests exercise
the JS path only. Verified by reading the script against the `maxDuration` = 120 s budget, and
it needs a real Redis to prove. Recorded here rather than papered over with a string-matching
assertion on the script body.

## Cost-gate pass (routes reachable by any signed-in account)

Two further audits claimed money could be spent upstream without paying for it. Each
claim was checked against the source before being acted on; every one was correct, and
verifying them turned up a ninth the audits did not name (`/api/memory` had no upstream
timeout either).

### Fixed

- `/api/image` — reachable by any signed-in account and completely ungated, because no
  client code calls it. It now runs through `beginRun()` with `consumesQuota: true`: one
  billed image costs one message from the daily allowance, a busy account is refused before
  any provider call, and a failed generation is refunded the way a failed chat turn is.
- `/api/transcribe` — 24 MB body ceiling plus a concurrency slot. Not quota-charged: the
  transcript becomes the chat message that is charged downstream, so charging here would
  bill one voice message twice.
- `/api/memory` — had no body ceiling, no per-message ceiling, no concurrency slot, no
  `maxDuration`, and a timeout that could never fire (`new AbortController().signal` is
  handed a signal nothing aborts). Now: an 8 MB ceiling checked on `content-length`, only
  the newest 40 turns, a 200,000-character transcript budget where the newest turns win,
  `AbortSignal.timeout(45_000)`, `maxDuration = 60`, and a held slot. Also not
  quota-charged, for the same reason as transcription — extraction fires after *every*
  reply, so charging it would silently halve the free allowance `/pricing` advertises.
- `/api/conversations` POST — an oversized save was refused only after `request.json()` had
  built the entire object in memory. `content-length` is checked first now.
- `/api/chat` — `projectContext` and `memory` are appended verbatim to the system prompt and
  were uncapped, so each one was billed as prompt tokens on every message. Both are refused
  above 200,000 characters, before quota, concurrency or a provider call.
- `generate_pdf` — the layout loop measures every line on the request thread; input above
  100,000 characters is refused instead of tying up the server.
- `src/lib/server/portal.ts` — `customers.list({ email, limit: 1 })` opened the portal on
  whichever customer Stripe happened to list first, so an account with an old cancelled
  customer and a live one could be sent to the wrong dashboard. It now reads up to five and
  prefers the customer with the live subscription (`active` before `trialing` before
  `past_due` …), falling back to the newest when none has one.
- `src/lib/server/conversations.ts` re-declared three limits that already existed in
  `src/lib/limits.ts` and hardcoded an image count of 4. It imports the shared constants
  now, so the numbers `/pricing` shows cannot drift from the numbers that are enforced.

### Deliberately not changed

- Quota still `INCR`s even when the answer is "denied". It costs nothing upstream, the key
  expires within 26 hours, and a second Lua script to avoid the extra increment buys
  nothing measurable.
- The `fetch_url` DNS time-of-check gap that was recorded here ("the host is resolved,
  checked, and then `fetch()` resolves it again on its own") is closed by the later
  *fetch_url address-pinning pass* below: the validated records are handed to the socket
  layer as the request's own `lookup`, so the check and the connection can no longer disagree.
- Model catalogue IDs and the Stripe billing-portal dashboard configuration need live
  credentials to confirm; nothing here claims they are right.

### Checks executed after this pass

- `tsc --noEmit --incremental false` — zero errors
- `eslint . --max-warnings=0` — zero errors, zero warnings
- `vitest run` — 27 files, **179 tests** passed (35 new)
- `next build` — succeeded; `/pricing` still prerendered static
- `npm audit --omit=dev` and `npm audit` — 0 vulnerabilities

New coverage: `src/lib/server/guards.test.ts` (the shared gate itself — slot refusal,
quota refusal releasing the slot, refund only when a charged run produced nothing, and the
`content-length` boundaries), `src/app/api/image/route.test.ts`,
`src/app/api/transcribe/route.test.ts` and `src/app/api/memory/route.test.ts` (each route's
own wiring: 401 / 413 / 429 before any provider call, memory and transcription never
touching quota, the 40-turn and character budgets observable on the transcript the extractor
is handed, and the slot released when extraction fails), `src/app/api/chat/route.test.ts`
(both prompt-context ceilings), plus two portal cases and a PDF ceiling case. The transcribe
suite keeps a throwing `fetch` stub installed for every case, so a refusal that leaked to the
upstream would fail the test rather than make a request.

### Still not unit-testable here

The 45-second extraction timeout needs a live upstream to prove, and the `/api/chat`
quota/concurrency wiring is only asserted through the routes that share it. The DNS
time-of-check gap mentioned above has since been closed and is covered by
`src/lib/tools/pinnedFetch.test.ts`.

## Privacy-boundary pass (24 findings from an external model audit)

Each of the 24 numbered claims was checked against this tree before acting. All of them were
real; the six marked "most important" turned out to be one root cause.

### Root cause: `execution: "local"` was a hint, not a policy

Routing respected the local model, and then five other code paths each felt free to move the
request somewhere else. Added `src/lib/privacy.ts`: a `PrivacyPolicy` computed once per
request from what was asked and what is about to answer, and threaded into every later
decision.

| # | Finding | What enforces it now |
| --- | --- | --- |
| 2 | A local model could fail over to a cloud provider | `rankFailoverCandidates()` takes `localOnly` and filters on `execution` **before** health, vision or capability |
| 3 | An attachment silently switched a local turn to a cloud vision model | the vision switch searches `withinBoundary(models, policy)` and returns a 400 explaining the refusal |
| 4 | Memory extraction sent a local transcript to the strongest cloud model | `/api/memory` takes `localOnly` from the client (it narrows only), and answers `{ memories: [], skipped }` when no local model exists |
| 5 | "Private" still called Tavily, Brave, `fetch_url` and Gemini image | `availableTools(policy)` drops the tools that reach outside; `findTool(name, policy)` refuses them too, so the agent planner never sees them |
| 6 | Search and tool output was inserted as `system` messages | `evidenceTurn()` delivers untrusted text as a labelled `user` data turn; `attachEvidence()` merges it into the human turn so Anthropic's role alternation still holds |
| 11 | Privacy lost to coding/research in `classify()` | `private` is now the first pattern, and the router test asserts it outranks the others |
| 1 | Auto-routing was not the default | `DEFAULT_SETTINGS.autoRoute` is `true`, the picker gained an explicit "Automatic" entry (so a local model is reachable while routing is on), and `selectModel()` will not route away from a pinned local model |

The boundary is announced in the stream rather than applied silently: `privacyNotice()` emits
either "keeping this on the local model, these tools are off" or "this reads as private, but
*Model* is answering from a cloud provider".

### Cost ceilings for the two free-running routes (#7, #8)

`quota.ts` grew a second, scoped counter (`checkDailyCap` / `refundDailyCap`,
`FREE_DAILY_MEMORY_RUNS = 60`, `FREE_DAILY_TRANSCRIPTIONS = 40`) sharing the counted
in-process fallback used when Upstash is absent. `beginRun()` takes `dailyCap`, checks
concurrency → cap → allowance, and refunds the cap when a run produced nothing usable. The
ceilings sit above `FREE_DAILY_LIMIT` so honest use never reaches them; they exist because
neither route can be proven to be tied to a chat message from the server side.

### Honesty and semantics (#9, #12-#19)

- `MODEL_SUMMARY.providers` is now the count of providers with a model in the catalog (8),
  not the size of the provider registry (10). OpenRouter and Hugging Face have
  implementations but no catalog entries, so the old number advertised reach the picker
  cannot offer.
- The Free card renders through `formatMoney(0, price.currency)` instead of a literal `$0`,
  so a non-USD deployment stops showing a dollar sign, and the paid card's badge says "No
  daily ceiling" instead of "Most capable" — the page's own table says the plans are equally
  capable.
- `MAX_TOOL_CALLS_PER_ANSWER` (`MAX_TOOL_STEPS - 1`) is what the plan table and FAQ quote.
  The last turn of a chat answer runs without tools, so "3 tool calls" was never three
  executable calls. The agent row is labelled "Agent tool steps per run", and the README
  states plainly that a step may retry, so upstream calls can exceed 8.
- `/api/conversations` distinguishes its errors now: `ConversationValidationError` (bad id,
  oversized or malformed body, unparseable JSON) is 400, anything else — including Redis
  being down — is 500. Same for `GET`/`DELETE` on `/api/conversations/[id]`. A client cannot
  retry its way out of a bad body, but it can retry out of a bad database.
- Voice uploads are named from the recorded mime type at both ends (`src/lib/audioMime.ts`),
  so Safari's `audio/mp4` arrives as `.m4a` instead of a mislabelled `.webm`. The name is
  always ours (`voice-message.<ext>`), never the caller's.
- Copy fixes: `DECISION_PIPELINE` names the real capability set (`image`, not "vision", which
  is generation rather than input) and gained the boundary step; the private/research/vision/
  agent/tools/memory capabilities and the FAQ describe what the code now enforces, including
  where it refuses.

### Checked and left alone, on purpose

- #10 — a failed speculative search continues unsearched. It does say so in the stream
  ("Live search is unavailable, so answering from what I know."), which is the honest part;
  making it hard-fail would refuse answers the user still wants. Unchanged.
- #12 — `inspect_pdf` reports pages, size and metadata only, and the composer accepts
  `image/*`, not PDFs. The page and FAQ already say it does not extract PDF text.
- #19 — verified there is no "deep research" claim anywhere in the copy; Research mode is
  described as searching, then answering with sources, which is what `runResearch()` does.
- #20 — citation markers are not validated against the sources. Fixing it means either a
  matching pass over every answer or dropping citations; both are product decisions, not
  repairs.
- #21 — blend participants are the first three distinct providers in catalog order. Better
  selection needs quality signal this deployment does not have.
- #22 — the agent's verification pass uses the same model that did the work. It checks the
  collected evidence rather than its own prose, which is a real check, but it is not
  independent.
- #23 — provider health cooldowns are process-local by design (an in-memory `Map`); sharing
  them would need Redis and a write per failure.
- #24 — the Stripe webhook applies `plan` metadata without persisted event-id
  deduplication/reconciliation. Needs live credentials and a design decision about storing
  event state to do properly.

### Checks executed after this pass

- `tsc --noEmit --incremental false` — zero errors
- `eslint . --max-warnings=0` — zero errors, zero warnings
- `vitest run` — 31 files, **240 tests** passed (61 new since the previous pass)
- `next build` — succeeded; `/pricing` still prerendered static
- `npm audit --omit=dev` and `npm audit` — 0 vulnerabilities

New coverage: `src/lib/privacy.test.ts` (boundary set from the answering model, notices,
`withinBoundary`, evidence turns and role alternation), `src/lib/model-selection.test.ts`
(the nine pin/route/boundary cases, including "never route away from a pinned local model"),
`src/lib/router.test.ts` (privacy outranking coding and research, catalog sanity),
`src/lib/audioMime.test.ts` (each browser container, codec suffixes, name fallback, no
caller-supplied path), plus cap and refund cases in `quota.test.ts`, `server/guards.test.ts`,
`app/api/memory/route.test.ts` and `app/api/transcribe/route.test.ts`, a `localOnly` failover
case in `provider-resilience.test.ts`, and a boundary case in `tools/index.test.ts`.
`product.test.ts` now reads its tool list from `ALL_TOOLS` and its provider count from
`MODELS`, so the page cannot outlive the catalog it describes.

### Still not unit-testable here

The stream notices, the 400 for an image under a local boundary and the vision switch need a
live `/api/chat` request with configured providers; they are covered by the pure functions
above plus the route's own validation tests.

## Follow-up pass: the unmet boundary still let the extras out

A re-review of the delivered zip found a hole in the pass above, and it is the kind of bug the
boundary exists to prevent: **a prompt that reads as private, on a deployment with no local
model configured, asking directly for an image, still reached Gemini's image API.**

### Why it happened

`privacyPolicy()` distinguishes two states, and the enforcement used the wrong one. With no
local model, a private prompt yields `requested: true, localOnly: false, unmet: true` —
`localOnly` honestly means "nothing is leaving", so it cannot be true when a cloud model is
answering. Every step that is *not* the answer was gated on `localOnly`, so in exactly the
deployment most users run (`OPENAI_API_KEY` or `GEMINI_API_KEY`, no Ollama) the private turn
lost no tools at all: the direct-image branch fired, `web_search` and `fetch_url` stayed in the
catalog, and the speculative research search ran.

### What enforces it now

The gates split by what they protect:

| Gate | Keyed on | Paths |
| --- | --- | --- |
| Who may answer | `localOnly` | `rankFailoverCandidates()`, `withinBoundary()` (vision switch, blend participants) |
| What else may leave | `requested` | `availableTools()` / `findTool()` for `web_search`, `fetch_url`, `generate_image`; `/api/chat`'s direct-image branch; the speculative live search and research mode |

- `src/lib/tools/index.ts` filters the external tools on `policy?.requested`.
- `src/app/api/chat/route.ts`: the direct-image condition is `!policy.requested`, and its
  `findTool("generate_image", policy)` call now passes the policy — it previously passed
  nothing, so it bypassed the filter even under a held boundary.
- `searchFirst` is `!policy.requested`, and the research-mode refusal message reads
  "Research mode needs the live web, which your privacy request rules out", so it is accurate
  when privacy was asked for and cannot be served locally, not only under `localOnly`.
- `privacyNotice()` for the unmet case now names the consequence: "…is answering from a cloud
  provider, **so web search, page fetching and image generation are off for this turn**." A
  private "generate an image of …" that comes back as text has to say why.

So the reported case now answers in text from the configured cloud model, with the boundary
stated in the stream, and never calls the image API. `README.md` documents the two levels.

### What deliberately did not change

Under an unmet request the reply still goes to a cloud chat provider, and provider failover can
move it to a *second* cloud provider if the first 503s. Both are announced (`privacyNotice`
then "Switched to X because Y was unavailable"), and refusing them would mean refusing to answer
at all — that is the difference between a privacy request and a product that cannot respond.
`/api/memory` likewise still accepts a cloud extractor when the transcript came from a cloud
model; the client sends `localOnly` only when the answer was local, and it narrows, never
widens. Blend mode keeps its multi-provider design whenever it is not inside a held boundary:
choosing blend is itself an instruction to ask several providers.

### Stale documentation cleared

- `.env.example` claimed the daily quota "fails open (unlimited)" without Upstash. It has been a
  counted per-instance fallback for several passes; the comment now says what actually happens,
  including the memory and transcription ceilings.
- `ADD_AUTH_AND_BILLING.sh` already refused to run without `FORCE=1`, but it still held stale
  copies of core files and ended in a `git push`, so a reader who ran it would overwrite the
  current `quota.ts` and others. The fourth audit flagged it and the script is now deleted from
  the repository (it remains in the untouched `omniagent-x-v2-fixed (2)-ORIGINAL-backup.zip`
  if it is ever needed again); the `.env.example` quota comment above is the live description.

### Checks executed after this pass

- `tsc --noEmit --incremental false` — zero errors
- `eslint . --max-warnings=0` — zero errors, zero warnings
- `vitest run` — 31 files, **244 tests** passed (4 new since the pass above)
- `next build` — succeeded; `/pricing` still prerendered static, and the rebuilt
  `pricing.html` carries the calls to action in the server HTML
- `npm audit --omit=dev` and `npm audit` — 0 vulnerabilities

New regression coverage: `tools/index.test.ts` gains the "private but no local model" policy and
asserts the external tools are gone while the four in-request tools survive — that test was run
against the previous `localOnly` gate and confirmed to fail there (`expected [ 'web_search',
'fetch_url', …(4) ] to not include 'web_search'`) before the fix was restored.
`privacy.test.ts` asserts the unmet notice names the switched-off extras,
`model-selection.test.ts` pins the cloud-only-catalog case that produced the bug, and
`product.test.ts` fails if the private copy goes back to promising the text never reaches a
cloud model.


## Billing-replay and citation pass (the last two open findings)

The external audit listed seven items. Five were closed by the passes above; the remaining two
are the ones that decide whether a paid deployment can be trusted with money and with sources:
the webhook had no idempotency or reconciliation, and `[n]` citation markers were never checked
against the sources that were actually returned.

### Stated accurately first

`customer.subscription.updated` and `customer.subscription.deleted` were **already** status-derived
(`stillActive = status === "active" || status === "trialing"`), so "the webhook has no
reconciliation at all" overstates it. The concrete defects were narrower, and are now the ones
fixed:

1. `checkout.session.completed` called `setPlan(clerkUserId, "paid")` unconditionally. Stripe
   retries a failed delivery for hours and the dashboard can replay an event weeks later, so a
   week-old checkout event re-delivered after a cancellation re-granted paid access.
2. No event id was recorded anywhere, so every replay re-derived state and re-wrote Clerk metadata.
3. A replayed or out-of-order `customer.subscription.updated` applied the status carried inside
   the event, which is the status as of when Stripe wrote it — for a stale delivery that is not the
   current one.

### What enforces billing state now

- `currentPlan()` retrieves the subscription (`stripe.subscriptions.retrieve`) and derives the
  plan from **live** status. All three handled event types go through it, so a replay converges on
  the account's real state instead of the state an old event described.
- The paid set is unchanged: `active` or `trialing`. `past_due` still falls to free, exactly as
  before — widening that is a billing decision, not a bug fix.
- A checkout session with no subscription id falls back to `payment_status === "paid"`; that is the
  only signal such a session carries.
- `src/lib/server/billing-events.ts` records applied event ids in `stripe:seen:<id>` with a 30-day
  TTL, and the route checks it before doing any work. Without Upstash it keeps the last 500 ids
  per process — weaker, never absent, matching how `quota.ts` and `concurrency.ts` degrade.
- A Redis read failure answers "not seen": dropping a billing event because a cache is unreachable
  is worse than applying it twice.
- The id is written **after** a successful handler. Any Clerk or Stripe failure returns 502 so
  Stripe re-delivers, and the unrecorded id keeps that retry path open.

### Deliberately unchanged

One `STRIPE_PRICE_ID`, one subscription mode, `publicMetadata.plan` as the only plan store, no new
event types (`customer.subscription.created` and the `invoice.*` family are still not handled), no
database, and no scheduled reconciliation job. One limit worth naming: an event whose Clerk user id
no longer resolves will keep being retried until Stripe gives up, because recognising that specific
permanence needs live Clerk error codes and cannot be verified in this environment.

### Citation markers are now resolved against the returned sources

`[n]` reached the browser as literal text — react-markdown does not turn a bare `[7]` into a link,
so it rendered as a citation with nothing behind it, whether the search returned three results or
the chat never searched at all. `src/lib/citations.ts` resolves each marker against `message.sources`
in `src/components/MessageList.tsx`, using the same numbering the visible source list uses (array
order from 1, which is how `runResearch()` labels the evidence turn it hands the model).

- Confirmed markers stay exactly as written. A group like `[1, 9]` with three sources keeps `[1]`
  and loses the number no source covers.
- `[1-9]` stays a range only when both ends are covered; a half-covered range is dropped rather
  than shrunk to `[1]`, which would claim the results in between too.
- With no sources attached, every marker goes: a chat answer cannot cite.
- Untouched on purpose: fenced blocks and inline spans (`values[9]` is code, not a citation), real
  markdown links, images and reference definitions, `[2024]` (no source list is 2024 long), and
  prose inside brackets. `[1][2]` chains are resolved one by one, `[text][1]` is left as the
  reference link it is.
- Only text is removed; nothing is added, renumbered or re-ordered, and no upstream call was added
  to do the checking — it is string work at render time. Because `message.content` is never mutated,
  a marker that arrives before its `sources` event is re-checked when the sources land.
- Product copy needed no change: `REALTIME_SEARCH` already claimed only that the stream says it is
  searching, lists the sources it used, and marks the search as a tool step.

### Checks executed after this pass

- `tsc --noEmit --incremental false` (after deleting `tsconfig.tsbuildinfo`) — zero errors
- `eslint . --max-warnings=0` — zero errors, zero warnings
- `vitest run` — 34 files, **282 tests** passed (38 new: 13 webhook, 7 dedupe, 18 citations)
- `next build` — succeeded; `/pricing` still prerendered static, `/api/stripe/webhook` still a
  server route
- `npm audit --omit=dev` and `npm audit` — 0 vulnerabilities

Regression proof: with the checkout branch reverted to the old unconditional grant, "does not
re-grant paid when a checkout is replayed after cancellation" failed; with the subscription branch
reverted to the payload status, "follows the live subscription status instead of the one in the
payload" failed too. Both assertions were then re-run against the fix and pass.

### Still not verifiable here

Live Stripe replay and retry behaviour, real webhook signature verification, actual Clerk metadata
writes, `SET`/`GET` against a real Upstash index, and how the rendered citation text looks in a
browser — the suite runs in `node` with no DOM, so `citations.test.ts` covers the pure function and
the wiring in `MessageList.tsx` was read, not clicked.

## Local integration pass (the list above, revisited)

That caveat was written from a unit-suite-only vantage point. A follow-up pass ran a real server, so
several of those lines moved from "read" to "executed". Two of them produced findings worth
recording, one of which was a false alarm caused by the harness.

### How it was run

`next start` on a local port, with a localhost stand-in for the Upstash REST API and Stripe
signatures computed with the scheme Stripe itself uses (`t=<unix>,v1=hmac_sha256(secret, "t.body")`).
No real credential of any kind was used, and nothing was written to `.env.local`: every placeholder
was passed in the command environment. Clerk's middleware was temporarily replaced with a
pass-through, because with only fabricated Clerk keys `next start` fails on every route.

### Executed over HTTP — billing webhook

| Case | Result |
| --- | --- |
| signed event with no Clerk reference | `200 {"received":true}` |
| **same event id replayed** | `200 {"received":true,"duplicate":true}` |
| unrelated `ping`, then the same `ping` replayed | `200`, then `duplicate:true` |
| third replay of the same id | still `duplicate:true` |
| missing `stripe-signature` header | `400 missing stripe-signature header` |
| forged signature | `400 signature verification failed: No signatures found matching…` |
| valid signature, timestamp an hour old | `400 Timestamp outside the tolerance zone` |
| new event id | `200 {"received":true}`, processed normally |

Real signature verification, the tolerance window, and the dedupe record therefore ran end to end
against the compiled server, not a mock. The plan-write branches still need a live Clerk instance,
so they stay covered at unit level.

### A false alarm worth the detail

The first replay returned `{"received":true}`, not `duplicate:true` — which reads like a dedupe bug.
It was the stand-in's fault. `@upstash/redis` 1.38.2 parses the raw protocol: `Command.exec`
destructures `{result, error}` off the response body and `/pipeline` returns an array of those, while
the stub answered with the older `{status, data}` envelope. Every lookup resolved `undefined`, and
`eventAlreadyHandled()`'s catch — the documented "answer 'not seen' rather than drop a billing event"
path — returned false. The stub was corrected, not the application: the log line showing
`pipeline [["set","stripe:seen:evt_it_noref","1","ex",2592000]]` had already proved the key naming and
the 30-day TTL, so the code was right and only the harness was wrong.

### Executed through the installed Redis client

`quota.ts` and `concurrency.ts` sit behind `auth()`, so no HTTP request reaches them in this setup.
Driving the same client those modules use, with the same commands, covers the client-side contract:
16 assertions pass — `incr` returning 1 on a fresh key (the branch that stamps the expiry),
`expire`, accumulating `incr`, `get` returning a real number rather than `undefined`, `decr` on the
refund path, `set`/`get` of an event id with its TTL, an unknown id reading back null, and both Lua
scripts through `eval`: three acquires allowed then the fourth denied at `MAX_CONCURRENT_PER_USER`,
`release` decrementing above one and deleting the key at one so the next acquire succeeds, plus two
concurrent `incr` calls auto-pipelined into one request returning distinct counts.

### Citation rendering, now executed rather than read

`test/render-citations.test.ts` renders the real `MessageList` with `renderToStaticMarkup`, so the
`MessageList.tsx` wiring is no longer "read, not clicked": a valid `[1]` survives into the HTML, an
out-of-range `[7]` does not, the source list emits its hrefs in the order the markers were checked
against, a fenced `values[9]` is preserved verbatim, and `[1][2]` is stripped when the message has no
sources. It needed one config change: `vitest.config.mts` now sets `oxc.jsx.runtime = "automatic"`,
because the tsconfig keeps `jsx: "preserve"` for Next's own compiler and the test transform cannot
parse a component import otherwise. `esbuild.jsx` is the wrong knob under this Vite release.

### What still cannot be checked locally

Clerk-gated routes cannot be exercised at all — under the bypass they fail with
`Clerk: auth() was called but Clerk can't detect usage of clerkMiddleware()`, and the server log
confirmed that `/api/conversations` and `/api/memory` returned 500 for exactly this reason, so those
responses are an artifact of the harness rather than behaviour worth reporting as a defect. Real
Stripe retries, real Clerk metadata writes, a real Upstash index and a browser's painted result all
remain unverified.

### Checks re-run after the tree was restored

`src/middleware.ts` was restored byte-identically (md5 `55f57d56f5d8dd1cb87ac04d8d84f37c`), `.next`
was deleted and rebuilt from the restored tree — the middleware bundle is back to 91.3 kB of Clerk
code — and the full chain re-run: `tsc --noEmit --incremental false` zero errors, `eslint .
--max-warnings=0` clean, `vitest run` 35 files **287 tests** passed (the 5 render tests added since
the pass above), `next build` succeeded with `/pricing` still prerendered static, and both
`npm audit --omit=dev` and `npm audit` report 0 vulnerabilities.

### The delivered artifact, re-verified

The packaged tree was re-extracted and confirmed byte-identical to the verified source by
`diff -rq` (excluding only build output), then the chain was run *inside the extraction*: typecheck
clean, lint clean, 287 tests, `next build` compiled successfully with `/pricing` prerendered static
and the middleware bundle back at 91 kB of real Clerk code.

The first attempt at that run reported four failures, and all four were the harness again: the
extracted copy's `node_modules` junction was not resolving, so `npx tsc` executed an unrelated
`tsc` package from the registry, `npx eslint` and `npx vitest` died on `ERR_MODULE_NOT_FOUND`, and
`npx next build` announced it was about to install `next@16.3.6` — two majors above the pinned
release, which would have "verified" the tree against a Next the project does not use. Nothing was
written into the install (`node_modules` still 399 packages at `next@15.5.26`, manifests untouched,
and the extraction still diffed identical afterwards), and the rerun called
`./node_modules/.bin/{tsc,eslint,vitest,next}` directly so no missing dependency can be silently
downloaded. `AGENTS.md` records that rule.

## fetch_url address-pinning pass (closing the DNS time-of-check gap)

### The gap

`assertPublicResolvedHost()` resolved the hostname, checked every record and returned. The
request that followed was a separate `fetch()`, which resolved the name again on its own. A
short-TTL or round-robin record could therefore answer public on the check and private on the
connection, which is exactly the path to `169.254.169.254`. The hop re-checks and the URL
guards were correct; only the coupling between a check and the socket it protected was missing.

### What enforces it now

- `src/lib/tools/pinnedFetch.ts` owns the transport: it re-applies the scheme, credential,
  blocked-hostname, private-address and port guards, resolves with
  `lookup(host, { all: true, verbatim: true })`, refuses zero-record or any-private answers,
  and then hands the **same records** to `node:http` / `node:https` as the request's own
  `lookup` callback. The socket can only connect to an address that was already validated, and
  the callback reads a captured copy, so a later DNS change cannot move it.
- The real hostname stays in the request options, so the `Host` header, TLS SNI and certificate
  verification still describe the target rather than an IP literal, and `agent: false` keeps a
  pooled socket from an earlier, unchecked resolution out of the path.
- `isPrivateIp` and `isBlockedHostname` moved here (exported) and `fetchUrl.ts` imports them,
  so there is one copy of each predicate and the dependency only points one way.
  `fetchUrl.ts` keeps its per-hop `assertPublicHttpUrl()` validation, the hop-by-hop
  `MAX_REDIRECTS` loop, the byte caps, the content-type check and the `UpstreamError` mapping;
  `fetchWithSafeRedirects()` now also reports which hop produced the body, because the
  constructed `Response` carries no `url` of its own.
- Redirects are not followed inside the transport, so the caller's per-hop re-validation stays
  the only redirect path. Timeouts (default 20 s) and a caller `AbortSignal` destroy the request
  and reject.

### Tests

`src/lib/tools/pinnedFetch.test.ts` stubs `node:dns/promises` plus both Node transports and
captures the options handed to the transport, which is the only place the pinned list is
observable. The regression case resolves the name to a public record, switches the DNS stub to
return `169.254.169.254` and `127.0.0.1`, then calls the captured `lookup` callback in both the
`all: true` and the single-address form Node actually uses and asserts it still yields only the
validated public address — the assertion that fails against the old check-then-`fetch()` shape.
Also covered: a private record and an empty answer refused before `request()` is called, blocked
hostnames refused without resolving, IPv4 and IPv6 answers pinned, an IP-literal target pinned
without any resolution, default ports on both schemes, non-2xx and 3xx returned as a `Response`
rather than thrown with the upstream status text and folded multi-value headers, and the timeout
and abort paths. `src/lib/tools/fetchUrl.test.ts` now stubs the transport module instead of
global `fetch`; the `assertPublicHttpUrl` and `htmlToText` suites are unchanged, and the
DNS-rebinding case still runs the real guard against the stubbed DNS with both transports set to
fail loudly, so a refusal that leaked to a socket would surface as `socket opened`.

### Checks executed after this pass

- `./node_modules/.bin/tsc --noEmit --incremental false` — zero errors
- `./node_modules/.bin/eslint src/lib/tools --max-warnings=0` — clean
- `./node_modules/.bin/vitest run src/lib/tools` — 7 files, 93 tests passed
- `./node_modules/.bin/vitest run` — 36 files, 335 passed, 1 failed:
  `test/agent.test.ts` expects `calculatorRunMock` to have been called with `("2 + 2")` while the
  tree now passes the turn's `AbortSignal` as a second argument. That is the in-flight
  signal-threading edit in `src/lib/agent.ts` / `src/lib/types.ts`, not this change set, so it is
  reported rather than fixed here. `eslint .` likewise fails only on
  `src/app/pricing/page.tsx:122` (`react/no-unescaped-entities`), also outside this scope.
- The `lookup` option's real behaviour was confirmed against a live loopback socket in a
  throwaway script (no file added): Node called the custom lookup with `{ hints: 0, all: true }`,
  connected to the address it was handed, and the server saw the request's `Host` as the real
  hostname.

### Still not verified here

`next build`, `npm audit` and a real outbound HTTPS request through this transport (no network
access from the suite, and certificate verification against a live host cannot be exercised
locally). Tool `run()` still ignores the turn's abort signal for `fetch_url` as it did before, so
cancelling a chat turn does not cancel an in-flight page fetch.

### Found while pinning, fixed in the round below

`isPrivateIp()`'s IPv4-mapped branch matched `/::ffff:(\d+\.\d+\.\d+)$/i`, which needs three
dotted groups, so neither `::ffff:127.0.0.1` nor the form a WHATWG `URL` normalises it to
(`new URL("http://[::ffff:127.0.0.1]/").hostname` is `[::ffff:7f00:1]`) was flagged, and both are
`isIP() === 6`. That was a live way to point `fetch_url` at loopback wearing an IPv6 address, so
it was not left as a note: `pinnedFetch.ts` now extracts the embedded address in either spelling
(`embeddedIpv4()`, covering `::ffff:a.b.c.d`, `::ffff:HHHH:HHHH`, the `::a.b.c.d` compat form and
a dotted tail behind any prefix) and judges it with the IPv4 rules, and `ff00::/12` is refused
the way `224.0.0.0/4` already was. `pinnedFetch.test.ts` gained both spellings of loopback and
`169.254.169.254` in the flagged list, plus two public embedded addresses that must stay allowed.
The two open items above — `test/agent.test.ts` and `src/app/pricing/page.tsx:122` — were closed
by the same round; see the next section.

## ChatGPT audit round (eight findings, each checked in source first)

Every claim was read against the code before anything was changed. All eight were real.

| # | Finding | Verdict | What changed |
| --- | --- | --- | --- |
| 1 | Paid plan copy contradicted enforcement | Confirmed: `checkDailyCap` returns before counting for a paid account, so memory saves and transcriptions are unlimited on paid while `PLAN_ROWS` quoted the free numbers with `differs: false` | Both rows now read `Unlimited` / `differs: true`; the voice and memory capability bullets and the "What does the paid plan change?" answer name all three ceilings; `product.test.ts` pins the row set and the paid side |
| 2 | "Local" copy claimed the visitor's own machine | Confirmed: `OLLAMA_BASE_URL` is read server-side, so local means the deployment's host | `Omni Private` tagline and bullets, the private FAQ, the pricing hero line, the Settings note, `privacyNotice()`, `.env.example` and the README privacy bullet now say "this deployment's own Ollama" and state that it is your hardware only when you host it |
| 3 | A cancellation on one subscription downgraded an account another was still billing | Confirmed: the webhook wrote the plan from one subscription's status, while `portal.ts` already documented that Stripe creates a customer per checkout session | New `src/lib/server/billing-plan.ts` with `reconcilePlan()`, used by both webhook cases: an unpaid status only downgrades after every subscription reachable for that account (same customer, plus sibling customers by email whose subscription carries the same `clerkUserId`) has been read. Reconciliation can keep access on, never grant it |
| 4 | `fetch_url` checked DNS and then resolved again | Confirmed, and closed by the section above (`pinnedFetch.ts`) | Pinned transport; `isPrivateIp`'s IPv4-mapped hole from the same pass also fixed |
| 5 | A malformed body produced a 500 | Confirmed: `null`, `[]` and a number in `model`/`projectContext`/`memory`/`conversationId` reached `.trim()`, `.role` or `.length`; `/api/image` already got this right | `bodyAsRecord()` and `optionalText()` in `guards.ts`; `/api/chat` refuses a non-object body with a 400 and reads its string fields through the helper; `/api/memory` does the same and filters transcript entries that are not messages. Cases added to both route tests plus unit tests for the helpers |
| 6 | Auto-search covered less than `REALTIME_SEARCH` promised | Confirmed: the research pattern was `search\|latest\|news\|who won\|current\|today\|source\|cite`, so a question about a price, a version or a score was answered from the model's memory | Pattern extended with the wording the page already promises (recent/breaking, this week/month/year, yesterday, price/pricing/cost, version, release, score/standings/election/polls, winner); `router.test.ts` now classifies one question per promised line and pins the list length so a new promise without a router case fails |
| 7 | Direct image generation ignored `request.signal` | Confirmed: `generateImage` had its own 120 s controller, equal to the route's whole `maxDuration`, and `ToolDefinition.run()` took no signal | `run(input, signal?)` in the interface; `generateImage` links the caller's abort to its controller and refuses to start on an already-aborted turn; `request.signal` passed at the direct-image call site, at the tool loop in `streamWithTools`, at `agent.ts`, and `/api/image` forwards its own |
| 8 | "Unlimited messages, so long research runs never stop mid-thought" | Confirmed: `/api/chat` exports `maxDuration = 120`, so a long run does stop, on both plans | The paid card now claims only that a daily count never ends the conversation; a new FAQ states the per-request bound (seconds, agent steps, tool calls) as identical on both plans; `MAX_REQUEST_SECONDS` in `limits.ts` is checked against the route's literal by reading the route source, because Next only honours a literal there |

`fetch_url` still ignored the turn's abort signal, as its own section notes: it has a 20 s
internal timeout and no per-call cost, unlike the generation that #7 was about. That gap and
the rest of the open list were closed by the next round.

### Checks executed after this round

Run from the repo root with the local binaries:

- `rm -f tsconfig.tsbuildinfo` then `./node_modules/.bin/tsc --noEmit --incremental false` — zero errors
- `./node_modules/.bin/eslint . --max-warnings=0` — clean
- `./node_modules/.bin/vitest run` — 36 files, **359 tests passed**, 0 failed (was 351 at the start
  of the round; the new cases are the regressions listed above)
- `./node_modules/.bin/next build` — compiled, 15 static pages, all 15 routes present
- `npm audit --omit=dev` and `npm audit` — 0 vulnerabilities each

`AGENTS.md` gained the invariants this round established: per-plan copy has to match what the code
does for a paid account, the `maxDuration` duplication, the "never claim the visitor's device"
wording rule, `reconcilePlan` as the only path to a plan write, boundary validation through the
two guards helpers, and `pinnedFetch` as `fetch_url`'s only transport.

## Second ChatGPT audit (seventeen findings, each checked in source first)

Sixteen were real. One (#3's streamed-text mechanism) could not be reproduced, and is recorded
below as what was found rather than as a claim. Nothing in this round touched the billing logic the
project already had: it hardened the paths around it.

| # | Finding | Verdict | What changed |
| --- | --- | --- | --- |
| 1 | A private request could still leak into memory extraction | Confirmed: `/api/memory` trusted only the client's `localOnly` flag, so a turn that read as private but had to be answered by a cloud model arrived with `localOnly: false` and its transcript was summarised by a cloud extractor | The route owns the boundary: it derives `localOnly` from the flag **or** from classifying its own transcript's user turns, filters extractor candidates to `execution === "local"`, and answers `{ memories: [], skipped }` when no local model exists instead of reaching for a cloud one |
| 2 | Blend could send an explicitly private request to several cloud providers | Confirmed: `withinBoundary()` only restricts when `localOnly`, so `requested: true, localOnly: false, unmet: true` walked straight through with a full cloud pool | New `blendParticipants(models, policy, primaryProvider)` in `privacy.ts`, used by `runBlend`: local-only stays local, and a private turn no local model can serve keeps its blend on the provider already answering it. `privacy.test.ts` covers all three policy shapes |
| 3 | Turning Tools OFF could still execute a tool | Half confirmed. The real hole was the partial native tool payload a provider leaves behind when it aborts mid-call: the route honoured it whatever the client had asked for. The stated mechanism — a streamed `TOOL: calculator \| 2+2` line parsed before the switch was read — does not hold: `held = allowTools`, so on a turn with no tools nothing is buffered and the line is emitted as text and never parsed | `streamWithTools` now bails to `retryWithoutTools` when `!allowTools` instead of running that payload, and the misleading comment was replaced with the actual mechanism. `route.tools.test.ts` pins all three paths: the aborted call runs with Tools on and not with them off, the streamed text line runs with Tools on and not off, and no tool definitions are sent at all when Tools are off |
| 4 | Agent mode ignored the Tools switch | Confirmed: `runAgentPlan()` was handed `availableTools(policy)` directly, whatever the client sent | The route builds the list once — `toolsEnabled ? availableTools(policy) : []` — and passes that to the planner, which emits "No tools are available; answering directly." on an empty list |
| 5 | IPv6 link-local filtering missed most of `fe80::/10` | Confirmed: `value.startsWith("fe80:")` covers `/16`, so `fe81`–`febf` passed, and the check sits before literal-IP targets are allowed | `/^fe[89ab]/i` for the real range, plus `fc`/`fd` ULA, `ff00::/12` multicast, and IPv4-mapped addresses in every spelling (`::ffff:a.b.c.d`, `::ffff:HHHH:HHHH`, `::a.b.c.d`, a dotted tail behind any prefix) judged by the IPv4 rules |
| 6 | `web_search` ignored the cancellation signal | Confirmed: `searchWeb()` already took a signal and `run(input)` dropped it | Signal threaded into each engine attempt (Tavily, Brave, DuckDuckGo) and its `fetch`, with an abort check between attempts |
| 7 | `fetch_url` ignored it | Confirmed | `fetchReadableText(input, signal)` → `fetchWithSafeRedirects(start, signal)` → `pinnedFetch`, so a stopped turn stops the fetch and its redirects |
| 8 | `/api/transcribe` ignored the incoming cancellation | Confirmed: only `AbortSignal.timeout(60_000)` | `AbortSignal.any([AbortSignal.timeout(60_000), request.signal])` |
| 9 | User cancellation could mark a healthy provider as failed | Confirmed: `AbortError` is retryable and `recordProviderFailure()` ran before the caller's own abort was consulted, so pressing Stop repeatedly could put a provider into cooldown for everyone | The catch reads `request.signal?.aborted` first and keeps cancellations out of the health record; the turn still stops |
| 10 | "Keep work off third-party providers" conflicted with server-side persistence | Confirmed as an honesty gap: with Save history on, a locally answered conversation is stored in the deployment's configured store | The Omni Private bullets now state that saving history is a separate choice, that the deployment stores those conversations as it stores any others, and that Delete all conversations clears them there too |
| 11 | Settings said history was local-only | Confirmed: "stored in localStorage only. Nothing is sent anywhere" is false whenever server persistence succeeds | Rewritten to what the code does: the browser keeps its copy in localStorage, and while signed in with Save history on the same conversations are kept on that server as well |
| 12 | A delete could silently leave the server copy behind | Confirmed: both `deleteConversation()` and `deleteAll()` stopped calling the delete API once `serverPersistence` had gone false, so a later successful load brought the text back | Deletions are tombstoned in `omniagent.deleted-conversations.v1` and replayed: `reconcileConversations()` drops them from every merge and returns the ids still owed, a pending local-only conversation is never re-uploaded as new work, `deleteServerConversation` counts a 404 as satisfied so the tombstone can be dropped, and the list is bounded |
| 13 | The 8 MB client image limit did not match the server's | Confirmed: the picker allowed 8 MB of bytes while the server measured 4,000,000 base64 characters, so a legal pick became an API rejection | `limits.ts` now derives every ceiling from `MAX_CHAT_BODY_BYTES` — 2,999,952 bytes per image, 3,145,488 per message — and `test/image-limits.test.ts` expands those byte numbers back into characters instead of trusting prose. The deeper half (a saved history whose attachments outgrow one request) is closed by `fitImageBudget()`, which re-sends the newest attachments that fit rather than 400ing |
| 14 | The UI supported one image though four were advertised | Confirmed: the composer held a single `attachedImage` and sent only it | Multi-attachment composer: `attached: Attached[]`, count/per-file/aggregate validation through `attachmentRejection()`, a preview grid with per-item remove and Remove all, a `multiple` picker that resets `input.value`, the attach button disabled at four, and send enabled for an image-only message |
| 15 | The 200-conversation cap was not enforced in browser storage | Confirmed: `saveConversations()` wrote the whole array | Sorted newest-first and sliced to `MAX_CONVERSATIONS`, the same constant the server enforces, so the local list and the loaded list are bounded by one documented number |
| 16 | Stripe reconciliation could miss an active subscription beyond its caps | Confirmed: 5 customers and 10 subscriptions with no pagination, and a truncated scan was indistinguishable from "nothing is charging" | `billing-plan.ts` pages both list calls (100 per page, 3 pages) and returns `undefined` when it ran out; `applyPlan()` in the webhook refuses to write anything on `undefined` and returns 502 so Stripe retries. Reconciliation still only ever keeps access on, never grants it |
| 17 | Duplicate-event protection was not atomic | Confirmed: read → process → mark, so two concurrent deliveries of one event both passed the read | `claimEvent()` takes a `SET NX EX` lease before any work: success lengthens the key to the 30-day record, failure calls `releaseEventClaim()` so the retry path stays open, and an unreachable Redis claims the event — applying twice beats dropping a billing event |

### Checks executed after this round

Run from the repo root with the local binaries:

- `rm -f tsconfig.tsbuildinfo` then `./node_modules/.bin/tsc --noEmit --incremental false` — zero errors
- `./node_modules/.bin/eslint . --max-warnings=0` — clean
- `./node_modules/.bin/vitest run` — 40 files, **421 tests passed**, 0 failed (359 at the start of
  the round; `test/image-limits.test.ts` and `src/lib/server/billing-plan.test.ts` are new, and
  `billing-events.test.ts`, `route.tools.test.ts`, `route.test.ts` for the webhook,
  `privacy.test.ts`, `conversation-sync.test.ts` and `product.test.ts` were extended)
- `./node_modules/.bin/next build` — compiled, 15 static pages, all 15 routes present
- `npm audit --omit=dev` and `npm audit` — 0 vulnerabilities each

### What could not be checked here

- No live Stripe, Clerk, Upstash, provider or Ollama call. The billing work was executed against
  fakes that follow the documented Stripe and Redis shapes, so pagination arithmetic, the lease
  semantics and the retry-on-502 path are verified as logic, not as integration.
- No browser click-through of the four-attachment composer or the tombstone replay. Those rest on
  the pure helpers (`attachmentRejection`, `fitImageBudget`, `reconcileConversations`) being tested
  directly, and on `next build` compiling the components; the interactive state machine around them
  was not exercised.
- Finding #3's stated mechanism was not reproducible, as the table says. What is pinned is the
  behaviour: with Tools off, no path through `/api/chat` runs a tool.
- Finding #1's server-side check uses the same heuristic classifier as the router. A private
  request phrased outside its patterns is still caught only by the client's `localOnly` flag, which
  a caller controls. That is a narrower boundary than the word "private" implies, and it is the
  same classifier every other auto-routing decision depends on.

## Third ChatGPT audit (six findings, each reproduced before it was fixed)

Five were confirmed and reproduced by running the old code against the new test; the sixth (#3)
described a real gap in shape validation and a 500 that the old code did not actually produce. No
billing logic was redesigned: the changes are in body validation, the privacy pool, the Tools
switch and the browser's delete bookkeeping.

| # | Finding | Verdict | What changed |
| --- | --- | --- | --- |
| 1 | Research mode still searched the live web with Tools off | Confirmed, reproduced: `searchFirst` applied `toolsEnabled` only to the chat-mode branch, so `mode === "research"` searched whatever the switch said | The `!policy.requested && toolsEnabled && (...)` condition is now one gate for both branches, and research mode with Tools off emits an explicit status line — the live web is reached by the `web_search` tool, and a mode cannot switch back on what the message switched off. `route.tools.test.ts` stubs `@/lib/tools/webSearch`: with Tools on the search runs and sources arrive (control), with Tools off `searchWeb` is never called in either mode |
| 2 | `/api/conversations` could answer 500 for a malformed body | Confirmed, reproduced twice: `{"title":123}` reached `title.slice()` and answered **500**, and `{"id":987}` passed the truthiness check and answered **200**, writing a Redis key built from a number | `normalizeConversation()` tests `typeof` for `id`, `title` and `projectId` before use, and the route reads the body through `bodyAsRecord()`/`decodeJsonBody()` so `null`, an array and a non-object answer 400 before the normaliser. New `src/app/api/conversations/route.test.ts` pins nine bodies: legal save, non-JSON, `null`, array, number title, number id, non-object message, path-shaped conversation id, chunked oversize |
| 3 | `/api/image` could answer 500 for a valid JSON `null` body | Half confirmed. The stated 500 did not reproduce: `null.prompt` threw inside the `catch` that wrapped `request.json()`, so the old route answered 400 — with the wrong message ("must be JSON") for the right reason by accident. What was real is that the body's shape was never checked and the size limit was header-only | The route now caps the read, then distinguishes the three cases: unparseable → "request body must be JSON", legal JSON that is not an object → "request body must be a JSON object", non-text prompt → "prompt is required" through `optionalText()`. `image/route.test.ts` covers `null`, a numeric prompt and a chunked body over the ceiling |
| 4 | An explicitly private request with an image could still be moved to another cloud provider | Confirmed, reproduced: with the old `withinBoundary(models, policy)` choice the private attachment was answered (200) by a provider the request never named | `boundaryPool(models, policy, currentProvider)` in `privacy.ts` holds the collapse rule — `localOnly` keeps the local pool, `requested && !localOnly` keeps only the provider already answering — and both `blendParticipants()` and the vision switch draw from it, so the two cannot diverge. A private turn whose provider cannot see gets an explicit refusal. New `src/app/api/chat/route.vision.test.ts` (control: an ordinary turn does switch; private turn refused; local-only turn refused) plus four `boundaryPool` cases in `privacy.test.ts` |
| 5 | Pending deletions were lost past 200 offline deletes | Confirmed: `saveDeletions()` wrote `ids.slice(-MAX_CONVERSATIONS)`, so every owed delete past the ceiling was dropped and the conversation returned as restored history | The tombstone list is bounded by a derived `MAX_PENDING_DELETIONS = 2 * MAX_CONVERSATIONS` (the rows the server returns plus the local rows merged beside them). Past that ceiling `saveDeletions()` records `omniagent.conversations.wipe-pending.v1`, and the next successful load clears the account's server history in one request and only then forgets the flag; a failed clear leaves it set. `test/conversation-sync.test.ts` pins the full list surviving, the overflow setting the flag, `clearWipePending()`, and the derived bound |
| 6 | Size protections relied on `Content-Length`, so a chunked request bypassed them | Confirmed for every JSON route and for multipart `/api/transcribe`: `content-length` is a client claim, and `request.json()`/`formData()` buffered the whole streamed body before any limit ran | New `readCappedBody(request, maxBytes)` counts bytes as it reads and calls `reader.cancel()` at the ceiling; `decodeJsonBody()` separates unparseable from present. `/api/chat`, `/api/memory`, `/api/image` and `/api/conversations` read through it, and `/api/transcribe` hands `formData()` an already-capped buffer. `oversizedBody()` stays as an early exit for honest callers, with a comment saying that is all it is. `MAX_CONVERSATION_BODY_BYTES` is derived in `limits.ts` from the character ceiling rather than restated |

Two consequential clean-ups came with #2 and #6: `/api/chat` answers **413** instead of 400 for a
body over the ceiling, which is what every other route already returned and what the code says it
does, and `POST /api/conversations` takes a `Request` rather than a `NextRequest` like the other
routes, so its handler is testable without a server.

### Checks executed after this round

- `rm -f tsconfig.tsbuildinfo` then `./node_modules/.bin/tsc --noEmit --incremental false` — zero errors
- `./node_modules/.bin/eslint . --max-warnings=0` — clean
- `./node_modules/.bin/vitest run` — 42 files, **454 tests passed**, 0 failed (421 at the start of
  the round; `src/app/api/conversations/route.test.ts` and `src/app/api/chat/route.vision.test.ts`
  are new, and `route.tools.test.ts`, `route.test.ts` for chat, `image/route.test.ts`,
  `memory/route.test.ts`, `transcribe/route.test.ts`, `privacy.test.ts`, `guards.test.ts` and
  `conversation-sync.test.ts` were extended)
- Findings #1, #2 and #4 were each re-run against the code exactly as it was before the fix, and the
  new test went red in all three: a 500 on `{"title":123}`, a 200 that wrote a Redis key built from
  a number on `{"id":987}`, a search executed with Tools off, and a private attachment answered by a
  second provider. That is what the "reproduced" verdicts above mean. #3 was checked the same way
  and did not reproduce as stated; #5 and #6 could not be re-run that way, because the helpers they
  now use (`readCappedBody`, `MAX_PENDING_DELETIONS`) did not exist before the fix — their old
  behaviour is what the table describes
- `./node_modules/.bin/next build` — compiled, 15 routes present (`/api/chat`,
  `/api/conversations`, `/api/conversations/[id]`, `/api/image`, `/api/memory`, `/api/status`,
  the three Stripe routes, `/api/transcribe`, `/`, `/pricing`, sign-in and sign-up), two static
  pages prerendered
- `npm audit --omit=dev` and `npm audit` — 0 vulnerabilities each

### What could not be checked here

- The chunked-body cases construct a `Request` with a `ReadableStream` body and `duplex: "half"`,
  which is how undici represents `Transfer-Encoding: chunked` in Node. No real HTTP client, proxy
  or deployment platform was put in front of the routes, so the ceiling is proven at the handler,
  not at whatever buffering a platform's own gateway does first.
- The wipe-pending path in `OmniAgentApp.tsx` is tested through `storage` directly. The component
  effect that consumes the flag needs a browser; `next build` compiles it and the pure storage
  behaviour around it is pinned, but the click-through was not performed.
- Finding #4's pool collapse is applied to the two places that choose a *different* model for one
  turn (blend, vision). Provider failover after a failed request still moves to another provider by
  design, on the reasoning recorded in `AGENTS.md`; if that is not the intended product decision,
  it is a one-constant change in `privacy.ts` and the failover ranking.
- Finding #2's number-id case is worth reading again: before the fix that save returned 200 and
  wrote a real Redis key. Any such row created by a malformed client before this round is still in
  the store; nothing here deletes it.

## Fourth ChatGPT audit (eleven findings, each checked against the source before it was changed)

Nine were confirmed and fixed, one (#4) is a deployment fact this repository cannot settle, and one
(#11) is three claims of different quality. Billing was again not redesigned: the Stripe changes are
the address the session is billed to and a refusal to open a second subscription.

| # | Finding | Verdict | What changed |
| --- | --- | --- | --- |
| 1 | Chats, projects and settings were shared between accounts in one browser | Confirmed: `src/lib/client/storage.ts` wrote fixed key names, so signing out and in as a second user in the same browser loaded the first account's history, and a delete in one account destroyed the other's | `setStorageScope(userId \| null)` selects the key namespace and `nameOf()` refuses every read and write until an account is known. Rows stored before keys existed are **moved** to the first real account and removed, never copied, so a later account cannot inherit them; a signed-out visitor keeps the unkeyed names because that data has no account to belong to. `OmniAgentApp.tsx` calls it from `useUser()` once Clerk has loaded, before any read. New `src/lib/client/storage.test.ts` (six cases: nothing before an account, two accounts apart, per-account projects/settings/tombstones, adoption moves rather than copies, adoption never overwrites, signed-out path). `test/conversation-sync.test.ts` now scopes its fake storage to an account |
| 2 | Checkout billed `emailAddresses[0]` whether or not it was verified, and nothing stopped a paid account opening another checkout | Confirmed on both halves: the route took the first row in Clerk's storage order, and a second `POST` for an already-paid user created a second Stripe session, which is a second subscription | `src/lib/server/billingEmail.ts` returns the verified primary address, else any verified address, else nothing — and it reads Clerk's real `verification.status`, not a boolean field that does not exist on the server type. Checkout passes `customer_email` only when one is confirmed, so Stripe asks instead of silently billing an abandoned address, and answers **409** with `alreadySubscribed` before a session is created when `publicMetadata.plan` is already paid. `/api/stripe/portal` uses the same resolver. `billingEmail.test.ts` (5) and a new `checkout/route.test.ts` (6, including "bills the primary address, not whichever Clerk happened to return first") |
| 3 | A concurrency slot could leak, and without Redis nothing reclaimed it | Confirmed: `beginRun()` acquired the lease and then charged quota, the daily cap and the plan lookup outside any `catch`, so a throw left the lease held; the in-process fallback counted per user with no expiry, so three leaks ended that account's ability to run until the process restarted | `beginRun()` wraps the charge stage and releases the lease on any throw before re-throwing. The fallback becomes a `Map<string, LocalSlot[]>` where each slot carries `expiresAt` (the same `SLOT_TTL_SECONDS` the Redis path uses) and `release()` removes that one object rather than a count, so an expired slot's late release cannot drop a live one. `guards.test.ts` gains the three throw cases (quota, cap, plan lookup) each asserting `release` ran; `concurrency.test.ts` gains three fake-timer cases including the staggered-expiry one |
| 4 | The app's body caps (5 MB chat, 20 MB conversations) can exceed what a hosting platform accepts, and `GET /api/conversations` answers up to 200 inline rows with no pagination | Half confirmed. The ceilings are enforced as written and are tested at the handler. Whether a given host's own limit is smaller is a property of that host and cannot be checked from this repository, so the specific figure was not adopted as fact | README and `AGENTS.md` now state that the platform's ceiling and ours are both in force and the smaller one decides, and that a deployment on a tighter host should lower these numbers rather than meet a 413 it did not raise. Pagination was **not** added: it would change the server route, the client merge and the tombstone bookkeeping at once, and a half-done version is worse than the documented bound. Recorded as checked and deliberately not changed |
| 5 | `getPlan()` called Clerk's `currentUser()` on every charge and every refund, and the daily allowance rolled over at UTC midnight | Confirmed for the lookups: one message could ask Clerk for the plan two or three times, since the consume and refund helpers each resolved it themselves. The UTC rollover is real but is a product decision, not a bug | The plan is resolved once per run in `chargeForRun()` and travels in `run.plan`; `checkAndConsumeQuota`, `refundQuota`, `checkDailyCap` and `refundDailyCap` take it as an optional argument and only look it up when the caller did not have one, so existing one-argument call sites still work. `guards.test.ts` asserts `getPlan` is called **one** time across a whole run including the refund. `USAGE_DAY_OFFSET_MINUTES` (default `0`, clamped, non-finite treated as zero) moves the rollover for operator-configured deployments; per-user timezones would need a stored preference and were not invented here |
| 6 | A reply whose visible text was under the release threshold was emitted raw, reasoning block and all | Confirmed: the short-answer branch sent `buffer`, which is the unprocessed stream, and wrote that same string into the conversation history | `stripThinking()` in `src/lib/tools/index.ts` removes a closed reasoning block, drops an unclosed one, and is applied at both flush sites and both history-write sites in `/api/chat`. `tools/index.test.ts` pins the closed block, the unclosed block and an ordinary short answer that must survive untouched |
| 7 | The SSRF filter missed address forms that reach a private host | Confirmed against the code: `2002:7f00:1::` is 6to4 wrapping 127.0.0.1 and the filter only unwrapped mapped and NAT64 addresses; `fec0::/10` and the documentation ranges were not tested at all | `embeddedIpv4()` now also unwraps 6to4 (`groups[0] === 0x2002`) and Teredo's complement, `isSiteLocal()` rejects `fec0::/10`, and the v4 documentation blocks plus `2001:db8::/32` are refused as the unreachable ranges they are. `pinnedFetch.test.ts` lists each form, including a public 6to4 address that must still be allowed, so the rule is not "block all of 2002::/16" |
| 8 | Source links were rendered as `href` without a scheme check | Confirmed: only the DuckDuckGo path tested the scheme, and `MessageList` built an anchor from whatever a provider handed back, so a `javascript:` or `data:` URL became a clickable link in the reader's own page | `src/lib/sources.ts` holds `isFollowableUrl()` (absolute http(s) only) and `followableSources()`, applied where search results become sources **and** again where a saved conversation renders, because a row stored before the filter is still in somebody's history. The renderer keeps the `[n]` numbering intact by drawing an unclickable source as plain text. New `src/lib/sources.test.ts` (5) |
| 9 | `htmlToText` decoded `&amp;` first, so `&amp;lt;` became `<` | Confirmed: decoding `&amp;` before the others re-opened entities that were escaped on purpose, which is how fetched text could smuggle markup into the prompt | The entity table is decoded with `&amp;` last, after `&nbsp;`, `&lt;`, `&gt;`, `&quot;` and `&#39;`. `fetchUrl.test.ts` asserts `&amp;lt;b&amp;gt;` reads back as literal `&lt;b&gt;` while an ordinary `&lt;` still becomes `<` |
| 10 | `ADD_AUTH_AND_BILLING.sh` held stale copies of core files and ended in a `git push` | Confirmed: the script embedded older revisions of server files and pushed, so running it would overwrite current code | The script is deleted from the repository. It stays recoverable from `omniagent-x-v2-fixed (2)-ORIGINAL-backup.zip`, and the paragraph above in the earlier section that described its header was rewritten to say the file is gone |
| 11 | The audit document was stale at 78 KB, `/api/chat` had broken indentation, and the `fetch_url` User-Agent hard-coded a personal GitHub URL | Three separate claims. The document was stale — this section is the fix. The indentation is real but purely cosmetic. The User-Agent was indeed shipping somebody's repository URL to every site the tool visits | `FETCH_USER_AGENT` now supplies the optional contact half and the shipped default is the bare product token `OmniAgent/1.0`, documented in `.env.example` and README; two new `fetchUrl.test.ts` cases pin the default (and assert it contains no URL or address) and the override. The indentation in `src/app/api/chat/route.ts` was **left alone on purpose**: `eslint` has no indent rule here, the four checks are green with it, and reflowing ~180 lines of the one streaming route in the app is a real risk of a behavioural typo bought for no gain |

### Checks executed after this round

- `rm -f tsconfig.tsbuildinfo` then `./node_modules/.bin/tsc --noEmit --incremental false` — zero errors
- `./node_modules/.bin/eslint . --max-warnings=0` — clean
- `./node_modules/.bin/vitest run` — 46 files, **516 tests passed**, 0 failed (454 at the start of
  the round; `src/lib/client/storage.test.ts`,
  `src/lib/server/billingEmail.test.ts`, `src/app/api/stripe/checkout/route.test.ts` and
  `src/lib/sources.test.ts` are new files, and `guards.test.ts`, `concurrency.test.ts`,
  `tools/index.test.ts`, `pinnedFetch.test.ts`, `fetchUrl.test.ts`, `conversation-sync.test.ts`,
  the memory / image / transcribe / chat route tests were extended
- Each "Confirmed" verdict above was produced the same way as the last round's: the new test was run
  against the behaviour it replaced. The storage tests cannot pass against the old unkeyed module,
  the checkout tests fail against a route that had no 409 and read `emailAddresses[0]`, the three
  `beginRun` throw tests fail while the lease stays held, the plan test sees two or three lookups
  in the old code, the reasoning-block tests emit the raw buffer, and `&amp;lt;b&amp;gt;` decoded to
  `<b>` before the entity order was fixed
- `./node_modules/.bin/next build` — compiled, all API routes and pages present
- `npm audit --omit=dev` and `npm audit` — 0 vulnerabilities each

### What could not be checked here

- Finding #4's platform ceiling. The handler-side caps are tested; what a specific host does to a
  request before it reaches the handler depends on a plan this repository cannot see, and the audit
  itself asked for that figure to be verified rather than asserting it. The README says the smaller
  ceiling wins instead of guessing a number.
- Finding #1's migration runs in a browser. The test stubs `window.localStorage`, so adoption, the
  never-overwrite rule and the signed-out path are pinned as logic; the actual case of a user who has
  chats in the old unkeyed keys, signs in, and sees them move to their account was not performed in
  a real browser.
- Finding #5's Clerk lookup is counted against a mocked `currentUser()`. The saving is real in the
  handler graph; the latency of the live API was not measured.
- The `verification.status` shape was read from the installed Clerk package, not from a live
  account. An address whose `verification` object is absent is treated as unverified, which is the
  safe direction, but no signed-in Stripe checkout was exercised.
- The same limits as last time hold: no live provider, no browser click-through of `MessageList`, and
  the indentation in `/api/chat` remains as reported because changing it was judged a worse trade
  than documenting it.

## Fifth ChatGPT audit (eight confirmed findings, each reproduced or read in source before it was changed)

The report separated what its author had reproduced from what it had only read. Only the eight in the
first group were touched; the "likely problems" and "smaller issues" lists are recorded at the end of
this section as seen-and-left, which is what the instruction to change nothing else required.

| # | Finding | Verdict | What changed |
| --- | --- | --- | --- |
| 1 | A chat longer than 60 messages broke | Confirmed: `history.slice(-MAX_HISTORY_MESSAGES)` keeps whatever sits at the boundary, and in an alternating transcript that is the assistant from message 61 onward — a first message that is an answer, which Anthropic's Messages API refuses outright | `trimHistory()` in `src/lib/server/guards.ts` slices and then moves the start onto the first `user` turn; a window holding none returns `[]`, which lands on the route's existing 400 rather than a provider error nobody could act on. `/api/chat` now builds its history through it. Four `guards.test.ts` cases: the 61-turn window opening on `message 2` at length 59, a 60-turn window untouched, an all-assistant window answering `[]`, a short chat untouched. README states the window rule where the other request bounds are stated |
| 2 | A reload could drop the newest messages | Confirmed: `reconcileConversations()` took the server's copy of any id present on both sides verbatim, so with the save debounced a tab closed within a second or two of a reply lost those turns to an older server row — four local messages came back as two | Resolution is per row now: `isMoreRecent()` compares `conversationStamp` and breaks a tie by the copy holding more messages, so the newer side wins whichever side it is on. The function also returns `needsUpload` — every row where the browser holds the truth, whether the server had no row or an older one — and `OmniAgentApp.tsx` feeds those ids to the ordinary debounced save instead of only the never-sent ones, so the recovered turns do not stay stranded in this one browser. Five cases in `test/conversation-sync.test.ts`, including the reported four-versus-two shape, the server-newer direction, the tie, and a delete outranking a newer local copy of the same row |
| 3 | Memory was not fully controllable while the copy said it was | Confirmed on all three halves: `/api/memory` answered GET and POST only, nothing anywhere listed or deleted a stored memory, and `/api/chat` read the stored facts on **every** request whatever the switch said — off stopped new writes but not the use of what was already there. `product.ts` had been claiming "you can delete any stored memory" for two rounds | Four parts. `deleteMemory()` and `clearMemories()` in `src/lib/server/memory.ts` — the clear walks the whole index rather than `listMemories`, because that read is capped at `MAX_MEMORIES` and a clear built on it would report success with the oldest rows still in storage. `DELETE /api/memory` taking `?id=` for one fact and `?all=1` for the account's list, answering 401 unsigned, 400 for a request naming nothing, an `all` that does not mean yes or an id too long to be one, 500 when storage refuses, and `{ deleted, memories }` otherwise. `memoryClient.ts` gains the three calls, and the Memory section of Settings now lists what is remembered with a Forget button per row, a clear-all, and three honest notices (nothing remembered / this needs a signed-in account / the list could not be read). Its old "Clear memory" button is labelled "Clear these notes", which is what it always did. And `/api/chat` reads **neither** half — the user's own notes nor the server's facts — unless the request says `memoryEnabled: true`, which `SendOptions` now requires rather than offers, because a request that never answered is not consent. Fourteen new cases across `test/memory.test.ts` (4), `src/app/api/memory/route.test.ts` (9, including the first coverage `GET` ever had) and `chat/route.tools.test.ts` (4). No copy change was needed: the two claims became true |
| 4 | The private keyword test was too broad | Confirmed, all three quoted phrases: "Why does my private method throw in TypeScript?", "make my PWA work offline" and "do not send me marketing emails" each classified as `private`, which took the tools and the search away, sent the question to a local model, and had memory extraction skip the turn | `PATTERNS` became a list of predicates instead of one regex per capability, and the private test became `PRIVATE`, a list of whole phrases ("private data", "keep this private", "this is confidential", "don't send this to anyone …", "local model only"). Private stays first, so a genuine privacy claim that also mentions code or search still outranks both. Two new `router.test.ts` cases pin the three false positives and four true ones. One fixture in `privacy.test.ts` said "private refactor of my search code", which is a code word rather than a privacy request; it now says "keep this private: …" and the assertion underneath it is unchanged |
| 5 | A rejected request burned quota no refund could recover | Confirmed: the counter was incremented before the ceiling was compared and never given back when the comparison refused it, so every over-limit attempt pushed the count further past the limit. An account with 19 successful messages could be locked out by its own failed attempts, and the route's refund then gave back one of the ones it had paid for | `consumeUpTo()` in `src/lib/quota.ts` takes the unit and puts it straight back when it lands above the ceiling, and both charge sites — the message allowance and each route's daily cap — go through it. Four new `quota.test.ts` cases: a full allowance that survives three refusals plus a refund, the same through the Redis path asserting the decrement on the dated key, a count that was inside the ceiling being left alone, and the cap scope |
| 6 | PDF export wrote `?` at the end of every Windows line, and a long title ran off the page | Confirmed both: `toWinAnsi` mapped `\r` to the font's not-defining glyph, and the title was cut at a fixed 90 characters measured against nothing, so it drew at 743 pt on a 483 pt text column | Line endings are normalised to `\n` inside `toWinAnsi` (`\r\n` and a lone `\r` both), and `fitToWidth()` trims the title against the bold font's own `widthOfTextAtSize` before adding the ellipsis. `PAGE_WIDTH`, `MARGIN` and `TITLE_SIZE` are exported so the test measures the same column the layout drew into. Four cases in `generatePdf.test.ts`: CRLF leaves no `?` anywhere, a lone `\r` becomes a break, a title that really is wider than the page comes back inside it and ends in the ellipsis, and a title that fits is not shortened |
| 7 | The DuckDuckGo fallback decoded every redirect twice | Confirmed: `searchParams.get("uddg")` already decodes, and the extra pass turned `%25` into `%` in the link the reader was handed, while a `%E9`-style escape made `decodeURIComponent` throw and — because it sat in the loop — fail a search that had perfectly good results in it | The second decode is gone. One new `webSearch.test.ts` case runs a `%2523` target, a `%25E9` target and a plain result through the parser together: the first two keep the escaping they arrived with and the plain one is untouched, which is the shape that used to sink the whole page |
| 8 | Enter sent the message in the middle of an input-method composition | Confirmed: the textarea's handler checked only `event.key` and `shiftKey`, so a keystroke confirming a Chinese, Japanese or Korean candidate sent the draft as it stood | `!event.nativeEvent.isComposing` joins the condition in `src/components/Composer.tsx`, with the reasoning at the handler. Not covered by a test: the suite runs in a node environment with no DOM, and this harness builds no React renderer — see what could not be checked below |

### Checks executed after this round

- `rm -f tsconfig.tsbuildinfo` then `./node_modules/.bin/tsc --noEmit --incremental false` — zero errors
- `./node_modules/.bin/eslint . --max-warnings=0` — clean
- `./node_modules/.bin/vitest run` — 46 files, **551 tests passed**, 0 failed (516 at the start of the
  round; +2 `router.test.ts`, +4 `quota.test.ts`, +4 `generatePdf.test.ts`, +1 `webSearch.test.ts`,
  +4 `guards.test.ts`, +5 `conversation-sync.test.ts`, +4 `test/memory.test.ts`, +9
  `src/app/api/memory/route.test.ts`, +4 `chat/route.tools.test.ts`)
- Each "Confirmed" verdict was produced by running its new cases against the behaviour it replaced:
  the 61-turn window test fails while the slice is unopened, the four-versus-two test fails while the
  server copy wins, the three quota tests fail while a refusal keeps its increment, the CRLF and
  title tests fail against the old mapper and the 90-character cut, the DuckDuckGo test fails on the
  double decode, and the four memory-gate tests fail while the route reads stored facts unasked
- `./node_modules/.bin/next build` — compiled, every route present; `/api/memory` is listed as a
  dynamic route as before
- `npm audit --omit=dev` and `npm audit` — 0 vulnerabilities each

### What could not be checked here

- Finding #8 has no test. `vitest.config.mts` sets `environment: "node"` and this suite deliberately
  has no React renderer, so a synthetic `keydown` with `isComposing` set cannot be dispatched here.
  The change is one clause on the handler that `tsc` and the build both cover; no browser with an IME
  was driven.
- Finding #3's Settings panel is likewise covered as logic only: the store, the route, the client
  calls and the chat-route gate are tested, while the list's rendering and the two buttons are checked
  by `tsc` and `next build`. No click-through in a browser was performed.
- Finding #1's provider half. No test reaches Anthropic; what is pinned is `trimHistory()`, the
  function the route calls, at exactly the boundary the report named. The 400 the provider would have
  returned is inferred from the documented rule that a Messages request must open on the user.
- Finding #2's multi-device case. The merge is pinned for one browser against the server's answer; a
  second browser holding a still-newer copy of the same row is a three-way race that this function
  does not resolve and was not exercised.
- Finding #3's clear-all against real Upstash. `test/memory.test.ts` asserts the swept key set
  through the mocked client, including the past-the-page rows; no live namespace was purged.
- The two lists the report labelled "likely" and "smaller" were **not** changed, as instructed: the
  `{ ...candidate, ...saved }` overwrite on a save echo, `react-markdown` rendering remote images,
  Perplexity's strict role alternation, `inspect_pdf` reachability from the composer, the
  "nothing goes to a third party" line in Privacy settings, provider timeouts after headers and
  abort-listener removal, the concurrency TTL equalling `maxDuration`, `formatMoney` on three-decimal
  currencies, the per-request Redis log line when Upstash is unset, and the duplicated client types.
  All are still open, and none of them is newly broken by this round.

### One thing found while fixing #3

The chat route's memory read had been shipping the user's own notes whenever the field arrived, so the
old client sent `memory` only while the switch was on. That is now the **server's** rule as well, and
the flag travels on every request. Consequence for anything outside this app that posts to
`/api/chat`: a body that does not say `memoryEnabled: true` gets no memory injected at all. That is
the deliberate direction — off is the default, and a caller that wants the remembered facts has to
ask for them — and it is the only behaviour change in this round that a third-party client could
notice.

## Sixth audit — reviewing the zip that came back with these fixes already in it

The round before this one ended with the five fixes and the documentation above. The tree then went
to another model and came back as `omniagent-x-v2-fixed (3).zip`: thirteen repairs, four new test
files, and a report claiming 50 test files / 571 tests with typecheck and lint clean. This section is
that artifact audited line by line against the previously verified tree, and everything this round
changed on top of it.

Every claim was re-run rather than read. The reported file and test counts, the clean typecheck and
the clean lint all held. The two verification gaps the report admitted to — a hand-rolled parser used
in place of `tsc`, and a `next build` run with the font loading stubbed out — were closed here with a
real `tsc --noEmit --incremental false` and a real `next build` with no stubs, both of which passed.

### Verdict on the thirteen repairs

| # | Change in the returned zip | Verdict |
| --- | --- | --- |
| 1 | `requestJson` builds the request signal from `AbortSignal.any([signal, AbortSignal.timeout(ms)])` instead of `setTimeout` + `clearTimeout`, so the deadline covers the streamed body and not only the headers | confirmed, kept |
| 2 | Anthropic and Gemini pass `timeoutMs: 120_000`; Perplexity drops the `isDeepResearch` branch and always gets 120s | confirmed, kept |
| 3 | New `normalizePerplexityMessages()` folds system text and merges adjacent same-role turns before the wire map | confirmed, kept |
| 4 | Concurrency slot TTL is `MAX_REQUEST_SECONDS + 30` rather than a duplicated 120 | confirmed, kept |
| 5 | Server keeps `shouldReplaceStoredConversation()`: fewer messages loses, equal length is decided by the newest `createdAt`, a tie is accepted only when the newest message keeps its id | confirmed, kept |
| 6 | Client `mergeSavedConversation()` refuses a save echo that carries fewer messages than local state | confirmed, kept |
| 7 | `conversationStamp()` reads the message timeline before `updatedAt`, because a server save stamps `updatedAt` fresh | confirmed, kept |
| 8 | Transcribe checks the whole multipart envelope against `MAX_UPLOAD_BYTES` and still checks the parsed part against `MAX_AUDIO_BYTES` | confirmed, kept |
| 9 | Markdown allows only `https?`/`mailto:`/`tel:` links, turns a bare link into text, and renders a remote image as a link rather than an `<img>` | confirmed, kept |
| 10 | Privacy copy now names Clerk, Upstash and Stripe instead of claiming nothing leaves for the provider | confirmed, kept |
| 11 | Delete during an in-flight save keeps a tombstone and a per-id `saveInFlightRef` counter, and the delete is re-applied when the save lands | confirmed, kept |
| 12 | The save effect's dependency list was completed, which is what silenced the `react-hooks/exhaustive-deps` warning | confirmed, kept |
| 13 | `formatMoney` three-decimal set, plus a comment saying ISK and UGX stay two-decimal | half right — corrected below |

`next-env.d.ts` reappearing in their zip is not a defect. Next generates it on any build; this package
excludes it, so the shipped tree still builds it fresh.

Their package also carried a separate `OMNIAGENT_DEEP_REPAIR_REPORT.md`. It was not carried forward, on
purpose: its headline verification line is "TypeScript/TSX syntax parsing: **124 files, 0 parse
diagnostics**", which is a hand-rolled parser's output and says nothing a `tsc` run would agree with,
and its build line was recorded with font loading stubbed out. Those numbers were the only place a
later reader could get a green check from, and they were not green checks. The replacements are the
real `tsc` and `next build` entries under "Checks executed on this tree" below. The rest of that
report's substance is reproduced in this section, including its one claim that did not describe the
arriving code at all: it says the previous pass broke `next build` by exporting `MAX_UPLOAD_BYTES`
from the transcribe route. That export existed only inside their own intermediate pass and was already
gone from the tree that arrived; the constant is module-private here.

### Corrected or tightened here

- **ISK and UGX are whole-unit money.** Stripe's currency page says both "transitioned to a
  zero-decimal currency" while backward compatibility requires the API amount to stay two-decimal,
  `500` buys 5, and no fraction is chargeable. The returned tree divided correctly and printed
  `12.50 ISK`, which is an amount that cannot exist. `money.ts` now keeps the minor-unit division and
  prints through `WHOLE_UNIT_CURRENCIES` with zero decimals, so `500` displays as `5 ISK`.
- **The KWD fixture was not a chargeable price.** Stripe requires the last digit of a three-decimal
  amount to be 0 or 5; `1234` KWD is not a value a price can hold. The test now uses `5120`.
- **The concurrency test pinned a number instead of the rule.** It asserted the TTL equalled a literal
  120, which passed only because the old constant was also wrong. It now asserts the TTL is greater
  than `MAX_REQUEST_SECONDS`, so changing the request budget cannot silently re-create the truncation.
- **`npm audit` (full, dev included) found one high advisory** in `brace-expansion` after the tree was
  otherwise clean. It is reachable only through `minimatch`, and the two versions in the dependency
  graph need different fixes, so `package.json` overrides it per parent major:
  `minimatch@3 → brace-expansion ^1.1.21` and `minimatch@10 → ^5.0.12`. `npm ls brace-expansion --all`
  reports both as `overridden`, and both audits are at zero.
- **A duplicated import** of `@/lib/client/storage` in `OmniAgentApp.tsx` was merged into one statement.
- **A length-based merge is not a bug to fix.** This round briefly widened both merge predicates to
  accept a shorter snapshot when it was an exact prefix of the longer one, which looked like a lost
  shrink on another device. That is wrong: a stale tab's copy of a conversation *is* byte-identical to
  a deleting tab's prefix, so accepting prefixes would let one device erase another's newest turn for
  the whole account. Both predicates are back to refusing the shrink, the reasoning is recorded in
  `AGENTS.md`, `README.md` and the code comments, and a test in `client/storage.test.ts` pins that a
  copy which lost a turn cannot overwrite the copy that has it. Regenerate stays safe because `run()`
  appends its placeholder synchronously, well before the 700ms autosave.

### Checks executed on this tree

- `tsc --noEmit --incremental false` — exit 0, no output
- `eslint . --max-warnings=0` — exit 0, no output
- `vitest run` — 50 test files, 572 tests passed
- `next build` — exit 0, compiled successfully, real font loading, `/api/memory` and `/api/transcribe`
  present in the route list
- `npm audit --omit=dev` and `npm audit` — 0 vulnerabilities each

### What could not be checked here

- The Markdown and composer changes are covered as pure functions and by the build. `vitest.config.mts`
  runs in the `node` environment with no React renderer, so no link or image was actually clicked or
  painted, and no IME was driven to confirm `isComposing`.
- No live provider, Clerk, Upstash or Stripe call was made. The timeout repairs are proven by spying
  `AbortSignal.timeout` and by a signal that survives headers and aborts on a slow body; what the
  upstream actually sends at 119 seconds is inferred from the route's own `maxDuration`.
- The conversation merge races are reasoned and pinned one browser at a time. Three tabs plus the
  server on the same row was not executed against real persistence.
- The ISK/UGX and KWD rules come from Stripe's published currency documentation. No real Stripe price
  was created or rendered to display them.

## Seventh audit — the full-product pass that came back, and what it got wrong

`omniagent-x-v2-full-audit-repaired.zip` was reviewed the way every round before it was: the
returned tree diffed against the last verified one, each claim in its report checked against
source, and then the whole chain actually executed rather than described.

### What arrived

148 files against a baseline of 145: eight modified, three added, nothing deleted. All fifty of the
earlier test files survived and both touched test files contained additions only, so the round did
not lose work.

Its own report is the part that could not be trusted. `OMNIAGENT_FULL_PRODUCT_AUDIT.md` counted the
tree at 146 files. It reported "127 TypeScript/TSX files parsed with zero parser diagnostics",
where the parsing was done by a hand-rolled script and not by `tsc`. And it stated that "Eight
targeted runtime checks were executed against the repaired source and all passed", with `AUDIT_
RUNTIME_SMOKE.txt` as two bare assertions behind that sentence - no command, no test name, no
output. Non-negotiable #5 in `AGENTS.md` is that a claim needs a command that produces it, so both
files were rewritten as the record of what really ran.

### The chain, run against the tree exactly as it arrived

| Check | Result |
| --- | --- |
| `tsc --noEmit --incremental false` | exit 0, no output |
| `eslint . --max-warnings=0` | **exit 1** - `src/lib/tools/pinnedFetch.test.ts:61`, `no-unused-expressions` |
| `vitest run` | exit 0 - 51 files, 576 tests |
| `next build` | exit 0 - the same warning surfaced, non-fatally |
| `npm audit --omit=dev`, `npm audit` | 0 vulnerabilities each |

That lint failure is the first one this repository has carried, and it arrived inside the code added
by the round that said it had not run lint.

### Repairs made in this pass

1. **`pinnedFetch.test.ts:61`** - the `this.response && (this.response as Readable).destroy(...)`
   expression statement became an `if` block. The gate is green again.
2. **`models.test.ts`** - one test demanded a hard-coded set of ten providers, which is a product
   inventory written into a test: it could only pass once somebody added a catalogue row for the two
   providers that had no model. A test should hold an invariant, not decide what the pricing page
   advertises. It now asserts the two things that break silently - every picker id resolves back to
   the row that declares it, so a `:free` or `:fastest` suffix cannot shadow another provider's
   model, and every row names a provider with a registered adapter.
3. **`models.ts`** - the OpenRouter row inherited `vision: true` from its Groq twin. Getting that
   flag wrong is not symmetric: advertising a model as vision-capable sends image turns to a
   provider that will reject them, while leaving it off only costs that one picker. The unverified
   flag is gone. Both new rows stay, because the two adapters they exercise were already registered
   and unusable before, and the derived `/pricing` line now reads 18 models across 10 providers -
   confirmed against the built HTML, not inferred.
4. **`anthropic.ts`** - the `claude-fable-5` exclusion of the `thinking` field rested on "Anthropic's
   current API guidance" with no citation, and contradicted itself: the same branch still sent
   `output_config.effort` to that model. Reverted to the request shape every Claude 5 model had in
   the verified tree, which the suite passed with. An uncited claim is not a reason to change what
   goes on the wire.
5. **`storage.ts`** - the exact-tie `return current` is kept; it fixes the save-echo overwrite the
   sixth audit left open. Its comment was not true. It said cross-device equal-stamp conflicts are
   handled by server-side reconciliation, and `shouldReplaceStoredConversation` does the opposite:
   same length, same newest timestamp, different message id means the stored row is kept and the
   write is refused. Rewritten to say what actually happens on both sides.
6. **`pinnedFetch.ts` / `fetchUrl.ts`** - keeping the deadline armed until the body closes is the
   right repair and stays. What nobody flagged is that it changes the meaning of a caller's number:
   `FETCH_TIMEOUT_MS` is now an end-to-end budget for headers *and* up to 1.5 MB of body instead of
   a time-to-headers allowance. The constant now documents that where it is set, rather than
   silently meaning something new.
7. **`OmniAgentApp.tsx`** - the account-switch hardening is genuinely good and closes a real hole,
   so it is kept; four things inside it were corrected. `setHydratedAccountId(undefined)` was dead
   code (both setters sit in one synchronous effect body, so React never renders the `undefined`),
   and the comment above it described a boundary mechanism that does not exist; the gate works
   because `hydratedAccountId` is only ever assigned at the end of that effect, and the comment now
   says that. `accountIdRef.current = accountId` ran during render, which React is free to repeat
   and discard - it moved into an effect, which is still earlier than any `await` that reads it. The
   history-load retry had no bound at all: an open tab would knock on a dead history service every
   five seconds for the life of the session, so it now makes its initial attempt plus two retries
   and then leaves the tab on local storage. And `forgetMemory`/`forgetEveryMemory` refused to act
   while signed out without saying anything, when `MEMORY_SIGNED_OUT` exists in that file for
   exactly that case; `deleteOnServer` still returns quietly, and now explains why a signed-out
   browser has nothing owed.

### Checks executed on the repaired tree

- `tsc --noEmit --incremental false` - exit 0, no output
- `eslint . --max-warnings=0` - exit 0, no output
- `vitest run` - 51 test files, 577 tests passed (one provider-set assertion replaced by two
  invariant assertions)
- `next build` - exit 0, 15/15 static pages, no warnings; `/pricing` HTML reads "18 models across 10
  providers, 7 of them able to read images"
- `npm audit --omit=dev`, `npm audit` - 0 vulnerabilities each

### What still cannot be certified from here

- Neither `qwen/qwen3.8-27b:free` nor `openai/gpt-oss-120b:fastest` was called. They are correctly
  routed by construction now that a test proves each row has an adapter, but whether a specific
  OpenRouter or Hugging Face account can answer them is not knowable without the key.
- No test covers the `OmniAgentApp.tsx` changes: `vitest.config.mts` runs in the `node` environment
  with no React renderer, so the account-switch guards, the retry bound and the signed-out notices
  were reasoned through and reviewed, not executed.
- No live Clerk, Upstash or Stripe path was exercised, so the retry bound is unverified against a
  real outage.

## Eighth audit — the model catalogue checked against live provider documentation

A third-party pass returned a "clean error list" of catalogue ids plus one provider-code claim, and
asked for every model's code to be checked. The rule from `AGENTS.md` applies: a returned report is a
set of claims, not evidence. So each id was re-checked at the provider's own documentation before any
string was edited, and the report's two assertions about our source were read back against the file
they named.

### What the report got right

- `gpt-5.6-sol`, `gpt-5.6-terra` and `gpt-5.6-luna` are not documented OpenAI ids. The models page
  lists `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna` and `gpt-5.6-cyber`.
- Perplexity is worse than the report said. It quoted a `sonar-reasoning-pro` effort branch, but the
  live problem is the transport: the Sonar chat-completions surface was retired on 2026-09-27 and
  replaced by the Agent API. Every request this application made to Perplexity since that date failed.

### What the report got wrong

- It quoted `src/lib/providers/perplexity.ts` as containing
  `if (model === "sonar-reasoning-pro") { return "medium"; }`. That code does not exist here and never
  did - the branch set `max_tokens`, not a returned effort level. The endpoint finding is real; the
  quoted snippet is not this repository.
- It listed `claude-haiku-4-5-20251001` as one of our entries. It is not in the tree: no catalogue row,
  no fixture, no reference. It is a documented, active Anthropic id and is a reasonable thing to add,
  but this pass does not invent a row on the strength of a report that mis-quoted our own file.
- It called the three Claude 5 ids errors. They are documented legacy-but-still-available, so requests
  were not failing. Moving them was a currency upgrade, not a repair.

### Decisions, id by id

| Row | Reported | Documentation says | Changed |
| --- | --- | --- | --- |
| `gpt-6-astra` | fine | listed, Responses + Chat Completions, text/image in | no |
| `gpt-5.6-sol` | stale | not listed; `gpt-6.1-sol` is, text/image in | renamed `gpt-6.1-sol` |
| `gpt-5.6-terra` | "remove or replace" | not listed. Nearest remaining general id is `gpt-5.6-cyber`, whose own page restricts it to invited, vetted organizations | removed |
| `gpt-5.6-luna` | stale | not listed; `gpt-6-luna` is, text/image in | renamed `gpt-6-luna` |
| `claude-opus-5` | legacy | legacy but accessible; `claude-opus-5-5` active | renamed `claude-opus-5-5` |
| `claude-sonnet-5` | legacy | same | renamed `claude-sonnet-5-5` |
| `claude-fable-5` | "error" | legacy but accessible; `claude-fable-5-1` active | renamed `claude-fable-5-1` |
| `gemini-3.8-flash`, `grok-4.6`, `deepseek-v4-pro`, the three Groq rows, the OpenRouter and Hugging Face rows, `llama3.1:latest` | fine | confirmed against each provider's model list | no |
| `sonar-deep-research`, `sonar-reasoning-pro` | effort mapping | ids are retired as wire values; `/v1/agent` selects depth with `preset` | ids stay as picker labels; the provider no longer sends `model` |

`gpt-5.6-terra` was removed instead of replaced. A catalogue row nobody can call is the failure
`AGENTS.md` already warns about, and `gpt-5.6-cyber` is gated behind a vetting program, so "replace
with a documented model" would have traded a dead id for an unreachable one.

The `vision: true` flags were re-derived from the same pages rather than trusted: all three surviving
OpenAI rows list `Input modalities: text, image`, so they keep the flag. The three Anthropic rows list
text and visual input too, but `vision` was **not** switched on for them. That flag is what routes a
visitor's attachment into a picker, so enabling it is a capability change rather than an error fix, and
it would move the public "models able to read images" number. Recorded as an open item, not silently
applied.

### Why an id rename is not a data edit

Three places compare exact id strings, so a rename that misses one silently changes what goes on the
wire rather than failing loudly:

- `src/lib/providers/anthropic.ts` - `isClaude5` decides both `max_tokens` and whether `thinking` and
  `output_config` are sent. Left alone, the renamed Claude rows would have quietly lost adaptive
  thinking and dropped to the 8192-token budget.
- `src/lib/providers/deepseek.ts` - `deepseek-v4-pro` gets `thinking` plus `reasoning_effort`. That id
  is unchanged, so the branch is unchanged.
- `src/lib/providers/perplexity.ts` - now `PERPLEXITY_PRESETS`, and the failure mode is the mirror
  image: an unmapped row throws instead of quietly answering a research question with the fast preset.

### Perplexity, migrated to the Agent API

`src/lib/providers/perplexity.ts` posts to `https://api.perplexity.ai/v1/agent` and sends the fields
the migration guide maps them to: `preset` for the retired model slug, `input` for `messages`,
`instructions` for the consolidated system text, and `max_output_tokens` for `max_tokens`.
`reasoning_effort` is gone, because presets carry effort now. Text deltas arrive on
`response.output_text.delta`, the same event family the OpenAI Responses provider already parses, so
`pickDelta` matches that type instead of `choices[0].delta.content`. The 120-second streamed-body
timeout and the message-normalization rule both carry over unchanged.

### Consequence worth knowing before testing

A chat that pinned one of the renamed ids resolves to no row, and `selectModel()` in
`src/lib/model-selection.ts` falls back to the first available model rather than erroring. That is the
pre-existing behaviour for any model whose provider key is absent, but after this pass it can also
trigger for a saved preference: a browser that had remembered Claude Sonnet 5 will show the picker on
GPT-6 Astra until the model is chosen again. No request is lost and nothing throws; the choice simply
has to be re-made once.

### Checks executed on the repaired tree

- `tsc --noEmit --incremental false` - exit 0, no output
- `eslint . --max-warnings=0` - exit 0, no output
- `vitest run` - 52 test files, 585 tests passed, 1 skipped (577 before; eight added - six for the
  Agent API request body, event parsing, preset mapping and the unmapped-slug throw, one
  catalogue-driven Anthropic request-shape assertion, and one
  every-Perplexity-row-has-a-preset invariant. The skipped file is
  `src/lib/providers/live-smoke.test.ts`, described below - skipped is its correct state for an
  offline run)
- `next build` - exit 0, 15/15 static pages, no warnings; the catalogue is 17 models across 10
  providers with 6 vision rows and 1 local row, counted from `src/lib/models.ts`
- `npm audit --omit=dev` - 0 vulnerabilities
- `npm audit` - **5 high**, all inside the `eslint-config-next` → `@next/eslint-plugin-next` →
  `fast-glob` → `micromatch` → `braces` dev chain (GHSA-vfj7-8cjw-p6xm, stack-exhaustion DoS). This
  advisory did not exist when the seventh audit recorded zero. `braces@3.0.3` is the newest release,
  so there is no version to move to; `npm audit fix --force` would downgrade `eslint-config-next` to
  14.2.35 while leaving `braces` at the same vulnerable code. It is a dev-only path that lint already
  exercises from a pinned config, so nothing was downgraded to chase a green number.

### The check that answers "is my model talking?"

Everything above is derived from documentation and stubbed `fetch` calls, which is the honest limit:
a green suite proves the request shape and nothing about the account behind the key. So the eighth
pass also adds `src/lib/providers/live-smoke.test.ts`, which calls the live APIs through the same
adapters `/api/chat` uses - one case per catalogued model whose provider has a key - and prints the
seconds taken plus the first 120 characters of the reply. It is gated on `LIVE_PROVIDER_SMOKE=1`
because each case spends money, it loads keys from `.env.local` without ever logging one, and it
throws for a model that connected and returned no text rather than counting that as success.

Run it with the keys in place:

```bash
LIVE_PROVIDER_SMOKE=1 npm test -- src/lib/providers/live-smoke.test.ts
```

Two properties of that file were executed here rather than asserted: without the flag
`vitest run` reports it skipped (1 skipped, 585 passed), and with the flag set but no keys it fails
out loud - "no provider key was found, so zero models were called" - instead of passing an empty
suite. Its third property, an actual answered model, cannot be demonstrated from this machine: there
is no `.env.local` here, only `.env.example`, and outbound provider calls from this workspace are
blocked by policy. The website test or that one command on your own machine settles it.

### What still cannot be certified from here

- No request reached any provider from this environment, so every conclusion above is
  documentation-derived. Whether `/v1/agent` accepts this exact payload from a real key, and whether
  the three renamed Claude ids and the three OpenAI ids answer as their pages promise, is what the
  live check or the website settles.
- `grok-4.6` is current but xAI now recommends `grok-4.7`. Not changed: the report itself marked the
  row fine, and a working id is not an error.
- The Anthropic `vision` flags are the open item described above.
