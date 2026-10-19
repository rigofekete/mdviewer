import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useEffect, useMemo, useRef, useState } from "react";
import electron from "@zenbu-labs/pixel/electron";
import {
  Box,
  Text,
  WebView,
  createRoot,
  makeTheme,
  useTerminalColors,
  type EngineKeyEvent,
  type TerminalColors,
  type WebViewHandle,
} from "@zenbu-labs/pixel";
import { renderMarkdown, type RenderedDoc } from "./render.js";

const { nativeImage } = electron;

interface Args {
  file: string;
  shot: string | null;
  record: string | null;
  quitAfter: number | null;
  watch: boolean;
}

function parseArgs(argv: string[]): Args {
  let file = "";
  let shot: string | null = null;
  let record: string | null = null;
  let quitAfter: number | null = null;
  let watch = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--shot") shot = argv[++i] ?? null;
    else if (arg === "--record") record = argv[++i] ?? null;
    else if (arg === "--quit-after") quitAfter = Number(argv[++i] ?? 0) || null;
    else if (arg === "--no-watch") watch = false;
    else if (!arg.startsWith("--") && !file) file = arg;
  }
  if (!file) {
    process.stderr.write("usage: mdview <file.md> [--shot out.png] [--record dir] [--quit-after ms] [--no-watch]\n");
    process.exit(2);
  }
  return { file: path.resolve(file), shot, record, quitAfter, watch };
}

const args = parseArgs(process.argv.slice(2));
const TMP_DIR = path.join(os.tmpdir(), "mdview");
fs.mkdirSync(TMP_DIR, { recursive: true });
const HTML_PATH = path.join(TMP_DIR, `${crypto.createHash("sha1").update(args.file).digest("hex").slice(0, 12)}.html`);

let keyHandler: ((event: EngineKeyEvent) => boolean | void) | null = null;

const root = createRoot({
  name: "mdview",
  onUnsupportedTerminal: () =>
    ["", "  \x1b[1mmdview needs a terminal with graphics support\x1b[0m", "", "  Ghostty, kitty, WezTerm, iTerm2, Konsole, Warp …", ""].join(
      "\n",
    ),
  onKey(event) {
    return keyHandler?.(event) ?? false;
  },
});

