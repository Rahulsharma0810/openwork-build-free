//
// White-label patcher. Runs against a clean checkout and rewrites identity +
// offline behavior in place. It never edits committed upstream files in git:
// CI applies it to a throwaway worktree, so rebasing on upstream stays clean.
//
//   bun scripts/white-label/apply.ts --check     # assert every anchor exists
//   bun scripts/white-label/apply.ts             # apply
//
// Every rule is fail-closed: if an upstream refactor removes or moves an
// anchor, this exits non-zero with the file and label instead of silently
// shipping an un-branded or chatty build.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { APP_DIR, REPO_ROOT, TAURI_DIR, loadBrand, slugOf, type Brand } from "./config.ts";

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");
const RESET_MARKER = args.has("--force");
// build-free.yml owns the updater config (self-hosted latest.json); skip the
// rules that would otherwise disable it.
const KEEP_SELF_UPDATER = process.env.WL_KEEP_SELF_UPDATER === "1";
const MARKER = join(REPO_ROOT, ".white-label-applied.json");

type Rule = {
  label: string;
  file: string;
  find: string | RegExp;
  replace: string;
  /** Exact expected occurrence count. Omit to accept one or more. */
  expect?: number;
};

const results: Array<{ label: string; file: string; count: number; state: string }> = [];

function fail(message: string): never {
  console.error(`\nwhite-label: ${message}\n`);
  process.exit(1);
}

function countOccurrences(text: string, find: string | RegExp): number {
  if (typeof find === "string") {
    if (!find) fail("empty find string");
    return text.split(find).length - 1;
  }
  const g = new RegExp(find.source, find.flags.includes("g") ? find.flags : `${find.flags}g`);
  return [...text.matchAll(g)].length;
}

function applyRule(rule: Rule): void {
  const abs = join(REPO_ROOT, rule.file);
  if (!existsSync(abs)) fail(`[${rule.label}] missing file ${rule.file}`);

  const text = readFileSync(abs, "utf8");
  const count = countOccurrences(text, rule.find);

  if (count === 0) {
    // Idempotency: a second run sees the replacement instead of the anchor.
    const applied = countOccurrences(text, rule.replace) > 0;
    if (applied) {
      results.push({ label: rule.label, file: rule.file, count: 0, state: "already" });
      return;
    }
    fail(
      `[${rule.label}] anchor not found in ${rule.file}\n` +
        `  find: ${JSON.stringify(String(rule.find)).slice(0, 160)}\n` +
        `  upstream probably moved it. Fix the anchor in scripts/white-label/apply.ts.`,
    );
  }

  if (rule.expect !== undefined && count !== rule.expect) {
    fail(
      `[${rule.label}] expected ${rule.expect} occurrence(s) in ${rule.file}, found ${count}.\n` +
        `  find: ${JSON.stringify(String(rule.find)).slice(0, 160)}\n` +
        `  upstream changed this call site; update the rule and its expectation.`,
    );
  }

  if (!CHECK_ONLY) {
    const next =
      typeof rule.find === "string"
        ? text.split(rule.find).join(rule.replace)
        : text.replace(rule.find, rule.replace);
    writeFileSync(abs, next);
  }
  results.push({ label: rule.label, file: rule.file, count, state: CHECK_ONLY ? "checked" : "applied" });
}

function editJson(file: string, label: string, mutate: (json: any) => void): void {
  const abs = join(REPO_ROOT, file);
  if (!existsSync(abs)) fail(`[${label}] missing file ${file}`);
  const before = readFileSync(abs, "utf8");
  const json = JSON.parse(before);
  mutate(json);
  const after = `${JSON.stringify(json, null, 2)}\n`;
  if (!CHECK_ONLY && after !== before) writeFileSync(abs, after);
  results.push({ label, file, count: 1, state: CHECK_ONLY ? "checked" : "applied" });
}

/**
 * Rewrites screenpipe's own service hosts to the offline discard port.
 * Only full URL literals are touched, so identifiers, bundle ids and
 * `screenpi.pe`-style labels stay intact.
 */
