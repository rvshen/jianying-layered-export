#!/usr/bin/env node
// @ts-check
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureElectronRuntime } from '../lib/openfilm-runtime.mjs';

const SELF = fileURLToPath(import.meta.url);
if (await ensureElectronRuntime(SELF, process.argv.slice(2))) {
  process.exit(process.exitCode ?? 0);
}

const { exportLayeredJianying } = await import('../lib/export-layered.mjs');

function usage() {
  console.log(`Usage:
  node bin/export.mjs --project <dir> [--drafts-dir <dir>] [--name <draftName>] [--fps 30] [--overwrite] [--json]`);
}

const args = process.argv.slice(2);
/** @type {string | undefined} */
let projectDir = process.env.OPENFILM_PROJECT || undefined;
/** @type {string | undefined} */
let draftsDir;
/** @type {string | undefined} */
let name;
let fps = 30;
let overwrite = false;
let jsonOut = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') {
    usage();
    process.exit(0);
  } else if ((a === '--project' || a === '-p') && args[i + 1]) {
    projectDir = args[++i];
  } else if ((a === '--drafts-dir' || a === '-d') && args[i + 1]) {
    draftsDir = args[++i];
  } else if ((a === '--name' || a === '-n') && args[i + 1]) {
    name = args[++i];
  } else if (a === '--fps' && args[i + 1]) {
    fps = Number(args[++i]) || 30;
  } else if (a === '--overwrite') {
    overwrite = true;
  } else if (a === '--json') {
    jsonOut = true;
  } else if (!a.startsWith('-') && !projectDir) {
    projectDir = a;
  }
}

if (!projectDir) {
  if (existsSync(resolve('film.html'))) projectDir = process.cwd();
  else {
    usage();
    process.exit(2);
  }
}

const resolvedProject = resolve(projectDir);
if (!existsSync(resolvedProject)) {
  console.error(`Project directory not found: ${resolvedProject}`);
  process.exit(2);
}

const result = await exportLayeredJianying({
  projectDir: resolvedProject,
  draftsDir,
  name: name || `${basename(resolvedProject)}-分层版`,
  fps,
  overwrite,
  onProgress: (info) => {
    if (!jsonOut) {
      const pct = Math.round((info.progress || 0) * 100);
      console.log(`[${pct}%] ${info.message || info.phase}`);
    }
  },
});

if (jsonOut) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('\n导出完成:');
  console.log(`  草稿路径: ${result.draftDir}`);
  console.log(`  图形 PNG 数: ${result.graphicsCount}`);
  console.log(`  可编辑文字数: ${result.editableTextCount}`);
  console.log(`  独立字幕数: ${result.subtitleCount}`);
  console.log('  轨道列表:');
  for (const t of result.tracks) {
    console.log(`    - [${t.type}${t.flag ? ` flag=${t.flag}` : ''}] ${t.name} (${t.segments} segs)`);
  }
  console.log('\n提示: 如果剪映当前正在运行，请先完全退出并重启剪映 Pro，即可在首页看到新草稿。');
}
