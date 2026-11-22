// @ts-check
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, '..');
const REPO_FALLBACK = resolve(PLUGIN_DIR, '..', '..', 'packages', 'openfilm');

/**
 * Resolve OpenFilm package location from PATH (`openfilm` or `openfilm.cmd`).
 * @returns {string | null}
 */
function resolveFromPath() {
  const pathEnv = process.env.PATH ?? '';
  const names = process.platform === 'win32' ? ['openfilm.cmd', 'openfilm.exe', 'openfilm'] : ['openfilm'];
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      if (name.endsWith('.cmd')) {
        try {
          const text = readFileSync(candidate, 'utf8');
          const match = /"([^"]*openfilm\.mjs)"/i.exec(text);
          if (match) {
            const pkg = resolve(dirname(match[1]), '..');
            if (existsSync(join(pkg, 'package.json'))) return pkg;
          }
        } catch { /* ignore unreadable cmd */ }
      }
      try {
        const real = realpathSync(candidate);
        const up = resolve(dirname(real), '..');
        if (existsSync(join(up, 'studio', 'server', 'exports.mjs'))) return up;
      } catch { /* ignore */ }
    }
  }
  return null;
}

/**
 * Locate the installed OpenFilm 0.4.0 package and its bundled Electron/ffmpeg/Playwright resources.
 */
export function resolveOpenFilmRuntime() {
  const installedPkg = process.platform === 'win32'
    ? join(process.env.OPENFILM_APP_DIR || 'D:\\openfilm', 'resources', 'app.asar.unpacked', 'node_modules', 'openfilm')
    : null;

  const candidates = [
    process.env.OPENFILM_PACKAGE ? resolve(process.env.OPENFILM_PACKAGE) : null,
    installedPkg,
    resolveFromPath(),
    REPO_FALLBACK,
  ].filter(Boolean);

  let packageDir = REPO_FALLBACK;
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'studio', 'server', 'jianying.mjs'))) {
      packageDir = dir;
      break;
    }
  }

  let resourcesDir = null;
  const marker = `${join('app.asar.unpacked', 'node_modules', 'openfilm')}`;
  const idx = packageDir.toLowerCase().indexOf(marker.toLowerCase());
  if (idx >= 0) {
    resourcesDir = packageDir.slice(0, idx).replace(/[\\/]+$/, '');
  } else if (process.platform === 'win32' && existsSync('D:\\openfilm\\resources\\app.asar')) {
    resourcesDir = 'D:\\openfilm\\resources';
  }

  const appDir = resourcesDir ? dirname(resourcesDir) : null;
  const electronExe = appDir && existsSync(join(appDir, 'OpenFilm.exe')) ? join(appDir, 'OpenFilm.exe') : null;
  const asarNodeModules = resourcesDir && existsSync(join(resourcesDir, 'app.asar'))
    ? join(resourcesDir, 'app.asar', 'node_modules')
    : null;
  const runtimeDir = resourcesDir ? join(resourcesDir, 'runtime') : null;
  const ffmpegDir = runtimeDir && existsSync(join(runtimeDir, 'ffmpeg')) ? join(runtimeDir, 'ffmpeg') : null;
  const playwrightDir = runtimeDir && existsSync(join(runtimeDir, 'ms-playwright')) ? join(runtimeDir, 'ms-playwright') : null;

  return {
    packageDir,
    resourcesDir,
    appDir,
    electronExe,
    asarNodeModules,
    ffmpegDir,
    playwrightDir,
  };
}

/**
 * Apply environment variables (`PLAYWRIGHT_BROWSERS_PATH`, `PATH`, `NODE_PATH`) needed by OpenFilm 0.4.0 modules.
 * @param {ReturnType<resolveOpenFilmRuntime>} [runtime]
 */
export function configureOpenFilmEnv(runtime = resolveOpenFilmRuntime()) {
  if (runtime.playwrightDir && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = runtime.playwrightDir;
  }
  if (runtime.ffmpegDir) {
    const parts = (process.env.PATH ?? '').split(delimiter);
    if (!parts.some((p) => p.toLowerCase() === runtime.ffmpegDir.toLowerCase())) {
      process.env.PATH = `${runtime.ffmpegDir}${delimiter}${process.env.PATH ?? ''}`;
    }
  }
  if (runtime.asarNodeModules) {
    const parts = (process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean);
    if (!parts.some((p) => p.toLowerCase() === runtime.asarNodeModules.toLowerCase())) {
      process.env.NODE_PATH = [runtime.asarNodeModules, ...parts].join(delimiter);
      if (process.versions.electron) {
        const Module = require('node:module');
        Module._initPaths();
      }
    }
  }
  return runtime;
}

/**
 * Re-execute the given script under OpenFilm's Electron binary (`ELECTRON_RUN_AS_NODE=1`) when running from
 * standard Node against an `app.asar`-packaged OpenFilm 0.4.0 installation. Returns `true` if re-exec handled
 * execution (caller should return immediately), or `false` if already running in the proper runtime.
 * @param {string} scriptPath
 * @param {string[]} [args]
 * @returns {Promise<boolean>}
 */
export async function ensureElectronRuntime(scriptPath, args = process.argv.slice(2)) {
  const runtime = configureOpenFilmEnv();
  if (process.versions.electron || !runtime.electronExe || !runtime.asarNodeModules) {
    return false;
  }
  const code = await new Promise((resolveCode, reject) => {
    const child = spawn(runtime.electronExe, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('exit', (status, signal) => resolveCode(status ?? (signal ? 1 : 0)));
  });
  process.exitCode = code;
  return true;
}

/**
 * Dynamically import the required OpenFilm 0.4.0 modules.
 * @param {{ packageDir?: string }} [opts]
 */
export async function loadOpenFilmModules(opts = {}) {
  const runtime = configureOpenFilmEnv();
  const base = opts.packageDir ? resolve(opts.packageDir) : runtime.packageDir;
  const mod = (/** @type {string} */ rel) => import(pathToFileURL(join(base, rel)).href);

  const [exportsMod, jianyingMod, fontsMod, projectFontsMod, nleMod, sharedMod, filmDocMod] = await Promise.all([
    mod('studio/server/exports.mjs'),
    mod('studio/server/jianying.mjs'),
    mod('studio/server/fonts.mjs'),
    mod('studio/server/project-fonts.mjs'),
    mod('studio/server/nle.mjs'),
    mod('src/shared.mjs'),
    mod('src/film-doc.mjs'),
  ]);

  return {
    runtime,
    createExports: exportsMod.createExports,
    draftsRoot: jianyingMod.draftsRoot,
    JIANYING_DRAFT_PATH: jianyingMod.JIANYING_DRAFT_PATH,
    installedFontFile: fontsMod.installedFontFile,
    projectFonts: projectFontsMod.projectFonts,
    allocateLanes: nleMod.allocateLanes,
    open: sharedMod.open,
    readFilmFile: filmDocMod.readFilmFile,
    kindOf: filmDocMod.kindOf,
    filmHtml: filmDocMod.filmHtml,
  };
}