function rewriteHosts(brand: Brand): void {
  const roots = [
    `${TAURI_DIR}/src`,
    `${TAURI_DIR}/swift`,
    `${TAURI_DIR}/livetext-stress`,
    // Embedded into the binary via include_str! (pi.rs, grokbot.rs, …).
    `${TAURI_DIR}/assets`,
    `${APP_DIR}/lib`,
    `${APP_DIR}/app`,
    `${APP_DIR}/components`,
    "crates",
    // feedback-tool.ts / video-tool.ts / context-tool.ts are embedded via
    // include_str! from pi.rs; the whole package source must be branded.
    "packages/workflows-ui/src",
  ];
  // The Tauri binary embeds the Next.js static export (`frontendDist: ../out`)
  // and never touches Contents/Resources, so brand the built site too when it
  // exists (build-free.yml builds the frontend before `tauri build`).
  if (existsSync(join(REPO_ROOT, `${APP_DIR}/out`))) roots.push(`${APP_DIR}/out`);
  // .sql covers non-migration SQL only; sqlx migrations are skipped below
  // (checksummed). .c is required: build scripts compile shim/test C files.
  // .md / .patch / .txt are required: pi.rs / pi_compaction.rs / acp runtime
  // include_str! dozens of skill prompts, pipe docs and .patch files, all of
  // which land verbatim in the binary's string section.
  const exts = new Set([
    ".rs", ".ts", ".tsx", ".js", ".mjs", ".swift", ".json", ".html", ".css",
    ".jsx", ".sql", ".c", ".toml", ".md", ".patch", ".txt",
  ]);
  const skipDirs = new Set(["node_modules", "target", ".git", "dist", "out", ".next", "gen"]);
  const from = ["https://api.screenpipe.com", "https://screenpipe.com", "https://screenpi.pe", "https://us.i.posthog.com"];
  const to = brand.offline.webBase;

  let files = 0;
  let hits = 0;

  const walk = (dir: string): void => {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      if (skipDirs.has(entry)) continue;
      const rel = join(dir, entry);
      const entryAbs = join(REPO_ROOT, rel);
      const info = statSync(entryAbs);
      if (info.isDirectory()) {
        walk(rel);
        continue;
      }
      const dot = entry.lastIndexOf(".");
      if (dot < 0 || !exts.has(entry.slice(dot))) continue;
      // Never touch sqlx migrations. sqlx records a checksum of every applied
      // migration file (comments included); changing even the header comment
      // makes an existing db.sqlite refuse to open ("migration … was
      // previously applied but has been modified"), so the engine never
      // starts. Their only hosts are inert `-- https://…` header lines
      // comment, which verify.ts tolerates in that exact SQL-comment form.
      if (entry.endsWith(".sql") && rel.split("/").includes("migrations")) continue;
      let text: string;
      try {
        text = readFileSync(entryAbs, "utf8");
      } catch {
        continue; // binary or non-UTF8 file
      }
      // Strip header comments: they mention screenpipe hosts, and strings(1)
      // scans the whole binary — including comment string data — so the
      // post-build verifier would still see them. URLs in code survive; only
      // whole-line `//`, `///` and `#` comments are removed.
      // Only strip comments OUTSIDE string literals: several Rust files embed
      // the header in a `&str` constant (specta_bindings.rs) and removing it
      // mid-string breaks the file. strings(1) sees constants either way, but
      // those constants are rewritten by the host pass below anyway.
      const inString = (idx: number): boolean => {
        let inStr = false;
        for (let i = 0; i < idx; i++) {
          const ch = text[i];
          if (ch === '"' && text[i - 1] !== "\\") inStr = !inStr;
        }
        return inStr;
      };
      const originalText = text;
      if (!entry.endsWith(".json") && !entry.endsWith(".html") && !entry.endsWith(".css")) {
        // Comment syntax varies by file type. Rust: only `//` (`#` = attribute).
        // SQL: only `--`. TOML/shell: only `#`. JS/TS/Swift/C: `//` and `///`.
        // Only blank comment lines that carry a forbidden host — a blanket
        // strip would erase legitimate schema/code docs and bloat the diff.
        // (The gate scans the binary for host URLs; the bare word "screenpipe"
        // in copy is tracked separately and is allowed.)
        const commentRe = entry.endsWith(".rs")
          ? /^[ \t]*\/\/[^\n]*$/gm
          : entry.endsWith(".sql")
            ? /^[ \t]*--[^\n]*$/gm
            : entry.endsWith(".toml")
              ? /^[ \t]*#[^\n]*$/gm
              : /^[ \t]*(\/\/[^\n]*|#[^\n]*)$/gm;
        const needsStrip = (line: string): boolean =>
          from.some((host) => line.includes(host));
        text = text.replace(commentRe, (match, offset: number) =>
          !inString(offset) && needsStrip(match) ? "" : match,
        );
      }
      let next = text;
      let local = 0;
      for (const host of from) {
        const parts = next.split(host);
        local += parts.length - 1;
        next = parts.join(to);
      }
      // Write when we stripped a comment OR rewrote a host. A file whose only
      // host lived inside a comment has `local === 0` after stripping, but the
      // stripped text must still be persisted or the original keeps the host.
      const changed = next !== originalText;
      if (!changed) continue;
      if (local > 0) {
        files += 1;
        hits += local;
      }
      if (!CHECK_ONLY) {
        // Keep the line count stable so error locations don't shift: blank the
        // comment instead of deleting the line.
        next = next.replace(/\n{3,}/g, "\n\n");
        writeFileSync(entryAbs, next);
      }
    }
  };

  roots.forEach(walk);
  results.push({ label: "host rewrite", file: `${roots.join(", ")}`, count: hits, state: CHECK_ONLY ? "checked" : `applied in ${files} file(s)` });
  // Surface the count in CI logs: a low number here with a later verify-gate
  // binary hit means a host is entering via a vector this walk misses.
  console.log(`white-label: host rewrite — ${hits} host(s) across ${files} file(s)`);
}

