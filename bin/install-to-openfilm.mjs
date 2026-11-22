#!/usr/bin/env node
// @ts-check
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let targetSkillsDir = process.env.OPENFILM_SKILLS || 'D:\\openfilm-data\\library\\Skills';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--skills-dir' && args[i + 1]) targetSkillsDir = resolve(args[++i]);
}

const destDir = join(targetSkillsDir, 'jianying-layered-export');
await mkdir(targetSkillsDir, { recursive: true });
if (existsSync(destDir)) {
  await rm(destDir, { recursive: true, force: true });
}
await cp(PLUGIN_SRC, destDir, {
  recursive: true,
  filter: (src) => !src.includes(`${join(PLUGIN_SRC, 'test')}`) && !src.endsWith('.tmp'),
});

console.log(`Installed OpenFilm plugin to: ${destDir}`);
console.log('Open OpenFilm Studio -> Community -> Added (or restart OpenFilm) to enable "剪映分层导出".');
