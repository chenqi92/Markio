#!/usr/bin/env node
// Bump version across package.json, src-tauri/tauri.conf.json,
// src-tauri/Cargo.toml and src-tauri/Cargo.lock (markio entry only).
//
// Usage:
//   node scripts/bump-version.mjs patch
//   node scripts/bump-version.mjs minor
//   node scripts/bump-version.mjs major
//   node scripts/bump-version.mjs 1.2.3
//
// Exits non-zero if the new version equals the current one or any target
// file is missing.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = resolve(ROOT, "package.json");
const TAURI_CONF = resolve(ROOT, "src-tauri/tauri.conf.json");
const CARGO_TOML = resolve(ROOT, "src-tauri/Cargo.toml");
const CARGO_LOCK = resolve(ROOT, "src-tauri/Cargo.lock");

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(v) {
  const m = SEMVER_RE.exec(v);
  if (!m) throw new Error(`Not a valid semver: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function bump(current, kind) {
  if (SEMVER_RE.test(kind)) return kind;
  const [maj, min, pat] = parse(current);
  switch (kind) {
    case "patch": return `${maj}.${min}.${pat + 1}`;
    case "minor": return `${maj}.${min + 1}.0`;
    case "major": return `${maj + 1}.0.0`;
    default:
      throw new Error(`Unknown bump kind: ${kind} (use patch|minor|major|x.y.z)`);
  }
}

function readJSON(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJSON(p, obj) {
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function replaceCargoTomlVersion(text, next) {
  // Replace only the [package] section's first version line.
  const lines = text.split(/\r?\n/);
  let inPackage = false;
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\[package\]\s*$/.test(line)) { inPackage = true; continue; }
    if (/^\s*\[/.test(line)) inPackage = false;
    if (inPackage && /^\s*version\s*=/.test(line)) {
      lines[i] = `version = "${next}"`;
      replaced = true;
      break;
    }
  }
  if (!replaced) throw new Error("Could not find [package] version in Cargo.toml");
  return lines.join("\n");
}

function replaceCargoLockMarkioVersion(text, next) {
  // Find `name = "markio"` block and rewrite its `version = "..."` line.
  const re = /(name = "markio"\r?\nversion = ")([^"]+)(")/;
  if (!re.test(text)) throw new Error("Could not find markio entry in Cargo.lock");
  return text.replace(re, `$1${next}$3`);
}

function main() {
  const kind = process.argv[2];
  if (!kind) {
    console.error("Usage: bump-version.mjs <patch|minor|major|x.y.z>");
    process.exit(2);
  }

  const pkg = readJSON(PKG);
  const current = pkg.version;
  const next = bump(current, kind);
  if (next === current) {
    console.error(`Version is already ${current}, nothing to do.`);
    process.exit(1);
  }

  pkg.version = next;
  writeJSON(PKG, pkg);

  const tauriConf = readJSON(TAURI_CONF);
  tauriConf.version = next;
  writeJSON(TAURI_CONF, tauriConf);

  const cargoToml = readFileSync(CARGO_TOML, "utf8");
  writeFileSync(CARGO_TOML, replaceCargoTomlVersion(cargoToml, next), "utf8");

  const cargoLock = readFileSync(CARGO_LOCK, "utf8");
  writeFileSync(CARGO_LOCK, replaceCargoLockMarkioVersion(cargoLock, next), "utf8");

  console.log(`${current} -> ${next}`);
  console.log("Updated:");
  console.log("  package.json");
  console.log("  src-tauri/tauri.conf.json");
  console.log("  src-tauri/Cargo.toml");
  console.log("  src-tauri/Cargo.lock");
}

main();
