// Markdown -> Telegram HTML, and chunking under Telegram's 4096-character message limit.
// Telegram HTML supports only: b, i, u, s, code, pre, a, blockquote, tg-spoiler. Everything else is escaped.

export const TELEGRAM_LIMIT = 4096;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

// Inline spans: code first (its content is literal), then links, bold, italic, strike.
function inline(text: string): string {
  const parts: string[] = [];
  const codeRe = /`([^`\n]+)`/g;
  let last = 0;
  for (const m of text.matchAll(codeRe)) {
    parts.push(spans(text.slice(last, m.index)));
    parts.push(`<code>${escapeHtml(m[1])}</code>`);
    last = m.index! + m[0].length;
  }
  parts.push(spans(text.slice(last)));
  return parts.join("");
}

function spans(raw: string): string {
  // Pull links out before escaping so their URLs survive intact.
  const links: string[] = [];
  let text = raw.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => {
    links.push(`<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  text = escapeHtml(text)
    .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, "<b>$1</b>")
    .replace(/__(?=\S)([^_\n]+?)__/g, "<b>$1</b>")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)\*(?!\w)/g, "$1<i>$2</i>")
    .replace(/(^|[^\w])_(?=\S)([^_\n]+?)_(?!\w)/g, "$1<i>$2</i>")
    .replace(/~~(?=\S)([^~\n]+?)~~/g, "<s>$1</s>");
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)]);
}

/** Convert common Markdown to Telegram HTML. Unknown syntax degrades to escaped text, never to broken tags. */
export function markdownToTelegramHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of text)
      const lang = fence[1] ? ` class="language-${escapeAttr(fence[1])}"` : "";
      out.push(`<pre><code${lang}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) { out.push(`<b>${inline(heading[1])}</b>`); i++; continue; }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${quote.map(inline).join("\n")}</blockquote>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("──────"); i++; continue; }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) { out.push(`${bullet[1]}• ${inline(bullet[2])}`); i++; continue; }
    out.push(inline(line));
    i++;
  }
  return out.join("\n");
}

/**
 * Split Markdown into pieces that each render under `limit` characters of Telegram HTML.
 * Splits at paragraph, then line, then word boundaries; a code fence cut in two is closed and reopened.
 */
export function chunkMarkdown(md: string, limit = TELEGRAM_LIMIT - 96): string[] {
  const fits = (s: string) => markdownToTelegramHtml(s).length <= limit;
  if (fits(md)) return [md];
  const chunks: string[] = [];
  let rest = md;
  while (rest.length > 0) {
    if (fits(rest)) { chunks.push(rest); break; }
    let cut = largestFittingPrefix(rest, fits);
    let head = rest.slice(0, cut);
    let tail = rest.slice(cut).replace(/^\n+/, "");
    const openFence = openFenceLang(head);
    if (openFence !== null) {
      head += "\n```";
      tail = "```" + openFence + "\n" + tail;
    }
    chunks.push(head.trimEnd());
    if (tail.length >= rest.length) { chunks.push(tail); break; } // cannot shrink; avoid an infinite loop
    rest = tail;
  }
  return chunks.filter((c) => c.trim().length > 0);
}

function largestFittingPrefix(text: string, fits: (s: string) => boolean): number {
  // Binary search the longest raw prefix that fits, then back off to a natural boundary.
  let lo = 1, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(text.slice(0, mid) + "\n```")) lo = mid; else hi = mid - 1;
  }
  const window = text.slice(0, lo);
  for (const sep of ["\n\n", "\n", " "]) {
    const at = window.lastIndexOf(sep);
    if (at > lo * 0.5) return at + sep.length;
  }
  return Math.max(lo, 1);
}

function openFenceLang(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (!m) continue;
    open = open === null ? m[1] : null;
  }
  return open;
}

/** Plain-text fallback when Telegram rejects our HTML: strip tags, unescape entities. */
export function htmlToPlain(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** Make invisible and direction-changing characters visible (approval cards must show exactly what runs). */
export function visibleControls(text: string): string {
  // Every control, format, separator, odd space and default-ignorable character, except newline, tab and space.
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Default_Ignorable_Code_Point}]/gu, (c) =>
    c === "\n" || c === "\t" || c === " " ? c : `\\u{${c.codePointAt(0)!.toString(16)}}`);
}
