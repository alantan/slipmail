// Plain text to a minimal HTML alternative for drafts. The input may be steered by untrusted email, so
// the output is built only from fixed tags and escaped text: no links, images, scripts, or style sheets.

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

// Blank line between blocks, as mail clients emit it.
const SPACER = "<div><br></div>";
const QUOTE_STYLE = "margin:0;padding-left:1em;border-left:2px solid #ccc";

/**
 * Splits one line on `**` pairs. Each pair around non-empty text is a bold segment, matched left to right
 * with no nesting. An unmatched `**` and an empty `****` stay literal. Runs in linear time.
 */
function boldSegments(line: string): Array<{ text: string; bold: boolean }> {
  const parts = line.split("**");
  const out: Array<{ text: string; bold: boolean }> = [];
  let lit = parts[0];
  let i = 1;
  while (i < parts.length) {
    // parts[i] follows an opening "**"; it is bold only if a closing "**" follows and it is non-empty.
    if (i + 1 < parts.length && parts[i] !== "") {
      if (lit) out.push({ text: lit, bold: false });
      out.push({ text: parts[i], bold: true });
      lit = parts[i + 1];
      i += 2;
    } else {
      lit += "**" + parts[i];
      i++;
    }
  }
  if (lit) out.push({ text: lit, bold: false });
  return out;
}

/** The line as the plain-text part shows it: bold markers removed. */
export function stripBold(line: string): string {
  return boldSegments(line).map((s) => s.text).join("");
}

/** One line: leading spaces (tabs count as four) become &nbsp;, the rest is escaped, **x** becomes bold. */
function renderLine(line: string): string {
  const lead = /^[ \t]*/.exec(line)![0];
  const nbsp = lead.replace(/\t/g, "    ").replace(/ /g, "&nbsp;");
  const rest = boldSegments(line.slice(lead.length)).map((s) =>
    s.bold ? `<strong>${escapeHtml(s.text)}</strong>` : escapeHtml(s.text)
  ).join("");
  return nbsp + rest;
}

// Quote nesting beyond this is rendered as plain escaped text: bounds recursion and blockquote depth.
const MAX_QUOTE_DEPTH = 20;

function renderBlocks(lines: string[], depth = 0): string {
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur);

  // Empty rendered blocks (a bare quote marker) are dropped so no stray spacer is emitted.
  return blocks.map((block) => {
    if (depth < MAX_QUOTE_DEPTH && block.every((l) => l.startsWith(">"))) {
      // Drop one ">" and one optional space per line, then handle the inner text the same way.
      const inner = renderBlocks(block.map((l) => l.slice(1).replace(/^ /, "")), depth + 1);
      return inner && `<blockquote style="${QUOTE_STYLE}">${inner}</blockquote>`;
    }
    return `<div>${block.map(renderLine).join("<br>")}</div>`;
  }).filter((html) => html !== "").join(SPACER);
}

export function textToHtml(text: string): string {
  const body = renderBlocks(text.split(/\r\n|\r|\n/));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}
