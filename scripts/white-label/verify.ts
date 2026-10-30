//
// Post-build gate for the white-label app. Fails the build when a branded
// artifact still carries screenpipe's service hosts, analytics keys, or the
// wrong bundle identity.
//
//   bun scripts/white-label/verify.ts [--app <path-to-.app>] [--allow-unsigned]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_DIR, REPO_ROOT, TAURI_DIR, loadBrand } from "./config.ts";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function runAllowFail(cmd: string, args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: run(cmd, args) };
  } catch (error: any) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** Binary + bundled JS must not reference screenpipe's own services. */
const FORBIDDEN = [
  "https://screenpipe.com",
  "https://api.screenpipe.com",
  "https://screenpi.pe",
  "https://us.i.posthog.com",
  "phc_z7FZXE8vmXtdTQ78LMy3j1BQWW4zP6PGDUP46rgcdnb",
  "Mediar, Inc.",
];

function findApp(brand: { productName: string }): string {
  const flagged = process.argv.indexOf("--app");
  if (flagged > -1 && process.argv[flagged + 1]) {
    return resolve(process.argv[flagged + 1]);
  }
  const targetRoot = join(REPO_ROOT, TAURI_DIR, "target");
  const preferred = join(targetRoot, "aarch64-apple-darwin", "release", "bundle", "macos", `${brand.productName}.app`);
  if (existsSync(preferred)) return preferred;

  // Fall back to any built bundle so local x64 builds verify too.
  if (existsSync(targetRoot)) {
    for (const target of readdirSync(targetRoot)) {
      const candidate = join(targetRoot, target, "release", "bundle", "macos");
      if (!existsSync(candidate)) continue;
      const apps = readdirSync(candidate).filter((entry) => entry.endsWith(".app"));
      if (apps.length === 1) return join(candidate, apps[0]);
    }
  }
  return preferred;
}

function scanText(label: string, text: string): void {
  const hits = FORBIDDEN.filter((token) => text.includes(token));
  record(`${label}: no screenpipe service hosts or keys`, hits.length === 0, hits.join(", "));
}

function main(): void {
  const brand = loadBrand();
  const appPath = findApp(brand);

  if (!existsSync(appPath)) {
    record("app bundle exists", false, appPath);
    console.error("\nwhite-label: build the app first (bunx tauri build) or pass --app <path>");
    process.exit(1);
  }
  record("app bundle exists", true, appPath);

  const expected = `${brand.productName}.app`;
  record("bundle name matches brand", appPath.endsWith(`/${expected}`), appPath.split("/").pop() ?? "");
  record("no legacy screenpipe bundle next to it", !existsSync(join(appPath, "..", "screenpipe.app")));

  const infoPlist = join(appPath, "Contents", "Info.plist");
  record("Info.plist present", existsSync(infoPlist), infoPlist);

  if (existsSync(infoPlist)) {
    const identifier = runAllowFail("plutil", ["-extract", "CFBundleIdentifier", "raw", infoPlist]);
    record(
      "CFBundleIdentifier matches branding/brand.json",
      identifier.code === 0 && identifier.out.trim() === brand.bundleId,
      `got ${identifier.out.trim() || "<none>"}, want ${brand.bundleId}`,
    );

    const env = runAllowFail("plutil", ["-extract", "LSEnvironment", "json", "-o", "-", infoPlist]);
    let offlineEnv = false;
    try {
      const parsed = JSON.parse(env.out);
      offlineEnv = parsed.SCREENPIPE_SKIP_ONBOARDING === "1" && parsed.SCREENPIPE_DISABLE_TELEMETRY === "1";
    } catch {
      offlineEnv = false;
    }
    record("offline env baked into Info.plist", offlineEnv, offlineEnv ? "" : env.out.slice(0, 120));

    const plistText = readFileSync(infoPlist, "utf8");
    record(
      "permission strings use the brand name",
      !/\bscreenpipe\b/i.test(plistText),
      (plistText.match(/\bscreenpipe\b/gi) ?? []).join(",") || "",
    );
  }

  const macosDir = join(appPath, "Contents", "MacOS");
  const binaries = existsSync(macosDir)
    ? readdirSync(macosDir).filter((entry) => statSync(join(macosDir, entry)).isFile())
    : [];
  record("main executable present", binaries.length > 0, binaries.join(", "));

  for (const binary of binaries) {
    const out = runAllowFail("strings", ["-a", join(macosDir, binary)]);
    scanText(`binary ${binary}`, out.out);
    const legacy = (out.out.match(/\bscreenpipe\b/gi) ?? []).length;
    if (legacy > 0) console.log(`info  binary ${binary}: ${legacy} legacy "screenpipe" token(s) remain (copy, not identity)`);
  }

  // Frontend assets ship inside Resources (Next static export).
  const resources = join(appPath, "Contents", "Resources");
  if (existsSync(resources)) {
    let scanned = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        const info = statSync(abs);
        if (info.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!/\.(js|mjs|html|json)$/.test(entry) || info.size > 12 * 1024 * 1024) continue;
        scanned += 1;
        const text = readFileSync(abs, "utf8");
        const hits = FORBIDDEN.filter((token) => text.includes(token));
        if (hits.length > 0) {
          record(`asset ${abs.slice(resources.length + 1)}: clean`, false, hits.join(", "));
        }
      }
    };
    walk(resources);
    record(`resources scanned: ${scanned} file(s)`, true);
  }

  const verify = runAllowFail("codesign", ["--verify", "--deep", "--strict", appPath]);
  if (verify.code === 0) {
    record("code signature verifies", true);
  } else if (process.argv.includes("--allow-unsigned")) {
    record("code signature verifies", true, "skipped (--allow-unsigned)");
  } else {
    record("code signature verifies", false, verify.out.trim().split("\n").slice(0, 2).join(" "));
  }

  const identity = process.env.WL_CODESIGN_IDENTITY;
  if (identity) {
    const dv = runAllowFail("codesign", ["-dv", "--verbose=2", appPath]);
    record("signed with the expected identity", dv.out.includes(identity), identity);
  }

  const appLabel = `${brand.productName} v${readVersion()}`;
  console.log(`\nwhite-label: verified ${appLabel} at ${appPath}`);
  console.log(`stream lint: ${FORBIDDEN.length} forbidden tokens, ${checks.length} checks`);

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error(`\nwhite-label: ${failed.length} check(s) failed — refusing to ship this build.`);
    process.exit(1);
  }
}

function readVersion(): string {
  const toml = readFileSync(join(REPO_ROOT, TAURI_DIR, "Cargo.toml"), "utf8");
  const match = toml.match(/^version\s*=\s*"([^"]+)"/m);
  return match?.[1] ?? "unknown";
}

main();
