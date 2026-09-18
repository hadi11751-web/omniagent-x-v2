# OmniAgent Repair Report

## Baseline
- `npx tsc --noEmit`: PASS (0 errors)
- `npx eslint .`: PASS (0 errors, 0 warnings)
- `npx vitest run`: PASS — 54 tests / 11 files, all green

The project was already in a structurally healthy state — no baseline compile,
lint, or test failures. All problems found below are real defects that static
checks and the existing test suite could not catch on their own (business-logic
correctness, not syntax/type errors), confirmed by reading the actual code, not
assumed from prior reports.

## Problems Found

1. **`src/lib/client/src/lib/providers/src/lib/providers/openai.ts`** — stale,
   multiply-nested duplicate of `src/lib/providers/openai.ts` from a prior
   broken automated file write. Not imported anywhere; dead weight only.
   **Fix:** deleted the malformed directory tree.

2. **`src/lib/src/lib/providers/provider-contract.test.ts`** — a real,
   passing test file, but sitting at a malformed nested path from the same
   class of broken write. **Fix:** moved to the correct
   `src/lib/providers/provider-contract.test.ts`.

3. **`src/lib/providers/openai.ts`** — vision was broken. Images were
   converted to a text marker (`[Attached images: N]`) instead of being sent
   to the model at all. **Fix:** rebuilt `buildInput()` to emit OpenAI's
   documented structured Responses-API input with real `input_image` items.

4. **`src/app/api/chat/route.ts` + `src/lib/client/chatClient.ts` +
   `src/components/OmniAgentApp.tsx`** — the `memoryEnabled` toggle in
   Settings was never sent to the server at all, so:
   - Automatic memory retrieval ran unconditionally regardless of the toggle.
   - Manual memory text relied only on the client omitting it — no
     server-side enforcement.
   - Automatic memory *saving* also ran unconditionally.
   **Fix:** added `memoryEnabled` to the request type end-to-end; server now
   gates both manual and automatic memory behind it; client now also gates
   the automatic-save call.

5. **`src/lib/client/chatClient.ts`** — the NDJSON reader exited on `done`
   without processing a final line lacking a trailing newline, silently
   dropping the last stream event. **Fix:** flush the remaining buffer after
   the loop. Added `chatClient.test.ts` with a real repro (a stream whose
   last chunk has no trailing `\n`) proving the fix.

6. **`src/app/api/chat/route.ts`** — quota was charged immediately after
   basic JSON/shape validation, before model/provider resolution or
   concurrency acquisition — so requests that failed for reasons unrelated
   to the user (missing model, no provider, concurrency limit) still cost
   quota. **Fix:** split `quota.ts` into `peekQuota` (read-only, used to fail
   fast) and the existing `checkAndConsumeQuota` (now called only once
   concurrency is secured, i.e. the request is truly about to run), plus a
   new `refundQuota` used when setup fails after charging but before the
   request actually executes.

## Corrections to prior claims (checked against this actual code, found false)
- "Anthropic vision is broken" — **false**. Read the file directly; it
  correctly builds base64 image content blocks.
- "Server SSE parser has the same final-buffer bug as the client" —
  **false**. `src/lib/http.ts`'s `parseSseDeltas` already flushes its
  trailing buffer after the read loop (with a comment noting this was
  already handled).
- "`saveAutomaticMemory()` requires an `enabled` argument" — **false**, no
  such parameter exists in the real function signature. The real underlying
  issue (the call site had no toggle check at all) is real and is fixed
  above as part of item 4.

## Files Changed
- `src/lib/providers/openai.ts`
- `src/app/api/chat/route.ts`
- `src/lib/client/chatClient.ts`
- `src/components/OmniAgentApp.tsx`
- `src/lib/quota.ts`
- `src/lib/providers/provider-contract.test.ts` (moved)
- `src/lib/client/chatClient.test.ts` (new)
- Removed: `src/lib/client/src/` (entire stale nested tree)

## Tests
Before: 54 passed / 0 failed (11 files)
After: **56 passed / 0 failed (12 files)**

## Typecheck
PASS — 0 errors, before and after.

## Lint
PASS — 0 errors, 0 warnings, before and after.

## Build
Not run — this container does not have network access to the fonts/services
`next build` needs at build time (confirmed unrelated to these code changes;
same limitation encountered earlier in this project's history). Typecheck
covers type-level build correctness; the production build itself should be
verified in your own environment or CI.

## Security Checks
- Confirmed OpenAI/Anthropic API keys are read only from `process.env` on
  the server, never referenced from client code or `NEXT_PUBLIC_*`.
- Confirmed the memory-toggle fix closes a real trust gap: previously the
  server trusted client-side omission alone for the manual-memory field.
- Did not re-verify SSRF/redirect handling, Redis concurrency-lease races,
  or Stripe webhook idempotency in this pass — out of scope for this
  specific repair batch; flagged as open items below rather than assumed
  fine.

## Remaining Issues (genuine, not padded)
- Quota refund only covers failures *before* the stream itself starts
  (setup-phase failures). A failure deep inside an already-started stream
  (e.g. the model provider dies mid-response) is not yet refunded — that
  would require tracking "did we emit any real output yet" through the
  entire streaming body, which is a larger, riskier change than this batch's
  scope.
- Production `next build` was not run in this environment (network
  limitation, not a code issue) — recommend running it once before deploying.
- Redis concurrency-lease race, `fetch_url` SSRF/redirect depth, and Stripe
  webhook idempotency were flagged in earlier conversation turns but are not
  re-verified against this specific zip in this pass.

## Final Status
**NOT CLEAN — remaining issues exist** (the three items above are real,
disclosed, and unresolved in this pass; everything else found was fixed and
verified).
