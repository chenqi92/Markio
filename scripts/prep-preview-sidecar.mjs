// 构建 markio-preview 二进制并按 Tauri externalBin 约定命名拷到 src-tauri/binaries/。
// Tauri 打包时会查找 binaries/markio-preview-<target-triple>[.exe] 并放进产物
// （macOS → Markio.app/Contents/MacOS/；Windows → 安装目录旁）。
//
//   node scripts/prep-preview-sidecar.mjs [target-triple]
//
// 不传 target 用 host triple（本地 `tauri build` 用）；CI 交叉编译传 matrix target。
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcTauri = resolve(root, 'src-tauri');
const manifest = resolve(srcTauri, 'Cargo.toml');

const target = process.argv[2] || '';
const hostMatch = execSync('rustc -vV').toString().match(/^host:\s*(.+)$/m);
if (!hostMatch) throw new Error('无法从 `rustc -vV` 解析 host triple（rustc 是否在 PATH？）');
const triple = target || hostMatch[1].trim();
const ext = triple.includes('windows') ? '.exe' : '';

const args = ['build', '--release', '-p', 'markio-preview', '--manifest-path', manifest];
if (target) args.push('--target', target);
console.log(`[sidecar] cargo ${args.join(' ')}`);
execSync(`cargo ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`, {
  stdio: 'inherit',
});

const builtDir = target ? `target/${target}/release` : 'target/release';
const src = resolve(srcTauri, builtDir, `markio-preview${ext}`);
if (!existsSync(src)) throw new Error(`找不到构建产物：${src}`);

const outDir = resolve(srcTauri, 'binaries');
mkdirSync(outDir, { recursive: true });
const dst = resolve(outDir, `markio-preview-${triple}${ext}`);
copyFileSync(src, dst);
console.log(`[sidecar] -> ${dst}`);
