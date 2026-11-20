import type React from "react";
import type { LabelLookup } from "./playConstants";

/** `[tag]` citation tokens in a rendered paragraph. */
const CITATION = /\[([^[\]\s]+)\]/g;
/** `@[handle]` mention tokens in typed action text. */
const MENTION = /@\[([^[\]\s]+)\]/g;

function splitBy(
  text: string,
  pattern: RegExp,
  renderToken: (inner: string, key: string) => React.ReactNode
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = new RegExp(pattern.source, "g");
  let last = 0;
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    out.push(renderToken(match[1], `t${match.index}`));
    last = match.index + match[0].length;
    match = re.exec(text);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A paragraph whose `[tag]` tokens render as small grey chips (with the
 *  tag's label when one is known). */
export function TaggedText({
  text,
  labelOf,
}: {
  text: string;
  labelOf: LabelLookup;
}) {
  return (
    <>
      {splitBy(text, CITATION, (tag, key) => (
        <span
          key={key}
          title={tag}
          className="inline-block mx-0.5 px-1.5 py-0 rounded bg-gray-200 text-gray-600 text-xs align-baseline"
        >
          {labelOf(tag) ?? tag}
        </span>
      ))}
    </>
  );
}

/** Action text with `@[handle]` shown as `@label`. */
export function MentionPreview({
  text,
  labelOf,
}: {
  text: string;
  labelOf: LabelLookup;
}) {
  return (
    <>
      {splitBy(text, MENTION, (handle, key) => (
        <span key={key} className="text-blue-700 font-medium">
          @{labelOf(handle) ?? handle}
        </span>
      ))}
    </>
  );
}
