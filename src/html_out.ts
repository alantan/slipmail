// Plain text to a minimal HTML alternative for drafts. The input may be steered by untrusted email, so
// the output is built only from fixed tags and escaped text: no links, images, scripts, or style sheets.

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

const P_STYLE = "margin:0 0 1em 0";
const QUOTE_STYLE = "margin:0 0 1em 0;padding-left:1em;border-left:2px solid #ccc";

/** One line: leading spaces (tabs count as four) become &nbsp;, the rest is escaped. */
function renderLine(line: string): string {
  const lead = /^[ \t]*/.exec(line)![0];
  const nbsp = lead.replace(/\t/g, "    ").replace(/ /g, "&nbsp;");
  return nbsp + escapeHtml(line.slice(lead.length));
}

function renderBlocks(lines: string[]): string {
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

  return blocks.map((block) => {
    if (block.every((l) => l.startsWith(">"))) {
      // Drop one ">" and one optional space per line, then handle the inner text the same way.
      const inner = block.map((l) => l.slice(1).replace(/^ /, ""));
      return `<blockquote style="${QUOTE_STYLE}">${renderBlocks(inner)}</blockquote>`;
    }
    return `<p style="${P_STYLE}">${block.map(renderLine).join("<br>")}</p>`;
  }).join("");
}

export function textToHtml(text: string): string {
  const body = renderBlocks(text.split(/\r\n|\r|\n/));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}
