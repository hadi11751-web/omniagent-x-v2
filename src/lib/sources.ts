import type { Source } from "@/lib/types";

/**
 * Which source URLs are usable.
 *
 * A source list is rendered as `<a href>`, so an answer whose "link" is
 * `javascript:` or `data:` is a link the reader can click into their own page.
 * Search providers and scraped HTML hand back strings this app did not write, so
 * the check has to sit where those strings become sources, and again where they
 * become an href: a row saved before the filter existed is still in somebody's
 * browser history.
 */

/** An absolute http(s) URL, which is the only thing a browser may be sent to. */
export function isFollowableUrl(value: string): boolean {
  try {
    const url = new URL(value);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }

    if (url.username || url.password) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/** The sources a reader can actually be linked to, in the order they arrived. */
export function followableSources(sources: Source[]): Source[] {
  return sources.filter((source) => isFollowableUrl(source.url));
}
