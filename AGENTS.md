> **Architecture note (read first):** OmniAgent now has exactly ONE model, Nexus
> (`src/lib/nexus.ts`). Anything below that mentions model routing, provider failover,
> Blend mode, `router.ts`, `model-selection.ts`, `src/lib/providers/`, `boundaryPool` or a
> model picker describes the removed multi-model design. See `NEXUS_AUDIT_REPORT.md` and
> `README.md`. Do not reintroduce a second model; `src/lib/single-model.test.ts` guards it.

# Working rules for this repository

Read this before changing anything. It is the working agreement used on this codebase:
how to verify, what not to touch, and how to report back. Follow it even when the task
looks small.

## What this project is

OmniAgent X v2 — a Next.js 15 (App Router) + React 19 + TypeScript + Tailwind 4 AI
assistant. One public product surface (`/pricing`), one auth-gated chat app, and a
server-side tool/agent runtime. Providers (OpenAI, Anthropic, Gemini, xAI, DeepSeek,
Perplexity, Groq, OpenRouter, Hugging Face, Ollama) are infrastructure behind a router;
the product identity is a single assistant called Omni.

Stack facts worth knowing up front:

- Auth: Clerk. Billing: Stripe (one subscription price). Storage/quota: Upstash Redis.
- There is no separate backend. The Next.js server is the only place API keys are read.
- Chat streams NDJSON events from `/api/chat` (`meta`, `status`, `delta`, `tool`,
  `sources`, `image`, `file`, `error`).
- Tests are Vitest, run in a `node` environment. No React Testing Library, no jsdom.

## Non-negotiables

1. **Do not redesign billing.** `/api/stripe/checkout` and `/api/stripe/webhook` create a
   subscription for `STRIPE_PRICE_ID` and flip `publicMetadata.plan`. Preserve that
   behaviour. New read-only surfaces (for example a customer-portal link on the pricing
   page) are fine; a new pricing model, plan enum, or database is not.
   The webhook reads the subscription's **current** status from Stripe instead of trusting
   the status inside the event. Dedupe in `src/lib/server/billing-events.ts` is a **claim**,
   not a check: `claimEvent()` is one atomic `SET NX EX` lease taken before any work,
   `markEventHandled()` lengthens it only after the write succeeded, and
   `releaseEventClaim()` hands it back when the handler failed so Stripe's retry counts as
   new work. A "have I seen this?" read followed by a separate record lets two concurrent
   copies of one delivery both answer "no" - do not split them again. Both exist because
   Stripe replays old events: a week-old `checkout.session.completed` re-delivered after a
   cancellation must not re-grant paid. Keep that shape - an unconditional grant, a
   payload-trusted status, or a claim taken after the work can fail are all regressions.
   Plan writes go through `reconcilePlan` in `src/lib/server/billing-plan.ts`, never a
   single subscription's status: Stripe creates a customer per checkout session, so
   cancelling one subscription must not downgrade an account another one is still billing.
   Reconciliation can only keep access on, never grant it, and a sibling customer's
   subscription counts only when its `metadata.clerkUserId` names the same account. It
   pages through Stripe lists to the end, and its return type includes `undefined` for
   "this account could not be read to the end" - which the route turns into a 502 rather
   than a plan write. Answering `free` from a partial list is the failure this function
   exists to prevent, so `undefined` must not be collapsed into `"free"` anywhere.
2. **No invented claims.** Product copy may describe behaviour that exists in this tree.
   "Coming soon", "roadmap", fake limits and fake model support are defects. If a
   capability isn't shipped, say what it does instead.
3. **Never commit or echo secrets.** No keys in source, fixtures, docs or logs.
   `.env.local` stays local.
4. **Finish the job.** No half-wired features, no commented-out code, no placeholder
   exports, no TODO left where a fix was possible.
5. **Report honestly.** Run the checks, then state what passed, what you could not
   verify and why. Do not claim a check ran when it did not.

## Verify before claiming anything

```powershell
Remove-Item tsconfig.tsbuildinfo -ErrorAction SilentlyContinue
npx tsc --noEmit --incremental false   # tsconfig has incremental: true; a stale cache reports clean without reading the code
npx eslint . --max-warnings=0          # warnings fail, so an unused import is a build break
npx vitest run                         # every test file, not a filtered subset
npx next build                         # .next/types/** route validators are in tsconfig include and only exist after a build
npm audit --omit=dev                   # dependency advisories; the four checks above cannot see them
```

All five, every time, at the end of a change set. `tsc` alone is not "no errors".

When verifying an **extracted copy** of the tree whose `node_modules` is a junction into
another install, invoke the binaries through `./node_modules/.bin/` instead of `npx`. With
the junction not resolving, `npx tsc` ran a decoy package from the registry, `npx eslint`
and `npx vitest` died on `ERR_MODULE_NOT_FOUND`, and `npx next build` announced it was
going to install `next@16.3.6` — a two-major jump that would have "verified" the tree
against a Next that is not in `package.json`. A missing dependency must fail loudly; it
must never be quietly downloaded. Confirm the real install afterwards (`ls node_modules |
wc -l`, `node -e "console.log(require('next/package.json').version)"`) — `npx` writes to
its own cache, not the project, but check rather than assume.