function main(): void {
  const brand = loadBrand();
  const pn = brand.productName;
  const slug = slugOf(brand);
  const bid = brand.bundleId;
  const scheme = brand.scheme;
  const webBase = brand.offline.webBase;
  const aiBase = brand.offline.aiBaseUrl;

  // ---------------------------------------------------------------- guard
  if (!existsSync(join(REPO_ROOT, `${TAURI_DIR}/tauri.conf.json`))) {
    fail(`not a screenpipe checkout: run from the repo root (looked in ${REPO_ROOT})`);
  }
  if (!CHECK_ONLY && !RESET_MARKER && existsSync(MARKER)) {
    console.log("white-label: already applied in this checkout (use --force to re-apply)");
    return;
  }

  // ------------------------------------------------------------ tauri JSON
  for (const file of ["tauri.conf.json", "tauri.prod.conf.json", "tauri.macos.conf.json", "tauri.windows.conf.json"]) {
    const path = `${TAURI_DIR}/${file}`;
    if (!existsSync(join(REPO_ROOT, path))) continue;
    editJson(path, `identity ${file}`, (json) => {
      json.productName = pn;
      json.identifier = bid;
      // Renaming productName makes the bundler derive CFBundleExecutable from it
      // ("Worklog-app"), but the compiled Cargo binary is still "screenpipe-app"
      // and is copied under that name — leaving CFBundleExecutable dangling, which
      // macOS reports as "the application is damaged or incomplete". Pin the
      // executable name to the real binary so the plist resolves.
      json.mainBinaryName = "screenpipe-app";
      if (json.bundle) {
        json.bundle.publisher = brand.publisher;
        if (!KEEP_SELF_UPDATER) delete json.bundle.createUpdaterArtifacts;
        if (json.bundle.windows) delete json.bundle.windows.signCommand;
        if (json.bundle.macOS?.exceptionDomain) json.bundle.macOS.exceptionDomain = "127.0.0.1";
      }
      if (json.plugins?.updater && !KEEP_SELF_UPDATER) {
        json.plugins.updater = { active: false, dialog: false, endpoints: [], pubkey: "" };
      }
      if (json.plugins?.["deep-link"]?.desktop?.schemes) {
        json.plugins["deep-link"].desktop.schemes = [scheme];
      }
      // Associated-domains / universal-link hosts name screenpipe.com and are
      // embedded in the compiled config JSON. The offline build has no domain,
      // so point them at the loopback discard host.
      const mobile = json.plugins?.["deep-link"]?.mobile;
      if (Array.isArray(mobile)) {
        for (const entry of mobile) {
          if (entry && typeof entry.host === "string" && /screenpipe\.com|screenpi\.pe/.test(entry.host)) {
            entry.host = "127.0.0.1";
          }
        }
      }
      if (json.app?.trayIcon) json.app.trayIcon.id = brand.trayId;
    });
  }

  // macOS-only build: drop Linux/Windows bundle targets from the base config.
  editJson(`${TAURI_DIR}/tauri.conf.json`, "targets", (json) => {
    if (Array.isArray(json.bundle?.targets)) json.bundle.targets = ["app", "dmg"];
  });

  // ------------------------------------------------------------- Info.plist
  applyRule({
    label: "plist offline env",
    file: `${TAURI_DIR}/Info.plist`,
    find: /<key>LSEnvironment<\/key>\s*<dict>[\s\S]*?<\/dict>/,
    replace:
      "\t<key>LSEnvironment</key>\n" +
      "\t<dict>\n" +
      `\t\t<key>SCREENPIPE_SKIP_ONBOARDING</key>\n\t\t<string>1</string>\n` +
      `\t\t<key>SCREENPIPE_DISABLE_TELEMETRY</key>\n\t\t<string>1</string>\n` +
      "\t</dict>",
    expect: 1,
  });
  applyRule({
    label: "plist usage strings",
    file: `${TAURI_DIR}/Info.plist`,
    find: /\bscreenpipe\b/gi,
    replace: pn,
  });


  // ------------------------------------------------------------ app menu UI
  applyRule({
    label: "menu submenu title",
    file: `${TAURI_DIR}/src/main.rs`,
    find: 'SubmenuBuilder::new(app, "screenpipe")',
    replace: `SubmenuBuilder::new(app, "${pn}")`,
    expect: 1,
  });
  applyRule({
    label: "menu about",
    file: `${TAURI_DIR}/src/main.rs`,
    find: 'localization::ui_text("About screenpipe")',
    replace: `localization::ui_text("About ${pn}")`,
    expect: 1,
  });
  applyRule({
    label: "menu quit",
    file: `${TAURI_DIR}/src/main.rs`,
    find: 'localization::ui_text("Quit screenpipe")',
    replace: `localization::ui_text("Quit ${pn}")`,
    expect: 1,
  });
  applyRule({
    label: "log prefix",
    file: `${TAURI_DIR}/src/main.rs`,
    find: '.filename_prefix("screenpipe-app")',
    replace: `.filename_prefix("${slug}-app")`,
    expect: 1,
  });

  applyRule({
    label: "tray quit",
    file: `${TAURI_DIR}/src/tray.rs`,
    find: 'ui_text("Quit screenpipe")',
    replace: `ui_text("Quit ${pn}")`,
  });
  applyRule({
    label: "tray quit capitalised",
    file: `${TAURI_DIR}/src/tray.rs`,
    find: 'ui_text("Quit Screenpipe")',
    replace: `ui_text("Quit ${pn}")`,
  });
  applyRule({
    label: "tray open",
    file: `${TAURI_DIR}/src/tray.rs`,
    find: 'ui_text("Open screenpipe")',
    replace: `ui_text("Open ${pn}")`,
  });
  applyRule({
    label: "tray version",
    file: `${TAURI_DIR}/src/tray.rs`,
    find: 'format!("screenpipe v{}',
    replace: `format!("${pn} v{}`,
    expect: 3,
  });
  applyRule({
    label: "tray tooltip",
    file: `${TAURI_DIR}/src/tray.rs`,
    find: /ui_text\("screenpipe — /g,
    replace: `ui_text("${pn} — `,
  });
  applyRule({
    label: "tray tooltip idle",
    file: `${TAURI_DIR}/src/tray.rs`,
    find: '"screenpipe".to_string()',
    replace: `"${pn}".to_string()`,
    expect: 1,
  });
  applyRule({
    label: "window titles",
    file: `${TAURI_DIR}/src/window/show.rs`,
    find: '.title("screenpipe")',
    replace: `.title("${pn}")`,
  });
  // macOS Background Task Management names the login item after the
  // autostart plugin's app_name, which defaults to the Cargo package name
  // ("screenpipe-app") — not the bundle productName. Name it after the brand
  // so the "can run in the background" prompt and Login Items show Worklog.
  applyRule({
    label: "autostart login-item name",
    file: `${TAURI_DIR}/src/main.rs`,
    find: "let builder = tauri_plugin_autostart::Builder::new().args([AUTOSTART_ARG]);",
    replace:
      "let builder = tauri_plugin_autostart::Builder::new()\n" +
      `                .app_name("${pn}")\n` +
      "                .args([AUTOSTART_ARG]);",
    expect: 1,
  });

  // ------------------------------------------------------- identity coupling
  applyRule({
    label: "keychain service",
    file: "crates/screenpipe-secrets/src/keychain.rs",
    find: 'const SERVICE: &str = "com.screenpipe.app";',
    replace: `const SERVICE: &str = "${bid}";`,
    expect: 1,
  });
  applyRule({
    label: "launchd label",
    file: "crates/screenpipe-engine/src/cli/service.rs",
    find: 'const LAUNCHD_LABEL: &str = "com.screenpipe.agent";',
    replace: `const LAUNCHD_LABEL: &str = "${bid}.agent";`,
    expect: 1,
  });
  applyRule({
    label: "self-detection bundle ids",
    file: "crates/screenpipe-audio/src/meeting_processes.rs",
    find: 'bundle_id == "screenpi.pe"',
    replace:
      `bundle_id == "${bid}"\n` +
      `        || bundle_id.starts_with("${bid}.")\n` +
      `        || bundle_id == "screenpi.pe"`,
    expect: 1,
  });
  applyRule({
    label: "search self-filter",
    file: "crates/screenpipe-engine/src/routes/search.rs",
    find: 'const SCREENPIPE_APP_NEEDLE: &[u8] = b"screenpipe";',
    replace: `const SCREENPIPE_APP_NEEDLE: &[u8] = b"${slug}";`,
    expect: 1,
  });
  applyRule({
    label: "handoff app path",
    file: `${TAURI_DIR}/src/manual_handoff.rs`,
    find: "Applications/screenpipe.app",
    replace: `Applications/${pn}.app`,
  });
  applyRule({
    label: "cli path",
    file: `${APP_DIR}/lib/utils.ts`,
    find: "/Applications/screenpipe.app/Contents/MacOS/screenpipe",
    replace: `/Applications/${pn}.app/Contents/MacOS/screenpipe-app`,
    expect: 1,
  });

  // ---------------------------------------------------------------- offline
  applyRule({
    label: "telemetry kill switch",
    file: "crates/screenpipe-engine/src/analytics.rs",
    find:
      "pub fn telemetry_disabled_by_env() -> bool {\n" +
      '    ["SCREENPIPE_DISABLE_TELEMETRY", "GITHUB_ACTIONS", "CI"]\n' +
      "        .iter()\n" +
      "        .any(|var| {\n" +
      "            std::env::var(var)\n" +
      "                .map(|v| env_value_truthy(&v))\n" +
      "                .unwrap_or(false)\n" +
      "        })\n" +
      "}",
    replace:
      "pub fn telemetry_disabled_by_env() -> bool {\n" +
      "    // white-label: outbound telemetry is always off in this build.\n" +
      "    true\n" +
      "}",
    expect: 1,
  });
  applyRule({
    label: "posthog constants (engine)",
    file: "crates/screenpipe-engine/src/analytics.rs",
    find: 'const POSTHOG_API_KEY: &str = "phc_z7FZXE8vmXtdTQ78LMy3j1BQWW4zP6PGDUP46rgcdnb";',
    replace: 'const POSTHOG_API_KEY: &str = "";',
    expect: 1,
  });
  applyRule({
    label: "posthog host (engine)",
    file: "crates/screenpipe-engine/src/analytics.rs",
    find: 'const POSTHOG_HOST: &str = "https://us.i.posthog.com";',
    replace: `const POSTHOG_HOST: &str = "${webBase}";`,
    expect: 1,
  });
  applyRule({
    label: "posthog resource monitor key",
    file: "crates/screenpipe-engine/src/resource_monitor.rs",
    find: '"api_key": "phc_z7FZXE8vmXtdTQ78LMy3j1BQWW4zP6PGDUP46rgcdnb",',
    replace: '"api_key": "",',
    expect: 1,
  });
  applyRule({
    label: "posthog resource monitor host",
    file: "crates/screenpipe-engine/src/resource_monitor.rs",
    find: 'https://us.i.posthog.com',
    replace: webBase,
    expect: 1,
  });
  applyRule({
    label: "posthog key (rust)",
    file: `${TAURI_DIR}/src/main.rs`,
    find: '"phc_z7FZXE8vmXtdTQ78LMy3j1BQWW4zP6PGDUP46rgcdnb"',
    replace: '""',
    expect: 1,
  });
  applyRule({
    label: "posthog init (webview)",
    file: `${APP_DIR}/app/providers.tsx`,
    find: '"phc_z7FZXE8vmXtdTQ78LMy3j1BQWW4zP6PGDUP46rgcdnb"',
    replace: '""',
    expect: 1,
  });
  applyRule({
    label: "posthog host (webview)",
    file: `${APP_DIR}/app/providers.tsx`,
    find: 'api_host: "https://us.i.posthog.com"',
    replace: `api_host: "${webBase}"`,
    expect: 1,
  });
  applyRule({
    label: "posthog offline guard",
    file: `${APP_DIR}/app/providers.tsx`,
    find: "if (isDebug || isE2E || isBrowserDev) return;",
    replace:
      'if (\n        isDebug ||\n        isE2E ||\n        isBrowserDev ||\n        process.env.NEXT_PUBLIC_SCREENPIPE_OFFLINE === "true"\n      )\n        return;',
    expect: 1,
  });
  applyRule({
    label: "pi bootstrap gate",
    file: `${TAURI_DIR}/src/main.rs`,
    find: "            crate::pi::ensure_pi_installed_background();",
    replace:
      "            // white-label: offline build skips the npm bootstrap.\n" +
      '            if std::env::var("SCREENPIPE_WL_ENABLE_PI").ok().as_deref() == Some("1") {\n' +
      "                crate::pi::ensure_pi_installed_background();\n" +
      "            }",
    expect: 1,
  });
  applyRule({
    label: "pi cloud provider gate",
    file: `${TAURI_DIR}/src/pi.rs`,
    find:
      '    let api_key_value = user_token.unwrap_or("$SCREENPIPE_API_KEY");\n' +
      "    let models = screenpipe_cloud_models(api_url, user_token).await;",
    replace:
      "    let api_key_value = user_token.unwrap_or(\"$SCREENPIPE_API_KEY\");\n" +
      "    // white-label: the hosted provider is opt-in, not always present.\n" +
      '    let wl_cloud = std::env::var("SCREENPIPE_WL_KEEP_CLOUD_PROVIDER").ok().as_deref() == Some("1");\n' +
      "    let models = if wl_cloud {\n" +
      "        screenpipe_cloud_models(api_url, user_token).await\n" +
      "    } else {\n" +
      "        serde_json::json!([])\n" +
      "    };",
    expect: 1,
  });
  applyRule({
    label: "pi cloud provider insert",
    file: `${TAURI_DIR}/src/pi.rs`,
    find: '    providers_map.insert("screenpipe".to_string(), screenpipe_provider);',
    replace:
      "    if wl_cloud {\n" +
      '        providers_map.insert("screenpipe".to_string(), screenpipe_provider);\n' +
      "    } else {\n" +
      "        let _ = screenpipe_provider;\n" +
      "    }",
    expect: 1,
  });
  applyRule({
    label: "local ai default (provider)",
    file: `${TAURI_DIR}/src/store.rs`,
    find: "provider: AIProviderType::ScreenpipeCloud,",
    replace: "provider: AIProviderType::NativeOllama,",
  });
  applyRule({
    label: "local ai default (url)",
    file: `${TAURI_DIR}/src/store.rs`,
    find: 'url: "https://api.screenpipe.com/v1".to_string(),',
    replace: `url: "${aiBase}".to_string(),`,
    expect: 2,
  });
  applyRule({
    label: "local ai default (workflow video)",
    file: `${TAURI_DIR}/src/workflow_video.rs`,
    find: '"https://api.screenpipe.com/v1"',
    replace: `"${aiBase}"`,
  });

  rewriteHosts(brand);

  // ---------------------------------------------------------------- summary
  const applied = results.filter((r) => r.state === "applied").length;
  const already = results.filter((r) => r.state === "already").length;
  const checked = results.filter((r) => r.state === "checked").length;
  const zeros = results.filter((r) => r.state === "applied" && r.count === 0);

  console.log(`white-label: ${pn} (${bid}) scheme=${scheme} webBase=${webBase}`);
  console.log(`white-label: ${applied} applied, ${checked} checked, ${already} already applied`);
  if (zeros.length) console.log(`white-label: no-op rules: ${zeros.map((z) => z.label).join(", ")}`);

  if (!CHECK_ONLY) {
    writeFileSync(
      MARKER,
      JSON.stringify({ brand, appliedAt: new Date().toISOString(), rules: results }, null, 2),
    );
    // Keep the marker out of `git status` in local checkouts.
    const exclude = join(REPO_ROOT, ".git", "info", "exclude");
    if (existsSync(join(REPO_ROOT, ".git")) ) {
      mkdirSync(join(REPO_ROOT, ".git", "info"), { recursive: true });
      const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
      if (!current.includes(".white-label-applied.json")) {
        appendFileSync(exclude, "\n.white-label-applied.json\n");
      }
    }
  }
}

main();
