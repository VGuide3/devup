#!/usr/bin/env node
/**
 * Universal zero-config build validator. Walks the whole tree — every nested
 * package.json / tsconfig.json / .env.example / Cargo.toml / go.mod / foundry.toml /
 * hardhat.config.* / *.py is checked inside its own subtree, so monorepos and
 * split front/back layouts work. Missing tools = warning+skip (STRICT=1 = error).
 *
 *   validate [dir]            report only
 *   validate --fix [dir]      auto-repair: node_modules, JSONC, .env (secrets generated)
 *   validate --launch [dir]   on PASS: migrate (if declared) → start; port busy → retry free
 *   validate --fix --launch   repair → validate → migrate → run   (alias: devup)
 *   validate --fix --launch https://github.com/x/y   clone to ~/repos, then all of the above
 *
 * Opt-ins:  VALIDATE_TESTS=1  npm test in every package that declares it
 *           VALIDATE_LINT=1   eslint (if configured)
 *           VALIDATE_DEAD=1   knip dead-code scan (if available)
 *           VALIDATE_OFFLINE=1 forbid external assets in HTML
 *           STRICT=1          missing checkers count as failures
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync, spawn } = require("child_process");

const args = process.argv.slice(2);
const FIX = args.includes("--fix") || process.env.VALIDATE_FIX === "1";
const LAUNCH = args.includes("--launch") || process.env.VALIDATE_LAUNCH === "1";
const dirArg = args.find((a) => !a.startsWith("-"));

/* git URL → clone (or fast-forward) into ~/repos/<name> */
let rootArg = dirArg;
if (dirArg && /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(dirArg)) {
  const name = path.basename(dirArg).replace(/\.git$/, "");
  const dest = path.join(os.homedir(), "repos", name);
  if (fs.existsSync(path.join(dest, ".git"))) {
    console.log(`  repo exists at ${dest} — git pull`);
    spawnSync("git", ["-C", dest, "pull", "--ff-only"], { stdio: "inherit" });
  } else if (fs.existsSync(dest)) {
    console.error(`  x ${dest} exists but is not a git clone — using it as-is`);
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    console.log(`  cloning ${dirArg} → ${dest}`);
    const r = spawnSync("git", ["clone", "--depth", "1", dirArg, dest], { stdio: "inherit" });
    if (r.status !== 0) process.exit(1);
  }
  rootArg = dest;
}
const ROOT = path.resolve(process.env.VALIDATE_ROOT || rootArg || process.cwd());

/* global env fallback — shared vars available to every project.
   Sources (first wins): $GLOBAL_ENV, ~/.env, ~/Desktop/devinscript/global.env */
const globalEnv = {};
for (const f of [process.env.GLOBAL_ENV,
  path.join(os.homedir(), ".env"),
  path.join(os.homedir(), "Desktop", "devinscript", "global.env")]) {
  if (!f || !fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in globalEnv))
      globalEnv[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const STRICT = process.env.STRICT === "1";
const errors = [];
const warnings = [];
const ran = [];
const fixed = [];

const err = (m) => errors.push(m);
const missing = (tool) => (STRICT ? err : warnings.push.bind(warnings))(`${tool} not available — skipped`);

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "target", "__pycache__", ".venv", "venv", "out"]);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/") || ".";
const has = (f) => fs.existsSync(path.join(ROOT, f));

const which = (c) => spawnSync("which", [c], { encoding: "utf8" }).status === 0;
const localBinIn = (dir, name) => {
  const p = path.join(dir, "node_modules", ".bin", name);
  return fs.existsSync(p) ? p : null;
};
function runIn(dir, cmd, cmdArgs, label) {
  const r = spawnSync(cmd, cmdArgs, { cwd: dir, encoding: "utf8" });
  ran.push(label);
  if (r.status !== 0) {
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    err(`${label} failed:\n${out.split("\n").slice(0, 15).join("\n")}`);
  }
  return r.status === 0;
}

const all = walk(ROOT);
const base = (p) => path.basename(p);
const dirs = new Set(all.map((p) => path.dirname(p)));

/* ============ --fix helper: strip JSONC comments + trailing commas ============ */
function jsoncToJson(src) {
  let out = "", i = 0, inStr = false, esc = false;
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") { i++; continue; }
    }
    out += c;
    i++;
  }
  return out;
}

