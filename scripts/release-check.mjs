#!/usr/bin/env node
// Static release preflight checks. This does not sign, notarize, or upload;
// it fails fast when release metadata or required release assets are missing.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const checks = [];

function readText(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function pass(name, detail = "") {
  checks.push({ ok: true, name, detail });
}

function fail(name, detail = "") {
  checks.push({ ok: false, name, detail });
}

function check(name, condition, detail = "") {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function fileExists(path) {
  return existsSync(resolve(ROOT, path));
}

function cargoPackageVersion(text) {
  const lines = text.split(/\r?\n/);
  let inPackage = false;
  for (const line of lines) {
    if (/^\s*\[package\]\s*$/.test(line)) {
      inPackage = true;
      continue;
    }
    if (/^\s*\[/.test(line)) inPackage = false;
    if (inPackage) {
      const match = line.match(/^\s*version\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    }
  }
  return null;
}

function cargoLockMarkioVersion(text) {
  const match = text.match(/name = "markio"\r?\nversion = "([^"]+)"/);
  return match?.[1] ?? null;
}

const packageJson = readJson("package.json");
const tauriConf = readJson("src-tauri/tauri.conf.json");
const cargoToml = readText("src-tauri/Cargo.toml");
const cargoLock = readText("src-tauri/Cargo.lock");
const releaseWorkflow = readText(".github/workflows/release.yml");
const ciWorkflow = readText(".github/workflows/ci.yml");

const version = packageJson.version;
const semver = /^\d+\.\d+\.\d+$/;
check("package version is semver", semver.test(version), version);
check("tauri.conf version matches package.json", tauriConf.version === version, tauriConf.version);
check(
  "Cargo.toml version matches package.json",
  cargoPackageVersion(cargoToml) === version,
  cargoPackageVersion(cargoToml) ?? "missing",
);
check(
  "Cargo.lock markio version matches package.json",
  cargoLockMarkioVersion(cargoLock) === version,
  cargoLockMarkioVersion(cargoLock) ?? "missing",
);

check("tauri bundle is active", tauriConf.bundle?.active === true);
check("updater artifacts are enabled", tauriConf.bundle?.createUpdaterArtifacts === true);
check("updater plugin is active", tauriConf.plugins?.updater?.active === true);
check("updater public key is configured", Boolean(tauriConf.plugins?.updater?.pubkey));
check(
  "updater endpoint points at latest.json",
  Array.isArray(tauriConf.plugins?.updater?.endpoints) &&
    tauriConf.plugins.updater.endpoints.some((endpoint) => /latest\.json$/.test(endpoint)),
);

check("release workflow exists", fileExists(".github/workflows/release.yml"));
check("release workflow uses tauri-action", releaseWorkflow.includes("tauri-apps/tauri-action"));
check(
  "release workflow has updater signing secret",
  releaseWorkflow.includes("TAURI_SIGNING_PRIVATE_KEY"),
);
check("release workflow publishes version tags", releaseWorkflow.includes("tagName: v"));

check("ci runs lint", ciWorkflow.includes("pnpm lint"));
check("ci runs vitest", ciWorkflow.includes("pnpm test"));
check("ci runs playwright", ciWorkflow.includes("pnpm e2e"));
check("ci runs rust clippy", ciWorkflow.includes("cargo clippy"));

for (const path of [
  "docs/PACKAGING.md",
  "scripts/build-mas.sh",
  "scripts/notarize.sh",
  "src-tauri/PrivacyInfo.xcprivacy",
  "src-tauri/entitlements/macos.entitlements",
  "src-tauri/entitlements/macos.dev.entitlements",
  "src-tauri/entitlements/macos.inherit.entitlements",
]) {
  check(`required release file exists: ${path}`, fileExists(path));
}

const failed = checks.filter((item) => !item.ok);
for (const item of checks) {
  const mark = item.ok ? "OK " : "ERR";
  console.log(`${mark} ${item.name}${item.detail ? ` (${item.detail})` : ""}`);
}

console.log("");
console.log("Manual release checklist:");
console.log("  1. Start from a clean worktree on main after CI passes.");
console.log("  2. Run pnpm release:preflight locally before bumping or tagging.");
console.log("  3. Confirm TAURI_SIGNING_PRIVATE_KEY is configured for updater artifacts.");
console.log("  4. For macOS direct releases, run notarization and verify stapling.");
console.log("  5. Confirm latest.json and installers are attached to the GitHub release.");
console.log("  6. Keep the previous release assets available as the rollback package.");

if (failed.length > 0) {
  console.error(`\n${failed.length} release check(s) failed.`);
  process.exit(1);
}