- A version pinned in `package.json` can be years behind and still compile, lint, pass every
  test and build cleanly. That is exactly how `next` 15.5.23 shipped with two unauthenticated
  RCE advisories (`<15.5.24`) that the whole chain above reported green. `npm audit` is not
  optional, and `npm ls <pkg>` plus the registry `dist-tags` are how you confirm a fix is real
  rather than assumed.
- `.npmrc` carries `legacy-peer-deps=true`, and it is **not** a leftover to tidy away.
  `@clerk/nextjs@7.8.0` peers `react: ~19.1.4` or newer while this project pins `react` and
  `react-dom` at exactly `19.1.0`, so `npm ci` without the flag stops with `ERESOLVE`. Treat removing
  it as a React bump plus a full re-verification, never as cleanup.
- `package.json` carries `overrides` for `postcss`, `sharp` and `brace-expansion`. Next 15.5
  pins a vulnerable `postcss@8.4.31` and pulls `sharp@^0.34`, both flagged; the overrides hold
  them at the patched releases inside Next's own declared ranges. `brace-expansion` is
  dev-only tooling (two copies, under `minimatch@3` and `minimatch@10`), so its overrides are
  **nested per parent major** — a single top-level `brace-expansion` override would force 5.x
  consumers onto 1.x and break eslint's globbing. Do not remove any override to "clean up" the
  manifest, and re-run the build after any Next bump to confirm the Tailwind pipeline still
  emits styles.

- A typecheck against hand-written stub types proves nothing about the real `@clerk/nextjs`,
  `stripe` or `@upstash/redis` signatures. Typecheck against installed dependencies.
- If a test fails, find the root cause. Do not weaken the assertion, delete the test, or
  mock the thing under test until it passes.
- Anything needing live credentials is **unverified**, and must be listed as such: real
  provider responses, Clerk session behaviour, Stripe webhook signature checks, Upstash
  quota/concurrency. Without `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`,
  `next start` errors on every route (a fabricated publishable key alone 500s; adding a
  fabricated secret key then fails `initPublishableKeyValues`), so a browser check of the
  signed-in app is impossible — say so rather than implying you looked.

## What a local integration pass can actually cover

The line above is not "nothing runs locally". Public routes are reachable once the Clerk
middleware is temporarily replaced with a pass-through, and that is enough to exercise the
billing path end to end:

- `/api/stripe/webhook` is public by design, so real HMAC signatures, the dedupe record and
  the 400/503 branches all run over HTTP with no Clerk session. Sign bodies with the same
  scheme Stripe uses (`t=<unix>,v1=hmac_sha256(secret, "t.body")`).
- `/pricing` and `/api/status` answer too, which is what confirms the prerendered page and
  the provider inventory in served HTML rather than in a test fixture.
- `src/lib/quota.ts` and `src/lib/concurrency.ts` sit behind `auth()`, so no request reaches
  them. Drive the installed `@upstash/redis` client directly with the same commands those
  modules send (`incr`/`expire`/`get`/`decr`, and the two Lua scripts through `eval`) to
  confirm the client-side contract without a live index.
- Routes that call `auth()` under the bypass fail with `Clerk: auth() was called but Clerk
  can't detect usage of clerkMiddleware()`. That 500 is an artifact of the bypass, never a
  product defect — read the server's own log before concluding anything about it.
- Restore `src/middleware.ts` byte-identically afterwards (record its md5 before editing),
  then delete `.next` and rebuild, because the running build was compiled from the bypassed
  tree. Never write a `.env.local` for this; pass placeholders in the command environment.

`@upstash/redis` 1.38.2 parses the **raw** protocol: `Command.exec` destructures
`{result, error}` from the response body, and `/pipeline` returns an array of those. An
older `{status, data}` envelope in a stand-in makes every read resolve `undefined`, which
looks exactly like a broken dedupe while the harness is at fault. Confirm a suspected
product bug by checking the response shape the installed client expects before changing
application code.

## When handed a zip back from another model

The tree comes back with different fixes each round, in both directions: one model keeps
something the other dropped. So:

```bash
diff -rq --exclude=node_modules --exclude=.next --exclude=next-env.d.ts THEIRS MINE
```

Then read every differing file's diff and **port changes into the target tree file by
file**. Never wholesale-copy a file from the other lineage — that is how a fixed
`AbortSignal` pass-through or a `deriveTitle` slice fix silently reverts. Prefer editing
in place; copy only files that exist on one side.

Note what each side uniquely keeps before you start, and confirm afterwards that both
sets survive.

A returned report is a list of claims, not evidence, and its own numbers are part of what to
check: a pass has described a hand-rolled script that parsed files as if `tsc` had run, has
listed "runtime checks" no command in the repository reproduces, has miscounted the tree it
delivered, and has shipped an `eslint . --max-warnings=0` failure in the code it added while
saying the gates could not be run here. Run the gates first and read the report afterwards.

