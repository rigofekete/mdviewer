#!/usr/bin/env node
// mdview — open a markdown file in a pixel WebView, optionally in a new terminal pane.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pixelTerminal from "@zenbu-labs/pixel/terminal";

const { detect, canSplit, cannotOpenPanes, callerTty } = pixelTerminal;

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIXEL_BIN = path.join(APP_DIR, "node_modules", ".bin", "pixel");
const TERMINALS = new Set(["auto", "ghostty", "herdr"]);

const USAGE = `mdview — markdown preview in the terminal (pixel + Chromium WebView)

usage:
  mdview <file.md>                  open in the current pane
  mdview open <file.md> [options]   open next to the current pane

options:
  --terminal auto|ghostty|herdr     preview target (default: config, then auto)
                                    auto: Ghostty window inside herdr, else split
  --split right|left|down|up        split direction (default: right)
  --size <1-99>                     new pane size as a percentage
  --here                            do not split, run in this pane
  -- png=<path>                     capture a screenshot and exit (debug)

config:
  ~/.config/mdview/config.json      {"terminal": "herdr"} (or ghostty, auto)
  MDVIEW_TERMINAL                   overrides the config file
`;

function parse(argv) {
  const options = {
    file: "",
    split: /** @type {null | string} */ ("right"),
    size: null,
    here: false,
    terminal: /** @type {null | string} */ (null),
    extra: [],
  };
  const rest = argv.slice();
  if (rest[0] === "open") rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--terminal") options.terminal = rest[++i] ?? "";
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

function report(message) {
  if (process.env.MDVIEW_QUIET) return;
  process.stderr.write(`mdview: ${message}\n`);
}

function fail(message) {
  process.stderr.write(`mdview: ${message}\n`);
  process.exit(1);
}

function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "mdview", "config.json");
}

function readConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    fail(`cannot read config ${file}: ${cause instanceof Error ? cause.message : cause}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`invalid config ${file}: expected a JSON object`);
  }
  return parsed;
}

function requestedTerminal(explicit, env) {
  // Do not read the config when a flag or env var already decides: a broken
  // config must not block an explicit choice.
  let target = explicit ?? env.MDVIEW_TERMINAL;
  if (target === undefined) target = readConfig().terminal;
  target ??= "auto";
  if (typeof target !== "string" || !TERMINALS.has(target)) {
    fail(`invalid terminal target ${JSON.stringify(target)} (expected auto, ghostty or herdr)`);
  }
  return target;
}

function isExecutable(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findGhostty(env = process.env) {
  const candidates = [];
  if (env.GHOSTTY_BIN_DIR) candidates.push(path.join(env.GHOSTTY_BIN_DIR, "ghostty"));
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "ghostty"));
  }
  return candidates.find(isExecutable) ?? null;
}

function hasGraphicalSession(env = process.env) {
  return Boolean(env.WAYLAND_DISPLAY || env.DISPLAY);
}

/** The +new-window action runs in the running Ghostty instance, but never leak herdr if we start one ourselves. */
function withoutHerdr(env) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("HERDR_")) delete childEnv[key];
  }
  return childEnv;
}

function runHere() {
  const child = spawn(PIXEL_BIN, pixelArgs, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

/**
 * Ask the running Ghostty instance for a window. Resolves `{ ok: false }` when
 * the action cannot be delivered (normally: no instance is running).
 */
function ghosttyAction(ghostty, args, env) {
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    let child;
    const finish = (ok, message = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, message });
    };
    const timer = setTimeout(() => {
      child?.unref();
      finish(true);
    }, 1500);
    timer.unref?.();
    try {
      child = spawn(ghostty, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    } catch (cause) {
      finish(false, cause instanceof Error ? cause.message : String(cause));
      return;
    }
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (cause) => finish(false, cause.message));
    child.once("close", (code) => finish(code === 0, stderr.trim()));
  });
}

async function launchGhosttyWindow(ghostty) {
  const dir = path.dirname(file);
  const env = withoutHerdr(process.env);
  const action = await ghosttyAction(
    ghostty,
    ["+new-window", `--working-directory=${dir}`, "-e", ...command],
    env,
  );
  if (action.ok) return;

  // No running instance (or the action failed): start Ghostty directly instead.
  // This child gets an env with every HERDR_* key removed, so Pixel cannot detect herdr.
  const child = spawn(ghostty, [`--working-directory=${dir}`, "-e", ...command], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.once("error", (cause) => fail(`failed to start Ghostty: ${cause.message}`));
  child.unref();
  if (action.message) report(`Ghostty action failed (${action.message}); starting a new window`);
}

async function openInPanes() {
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
    return;
  }

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

if (options.here) {
  runHere();
} else {
  const requested = requestedTerminal(options.terminal, process.env);
  const ghostty = findGhostty();

  if (requested === "ghostty") {
    if (!hasGraphicalSession()) fail("cannot open a Ghostty window: no graphical session (WAYLAND_DISPLAY or DISPLAY is unset)");
    if (!ghostty) fail("cannot open a Ghostty window: ghostty not found on PATH or in $GHOSTTY_BIN_DIR");
  }

  const useWindow =
    requested === "ghostty" ||
    (requested === "auto" && Boolean(process.env.HERDR_PANE_ID) && Boolean(ghostty) && hasGraphicalSession());

  if (useWindow && ghostty) {
    report("opening a native Ghostty window");
    try {
      await launchGhosttyWindow(ghostty);
    } catch (cause) {
      fail(`failed to open a Ghostty window: ${cause instanceof Error ? cause.message : cause}`);
    }
  } else {
    if (requested !== "herdr" && process.env.HERDR_PANE_ID) {
      const reason = !hasGraphicalSession()
        ? "no graphical session (WAYLAND_DISPLAY or DISPLAY is unset)"
        : "ghostty not found on PATH or in $GHOSTTY_BIN_DIR";
      report(`splitting the current pane (${reason})`);
    } else {
      report("splitting the current pane");
    }
    await openInPanes();
  }
}
