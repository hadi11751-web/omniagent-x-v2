import type { Source } from "@/lib/types";

/**
 * Research answers are told to cite with `[n]` markers numbered against the
 * sources that were attached to the turn, and the source list the user sees is
 * numbered in that same order. A model can still write `[9]` when three results
 * came back, or cite in a plain chat that never searched at all, and the reader
 * cannot tell the difference. This resolves each marker against the sources that
 * were actually returned, so a marker with nothing behind it never renders as if
 * it were one.
 *
 * It only ever removes text; nothing here decides what the model said.
 */

/** More than this in one group is prose, not a citation list. */
const MAX_GROUP_SIZE = 8;

/** The widest plausible group, so a long bracket run is not a citation. */
const MAX_GROUP_CHARS = 40;

export interface CitationAudit {
  /** Safe to render: every marker with no matching source is gone. */
  text: string;
  /** Markers that matched a returned source, in the order they appeared. */
  verified: number[];
  /** Numbers the answer cited that the returned sources do not contain. */
  unresolved: number[];
}

interface Marker {
  numbers: number[];
  /** A `[1-3]` group stays written as a range when it is confirmed. */
  range: boolean;
  /** Index just past the closing bracket. */
  end: number;
}

const SINGLE = /^\d{1,3}$/;
const LIST = /^\d{1,3}(?:[,\s]+\d{1,3})+$/;
const RANGE = /^\d{1,3}-\d{1,3}$/;

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

/** True for the bracket run right before `start`, as in `[1][2]`. */
function previousRunIsMarker(segment: string, start: number): boolean {
  let open = start - 1;

  while (open > 0 && segment[open] !== "[") open -= 1;

  if (segment[open] !== "[") return false;

  const inner = segment.slice(open + 1, start - 1);

  return SINGLE.test(inner) || LIST.test(inner) || RANGE.test(inner);
}

/**
 * Reads a `[n]`, `[n, m]` or `[n-m]` group at `start`, which is known to hold
 * `[`. Returns null when the run is something else that merely starts with a
 * bracket, so markdown links, images and reference definitions are left alone.
 */
function readMarker(segment: string, start: number): Marker | null {
  const before = segment[start - 1];

  if (before === "!") return null;

  // `[text][1]` is a reference link; `[1][2]` is a chain of citations.
  if (before === "]" && !previousRunIsMarker(segment, start)) return null;

  let index = start + 1;
  let inner = "";

  while (index < segment.length && segment[index] !== "]") {
    const char = segment[index];

    if (!isDigit(char) && char !== "," && char !== " " && char !== "-") return null;

    inner += char;
    index += 1;

    if (inner.length > MAX_GROUP_CHARS) return null;
  }

  if (segment[index] !== "]") return null;

  index += 1;

  const after = segment[index];

  // `[1](url)` and `[1]: url` are markdown link syntax, not a bare marker.
  if (after === "(" || after === ":") return null;

  const range = RANGE.test(inner);
  const isGroup = SINGLE.test(inner) || LIST.test(inner);

  if (!range && !isGroup) return null;

  const numbers = inner
    .split(/[^0-9]+/)
    .filter((piece) => piece.length > 0)
    .map(Number);

  if (numbers.length === 0 || numbers.length > MAX_GROUP_SIZE) return null;

  return { numbers, range, end: index };
}

function rewrite(
  segment: string,
  sourceCount: number,
  verified: number[],
  unresolved: number[],
): string {
  let out = "";
  let cursor = 0;

  while (cursor < segment.length) {
    const start = segment.indexOf("[", cursor);

    if (start === -1) {
      out += segment.slice(cursor);
      break;
    }

    out += segment.slice(cursor, start);

    const marker = readMarker(segment, start);

    if (!marker) {
      out += "[";
      cursor = start + 1;
      continue;
    }

    const kept: number[] = [];

    for (const number of marker.numbers) {
      if (number >= 1 && number <= sourceCount) {
        kept.push(number);
        verified.push(number);
      } else {
        unresolved.push(number);
      }
    }

    if (kept.length === marker.numbers.length) {
      out += segment.slice(start, marker.end);
      cursor = marker.end;
    } else if (kept.length > 0 && !marker.range) {
      /*
       * A list can lose one number and stay honest. A range cannot: "[1-9]"
       * trimmed to "[1]" would claim the middle results too, so an unconfirmed
       * range goes.
       */
      out += `[${kept.join(", ")}]`;
      cursor = marker.end;
    } else {
      const trimmed = out.replace(/(\S)[ ]+$/, "$1");

      if (trimmed === out) {
        /*
         * Nothing but indentation stood in front of the marker, so the space
         * behind it goes instead — otherwise the line keeps a doubled gap.
         */
        let next = marker.end;

        while (segment[next] === " ") next += 1;

        cursor = next;
      } else {
        cursor = marker.end;
      }

      out = trimmed;
    }
  }

  return out;
}

/**
 * Splits the answer into what the model wrote as prose and what it wrote as
 * code. A `[1]` inside a fenced block or an inline span is a snippet, not a
 * citation, so those parts are passed through untouched.
 */
function proseParts(text: string): Array<{ code: boolean; part: string }> {
  const parts: Array<{ code: boolean; part: string }> = [];
  let inFence = false;
  const lines = text.split("\n");

  lines.forEach((line, lineNumber) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      parts.push({ code: true, part: line });
    } else if (inFence) {
      parts.push({ code: true, part: line });
    } else {
      // Every fourth piece of a backtick split sits outside a code span.
      line.split(/(`+)/).forEach((piece, index) => {
        if (piece) parts.push({ code: index % 4 !== 0, part: piece });
      });
    }

    if (lineNumber < lines.length - 1) parts.push({ code: false, part: "\n" });
  });

  return parts;
}

export function auditCitations(text: string, sources: Source[]): CitationAudit {
  const verified: number[] = [];
  const unresolved: number[] = [];
  const count = sources.length;

  if (!text.includes("[")) {
    return { text, verified, unresolved };
  }

  let out = "";

  for (const { code, part } of proseParts(text)) {
    out += code ? part : rewrite(part, count, verified, unresolved);
  }

  return { text: out, verified, unresolved };
}