/* ============ every .json parses (fixable in --fix) ============ */
for (const f of all.filter((p) => p.endsWith(".json"))) {
  const src = fs.readFileSync(f, "utf8");
  try { JSON.parse(src); }
  catch (e) {
    let repaired = false;
    if (FIX) {
      try {
        const cleaned = jsoncToJson(src);
        JSON.parse(cleaned);
        fs.writeFileSync(f, cleaned);
        fixed.push(`${rel(f)} (stripped comments/trailing commas)`);
        repaired = true;
      } catch { /* still broken */ }
    }
    if (!repaired) err(`${rel(f)} invalid JSON: ${e.message}`);
  }
}
ran.push("json-parse");

/* ============ every package.json subtree: deps installed? ============ */
const pkgDirs = [...new Set(
  all.filter((p) => base(p) === "package.json").map((p) => path.dirname(p))
)].sort();
const pkgs = {};
for (const dir of pkgDirs) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); }
  catch { continue; } // invalid JSON already reported above
  pkgs[dir] = pkg;
  const nDeps = Object.keys(pkg.dependencies || {}).length +
                Object.keys(pkg.devDependencies || {}).length;
  if (nDeps > 0 && !fs.existsSync(path.join(dir, "node_modules"))) {
    const at = rel(dir) === "." ? "root" : rel(dir);
    if (FIX) {
      const cmd = fs.existsSync(path.join(dir, "package-lock.json")) ? "ci" : "install";
      if (runIn(dir, "npm", [cmd], `npm ${cmd} (${at})`))
        fixed.push(`npm ${cmd} in ${at}`);
    } else {
      err(`[${at}] node_modules missing — run npm ci (or: validate --fix)`);
    }
  }
}
ran.push("deps");

/* ============ every plain .js parses ============ */
for (const f of all.filter((p) => /\.(mjs|cjs|js)$/.test(p) && !p.endsWith(".d.ts"))) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) err(`${rel(f)} syntax error: ${r.stderr.trim().split("\n")[0]}`);
}
ran.push("js-syntax");

