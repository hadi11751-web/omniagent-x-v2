# OmniAgent

Multi-provider AI chat agent: streaming chat UI, server-side tools (web search, URL
fetch, calculator, text analysis, image generation), research mode with sources,
blend mode, a controlled agent mode, and an abstraction for local/on-device models.

Built with Next.js 15 (App Router), React 19, TypeScript and Tailwind CSS 4.
Only two runtime dependencies were added on top of the framework
(`react-markdown`, `remark-gfm`); every provider call uses `fetch`.

## Quick start (Windows PowerShell)

```powershell
git clone https://github.com/musharib11701-afk/omniagent-x-v2.git
cd omniagent-x-v2
npm install
Copy-Item .env.example .env.local
notepad .env.local     # paste at least one API key
npm run dev            # http://localhost:3000
```

macOS/Linux is the same with `cp .env.example .env.local`.

Production run:

```powershell
npm run build
npm run start
```

There is no separate backend server: the Next.js server *is* the backend, and it is
the only place API keys are read.

## Configuration

All keys live in `.env.local` (git-ignored). At least one chat provider key is
required; everything else is optional and degrades gracefully.

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Groq chat models (fastest option, free tier) |
| `GEMINI_API_KEY` | Google Gemini chat models |
| `OPENROUTER_API_KEY` | OpenRouter chat models |
| `HUGGINGFACE_API_KEY` | Hugging Face chat models **and** image generation |
| `OLLAMA_BASE_URL` | Local Ollama server, e.g. `http://127.0.0.1:11434` |
| `TAVILY_API_KEY` / `BRAVE_API_KEY` | Better web search; without them a keyless DuckDuckGo fallback is used |

`GET /api/status` reports which providers, models and tools are actually usable; the
UI hides anything unconfigured, and the model picker marks each model as
Cloud (`☁`) or Local (`🔒`).

## Modes

| Mode | Behaviour |
| --- | --- |
| Chat | Normal streaming chat; the model may call a tool when it helps |
| Research | Runs a web search first, then answers citing the returned sources |
| Agent | Planner picks up to 3 tool steps, runs them, then answers |
| Blend | Asks up to 3 configured providers and synthesises one answer |

Automatic routing (Settings) classifies the prompt (fast / coding / reasoning /
research / private) and picks a matching configured model.

## Tools

`web_search`, `fetch_url`, `calculator`, `analyze_text`, `generate_image`
(the last one only when `HUGGINGFACE_API_KEY` is set). Tools run server-side and
are invoked through a single-line text protocol (`TOOL: name | argument`), so any
chat model works, not only ones with native function calling. A failing tool
returns an error string to the model instead of crashing the request.

Safety: `calculator` uses a shunting-yard parser (never `eval`), `fetch_url`
refuses non-HTTP(S) URLs plus loopback/private address ranges, and no user input
is ever passed to a shell.

## Privacy

- API keys are read only in server code; nothing is exposed via `NEXT_PUBLIC_*`.
- Conversations, projects and memory live in the browser's `localStorage`; they can
  be deleted per chat or all at once in Settings.
- Long-term memory is opt-in and editable/clearable.
- Prompts are sent to whichever provider you select. Only models labelled Local
  (Ollama) stay on your machine — the UI never claims local processing for a cloud
  request.

## Project layout

```
src/app/page.tsx            entry page
src/app/api/chat/route.ts   streaming chat: modes, tool loop, NDJSON events
src/app/api/status/route.ts capability discovery (no secrets)
src/app/api/image/route.ts  direct image generation
src/lib/providers/          provider abstraction (OpenAI-compatible + Gemini)
src/lib/tools/              tool implementations and registry
src/lib/router.ts           task -> model routing
src/components/             chat UI (sidebar, message list, composer, settings)
```

## Checks

```powershell
npm run build
npm run typecheck
npm run lint
```

## Deploying

The app is a standard Next.js server app; Vercel is the shortest path
(`npx vercel`), and the same environment variables must be set in the host's
dashboard. Any Node 20+ host works with `npm run build && npm run start`.
