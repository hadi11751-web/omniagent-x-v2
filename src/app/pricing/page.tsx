import Link from "next/link";
import type { Metadata } from "next";
import { CurrentPlanFlag, PlanCallToAction } from "@/components/PricingPlanControls";
import {
  DECISION_PIPELINE,
  FAQ,
  FREE_PLAN_NAME,
  INCLUDED_ON_BOTH,
  MODE_DETAILS,
  MODEL_SUMMARY,
  OMNI_CAPABILITIES,
  PAID_PLAN_NAME,
  PLAN_ROWS,
  REALTIME_SEARCH,
} from "@/lib/product";
import { formatInterval, formatMoney } from "@/lib/money";
import { readPlanPrice } from "@/lib/server/price";
import { FREE_DAILY_LIMIT, MAX_AGENT_STEPS } from "@/lib/limits";

export const metadata: Metadata = {
  title: "OmniAgent — one AI, everything you need",
  description:
    "What OmniAgent can do, how it decides to search the live web, and what the free and paid plans include.",
};

/*
 * The copy here only changes when a limit or the Stripe price does, so the page
 * is rendered on a schedule instead of per request.
 */
export const revalidate = 3600;

export default async function PricingPage() {
  const price = await readPlanPrice();

  return (
    <main className="mx-auto w-full max-w-6xl px-5 pb-24">
      <Header />
      <Hero />
      <LiveSearch />
      <Capabilities />
      <HowItDecides />
      <Modes />
      <Plans price={price} />
      <Comparison />
      <Faq />
      <Footer />
    </main>
  );
}

function Header() {
  return (
    <header className="flex items-center justify-between gap-3 py-6">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-[var(--accent)] to-[var(--accent2)] text-sm font-bold text-black">
          O
        </span>
        <span className="text-lg font-semibold tracking-tight">OmniAgent</span>
      </div>
      <nav className="flex items-center gap-2 text-sm">
        <a
          href="#capabilities"
          className="hidden rounded-lg px-3 py-1.5 text-[var(--muted)] transition hover:text-[var(--foreground)] sm:block"
        >
          Features
        </a>
        <a
          href="#plans"
          className="hidden rounded-lg px-3 py-1.5 text-[var(--muted)] transition hover:text-[var(--foreground)] sm:block"
        >
          Plans
        </a>
        <Link
          href="/sign-in"
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-[var(--muted)] transition hover:text-[var(--foreground)]"
        >
          Sign in
        </Link>
        <Link
          href="/sign-up"
          className="rounded-lg bg-gradient-to-r from-[var(--accent)] to-[var(--accent2)] px-3 py-1.5 font-medium text-black transition hover:opacity-90"
        >
          Start free
        </Link>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section className="pt-10 pb-14 sm:pt-16">
      <p className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">
        One AI. Everything you need.
      </p>
      <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
        Ask Omni anything.
      </h1>
      <p className="mt-4 max-w-2xl text-[var(--muted)]">
        OmniAgent is one assistant that understands, reasons, researches, codes, sees,
        hears, creates, uses tools, remembers and acts. You do not choose between a
        coding AI, a research AI and an image AI &mdash; you ask Omni, and Omni works out
        what the job needs.
      </p>
      <div className="mt-7 flex flex-wrap gap-3">
        <Link
          href="/sign-up"
          className="rounded-xl bg-gradient-to-r from-[var(--accent)] to-[var(--accent2)] px-5 py-2.5 font-medium text-black transition hover:opacity-90"
        >
          Start free &mdash; {FREE_DAILY_LIMIT} messages a day
        </Link>
        <a
          href="#plans"
          className="rounded-xl border border-[var(--border)] px-5 py-2.5 text-[var(--muted)] transition hover:text-[var(--foreground)]"
        >
          Compare plans
        </a>
      </div>
      <p className="mt-6 text-sm text-[var(--muted)]">
        One model: {MODEL_SUMMARY.name}. It reasons, searches, reads your files
        and images, draws, and remembers &mdash; you never have to choose
        between models.
      </p>
    </section>
  );
}

