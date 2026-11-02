import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Brand = {
  productName: string;
  bundleId: string;
  publisher: string;
  scheme: string;
  trayId: string;
  offline: {
    webBase: string;
    aiBaseUrl: string;
    skipOnboarding: boolean;
    disableTelemetry: boolean;
    disableRemoteAnnouncements: boolean;
    disablePiBootstrap: boolean;
  };
  signing: {
    identityEnv: string;
    commonName: string;
  };
};

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Repository root. Defaults to the checkout this script lives in, but CI runs
 * the script from a side checkout (`.wl/`) against the upstream worktree, so
 * WL_REPO_ROOT points it at the directory to patch.
 */
export const REPO_ROOT = process.env.WL_REPO_ROOT?.trim() || resolve(HERE, "..", "..");

export function loadBrand(root: string = REPO_ROOT): Brand {
  // Prefer the branding shipped next to the scripts (the tooling repo), fall
  // back to one staged into the patched worktree. CI copies both.
  const candidates = [resolve(HERE, "..", "..", "branding", "brand.json"), join(root, "branding", "brand.json")];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error(`branding: brand.json not found (looked in ${candidates.join(", ")})`);
  }
  const brand = JSON.parse(readFileSync(path, "utf8")) as Brand;

  // Env overrides let CI drive identity without editing the checked-in file.
  brand.productName = process.env.WL_PRODUCT_NAME?.trim() || brand.productName;
  brand.bundleId = process.env.WL_BUNDLE_ID?.trim() || brand.bundleId;
  brand.publisher = process.env.WL_PUBLISHER?.trim() || brand.publisher;
  brand.scheme = process.env.WL_SCHEME?.trim() || brand.scheme;
  brand.offline.webBase =
    process.env.WL_WEB_BASE?.trim().replace(/\/+$/, "") || brand.offline.webBase;
  brand.offline.aiBaseUrl =
    process.env.WL_AI_BASE_URL?.trim().replace(/\/+$/, "") || brand.offline.aiBaseUrl;

  assert(brand.productName, "productName");
  assert(brand.bundleId, "bundleId");
  assert(brand.publisher, "publisher");
  assert(brand.scheme, "scheme");
  assert(brand.trayId, "trayId");
  return brand;
}

function assert(value: string | undefined, field: string): void {
  if (!value || !value.trim()) {
    throw new Error(`branding: ${field} is empty; fix branding/brand.json or set WL_* env`);
  }
}

/** Lowercase, dash-separated name used for file and log prefixes. */
export function slugOf(brand: Brand): string {
  return brand.productName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const APP_DIR = "apps/screenpipe-app-tauri";
export const TAURI_DIR = `${APP_DIR}/src-tauri`;
