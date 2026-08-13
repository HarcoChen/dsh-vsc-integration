"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
    MAX_COPIED_CODE_BYTES,
    isCopyableCode,
    parseSafeHttpUrl,
    renderMarkdownMessage,
    renderSafeMarkdown,
} = require("../dist/safeMarkdown.js");

test("safe Markdown supports the shared message subset with fixed markup", () => {
    const rendered = renderMarkdownMessage([
        "# Title",
        "",
        "Paragraph with **bold**, *emphasis*, `a < b`, and [docs](https://example.com/a?q=1&x=2).",
        "",
        "- first",
        "- second",
        "",
        "> quoted `text`",
        "",
        "```ts",
        "const tag = '<script>';",
        "```",
    ].join("\n"));
    assert.match(rendered.html, /^<h1>Title<\/h1>/);
    assert.match(rendered.html, /<strong>bold<\/strong>/);
    assert.match(rendered.html, /<em>emphasis<\/em>/);
    assert.match(rendered.html, /<code>a &lt; b<\/code>/);
    assert.match(rendered.html, /data-external-url="https:\/\/example\.com\/a\?q=1&amp;x=2"/);
    assert.match(rendered.html, /<ul><li>first<\/li><li>second<\/li><\/ul>/);
    assert.match(rendered.html, /<blockquote><p>quoted <code>text<\/code><\/p><\/blockquote>/);
    assert.match(rendered.html, /data-copy-code-id="code-0"/);
    assert.match(rendered.html, /const tag = &#39;&lt;script&gt;&#39;;/);
    assert.deepEqual(rendered.codeBlocks, [{ id: "code-0", text: "const tag = '<script>';" }]);
});

test("raw HTML, event handlers, and malicious link attribute payloads remain inert", () => {
    const html = renderSafeMarkdown([
        '<img src=x onerror="alert(1)">',
        '[bad](https://example.com/" onmouseover="alert(1))',
        '[html](javascript:alert(1))',
        '[command](command:dsh.stop)',
        '[file](file:///etc/passwd)',
        '[data](data:text/html,<script>alert(1)</script>)',
    ].join("\n"));
    assert.doesNotMatch(html, /<img|<script|data-external-url=|href=/iu);
    assert.doesNotMatch(html, /javascript:|command:|file:|data:text/iu);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.doesNotMatch(html, /href=/u, "renderer never creates navigable browser anchors");
    assert.doesNotMatch(html, /data-external-url=/u, "malicious URLs degrade to label text");
});

test("URL parser allows only explicit credential-free HTTP(S) URLs", () => {
    assert.equal(parseSafeHttpUrl("https://example.com/a b"), undefined);
    assert.equal(parseSafeHttpUrl("http://example.com/path"), "http://example.com/path");
    assert.equal(parseSafeHttpUrl("HTTPS://EXAMPLE.COM/x"), "https://example.com/x");
    assert.equal(parseSafeHttpUrl("https://user:pass@example.com/"), undefined);
    assert.equal(parseSafeHttpUrl("//example.com"), undefined);
    assert.equal(parseSafeHttpUrl("javascript:alert(1)"), undefined);
    assert.equal(parseSafeHttpUrl("command:dsh.stop"), undefined);
    assert.equal(parseSafeHttpUrl("file:///tmp/a"), undefined);
    assert.equal(parseSafeHttpUrl("https://example.com/\nnext"), undefined);
});

test("fenced code is escaped, retained exactly for host copy, and size bounded by UTF-8 bytes", () => {
    const code = "<button data-x='1'>\n& done";
    const rendered = renderMarkdownMessage(`~~~html\n${code}\n~~~`);
    assert.match(rendered.html, /&lt;button data-x=&#39;1&#39;&gt;/);
    assert.deepEqual(rendered.codeBlocks, [{ id: "code-0", text: code }]);

    assert.equal(isCopyableCode("a".repeat(MAX_COPIED_CODE_BYTES)), true);
    assert.equal(isCopyableCode("a".repeat(MAX_COPIED_CODE_BYTES + 1)), false);
    assert.equal(isCopyableCode("你".repeat(Math.floor(MAX_COPIED_CODE_BYTES / 3))), true);
    assert.equal(isCopyableCode("你".repeat(Math.floor(MAX_COPIED_CODE_BYTES / 3) + 1)), false);

    const oversized = renderMarkdownMessage(`\`\`\`\n${"x".repeat(MAX_COPIED_CODE_BYTES + 1)}\n\`\`\``);
    assert.equal(oversized.codeBlocks.length, 0);
    assert.doesNotMatch(oversized.html, /data-copy-code-id=/u);
    assert.match(oversized.html, /disabled/);
});