## Keep the product and the page from drifting

- Every enforced ceiling lives in `src/lib/limits.ts`. Enforcing code imports it; it does
  not keep a local copy of the number. Public copy in `src/lib/product.ts` is built from
  those same constants, and model/provider counts come from `src/lib/models.ts` and
  `src/lib/providers`.
- `src/lib/money.ts` + `src/lib/server/price.ts` render the price from `STRIPE_PRICE_ID`
  rather than a typed-in figure, and return `null` when billing is unconfigured so the
  page can say "Shown at checkout".
- `src/app/pricing/page.tsx` stays a server component. Per-visitor state (current plan) is
  rendered by the client component in `src/components/PricingPlanControls.tsx` so the
  route keeps prerendering; reading Clerk's session in the page body would make it
  dynamic. Inside that component, `useUser()` reports `isLoaded: false` during
  prerendering: render the signed-out markup until a `mounted` flag flips, so the server
  HTML and the first client paint match and the buttons exist without JavaScript. A
  skeleton-for-everything-first branch puts no call to action in the static output at all
  — check `.next/server/app/pricing.html` after changing this file.
- `[n]` markers are checked against the sources that were actually returned by
  `src/lib/citations.ts`, which numbers them the way the source list in
  `src/components/MessageList.tsx` renders them (array order, starting at 1). If you change
  either numbering, change the other; a marker with no source behind it must not render.
- When you change a limit, mode, tool or provider, update `README.md` and
  `OMNIAGENT_REPAIR_AUDIT.md` in the same change set.
- A test must never dictate the catalogue. `MODELS` rows flow into public copy, so an
  assertion like "every provider has at least one model" is a marketing number made
  load-bearing - and it gets satisfied by inventing a row rather than by fixing anything.
  `src/lib/models.test.ts` holds the invariants instead: ids unique, each id resolving back
  to the row that declares it, each row naming a provider with a registered adapter.
- `vision: true` on a `MODELS` row is what lets an image attachment route to that picker. Set
  it from something that proves the endpoint accepts images. The error is asymmetric: a wrong
  flag sends the visitor's picture to a model that rejects the request, while no flag only
  withholds a capability that picker may not have had. The same page that proves the id usually
  states the input modalities, so read both while you are there.
- A catalogue `id` is not data. Three places compare the exact string and pick a different
  request for it: `isClaude5` in `anthropic.ts` (`max_tokens`, `thinking`, `output_config`),
  the `deepseek-v4-pro` branch in `deepseek.ts`, and `PERPLEXITY_PRESETS` in `perplexity.ts`.
  Renaming a row without moving its branch changes what goes on the wire and fails no test, so
  the Anthropic assertion in `anthropic.test.ts` walks the catalogue rather than a hard-coded id
  list, and `models.test.ts` requires every Perplexity row to have a preset.
- Retired is not the same as legacy, and a model list cannot tell them apart. Anthropic documents
  the unsuffixed Claude 5 ids as legacy but still callable, so renaming them was currency, not a
  repair; Perplexity retired the whole Sonar chat-completions surface on 2026-09-27, so both Sonar
  rows failed on every request while their slugs still appeared in docs. When a provider is in
  question, read its changelog and migration page for endpoint and field renames
  (`preset` for `model`, `input` for `messages`, `max_output_tokens` for `max_tokens`) - the
  transport dies more loudly than the id does.
- Do not change what goes on the wire to a provider because of guidance nobody has cited.
  `src/lib/providers/anthropic.ts` grew a branch omitting `thinking` for one Claude 5 model
  while still sending that same model `output_config`, no test covered either shape, and the
  stated reason had no source. Uncited and untested is not a fix; revert to what the suite
  passes against. Citing the Messages API schema *is* the fix - it confirms `thinking.type`
  accepts `"adaptive"` and `output_config.effort` accepts `"high"`, which is what the file sends.
- Renaming or dropping a row moves two things nobody tests for: the derived `/pricing` sentence
  (`product.ts` counts the catalogue, so it currently reads 17 models across 10 providers with 6
  vision rows), and any browser that pinned the old id - `selectModel()` falls back to the first
  available model instead of erroring, so the picker silently changes provider. Say both out loud
  in `OMNIAGENT_REPAIR_AUDIT.md`.
- Copy has to say what the code does **for each plan**, not just that a number exists.
  `checkDailyCap` and `checkAndConsumeQuota` return before counting for a paid account, so
  the message, memory-save and transcription ceilings are free-plan only: their
  `PLAN_ROWS` rows read `Unlimited` on the paid side and carry `differs: true`. A row that
  repeats the free number for both plans is a limit the page invents.
- `MAX_REQUEST_SECONDS` in `src/lib/limits.ts` duplicates the literal
  `export const maxDuration = 120` in `src/app/api/chat/route.ts`, which `product.test.ts`
  reads out of the route source. Next only honours a literal there, so keep both in step and
  do not turn the route's value into an import to "fix" the duplication.
