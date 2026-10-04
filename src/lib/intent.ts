/**
 * What a message is asking for. This is NOT model routing - there is only one
 * model. It decides two tool-side questions: does the message ask to be kept
 * private (so external tools stay off), and does it read as time-sensitive (so
 * a live search runs before Nexus answers).
 */
export type Intent = "fast" | "coding" | "reasoning" | "research" | "image" | "private";


/*
 * Privacy has to be claimed, not guessed from a single word. A bare
 * `\bprivate\b|\boffline\b` also matched "why does my private method throw in
 * TypeScript", "make my PWA work offline" and "do not send me marketing
 * emails" - and each of those false positives switched tools and live search
 * off, moved the question to the deployment's local model and told the memory
 * extractor to skip the chat. So every rule below needs the privacy word next
 * to something that is being kept, or a sentence that says keep it.
 *
 * The words this deliberately does not treat as private are programming
 * vocabulary: method, function, field, property, variable, class, member.
 */
const PRIVATE: RegExp[] = [
  /\b(?:private|confidential|sensitive)\s+(?:data|details|information|info|notes?|records?|documents?|files?|chats?|conversations?|messages?|business|customer|clients?|patients?|salary|payroll|figures?|project|code|text|content|issue|issues|matter|matters)\b/i,
  /\b(?:keep|kept|make|made|treat|stays?|stay)\s+(?:this|that|it|these|those|them|my)\s+(?:private|confidential|local|offline)\b/i,
  /\b(?:this|that|it|these|those)\s+is\s+(?:private|confidential)\b/i,
  /(?:^|[.!?;:])\s*(?:private|confidential)\s*[:,]\s*/i,
  /\b(?:do\s+not|don't|dont|never)\s+(?:send|share|upload|transmit|forward|give)\b[^.!?]{0,32}\b(?:to|anyone|anywhere|the\s+(?:cloud|internet|third[- ]party))\b/i,
  /\b(?:local(?:ly)?|on[- ]device)\s+only\b|\bon\s+my\s+(?:own\s+)?(?:machine|device|computer|laptop)\s+only\b|\b(?:offline|local)\s+(?:model|assistant|run|routing)\b/i,
];

const PATTERNS: { capability: Intent; test: (prompt: string) => boolean }[] = [
  /*
   * First, and unmatched by anything after it. A private request that also
   * reads as coding or research used to classify as those instead, which is the
   * wrong way round: the capability that costs the user something to get wrong
   * has to win. Privacy is several phrasings rather than one word, which is why
   * this entry tests a list.
   */
  { capability: "private", test: (prompt) => PRIVATE.some((rule) => rule.test(prompt)) },
  { capability: "image", test: (prompt) => /\b(draw|generate an image|image of|picture of|illustrate|logo)\b/i.test(prompt) },
  { capability: "coding", test: (prompt) => /\b(code|function|bug|typescript|python|regex|refactor|stack ?trace|compile)\b/i.test(prompt) },
  /*
   * The wording the pricing page promises live search for, not just the verbs:
   * a question about a price, a version number or yesterday's score reads as
   * time-sensitive to the person asking it, and used to be answered from the
   * model's own memory.
   */
  {
    capability: "research",
    test: (prompt) =>
      /\b(search|latest|news|breaking|recent|who ?won|winner|current|today|tonight|yesterday|this (?:week|month|year)|sources?|cite|price|prices|pricing|costs?|version|versions|release|releases|released|score|scores|standings|election|polls|stock)\b/i.test(
        prompt,
      ),
  },
  { capability: "reasoning", test: (prompt) => /\b(why|prove|analy[sz]e|step by step|explain in depth|compare|strategy)\b/i.test(prompt) },
];

/** Classifies a prompt into the intent that best matches it. */
export function classify(prompt: string): Intent {
  for (const { capability, test } of PATTERNS) {
    if (test(prompt)) return capability;
  }
  return "fast";
}
