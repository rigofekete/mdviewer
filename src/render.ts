import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";
import type { Rgba, TerminalColors } from "@zenbu-labs/pixel";

export interface RenderedDoc {
  html: string;
  title: string;
  lines: number;
  words: number;
  headings: { depth: number; text: string; id: string }[];
}

type Color = [number, number, number];

function toRgb(value: Rgba | null | undefined): Color | null {
  if (!value) return null;
  const [r, g, b] = value;
  return [r, g, b];
}

function css([r, g, b]: Color, alpha = 1): string {
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function luminance([r, g, b]: Color): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function mix(a: Color, b: Color, amount: number): Color {
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount),
  ];
}

function contrastOn(bg: Color): Color {
  return luminance(bg) > 0.45 ? [12, 14, 18] : [248, 250, 252];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type Token = MarkdownIt.Token;

function inlineText(token: Token | undefined): string {
  if (!token) return "";
  if (!token.children?.length) return token.content;
  return token.children
    .map((child) => {
      if (child.type === "text" || child.type === "code_inline") return child.content;
      if (child.type === "softbreak" || child.type === "hardbreak") return " ";
      return inlineText(child);
    })
    .join("");
}

/** GitHub-flavoured heading slug, so the repo's own TOC anchors keep working. */
function slugify(text: string, seen: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  sh: "bash",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
};

function highlight(code: string, lang: string | undefined): string {
  if (!lang) return escapeHtml(code);
  const name = LANG_ALIASES[lang] ?? lang;
  if (!hljs.getLanguage(name)) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function themeCss(colors: TerminalColors): string {
  const bg = toRgb(colors.background) ?? [24, 24, 27];
  const fg = toRgb(colors.foreground) ?? [228, 228, 231];
  const dark = luminance(bg) < 0.4;
  const palette = colors.palette ?? [];
  const accent = toRgb(palette[4]) ?? toRgb(palette[6]) ?? (dark ? [125, 170, 255] : [30, 90, 200]);
  const accentAlt = toRgb(palette[6]) ?? toRgb(palette[5]) ?? accent;
  const border = mix(bg, fg, dark ? 0.14 : 0.12);
  const surface = mix(bg, fg, dark ? 0.05 : 0.035);
  const surfaceAlt = mix(bg, fg, dark ? 0.09 : 0.06);

  return `
  --bg: ${css(bg)};
  --fg: ${css(fg)};
  --muted: ${css(mix(fg, bg, 0.42))};
  --border: ${css(border)};
  --surface: ${css(surface)};
  --surface-alt: ${css(surfaceAlt)};
  --accent: ${css(accent)};
  --accent-alt: ${css(accentAlt)};
  --accent-fg: ${css(contrastOn(accent))};
  --code-bg: ${css(dark ? mix(bg, fg, 0.08) : mix(bg, fg, 0.045))};
  --selection: ${css(accent, 0.28)};
  --hl-keyword: ${css(toRgb(palette[5]) ?? accentAlt)};
  --hl-string: ${css(toRgb(palette[2]) ?? accent)};
  --hl-comment: ${css(mix(fg, bg, 0.5))};
  --hl-number: ${css(toRgb(palette[3]) ?? accentAlt)};
  --hl-title: ${css(toRgb(palette[4]) ?? accent)};
  --hl-type: ${css(toRgb(palette[6]) ?? accentAlt)};
  --hl-attr: ${css(toRgb(palette[3]) ?? accentAlt)};
  color-scheme: ${dark ? "dark" : "light"};`;
}

const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); }
body {
  color: var(--fg);
  font-family: ui-sans-serif, -apple-system, "Segoe UI", Inter, "Helvetica Neue", Arial, sans-serif;
  font-size: 16px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
::selection { background: var(--selection); }
body::-webkit-scrollbar { width: 10px; height: 10px; }
body::-webkit-scrollbar-thumb { background: var(--surface-alt); border-radius: 8px; border: 2px solid var(--bg); }
body::-webkit-scrollbar-track { background: transparent; }

main {
  max-width: 54rem;
  margin: 0 auto;
  padding: 2.5rem 3rem 55vh;
  cursor: default;
}
main > :first-child { margin-top: 0; }

h1, h2, h3, h4, h5, h6 {
  line-height: 1.25;
  margin: 2.2em 0 0.6em;
  font-weight: 640;
  letter-spacing: -0.01em;
  scroll-margin-top: 1rem;
}
h1 { font-size: 2.05rem; letter-spacing: -0.022em; margin-top: 0.4em; }
h2 { font-size: 1.45rem; padding-bottom: 0.35rem; border-bottom: 1px solid var(--border); }
h3 { font-size: 1.16rem; }
h4 { font-size: 1rem; }
h5, h6 { font-size: 0.92rem; color: var(--muted); }

p, ul, ol, blockquote, table, pre { margin: 0 0 1.1em; }
ul, ol { padding-left: 1.5em; }
li + li { margin-top: 0.3em; }
li > ul, li > ol { margin: 0.3em 0 0; }

a { color: var(--accent); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); }
a:hover { border-bottom-color: var(--accent); }

