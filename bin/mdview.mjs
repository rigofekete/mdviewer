#!/usr/bin/env node
// mdview — open a markdown file in a pixel WebView, optionally in a new terminal pane.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pixelTerminal from "@zenbu-labs/pixel/terminal";

const { detect, canSplit, cannotOpenPanes, callerTty } = pixelTerminal;

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIXEL_BIN = path.join(APP_DIR, "node_modules", ".bin", "pixel");

const USAGE = `mdview — markdown preview in the terminal (pixel + Chromium WebView)

usage:
  mdview <file.md>                  open in the current pane
  mdview open <file.md> [options]   open next to the current pane

options:
  --split right|left|down|up        split direction (default: right)
  --size <1-99>                     new pane size as a percentage
  --here                            do not split, run in this pane
  -- png=<path>                     capture a screenshot and exit (debug)
`;

function parse(argv) {
  const options = { file: "", split: /** @type {null | string} */ ("right"), size: null, here: false, extra: [] };
  const rest = argv.slice();
  if (rest[0] === "open") rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--split") options.split = rest[++i] ?? "right";
    else if (arg === "--size") options.size = Number(rest[++i]) || null;
    else if (arg === "--here") options.here = true;
    else if (arg === "--") options.extra.push(...rest.slice(i + 1));
    else if (!arg.startsWith("--") && !options.file) options.file = arg;
  }
  return options;
}

const options = parse(process.argv.slice(2));
if (options.help || !options.file) {
  process.stdout.write(USAGE);
  process.exit(options.help ? 0 : 2);
}

const file = path.resolve(process.cwd(), options.file);
if (!fs.existsSync(file)) {
  process.stderr.write(`mdview: no such file: ${file}\n`);
  process.exit(1);
}

const pixelArgs = [APP_DIR, "--", file, ...options.extra];
const command = [PIXEL_BIN, ...pixelArgs];

function runHere() {
  const child = spawn(PIXEL_BIN, pixelArgs, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function report(message) {
  if (process.env.MDVIEW_QUIET) return;
  process.stderr.write(`mdview: ${message}\n`);
}

if (options.here) {
  runHere();
} else {
  const terminal = detect();
  const tty = callerTty().path;
  let pane = null;
  try {
    pane = terminal?.getCurrentPane ? await terminal.getCurrentPane({ tty, cwd: process.cwd() }) : null;
  } catch {
    pane = null;
  }

  if (!terminal || !canSplit(terminal) || !pane) {
    report(cannotOpenPanes(terminal) || "no pane support here; opening in this pane");
    runHere();
  } else {
    try {
      await terminal.prepare?.();
      await terminal.split({
        from: pane,
        direction: options.split,
        command,
        size: options.size,
        tty,
      });
    } catch (cause) {
      report(`split failed (${cause instanceof Error ? cause.message : cause}); opening in this pane`);
      runHere();
    }
  }
}