- One run reads the plan **once**. `getPlan()` is a Clerk API call, so `beginRun()` resolves
  it in `chargeForRun()` and hands the answer to `checkDailyCap()`, `checkAndConsumeQuota()`
  and `endRun()`'s refunds through the optional `plan` parameter — a route that calls a
  counter without it pays for another lookup on the hot path and on the failure path.
- "Daily" rolls over at `USAGE_DAY_OFFSET_MINUTES` (default `0`, so UTC) rather than a
  hard-coded UTC midnight: a deployment whose users are at UTC+5 names that offset and the
  allowance turns over at their midnight. It shifts every counter's key when changed, so it
  is operator config, not something to schedule per user.
- Billing reads the account's email through `src/lib/server/billingEmail.ts`, never
  `emailAddresses[0]` — that is Clerk's storage order and can be a discarded or unverified
  address. Nothing verified returns `undefined`, and checkout then omits `customer_email` so
  Stripe asks for it. `/api/stripe/checkout` also answers 409 when
  `publicMetadata.plan === "paid"`: this app records no Stripe objects of its own, so a
  second session is a second subscription on the same card, and paid users go to the portal.
- Nothing may claim the visitor's own device. Local models are served by the Ollama
  `OLLAMA_BASE_URL` points at, which is the server's machine on a hosted deployment; say
  "this deployment's own Ollama", never "your own machine". `REALTIME_SEARCH.searchesFor`
  is held to `classify()` by `src/lib/router.test.ts`, so a promised line has to be a
  question the router actually reads as research.

## Code style actually used here

- Edit existing files instead of adding new ones. Small modules only where there is a real
  second consumer.
- Comments explain *why* (a constraint, a regression, a non-obvious invariant), usually one
  short block above the code. No comments restating what the next line does, no
  multi-paragraph docstrings.
- Don't add error handling for states that cannot occur; validate at boundaries (request
  bodies, URLs, provider payloads, third-party APIs) and trust internal calls.
- No backwards-compatibility shims, re-exports "just in case", or renamed leftovers of code
  you deleted. If something is unused, delete it.
- Match the file's existing dialect: named exports, `for...of` over index loops, early
  `return` guards, `Record<string, unknown>` payloads narrowed with explicit checks.
- Styling is Tailwind utilities over the CSS variables in `src/app/globals.css`
  (`--surface`, `--border`, `--muted`, `--accent`, `--accent2`). Reuse them; don't add a
  parallel design system.
- Security is a feature here: keep `fetch_url`'s private-address and redirect-hop checks,
  keep the shunting-yard calculator (never `eval`), keep request body caps, and never pass
  user input to a shell. `src/lib/tools/pinnedFetch.ts` is the only transport `fetch_url`
  may use: it resolves once, refuses any private record in the answer, and hands **those
  same records** to `node:http`/`node:https` as the request's own `lookup`, with
  `agent: false`. A separate check-then-`fetch()` is the regression to avoid — a short-TTL
  name can answer public on the check and private on the socket, and a pooled socket from
  an earlier resolution ignores the lookup entirely.
- That private-address test is a list of *forms*, not one prefix. Alongside the obvious
  loopback/private/link-local ones it covers the IPv4 reserved documentation and
  anycast blocks (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `192.88.99.0/24`),
  IPv6 site-local `fec0::/10`, `2001:db8::/32`, and the addresses embedded in `::ffff:`
  (mapped), `64:ff9b:` (NAT64), `2002:` (6to4) and `2001:0::/32` (Teredo) forms — each
  unwrapped and re-tested, because `2002:7f00:1::` is `127.0.0.1` wearing a public prefix.
  New literals go in `src/lib/tools/pinnedFetch.test.ts`; the flag list there is the spec.
- A source is only a link if its scheme is http(s). `src/lib/sources.ts` filters search
  results on the server and `MessageList.tsx` renders anything else as plain text, because
  a search API can hand back a `javascript:` or `data:` URI and `href={source.url}` turns
  that into a click handler written by whoever wrote the page. Render rather than drop the
  row: the `[n]` markers in `src/lib/citations.ts` are numbered against the same list.
- Model-written markdown goes through the same rule, in `src/components/Markdown.tsx`:
  `SAFE_LINK` decides what is an anchor (http(s), mailto, tel) and everything else becomes
  its text. A remote `![](https://…)` is rendered as a link, **not loaded** — the browser
  must not be able to fetch a URL a model invented, because the request would carry this
  reader's IP, timing and session to whoever wrote the answer. `data:image/…;base64,` and
  `blob:` still render, since those are the app's own attachments and cannot phone anyone.
- HTML entity decoding runs in one pass with `&amp;` **last**. Decoding it first turns
  `&amp;lt;` into `<`, which is a second decode step the page never asked for.
- A model's reasoning block never reaches the reader: `stripThinking()` in
  `src/lib/tools/index.ts` is what every end-of-turn flush and history write passes the
  buffer through, including the short-answer and aborted-stream fallbacks that used to
  send the raw buffer. One unclosed block drops the rest of the buffer.