function statKey(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

function writeDocument(file: string): RenderedDoc {
  const doc = renderMarkdown(file, root.info.colors as TerminalColors);
  fs.writeFileSync(HTML_PATH, doc.html, "utf8");
  return doc;
}

/** Turn the newest recorded surface frame into a PNG (a terminal-independent check). */
function saveFrame(
  handle: WebViewHandle,
  capture: ReturnType<WebViewHandle["recording"]["start"]>,
  out: string | null,
  dir: string,
): { frames: number; png: string | null } {
  const size = handle.recording.frameSize();
  capture.stop();
  const index = capture.index();
  const frames = index.frames.length;
  const last = frames > 0 ? capture.frame(frames - 1) : null;
  let written: string | null = null;
  if (last && size) {
    const image = nativeImage.createFromBitmap(last, { width: size.width, height: size.height });
    if (!image.isEmpty()) {
      written = out ?? path.join(dir, "frame.png");
      fs.writeFileSync(written, image.toPNG());
    }
  }
  capture.release();
  return { frames, png: written };
}

function App() {
  const theme = makeTheme(useTerminalColors());
  const rem = root.info.basePx;
  const page = useRef<WebViewHandle>(null);
  const scroll = useRef(0);
  const [doc, setDoc] = useState<RenderedDoc | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const src = useMemo(() => pathToFileURL(HTML_PATH).href, []);

  const build = (restoreScroll: boolean) => {
    try {
      setDoc(writeDocument(args.file));
      setError(null);
      const handle = page.current;
      if (!handle) return;
      if (restoreScroll) {
        void handle.webContents
          .executeJavaScript("window.scrollY")
          .then((value) => {
            scroll.current = Number(value) || 0;
          })
          .catch(() => {});
      }
      handle.webContents.once("did-finish-load", () => {
        if (scroll.current > 0) {
          void handle.webContents.executeJavaScript(`window.scrollTo(0, ${Math.round(scroll.current)})`).catch(() => {});
        }
      });
      handle.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    setDoc(writeDocument(args.file));
    root.setTitle(`mdview: ${path.basename(args.file)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // live reload when the file changes on disk (nvim saves by rename, so poll)
  useEffect(() => {
    if (!args.watch) return;
    let last = statKey(args.file);
    const timer = setInterval(() => {
      const next = statKey(args.file);
      if (next && next !== last) {
        last = next;
        build(true);
      }
    }, 350);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // debug capture: record the webview surface, then dump the newest frame
  useEffect(() => {
    if ((!args.shot && !args.record) || !loaded) return;
    const handle = page.current;
    if (!handle) return;
    const dir = args.record ?? path.join(os.tmpdir(), "mdview-capture");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const capture = handle.recording.start(dir);
    const timer = setTimeout(() => {
      try {
        saveFrame(handle, capture, args.shot, dir);
      } catch (cause) {
        process.stderr.write(`mdview: capture failed ${String(cause)}\n`);
      }
      root.stop(0);
    }, 1500);
    return () => clearTimeout(timer);
  }, [loaded]);

  useEffect(() => {
    if (!args.quitAfter) return;
    const timer = setTimeout(() => root.stop(0), args.quitAfter);
    return () => clearTimeout(timer);
  }, []);

  keyHandler = (event) => {
    if (event.kind !== "press") return false;
    if (event.mods.ctrl && event.key === "c") {
      root.stop(0);
      return true;
    }
    if (event.mods.alt || event.mods.super) return false;
    const handle = page.current;
    const scrollBy = (top: number) =>
      void handle?.webContents.executeJavaScript(`window.scrollBy({ top: ${top}, behavior: "instant" })`).catch(() => {});
    switch (event.key) {
      case "q":
      case "escape":
        root.stop(0);
        return true;
      case "r":
        build(false);
        return true;
      case "j":
        scrollBy(rem * 12);
        return true;
      case "k":
        scrollBy(-rem * 12);
        return true;
      case "d":
        scrollBy(root.info.height * 0.8);
        return true;
      case "u":
        scrollBy(-root.info.height * 0.8);
        return true;
      case "g":
        void handle?.webContents.executeJavaScript("window.scrollTo(0, 0)").catch(() => {});
        return true;
      case "G":
        void handle?.webContents.executeJavaScript("window.scrollTo(0, document.body.scrollHeight)").catch(() => {});
        return true;
      case "backspace":
        handle?.back();
        return true;
      case "+":
      case "=":
        handle?.zoom(1);
        return true;
      case "-":
        handle?.zoom(-1);
        return true;
      case "0":
        handle?.zoom(0);
        return true;
      default:
        return false;
    }
  };

  const meta = doc ? `${doc.lines} lines · ${doc.words.toLocaleString("en-US")} words` : "";

  return (
    <Box style={{ flexDirection: "column", width: "100%", height: "100%", background: theme.bg }}>
      <Box
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: rem * 0.75,
          height: rem * 2.1,
          padding: { left: rem * 1.1, right: rem * 1.1 },
          background: theme.bg,
          border: { bottom: [1, theme.hairline] },
        }}
      >
        <Text style={{ fontSize: rem * 0.78, color: theme.muted }}>md</Text>
        <Text style={{ fontSize: rem * 0.78, color: theme.accent }}>{path.basename(args.file)}</Text>
        <Text style={{ fontSize: rem * 0.7, color: theme.muted }}>{meta}</Text>
        <Box style={{ flexGrow: 1 }} />
        {error ? (
          <Text style={{ fontSize: rem * 0.72, color: theme.red }}>{error}</Text>
        ) : (
          <Text style={{ fontSize: rem * 0.72, color: theme.disabled }}>
            q quit · r reload · j/k scroll · +/− zoom
          </Text>
        )}
      </Box>
      <WebView
        ref={page}
        src={src}
        style={{ flexGrow: 1, width: "100%" }}
        autoFocus
        onChange={(state) => {
          if (!state.loading) setLoaded(true);
        }}
      />
    </Box>
  );
}

writeDocument(args.file);
root.render(<App />);