function LiveSearch() {
  return (
    <section className="mb-16 grid gap-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8 lg:grid-cols-2">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-[var(--accent2)]">
          Real-time intelligence
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">
          {REALTIME_SEARCH.headline}
        </h2>
        <p className="mt-3 text-sm text-[var(--muted)]">
          When an answer depends on what is true right now, Omni searches the live web,
          reads the results and cites them &mdash; without you switching modes. You watch it
          happen: the stream says it is searching, lists the sources it used, and marks
          the search as a tool step.
        </p>
        <div className="mt-5 flex flex-wrap gap-2 text-xs">
          {["news", "prices", "latest versions", "who won", "read this page"].map(
            (example) => (
              <span
                key={example}
                className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[var(--muted)]"
              >
                {example}
              </span>
            ),
          )}
        </div>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Steps</p>
          <ol className="mt-3 space-y-2 text-sm">
            {REALTIME_SEARCH.steps.map((step, index) => (
              <li key={step} className="flex gap-2">
                <span className="text-[var(--accent2)]">{index + 1}</span>
                <span className="text-[var(--muted)]">{step}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="space-y-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
              Searches when you ask about
            </p>
            <ul className="mt-2 space-y-1.5 text-sm text-[var(--muted)]">
              {REALTIME_SEARCH.searchesFor.map((item) => (
                <li key={item}>&bull; {item}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
              Answers straight from knowledge for
            </p>
            <ul className="mt-2 space-y-1.5 text-sm text-[var(--muted)]">
              {REALTIME_SEARCH.skipsFor.map((item) => (
                <li key={item}>&bull; {item}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function Capabilities() {
  return (
    <section id="capabilities" className="mb-16">
      <h2 className="text-2xl font-semibold tracking-tight">What OmniAgent can do</h2>
      <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
        Ten capabilities, one assistant. Everything below is in the product you get
        today &mdash; no waitlist items.
      </p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {OMNI_CAPABILITIES.map((capability) => (
          <article
            key={capability.key}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 transition hover:border-[var(--accent)]/60"
          >
            <h3 className="font-semibold tracking-tight">{capability.title}</h3>
            <p className="mt-1 text-sm text-[var(--accent2)]">{capability.tagline}</p>
            <ul className="mt-3 space-y-1.5 text-sm text-[var(--muted)]">
              {capability.bullets.map((bullet) => (
                <li key={bullet}>&bull; {bullet}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

function HowItDecides() {
  return (
    <section className="mb-16 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8">
      <h2 className="text-2xl font-semibold tracking-tight">
        Omni decides how to solve the problem
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
        You say what you want. A request such as &ldquo;read this PDF, check the claims
        against what is current, put it in a table and give me a PDF&rdquo; becomes a plan,
        then tool calls, then a checked answer &mdash; up to {MAX_AGENT_STEPS} steps per run.
      </p>
      <ol className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {DECISION_PIPELINE.map((step, index) => (
          <li
            key={step}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-sm"
          >
            <span className="text-xs text-[var(--accent2)]">
              {String(index + 1).padStart(2, "0")}
            </span>
            <p className="mt-1 text-[var(--muted)]">{step}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Modes() {
  return (
    <section className="mb-16">
      <h2 className="text-2xl font-semibold tracking-tight">Three ways to ask</h2>
      <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
        One box, three levels of effort. Chat is the default; Research and Agent are for
        larger jobs.
      </p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {MODE_DETAILS.map((mode) => (
          <div
            key={mode.id}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
          >
            <p className="font-medium">{mode.label}</p>
            <p className="mt-1.5 text-sm text-[var(--muted)]">{mode.hint}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Plans({
  price,
}: {
  price: Awaited<ReturnType<typeof readPlanPrice>>;
}) {
  const paidPrice = price
    ? `${formatMoney(price.unitAmount, price.currency)}${formatInterval(price.interval)}`
    : "Shown at checkout";

  // Derived so a non-USD deployment does not show a dollar sign on the free tier.
  const freePrice = formatMoney(0, price?.currency ?? "usd");

  return (
    <section id="plans" className="mb-16">
      <h2 className="text-2xl font-semibold tracking-tight">Plans</h2>
      <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
        The plans differ in how much you can send per day, not in what Omni is able to
        do. Every capability listed above is on both.
      </p>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
          <p className="font-medium">{FREE_PLAN_NAME}</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight">{freePrice}</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {FREE_DAILY_LIMIT} messages a day, every capability.
          </p>
          <ul className="mt-5 space-y-1.5 text-sm text-[var(--muted)]">
            <li>&bull; Live web research with citations</li>
            <li>&bull; Vision input, image generation and PDF export</li>
            <li>&bull; Agent and research modes</li>
            <li>&bull; Memory, voice and private turns</li>
          </ul>
          <CurrentPlanFlag which="free" />
          <PlanCallToAction which="free" />
        </div>

        <div className="relative rounded-2xl border border-[var(--accent)]/60 bg-[var(--surface)] p-6">
          <span className="absolute right-5 top-5 rounded-full bg-gradient-to-r from-[var(--accent)] to-[var(--accent2)] px-2.5 py-1 text-[11px] font-medium text-black">
            No daily ceiling
          </span>
          <p className="font-medium">{PAID_PLAN_NAME}</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight">{paidPrice}</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            No daily message ceiling, same models and tools.
          </p>
          <ul className="mt-5 space-y-1.5 text-sm text-[var(--muted)]">
            <li>&bull; Unlimited messages, so a daily count never ends the conversation</li>
            <li>&bull; Same {MAX_AGENT_STEPS}-step agent runs and tool calls</li>
            <li>&bull; Managed by Stripe; cancel any time from the billing page</li>
          </ul>
          <CurrentPlanFlag which="paid" />
          <PlanCallToAction which="paid" />
          <p className="mt-2 text-center text-xs text-[var(--muted)]">
            Both buttons use this deployment&apos;s existing Stripe setup: the checkout
            session for an upgrade, Stripe&apos;s customer portal to change or cancel.
          </p>
        </div>
      </div>
    </section>
  );
}

function Comparison() {
  return (
    <section className="mb-16">
      <h2 className="text-2xl font-semibold tracking-tight">The limits, exactly</h2>
      <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
        These numbers are read from the same constants the server enforces, so this
        table and the product cannot drift apart.
      </p>
      <div className="mt-5 overflow-x-auto rounded-2xl border border-[var(--border)]">
        <table className="w-full min-w-[34rem] border-collapse text-sm">
          <thead>
            <tr className="bg-[var(--surface)] text-left">
              <th className="px-5 py-3 font-medium text-[var(--muted)]">Limit</th>
              <th className="px-5 py-3 font-medium">{FREE_PLAN_NAME}</th>
              <th className="px-5 py-3 font-medium">{PAID_PLAN_NAME}</th>
            </tr>
          </thead>
          <tbody>
            {PLAN_ROWS.map((row) => (
              <tr key={row.label} className="border-t border-[var(--border)]">
                <td className="px-5 py-3 text-[var(--muted)]">{row.label}</td>
                <td
                  className={`px-5 py-3 ${row.differs ? "text-[var(--muted)]" : "font-medium"}`}
                >
                  {row.free}
                </td>
                <td
                  className={`px-5 py-3 ${
                    row.differs
                      ? "bg-gradient-to-r from-[var(--accent)]/15 to-[var(--accent2)]/15 font-medium"
                      : "text-[var(--muted)]"
                  }`}
                >
                  {row.paid}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <p className="text-sm font-medium">Included on both plans</p>
        <ul className="mt-3 grid gap-1.5 text-sm text-[var(--muted)] sm:grid-cols-2">
          {INCLUDED_ON_BOTH.map((item) => (
            <li key={item}>&bull; {item}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section className="mb-16">
      <h2 className="text-2xl font-semibold tracking-tight">Questions worth asking</h2>
      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        {FAQ.map((item) => (
          <div
            key={item.question}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
          >
            <p className="font-medium">{item.question}</p>
            <p className="mt-2 text-sm text-[var(--muted)]">{item.answer}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-8 text-sm text-[var(--muted)]">
      <p>OmniAgent &mdash; one model, Nexus, and the tools it uses.</p>
      <div className="flex gap-4">
        <Link href="/" className="transition hover:text-[var(--foreground)]">
          Open the app
        </Link>
        <Link href="/sign-in" className="transition hover:text-[var(--foreground)]">
          Sign in
        </Link>
      </div>
    </footer>
  );
}