- `await request.json()` is `unknown`, whatever the route casts it to, and `null`, `[]` and
  a number in a string slot are all valid JSON. Routes answer that shape with a 400 through
  `bodyAsRecord()` and `optionalText()` in `src/lib/server/guards.ts` rather than reaching a
  `.trim()` or a `.role` and throwing a 500.
- A tool that spends minutes and money upstream takes the turn's `AbortSignal`:
  `ToolDefinition.run(input, signal?)`, with `request.signal` passed at every call site in
  `route.ts` and `agent.ts`. `generate_image` is the case that matters — its own two-minute
  timeout was longer than the request's `maxDuration`, so an abandoned turn kept paying the
  `GEMINI_API_KEY` account.
- Abuse limits must stay bounded when Upstash is missing. `quota.ts` and `concurrency.ts`
  each fall back to an in-process counter — per-instance, weaker than Redis, but never
  "unlimited". Returning `allowed: true` for an unconfigured deployment is the failure mode
  that silently removes the daily cap, so keep the fallback counted. `.env.example` said
  "fails open (unlimited)" long after the code stopped doing that. A fallback counter also
  has to *recover*: the Redis concurrency key carries a TTL, so the in-process slots each
  carry the same expiry — three requests that threw before reaching their `release()` used
  to hold three slots and lock the account out of every model route until the process
  restarted.
- A slot is taken before any counter is charged, so everything between `acquireConcurrency()`
  and the run's own `try/finally` has to hand it back on the way out: `beginRun()` wraps its
  charge in a `try` and releases on the throw, `/api/chat` does the same in `holdChatRun()`.
  Clerk and Upstash are both network calls with no fallback of their own.
- The concurrency slot TTL is refreshed on **every** acquire, not only the first. A chat
  request can run for `maxDuration` seconds, so a key whose expiry was stamped once could
  lapse mid-stream and let one user exceed `MAX_CONCURRENT_PER_USER`. The TTL itself is
  `MAX_REQUEST_SECONDS + 30`, imported rather than typed: a slot that expires *while* its
  request is still streaming stops counting that request, so a user holding four long chats
  open pays for three. The extra 30 seconds are the price of an abandoned slot lingering —
  do not tune it back down to `maxDuration` exactly.
- `requestJson()`'s timeout is attached with `AbortSignal.timeout()` and combined with the
  caller's signal, so it covers **the whole streamed body**, not just the wait for headers.
  That is what a provider's `timeoutMs` means: the longest answer it can deliver. Every
  streaming provider therefore passes `MAX_REQUEST_SECONDS` (120 000), matching
  `/api/chat`'s `maxDuration`; a provider left on the 60-second default cuts a long answer
  off mid-sentence, and `src/lib/providers/stream-timeout.test.ts` is the guard.
- `pinnedFetch()` holds the same position for `fetch_url`: its timer is cleared when the
  response body closes, not when headers arrive, because the function hands back a `Response`
  whose body has not started yet and a server that sends headers then stalls would otherwise
  be held open forever. The consequence belongs to the caller: `FETCH_TIMEOUT_MS` in
  `src/lib/tools/fetchUrl.ts` is an **end-to-end** allowance for headers plus up to
  `MAX_RESPONSE_BYTES`, so treat changing it as retuning how long a slow page may take to
  arrive, not as a connect timeout.
- A route that spends money upstream goes through `src/lib/server/guards.ts` — it does not
  call `acquireConcurrency()` or `checkAndConsumeQuota()` itself. `/api/chat` predates the
  helper and holds both inline around its stream; every other route (`/api/image`,
  `/api/transcribe`, `/api/memory`) uses `beginRun()` / `endRun()`, and a new one that skips
  the gate is a free provider bill for any signed-in account.
- Which of those runs also charges quota is a decision, not a default: `/api/image` charges
  (a billed image is a message of its own), transcription and memory extraction do **not**,
  because the chat message they feed into or came out of already paid — charging them too
  would bill one voice message twice and quietly halve the allowance `/pricing` prints.
- A route that spends money but bills no message takes a `dailyCap` scope from
  `quota.ts` instead of borrowing the message allowance. Adding a scope is a
  three-place change: `DAILY_CAPS`, `CAP_NOUNS`, and a row in `PLAN_ROWS` so the page
  states the ceiling it enforces.
- `src/lib/privacy.ts` holds the request-scoped boundary. It is computed once, in
  `selectModel()`, and every later step that could move the request between providers
  takes the policy as an argument: `rankFailoverCandidates()`, `availableTools()`,
  `findTool()`, `runAgentPlan()`, `runBlend()`, `blendParticipants()`, the vision switch and
  `/api/memory`. A new path that picks a provider without checking it is the regression
  this whole file was written to prevent. Never re-derive the boundary from the
  transcript — the chat route threads the classification it made from the human text.
  `/api/memory` is not handed a policy, so it classifies the transcript it was sent
  instead: a caller's `localOnly: false` may not talk the extractor into a cloud model
  over text that reads as private.
- Anything a local model cannot serve is refused in the stream (an image under
  `localOnly`, research with no local model) rather than silently upgraded to a cloud
  provider. Downgrading quietly is how "private" becomes a label instead of a behaviour.