/* ============ wiring: relative imports must resolve ============ */
const codeExts = [".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".json", ".vue", ".svelte", ".css"];
function resolvesImport(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  if (fs.existsSync(base)) return true;
  for (const e of codeExts) if (fs.existsSync(base + e)) return true;
  for (const e of codeExts) if (fs.existsSync(path.join(base, "index" + e))) return true;
  return false;
}
const importRe = /(?:import\s+(?:[^'";]+\s+from\s+)?|import\s*\(|require\s*\(|export\s+[^'";]*\sfrom\s*)['"]([^'"]+)['"]/g;

/* mask comments + string/template interiors to spaces (newlines kept) so
   fake "import" text inside literals can't false-positive */
function maskCode(src) {
  const out = src.split("");
  let st = 0; // 0 code · 1 // · 2 /* */ · 3 ' · 4 " · 5 `
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (st === 0) {
      if (c === "/" && n === "/") { out[i] = out[i + 1] = " "; st = 1; i++; }
      else if (c === "/" && n === "*") { out[i] = out[i + 1] = " "; st = 2; i++; }
      else if (c === "'") st = 3;
      else if (c === '"') st = 4;
      else if (c === "`") st = 5;
    } else if (st === 1) {
      if (c === "\n") st = 0; else out[i] = " ";
    } else if (st === 2) {
      if (c === "*" && n === "/") { out[i] = out[i + 1] = " "; st = 0; i++; }
      else if (c !== "\n") out[i] = " ";
    } else { // inside a string or template literal
      if (c === "\\") { out[i] = " "; if (n !== "\n") out[i + 1] = " "; i++; }
      else if ((st === 3 && c === "'") || (st === 4 && c === '"') || (st === 5 && c === "`")) st = 0;
      else if (c !== "\n") out[i] = " ";
    }
  }
  return out.join("");
}

for (const f of all.filter((p) => /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(p) && !p.endsWith(".d.ts"))) {
  const src = fs.readFileSync(f, "utf8");
  const masked = maskCode(src);
  const dir = path.dirname(f);
  for (const m of src.matchAll(importRe)) {
    if (masked[m.index] === " ") continue; // keyword sits inside a string/comment
    const spec = m[1];
    if (!spec.startsWith(".")) continue; // bare specifiers are package deps, not wiring
    if (!resolvesImport(dir, spec)) err(`${rel(f)} unresolved import: "${spec}"`);
  }
}
ran.push("imports");

/* ============ every tsconfig subtree: tsc --noEmit ============ */
const tsDirs = [...new Set(
  all.filter((p) => base(p) === "tsconfig.json").map((p) => path.dirname(p))
)].sort();
if (tsDirs.length) {
  const tsc = tsDirs.map((d) => localBinIn(d, "tsc")).find(Boolean)
    || localBinIn(ROOT, "tsc") || (which("tsc") ? "tsc" : null);
  if (!tsc) missing("tsc (npm i -D typescript)");
  else for (const dir of tsDirs)
    runIn(dir, tsc, ["--noEmit", "-p", dir], `tsc --noEmit (${rel(dir)})`);
}

/* ============ every .env.example vs code in its subtree ============ */
const envFiles = all.filter((p) => base(p) === ".env.example");
const globallySatisfied = new Set();
const PLACEHOLDER = /^(|.*(your|change|here|xxx|todo|placeholder|example).*)$/i;
for (const envFile of envFiles) {
  const dir = path.dirname(envFile);
  const envPath = path.join(dir, ".env");

  /* --fix: materialize .env, generating real values for secrets */
  if (!fs.existsSync(envPath)) {
    if (FIX) {
      const out = fs.readFileSync(envFile, "utf8").split("\n").map((line) => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (!m || !PLACEHOLDER.test(m[2].trim())) return line;
        const [, key] = m;
        if (/SECRET|TOKEN|PASSWORD|API_KEY/.test(key))
          return `${key}=${crypto.randomBytes(24).toString("hex")}`;
        if (/PRIVATE_KEY/.test(key))
          return `${key}=0x${crypto.randomBytes(32).toString("hex")}`;
        if (/MNEMONIC/.test(key)) {
          warnings.push(`${key}: left as placeholder in ${rel(envPath)} — generate a real mnemonic yourself`);
          return line;
        }
        return line;
      });
      fs.writeFileSync(envPath, out.join("\n"));
      fixed.push(`created ${rel(envPath)} from ${rel(envFile)} (secrets generated)`);
    } else {
      warnings.push(`${rel(envPath)} missing — dev defaults will be used (validate --fix creates it)`);
    }
  }
  const declared = new Set(
    fs.readFileSync(envFile, "utf8").split("\n")
      .map((l) => l.split("=")[0].trim())
      .filter((k) => k && !k.startsWith("#"))
  );
  const missingEnv = new Set();
  for (const f of all.filter((p) =>
    p.startsWith(dir + path.sep) && /\.(js|ts|mjs|cjs|py)$/.test(p))) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)|os\.environ(?:\.get)?\(?\[?["']([A-Z_][A-Z0-9_]*)["']/g)) {
      const name = m[1] || m[2];
      if (!declared.has(name)) {
        if (name in globalEnv || name in process.env) globallySatisfied.add(name);
        else missingEnv.add(`${name} (in ${rel(f)})`);
      }
    }
  }
  for (const m of missingEnv)
    err(`env var referenced but not in ${rel(envFile)}: ${m}`);
}
if (envFiles.length) ran.push(`env-vs-example(${envFiles.length})`);
if (globallySatisfied.size)
  warnings.push(`env vars supplied by global env, not ${envFiles.length ? ".env.example" : "project"}: ${[...globallySatisfied].join(", ")}`);

/* ============ HTML: refs, links, anchors, ids ============ */
const pages = all.filter((p) => p.endsWith(".html"));
if (pages.length) {
  const pageSet = new Set(pages.map(rel));
  const refRe = /\s(?:src|href)="([^"]+)"/g;
  const htmlLinkRe = /href="([^"#:]+\.html)(?:[?#][^"]*)?"/g;
  const idCache = {};
  const idsOf = (p) => (idCache[p] ??= new Set(
    [...fs.readFileSync(p, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
  ));

  for (const pagePath of pages) {
    const page = rel(pagePath);
    const html = fs.readFileSync(pagePath, "utf8");
    const dir = path.dirname(pagePath);
    const ids = idsOf(pagePath);

    for (const m of html.matchAll(refRe)) {
      const url = m[1];
      if (/^(https?:|mailto:|tel:|data:|#|javascript:|\/\/)/i.test(url)) {
        if (process.env.VALIDATE_OFFLINE === "1" && /^https?:\/\//i.test(url))
          err(`[${page}] external asset: ${url}`);
        continue;
      }
      const ref = url.split(/[?#]/)[0];
      if (ref && !fs.existsSync(ref.startsWith("/") ? path.join(ROOT, ref) : path.resolve(dir, ref)))
        err(`[${page}] broken local ref: "${ref}"`);
    }
    const idArr = [...ids];
    for (const id of new Set(idArr))
      if (idArr.filter((x) => x === id).length > 1) err(`[${page}] duplicate id: #${id}`);
    for (const m of html.matchAll(/href="#([^"]+)"/g))
      if (!ids.has(m[1])) err(`[${page}] hash link has no target: #${m[1]}`);
    for (const m of html.matchAll(htmlLinkRe)) {
      const t = rel(path.resolve(dir, m[1]));
      if (!pageSet.has(t)) err(`[${page}] internal link to missing page: ${m[1]}`);
    }
    for (const m of html.matchAll(/href="([^"#?]+\.html)#([^"]+)"/g)) {
      const t = path.resolve(dir, m[1]);
      if (pageSet.has(rel(t)) && !idsOf(t).has(m[2]))
        err(`[${page}] anchor has no target: ${m[1]}#${m[2]}`);
    }
    if (!/<title>.+<\/title>/i.test(html)) err(`[${page}] missing <title>`);
  }
  ran.push(`html(${pages.length} pages)`);
}

/* ============ every Cargo.toml subtree ============ */
const cargoDirs = [...new Set(
  all.filter((p) => base(p) === "Cargo.toml").map((p) => path.dirname(p))
)].sort();
if (cargoDirs.length) {
  if (!which("cargo")) missing("cargo");
  else for (const dir of cargoDirs)
    runIn(dir, "cargo", ["check", "--quiet"], `cargo check (${rel(dir)})`);
}

/* ============ every go.mod subtree ============ */
const goDirs = [...new Set(
  all.filter((p) => base(p) === "go.mod").map((p) => path.dirname(p))
)].sort();
if (goDirs.length) {
  if (!which("go")) missing("go");
  else for (const dir of goDirs)
    runIn(dir, "go", ["vet", "./..."], `go vet (${rel(dir)})`);
}

/* ============ smart contracts: forge build / hardhat compile ============ */
const foundryDirs = [...new Set(
  all.filter((p) => base(p) === "foundry.toml").map((p) => path.dirname(p))
)].sort();
if (foundryDirs.length) {
  if (!which("forge")) missing("forge (foundry)");
  else for (const dir of foundryDirs)
    runIn(dir, "forge", ["build", "--quiet"], `forge build (${rel(dir)})`);
}
const hardhatDirs = [...new Set(
  all.filter((p) => /^hardhat\.config\.(js|ts|cjs|mjs)$/.test(base(p))).map((p) => path.dirname(p))
)].sort();
if (hardhatDirs.length) {
  for (const dir of hardhatDirs) {
    const hh = localBinIn(dir, "hardhat");
    if (hh) runIn(dir, hh, ["compile"], `hardhat compile (${rel(dir)})`);
    else missing(`hardhat (${rel(dir)}) — run npm ci there or validate --fix`);
  }
}

/* ============ Python: byte-compile everything ============ */
if (all.some((p) => p.endsWith(".py"))) {
  if (!which("python3")) missing("python3");
  else {
    const r = spawnSync("python3", ["-m", "compileall", "-q", ROOT], { cwd: ROOT, encoding: "utf8" });
    ran.push("py-compileall");
    if (r.status !== 0)
      err(`python compileall:\n${(r.stderr || "").trim().split("\n").slice(0, 10).join("\n")}`);
  }
}

/* ============ docker compose config sanity ============ */
const composeFile = all.find((p) => /^(docker-)?compose\.(ya?ml)$/.test(base(p)));
if (composeFile) {
  if (!which("docker")) missing("docker (compose check skipped)");
  else runIn(path.dirname(composeFile), "docker", ["compose", "config", "-q"], "compose config");
}

/* ============ opt-ins ============ */
if (process.env.VALIDATE_TESTS === "1") {
  const testDirs = pkgDirs.filter((d) =>
    pkgs[d]?.scripts?.test && fs.existsSync(path.join(d, "node_modules")));
  if (!testDirs.length && pkgDirs.length)
    warnings.push("VALIDATE_TESTS=1 but no package with installed deps declares a test script");
  for (const dir of testDirs)
    runIn(dir, "npm", ["test", "--silent"], `npm test (${rel(dir)})`);
}
if (process.env.VALIDATE_LINT === "1") {
  const eslint = pkgDirs.map((d) => localBinIn(d, "eslint")).find(Boolean);
  if (eslint) runIn(ROOT, eslint, ["."], "eslint");
  else if (pkgDirs.length || tsDirs.length) missing("eslint");
}
if (process.env.VALIDATE_DEAD === "1") {
  const knip = pkgDirs.map((d) => localBinIn(d, "knip")).find(Boolean);
  if (knip) runIn(ROOT, knip, ["--no-progress"], "knip (dead code)");
  else missing("knip (npm i -D knip) — finds unused files/exports/deps");
}

/* ============ report ============ */
function needsYou(msg) {
  process.stdout.write("\x07"); // bell
  if (os.platform() === "darwin" && which("osascript"))
    spawnSync("osascript", ["-e",
      `display notification "${msg.replace(/"/g, "'")}" with title "validate" sound name "Glass"`]);
}
for (const f of fixed) console.log(`  + fixed: ${f}`);
for (const w of warnings) console.log(`  ! ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`  x ${e}`);
  console.error(`\nFAIL - ${errors.length} error(s), ${warnings.length} warning(s)  [${ran.join(", ")}]`);
  needsYou(`${errors.length} error(s) need you`);
  process.exit(1);
}
console.log(`PASS - ${ran.join(", ")} (${warnings.length} warnings)`);

/* ============ --launch: nearest-to-root runnable target wins ============ */
if (LAUNCH) {
  const candidates = [];
  for (const dir of pkgDirs) {
    const s = pkgs[dir]?.scripts || {};
    if (s.dev) candidates.push({ dir, cmd: "npm", args: ["run", "dev"], label: `npm run dev (${rel(dir)})` });
    else if (s.start) candidates.push({ dir, cmd: "npm", args: ["start"], label: `npm start (${rel(dir)})` });
  }
  for (const dir of cargoDirs)
    if (which("cargo")) candidates.push({ dir, cmd: "cargo", args: ["run"], label: `cargo run (${rel(dir)})` });
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir, "manage.py")) && which("python3"))
      candidates.push({ dir, cmd: "python3", args: ["manage.py", "runserver"], label: `django (${rel(dir)})` });
  }
  for (const dir of dirs) {
    const f = ["app.py", "main.py"].find((n) => fs.existsSync(path.join(dir, n)));
    if (f && which("python3"))
      candidates.push({ dir, cmd: "python3", args: [f], label: `python3 ${f} (${rel(dir)})` });
  }
  if (!candidates.length && pages.length && which("python3"))
    candidates.push({ dir: ROOT, cmd: "python3", args: ["-m", "http.server", "8080"], label: "http.server :8080" });

  candidates.sort((a, b) => rel(a.dir).split("/").length - rel(b.dir).split("/").length);
  const pick = candidates[0];
  if (!pick) {
    console.log("  ! no launch target detected (need package.json scripts, Cargo.toml, *.py, or *.html)");
    process.exit(2);
  }
  if (candidates.length > 1)
    console.log(`  (also runnable: ${candidates.slice(1).map((c) => c.label).join(", ")})`);

  /* run migrate first if the picked package declares it (like chasebankio's npm run migrate) */
  if (pick.cmd === "npm" && pkgs[pick.dir]?.scripts?.migrate) {
    console.log(`\n  migrate: npm run migrate (${rel(pick.dir)})`);
    const mig = spawnSync("npm", ["run", "migrate"], { cwd: pick.dir, stdio: "inherit" });
    if (mig.status !== 0) {
      console.error("  x migrate failed — not launching");
      process.exit(1);
    }
  }

  /* launch with one automatic retry on port conflict (PORT=<free>) */
  const freePort = () => new Promise((res) => {
    const s = require("net").createServer().listen(0, () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
  const tryLaunch = (extraEnv) => new Promise((resolve) => {
    const child = spawn(pick.cmd, pick.args, {
      cwd: pick.dir, env: { ...globalEnv, ...process.env, ...extraEnv }
    });
    let tail = "";
    const tee = (d) => { process.stdout.write(d); tail = (tail + d).slice(-8192); };
    child.stdout.on("data", tee);
    child.stderr.on("data", tee);
    process.on("SIGINT", () => child.kill("SIGINT"));
    child.on("exit", (code) => resolve({ code, tail }));
    child.on("error", (e) => resolve({ code: 1, tail: String(e) }));
  });

  (async () => {
    console.log(`\n  launching: ${pick.label}  (cwd: ${pick.dir})\n`);
    let res = await tryLaunch({});
    if (res.code && /EADDRINUSE|address already in use|port \d+ is (already )?in use/i.test(res.tail)) {
      const free = await freePort();
      console.log(`\n  + fixed: port busy — retrying on :${free}\n`);
      res = await tryLaunch({ PORT: String(free) });
    }
    if (res.code) needsYou(`${pick.label} exited with code ${res.code}`);
    process.exit(res.code ?? 0);
  })();
}
