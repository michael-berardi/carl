import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, htmlToPlain, markdownToTelegramHtml, TELEGRAM_LIMIT } from "../src/channels/format.ts";

test("escapes HTML and converts common markdown", () => {
  assert.equal(markdownToTelegramHtml("a < b & **bold** and *it* and `x<y`"), "a &lt; b &amp; <b>bold</b> and <i>it</i> and <code>x&lt;y</code>");
  assert.equal(markdownToTelegramHtml("# Title"), "<b>Title</b>");
  assert.equal(markdownToTelegramHtml("- one\n- two"), "• one\n• two");
  assert.equal(markdownToTelegramHtml("> quoted"), "<blockquote>quoted</blockquote>");
});

test("keeps link URLs intact and escapes attributes", () => {
  assert.equal(markdownToTelegramHtml("[site](https://a.com/x?y=1&z=\"2\")"), '<a href="https://a.com/x?y=1&amp;z=&quot;2&quot;">site</a>');
});

test("code fences are literal", () => {
  const html = markdownToTelegramHtml("```ts\nconst a = **1** < 2;\n```");
  assert.equal(html, '<pre><code class="language-ts">const a = **1** &lt; 2;</code></pre>');
});

test("snake_case words are not italicised", () => {
  assert.equal(markdownToTelegramHtml("use my_var_name here"), "use my_var_name here");
});

test("chunks stay under the limit and rebalance code fences", () => {
  const md = "intro\n\n```\n" + "line of code\n".repeat(800) + "```\n\noutro";
  const chunks = chunkMarkdown(md);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(markdownToTelegramHtml(c).length <= TELEGRAM_LIMIT, `chunk too long: ${markdownToTelegramHtml(c).length}`);
    assert.equal((c.match(/```/g) ?? []).length % 2, 0, "unbalanced fence");
  }
  assert.ok(chunks.join("\n").includes("outro"));
});

test("long text without breaks still chunks", () => {
  const chunks = chunkMarkdown("x".repeat(10_000));
  assert.ok(chunks.length >= 3);
  assert.equal(chunks.join("").replace(/```/g, "").replace(/\n/g, "").length, 10_000);
});

test("plain fallback strips tags and unescapes", () => {
  assert.equal(htmlToPlain("<b>a &lt; b</b> &amp; c"), "a < b & c");
});