- The Tools switch means *no tool runs for this message*, and research mode reaches the
  live web through one: `web_search`. So `toolsEnabled: false` stops research mode's
  search too, in `searchFirst`, and the stream says why instead of the answer just
  arriving without sources. A mode cannot switch back on what the message switched off.
  Buffering is what enforces the switch elsewhere (`held = allowTools`), so a `TOOL:`
  line the model wrote as text streams out as text and is never parsed — that path was
  reported as a hole and could not be reproduced.
- The boundary has two gates and they are not interchangeable. `policy.localOnly`
  governs who may **answer** (`rankFailoverCandidates()`, `withinBoundary()`, blend
  participants); `policy.requested` governs the steps that are **not the answer** —
  `availableTools()`/`findTool()` for the external tools, the speculative live search,
  and `/api/chat`'s direct-image branch. Gating the extras on `localOnly` was the bug:
  a prompt that reads as private with no local model configured reports
  `unmet: true, localOnly: false`, so "generate an image of my confidential logo"
  sailed past the guard and forwarded the prompt to Gemini anyway. `unmet` is not a
  licence to widen the blast radius — the reply having to leave says nothing about
  what else may.
- `boundaryPool()` is the collapse of that rule into one list, and it is what every
  choice of *a different model for this turn* draws from: blend's participants and the
  vision switch. `withinBoundary()` alone only speaks for a pinned local model, so a
  turn that merely read as private could be moved to a second cloud provider — to fan a
  blend out, or to find a model that could see an attachment. Under
  `requested && !localOnly` the pool collapses to the provider already answering.
  Provider failover is deliberately not in that pool: a sequential retry after a failed
  request still sends the text to one provider at a time, whereas picking a *new*
  recipient up front is a different decision and needs its own reasoning.
- Tool, search and fetched-page output goes to the model through
  `evidenceTurn()` / `attachEvidence()` — a `user` turn labelled as data, merged into the
  human turn in progress. `system` turns are reserved for instructions this server wrote
  itself, and Anthropic hoists them into `body.system`, so an untrusted page's text in one
  of those reads as an instruction from us.
- `private` is the first entry in `router.ts`'s `PATTERNS` on purpose. A private request
  that also reads as coding or research must stay private, so do not "tidy" that list into
  capability order. Its test is a list of whole phrases (`PRIVATE`), not the bare word: a
  rule that fires on `private` alone reads "why does my private method throw" as a privacy
  claim and sends a coding question to a local model with the tools taken off. Keep any
  added rule phrase-shaped for the same reason — the word appearing in someone's code is
  not the user asking for privacy.
- Memory is one switch with two halves, and both must answer to it: the notes the user
  wrote, and the facts the server remembered on its own. `/api/chat` reads either only
  when the request says `memoryEnabled: true`, so a turn that does not say is a turn that
  gets neither half. Turning the switch off stops extraction *and* retrieval; if you add a
  place that injects stored text, gate it on that flag, not on the field being present.
- Auto-routing is the default, but a pinned local model is never routed away from
  (`model-selection.ts`). Cloud pins stay routable — the difference is privacy versus
  preference.
- Every size ceiling a route checks is imported from `src/lib/limits.ts`. A number restated
  inside `conversations.ts` or a chat route is a number that will disagree with the page.
  Image ceilings are measured in two units at once — the server counts base64 characters,
  the browser measures file bytes — so `MAX_IMAGE_BYTES` and `MAX_MESSAGE_IMAGE_BYTES` are
  *derived* from `MAX_IMAGE_DATA_CHARS` and `MAX_REQUEST_IMAGE_DATA_CHARS` by the base64
  4-chars-per-3-bytes rule, and `test/image-limits.test.ts` expands them to prove the
  advertised byte ceiling never produces a data URL the character ceiling refuses. A
  hand-typed MB number there is the bug that let the browser accept an 8 MB file the server
  answered 400 to. `isImageDataUrl()` is the one format test both routes share, and the
  picker's `accept` is built from the same `IMAGE_FORMATS` list.
- A body-size ceiling is enforced on the bytes, never on `content-length`. That header is
  a claim the client makes, and a request sent with `Transfer-Encoding: chunked` carries
  no useful one, so `oversizedBody()` is only an early exit for honest callers; every
  route reads through `readCappedBody()` (which stops reading and cancels the reader at
  the ceiling) and then `decodeJsonBody()`, because `request.json()`/`formData()` would
  have buffered the whole upload before any limit ran. The union results are narrowed with
  `if ("tooLarge" in incoming)`, which is also the file's existing `{ run } | { rejection }`
  style. A size refusal answers 413 from every route, body-shape refusals 400.
- Those caps are ours and are not the whole story: a hosting platform enforces a body
  ceiling of its own that is usually smaller, and whichever is smaller is what the visitor
  hits. Do not treat `MAX_CONVERSATION_BODY_BYTES` as a promise that a 20 MB upload works in
  production, and do not raise a cap without checking the deployment target. `GET
  /api/conversations` is deliberately still a single unpaginated `MAX_CONVERSATIONS`-row
  response — adding pagination is a wider change (server, client merge, tombstones) than the
  audit finding that asked about it, so it is documented rather than half-done.