strong { font-weight: 650; }
hr { border: 0; border-top: 1px solid var(--border); margin: 2.4em 0; }

blockquote {
  border-left: 3px solid var(--accent);
  background: var(--surface);
  margin-left: 0;
  padding: 0.7em 1.1em;
  color: var(--muted);
  border-radius: 0 6px 6px 0;
}
blockquote > :last-child { margin-bottom: 0; }

code, kbd, pre {
  font-family: ui-monospace, "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 0.86em;
}
:not(pre) > code {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 0.12em 0.36em;
  white-space: nowrap;
}
pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1em 1.15em;
  overflow: auto;
  line-height: 1.5;
  position: relative;
}
pre code { background: none; border: 0; padding: 0; white-space: pre; }
pre .code-lang {
  position: absolute;
  top: 0.55em;
  right: 0.8em;
  font-size: 0.68em;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  user-select: none;
}

table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  font-size: 0.92em;
}
thead { background: var(--surface-alt); }
th, td { padding: 0.5em 0.8em; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
th { font-weight: 620; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:nth-child(2n) { background: color-mix(in srgb, var(--surface) 55%, transparent); }

img { max-width: 100%; border-radius: 8px; }
del { color: var(--muted); }

.hljs-keyword, .hljs-selector-tag, .hljs-literal { color: var(--hl-keyword); font-weight: 550; }
.hljs-string, .hljs-regexp, .hljs-addition { color: var(--hl-string); }
.hljs-comment, .hljs-quote { color: var(--hl-comment); font-style: italic; }
.hljs-number, .hljs-symbol, .hljs-bullet { color: var(--hl-number); }
.hljs-title, .hljs-section, .hljs-name { color: var(--hl-title); }
.hljs-type, .hljs-built_in, .hljs-class .hljs-title { color: var(--hl-type); }
.hljs-attr, .hljs-attribute, .hljs-variable, .hljs-template-variable { color: var(--hl-attr); }
.hljs-meta { color: var(--muted); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
`;

export function renderMarkdown(file: string, colors: TerminalColors): RenderedDoc {
  const source = fs.readFileSync(file, "utf8");
  const headings: RenderedDoc["headings"] = [];
  const seen = new Map<string, number>();

  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  md.options.highlight = (code: string, lang: string) => {
    const language = (lang ?? "").trim().split(/\s+/)[0] || undefined;
    const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : "";
    return `<pre class="code-block">${label}<code>${highlight(code, language)}</code></pre>`;
  };

  const tokens = md.parse(source, {});
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "heading_open" || !token.map) continue;
    const text = inlineText(tokens[i + 1]);
    const id = slugify(text, seen);
    token.attrSet("id", id);
    headings.push({ depth: Number(token.tag.slice(1)), text, id });
  }
  const body = md.renderer.render(tokens, md.options, {});

  const words = source.split(/\s+/).filter(Boolean).length;
  const lines = source.split("\n").length;
  const title = headings.find((h) => h.depth === 1)?.text ?? path.basename(file);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${pathToFileURL(path.dirname(file) + path.sep).href}">
<title>${escapeHtml(title)}</title>
<style>
:root {${themeCss(colors)}
}
${CSS}
</style>
</head>
<body>
<main>${body}</main>
<script>
// The base URL is the Markdown directory for images and relative links, but
// fragment-only links must resolve against the generated preview instead.
for (const link of document.querySelectorAll('a[href^="#"]')) {
  link.href = location.href.split('#')[0] + link.getAttribute('href');
}
</script>
</body>
</html>`;

  return { html, title, lines, words, headings };
}