- `blendParticipants()` is where blend mode learns the boundary. A private turn gets one
  provider — the one already answering — because asking a second cloud provider is a second
  upload whether or not the reply comes from it, and the synthesis failover is gated on
  `policy.requested` so a private blend cannot move sideways to a provider it never asked.
- A conversation the visitor deleted is remembered in `omniagent.deleted-conversations.v1`
  until the server confirms the delete. `reconcileConversations()` in
  `src/lib/client/storage.ts` drops tombstoned rows on both sides, so a delete that failed
  while the history service was down cannot come back as restored history or be re-uploaded
  by the next keystroke. Do not answer "did the delete happen?" with the local list alone.
  The list is capped at `MAX_PENDING_DELETIONS` (= `2 * MAX_CONVERSATIONS`: the rows the
  server returns plus the local rows merged beside them), and past that cap `saveDeletions()`
  sets `omniagent.conversations.wipe-pending.v1` instead of dropping ids — trimming with
  `slice(-MAX_CONVERSATIONS)` was how an unrecorded delete came back as restored history. A
  load that finds that flag clears the account's server history in one request and only then
  forgets the flag, so a failed clear retries at the next load. That is honest only because
  this app keeps one workspace per browser: a delete-all already means the account's whole
  server history.
- A tombstone is only finished when no save for that row is in flight. `saveInFlightRef` in
  `OmniAgentApp.tsx` counts the debounced saves per conversation id: `deleteOnServer()` leaves
  the id recorded while the count is above zero, and the save's `finally` re-issues the delete
  once it reaches zero. Clearing the tombstone on the first successful DELETE is the bug — a
  PUT that was already on the wire lands *after* it and quietly re-creates the conversation.
  The same rule holds for Delete-all, which is why that path prunes per id instead of calling
  `clearDeletions()`.
- A row the two sides disagree on resolves by **recency, not by side**.
  `reconcileConversations()` takes whichever copy carries the newer `conversationStamp` (a tie
  goes to the one holding more messages) and returns `needsUpload` — the ids where the browser
  is the one holding the truth, whether or not the server has that row at all — which the app
  hands to the same debounced save as any other dirty conversation. Do not "simplify" that back
  to server-wins: saving is debounced, so a tab closed a second after a reply leaves its newest
  turns only in `localStorage`, and taking the older server row dropped them.
- `conversationStamp()` reads the **message timeline first** and only then `updatedAt`, and
  `mergeSavedConversation()` compares timelines rather than the response object, because
  `saveConversation()` stamps `updatedAt: Date.now()` on the server. A row that was saved a
  second ago therefore carries a newer `updatedAt` than the turns the visitor added since it
  was read, and any rule that trusts that field first makes the older snapshot win.
- A save may **never shrink** a conversation: `shouldReplaceStoredConversation()` refuses a
  shorter snapshot and `saveConversation()` answers with what it already held, so a late
  request from an old tab cannot erase turns a newer tab wrote. It accepts a same-length
  snapshot whose newest message keeps its id even when its text, `sources`, `images`, `files`
  or `error` arrived afterwards — that is the same writer finishing a run — but keeps the
  stored row when the identical timestamp carries a *different* message id, because that is two
  writers. Do not "fix" the refusal so a shorter copy is accepted as a deletion: the tab that
  deleted a turn and the tab that never received it send byte-identical prefixes, so
  accepting one would let a stale tab delete another device's newest answer for the whole
  account. Regenerate is safe without it because the run re-grows the turn it trimmed before
  the debounced save fires.
- Every one of those `localStorage` names is suffixed with the signed-in Clerk user id, and
  `setStorageScope(user?.id ?? null)` in `OmniAgentApp.tsx` runs **before** any read. As bare
  constants the keys were one shared bucket per browser, so signing out and back in as a
  second account opened the first one's chats, projects, settings and owed deletes. A
  visitor with no session keeps the unkeyed names (that data has no account to belong to),
  and the first real sign-in *moves* those rows into its own space — copying them to each
  account is the same leak in a new shape. Writes before Clerk has settled are dropped, so
  nothing can be saved to the wrong account while `useUser()` is still loading.
- The other half of that guard: every persistence effect in `OmniAgentApp.tsx` compares
  `hydratedAccountId` against `accountId` and skips a mismatch. The flag is only ever
  assigned at the **end** of the scope effect, and that is what makes it work - the sibling
  effects run from the same commit while still holding the previous account's
  `conversations`/`settings`/`projects`, so they see the mismatch and do nothing. Assigning
  `undefined` at the *start* of that same effect is dead code: React batches, no render
  happens in between. A comment once described that no-op as marking a "hydration boundary"
  and thereby invented a mechanism; keep it deleted.
- A `useRef` that exists to notice an account change after an `await` is written from an
  effect, never during render (`accountIdRef`). A render can run more than once, and one of
  those runs may be discarded; writing to anything outside the component from that body is
  the impurity React's rules are about. The comparisons still work because every reader
  resumes on a later task than the effect.
- Any retry added to a client loop needs a bound. The history-load retry stops after
  `HISTORY_EXTRA_ATTEMPTS` follow-ups, and the reason is the failure mode rather than the
  number: an unbounded 5-second retry in an open tab is one request every five seconds per
  visitor, for the life of the tab, against a history service that may be down for the day.
  Recovering from a transient outage is the goal; a self-inflicted flood is not.

## Test conventions

- File sits next to the code as `*.test.ts`; `@/` resolves to `src/`.
- Mock Stripe's default export with `vi.fn(function () { ... })`, **not** an arrow — the
  code under test calls `new Stripe(key)` and an arrow is not constructible.
- Reach for `vi.hoisted()` for fakes referenced inside a `vi.mock` factory, `vi.stubEnv`
  plus `vi.unstubAllEnvs()` for key handling, `vi.stubGlobal("fetch", ...)` plus
  `vi.unstubAllGlobals()` for HTTP.
- Guard the copy: `src/lib/product.test.ts` fails if marketing text starts claiming
  unshipped behaviour or if plan numbers stop matching `src/lib/limits.ts`. Keep it red
  if you take a shortcut.
- A fix without a regression test is not finished, and the test must fail against the old
  behaviour.
- A green `vitest run` still prints stack traces, and that is expected, not a failure to chase.
  `src/app/api/memory/route.test.ts` deliberately makes extraction throw
  (`memory_extraction_failed Error: timeout`) and makes Redis refuse
  (`memory_delete_failed Error: redis is unreachable`) because the branches under test are the ones
  that release a slot, refund a charge and answer 502 instead of a bare failure. Read the `Test Files`
  / `Tests` lines for the verdict; a stderr block above them belongs to a passing test.
- Route handlers are testable without a server: `vi.mock("@clerk/nextjs/server", …)` for the
  session, mock `@/lib/concurrency` + `@/lib/quota` so the real gate runs against fakes, then
  call the imported `POST` with `new Request(url, { method: "POST", headers, body })` and set
  `content-length` by hand (undici does not add it). See `src/app/api/*/route.test.ts`.
- Keep those route assertions on the paths that return *before* the provider call. A `/api/chat`
  test that passes every validation streams from the real provider — that is a network call in
  the suite, not a unit test.
- The one sanctioned network call lives in `src/lib/providers/live-smoke.test.ts`, because "is this
  model actually talking?" is not answerable from a stubbed `fetch`: a green suite proves the request
  shape and nothing about the account behind the key. It runs the real adapters `/api/chat` uses, and
  it stays inert unless `LIVE_PROVIDER_SMOKE=1`, so an ordinary `vitest run` reports it skipped and
  must keep doing that - every case spends money. It logs only the reply excerpt, never a key, and it
  fails for a model that connected and returned no text instead of calling that a pass. Do not pull
  any of its cases into the default suite.
- Build a `Request` with an explicit `content-length` header when testing a size refusal;
  asserting on the parsed-body check alone proves nothing about the pre-parse guard. That
  header only proves the early exit, though: also test the ceiling with a streamed body —
  `new Request(url, { body: new ReadableStream({ pull }), duplex: "half" })` — and assert
  `headers.get("content-length")` is `null` first, or the case silently tests the header
  path again. Size fixtures are sized from the same `limits.ts` constant the route reads,
  never from a number restated in the test.

## Windows notes (this machine is Windows with Git Bash)

- Reuse the installed dependencies instead of re-running `npm ci`
  (`cmd //c mklink /J` can create a junction at a mangled path; use
  `powershell New-Item -ItemType Junction` with absolute paths).
- Delete a junction with `cmd //c rmdir "<path>\node_modules"`. Never `rm -rf` a junction:
  it walks into and destroys the real target directory.
- Build deliverable zips with `/c/Windows/System32/tar.exe -a -cf out.zip <dir>` (bsdtar).
  Plain `tar` in Git Bash is GNU tar: it accepts `-a -cf out.zip` and silently writes an
  *uncompressed tar* named `.zip`, which Windows and the user's tools cannot open. Check the
  first four bytes are `50 4b 03 04` before trusting an archive. PowerShell's
  `Compress-Archive` writes backslash entry separators that other tools mishandle.
- Never run `npm install` while a junctioned `node_modules` is in place: npm deletes the
  link, creates a real directory, and can leave a partial package tree behind. Install in the
  directory that owns the real `node_modules`, then junction the copy you want to verify.
- After packaging: re-extract the artifact to a clean directory, junction the dependencies
  back in, and run the full five-check chain against the extracted copy. Confirm byte size,
  entry count and md5. Then remove the junctions.
- `cmd //c` eats quoted arguments; put a whole command in one single-quoted argument or use
  PowerShell for anything with paths and spaces.

## Report format

End with: what changed (files, one line each), what the four checks returned, and an
explicit "cannot verify here" list with reasons. Once the user accepts a result, stop —
do not re-run the same chain to make the same point again. If asked "are there errors?",
answer with fresh output, then stop at the confirmed/uncertain split above.
