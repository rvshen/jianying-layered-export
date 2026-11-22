// @ts-check
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

/**
 * @typedef {{
 *   id: string,
 *   clipId: string,
 *   name: string,
 *   fileName: string,
 *   path: string,
 *   startMs: number,
 *   durMs: number,
 *   w: number,
 *   h: number,
 *   x: number,
 *   y: number,
 *   rotation: number,
 *   opacity: number,
 *   visible: boolean,
 *   track: number,
 * }} ExtractedGraphic
 *
 * @typedef {{
 *   text: string,
 *   color: string,
 *   bold: boolean,
 *   italic: boolean,
 *   underline: boolean,
 *   fontSize: number,
 *   fontFamily: string,
 * }} TextRun
 *
 * @typedef {{
 *   id: string,
 *   clipId: string,
 *   name: string,
 *   text: string,
 *   runs: TextRun[],
 *   startMs: number,
 *   durMs: number,
 *   x: number,
 *   y: number,
 *   w: number,
 *   h: number,
 *   fontSize: number,
 *   fontFamily: string,
 *   color: string,
 *   bold: boolean,
 *   italic: boolean,
 *   underline: boolean,
 *   align: 'left' | 'center' | 'right',
 *   letterSpacing: number,
 *   lineSpacing: number,
 *   wrapped: boolean,
 *   rotation: number,
 *   opacity: number,
 *   visible: boolean,
 *   track: number,
 * }} ExtractedText
 *
 * @typedef {{
 *   clipId: string,
 *   src: string,
 *   status: 'decomposed' | 'static-graphic' | 'pure-graphic',
 *   textCount: number,
 *   hasGraphic: boolean,
 *   graphicFile?: string,
 * }} PageLayerReport
 */

const safeStem = (/** @type {string} */ s) =>
  String(s || 'clip').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'clip';

/**
 * Allocate a unique `.png` filename in `dir` avoiding collisions with `reserved` (case-insensitive).
 * @param {string} dir @param {string} stem @param {Set<string>} reserved
 */
function freePngName(dir, stem, reserved) {
  let name = `${stem}.png`;
  for (let n = 2; reserved.has(name.toLowerCase()) || existsSync(join(dir, name)); n++) {
    name = `${stem}-${n}.png`;
  }
  reserved.add(name.toLowerCase());
  return name;
}

/**
 * Copy a project into an isolated temporary workspace directory so OpenFilm's `open()` and
 * `createExports()` never write `.film/cache` or temp files into the user's real project folder.
 * Unreferenced root-level media renders (e.g. final `.mp4` exports) are skipped for speed.
 * @param {string} projectDir
 * @param {import('./openfilm-runtime.mjs')} modules
 * @returns {Promise<{ workDir: string, doc: any, markup: string, cleanup: () => Promise<void> }>}
 */
export async function createIsolatedWorkspace(projectDir, modules) {
  const rawHtml = await readFile(join(projectDir, 'film.html'), 'utf8');
  const parsed = modules.readFilmFile(rawHtml);
  if (!parsed.doc) {
    throw new Error(`Invalid film.html: ${parsed.problems?.[0] ?? 'unreadable'}`);
  }
  const referencedTopFiles = new Set();
  for (const track of parsed.doc.tracks) {
    if (track.captions?.src) referencedTopFiles.add(track.captions.src.split(/[?#]/, 1)[0].toLowerCase());
    for (const clip of track.clips) {
      if (typeof clip.src === 'string') referencedTopFiles.add(clip.src.split(/[?#]/, 1)[0].toLowerCase());
    }
  }

  const workDir = await mkdtemp(join(tmpdir(), 'openfilm-layered-'));
  const skipDirs = new Set(['.film', '.git', 'node_modules']);
  const skipMediaExts = /\.(mp4|mov|mkv|webm|avi|m4v|zip)$/i;

  try {
    const entries = await readdir(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || skipDirs.has(entry.name)) continue;
      const src = join(projectDir, entry.name);
      const dst = join(workDir, entry.name);
      if (entry.isDirectory()) {
        await cp(src, dst, { recursive: true });
      } else if (entry.isFile()) {
        if (skipMediaExts.test(entry.name) && !referencedTopFiles.has(entry.name.toLowerCase())) {
          continue;
        }
        await copyFile(src, dst);
      }
    }
  } catch (err) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return {
    workDir,
    doc: parsed.doc,
    markup: rawHtml,
    cleanup: () => rm(workDir, { recursive: true, force: true }).catch(() => {}),
  };
}

/**
 * Build a minimal pages-only film.html inside `workDir/.film/probe-pages/` so `open()` only loads
 * `<iframe>` HTML clips without decoding videos or audio while inspecting text & graphics.
 */
async function createProbePagesDir(workDir, doc, rawHtml, modules) {
  const probeDir = join(workDir, '.film', 'probe-pages');
  await mkdir(probeDir, { recursive: true });
  const up = relative(probeDir, workDir).split(sep).join('/');
  const back = (/** @type {string} */ p) => (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(p) ? p : `${up}/${p}`);
  const urls = (/** @type {string} */ css) => css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_, q, p) => `url(${q}${back(p)}${q})`);
  const head = urls(rawHtml.replace(/(<link\b[^>]*\bhref\s*=\s*)(["'])([^"']*)\2/gi, (_, a, q, p) => `${a}${q}${back(p)}${q}`));

  const pageTracks = doc.tracks
    .map((t) => ({ ...t, clips: t.clips.filter((c) => modules.kindOf(c) === 'page') }))
    .filter((t) => t.clips.length > 0);
  const moved = {
    stage: doc.stage,
    ...(doc.keyframes ? { keyframes: doc.keyframes } : {}),
    tracks: pageTracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => ({
        ...c,
        src: back(c.src),
        ...(typeof c.style === 'string' ? { style: urls(c.style) } : {}),
      })),
    })),
  };
  await writeFile(join(probeDir, 'film.html'), modules.filmHtml(moved, head), 'utf8');
  return probeDir;
}

/**
 * Inspect all `<iframe>` HTML page clips in `workDir` and extract:
 * - editable text blocks (`texts`) with multi-run inline styles, stage positions, font sizes, rotation, and stagger timing;
 * - text-free transparent graphic PNGs (`graphics`) tight-cropped from the isolated iframe;
 * - `replacedClipIds` for decomposed pages (pure-graphic pages with 0 text remain in native export).
 *
 * @param {{
 *   workDir: string,
 *   doc: any,
 *   markup: string,
 *   stagingMediaDir: string,
 *   reservedNames?: Iterable<string>,
 *   modules: any,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{
 *   graphics: ExtractedGraphic[],
 *   texts: ExtractedText[],
 *   replacedClipIds: Set<string>,
 *   pageReports: PageLayerReport[],
 *   stage: { w: number, h: number },
 * }>}
 */
export async function extractProjectPageLayers(opts) {
  const { workDir, doc, markup, stagingMediaDir, modules, signal } = opts;
  const stage = { w: doc.stage?.w ?? 1920, h: doc.stage?.h ?? 1080 };
  /** @type {ExtractedGraphic[]} */
  const graphics = [];
  /** @type {ExtractedText[]} */
  const texts = [];
  /** @type {Set<string>} */
  const replacedClipIds = new Set();
  /** @type {PageLayerReport[]} */
  const pageReports = [];

  /** @type {{ clip: any, trackIndex: number, hidden: boolean }[]} */
  const pageClips = [];
  doc.tracks.forEach((track, ti) => {
    for (const clip of track.clips) {
      if (modules.kindOf(clip) === 'page') {
        pageClips.push({ clip, trackIndex: ti, hidden: Boolean(track.hidden || clip.disabled) });
      }
    }
  });

  if (!pageClips.length) {
    return { graphics, texts, replacedClipIds, pageReports, stage };
  }
  if (signal?.aborted) throw new Error('cancelled');

  const reserved = new Set([...(opts.reservedNames ?? [])].map((n) => n.toLowerCase()));
  await mkdir(stagingMediaDir, { recursive: true });

  const probeDir = await createProbePagesDir(workDir, doc, markup, modules);
  const probe = await modules.open(probeDir, { root: workDir, transparent: true, signal });

  try {
    await probe.film.page.addStyleTag({ content: 'html, body { background: transparent !important; }' });

    for (const entry of pageClips) {
      if (signal?.aborted) throw new Error('cancelled');
      const clipId = entry.clip.id;

      /* Read clip timeline span from the live timeline stage (handles implicit page durations). */
      const clipTiming = await probe.film.page.evaluate((id) => {
        const clips = /** @type {any} */ (window).__filmEditor?.stage?.clips?.() ?? [];
        const c = clips.find((/** @type {any} */ x) => x.id === id && x.kind === 'page');
        return c ? { at: c.at, end: c.end } : null;
      }, clipId);
      if (!clipTiming) continue;

      const durSec = Math.max(0.01, clipTiming.end - clipTiming.at);
      const sampleFracs = [0.78, 0.62, 0.48, 0.88, 0.30];
      /** @type {any} */
      let extracted = null;
      let settledT = clipTiming.at + durSec * sampleFracs[0];

      for (const frac of sampleFracs) {
        settledT = clipTiming.at + Math.min(durSec * frac, Math.max(0, durSec - 0.002));
        await probe.film.seek(settledT);
        extracted = await probe.film.page.evaluate(inspectPageInStage, {
          clipId,
          stageW: stage.w,
          stageH: stage.h,
        });
        if (extracted?.blocks?.length > 0 || (extracted && !extracted.animated)) break;
      }

      if (!extracted || (!extracted.blocks.length && extracted.animated)) {
        pageReports.push({
          clipId,
          src: entry.clip.src,
          status: 'pure-graphic',
          textCount: 0,
          hasGraphic: true,
        });
        continue;
      }

      /* 1. Capture text-free graphic PNG AT `settledT` while text nodes are hidden with CSS (or single static graphic). */
      const clipBox = extracted.clipBox;
      let graphicFile;
      if (clipBox && clipBox.width >= 1 && clipBox.height >= 1) {
        await probe.film.page.evaluate(prepareTextFreeCapture, { clipId });
        const rawShot = await probe.film.page.screenshot({ clip: clipBox, omitBackground: true });
        await probe.film.page.evaluate(restoreAfterTextFreeCapture, { clipId });

        const cropped = await probe.film.page.evaluate(cropPngByAlpha, {
          b64: rawShot.toString('base64'),
          originX: clipBox.x,
          originY: clipBox.y,
        });

        if (cropped) {
          const stem = safeStem(`${clipId}-graphic`);
          const fileName = freePngName(stagingMediaDir, stem, reserved);
          const outPath = join(stagingMediaDir, fileName);
          await writeFile(outPath, Buffer.from(cropped.b64, 'base64'));
          graphicFile = fileName;
          graphics.push({
            id: `${clipId}-graphic`,
            clipId,
            name: fileName.replace(/\.png$/i, ''),
            fileName,
            path: outPath,
            startMs: Math.round(clipTiming.at * 1000),
            durMs: Math.max(100, Math.round(durSec * 1000)),
            w: cropped.w,
            h: cropped.h,
            x: cropped.stageX + cropped.w / 2,
            y: cropped.stageY + cropped.h / 2,
            rotation: 0,
            opacity: 1,
            visible: !entry.hidden,
            track: entry.trackIndex,
          });
        }
      }

      if (!extracted.blocks.length) {
        if (graphicFile) {
          replacedClipIds.add(clipId);
          pageReports.push({
            clipId,
            src: entry.clip.src,
            status: 'static-graphic',
            textCount: 0,
            hasGraphic: true,
            graphicFile,
          });
        } else {
          pageReports.push({
            clipId,
            src: entry.clip.src,
            status: 'pure-graphic',
            textCount: 0,
            hasGraphic: false,
          });
        }
        continue;
      }

      /* 2. Refine stagger timing per text block if the page has animation. */
      const blockTimings = await probeBlockTimings(probe.film, clipId, clipTiming.at, clipTiming.end, extracted.blocks.length, extracted.animated);

      extracted.blocks.forEach((/** @type {any} */ block, idx) => {
        const timing = blockTimings[idx] ?? { startSec: clipTiming.at, endSec: clipTiming.end };
        const startMs = Math.round(timing.startSec * 1000);
        const durMs = Math.max(100, Math.round((timing.endSec - timing.startSec) * 1000));
        const primary = block.runs[0];
        texts.push({
          id: `${clipId}-text-${idx + 1}`,
          clipId,
          name: `${clipId}-text-${idx + 1}`,
          text: block.text,
          runs: block.runs,
          startMs,
          durMs,
          x: block.x,
          y: block.y,
          w: block.w,
          h: block.h,
          fontSize: primary.fontSize,
          fontFamily: primary.fontFamily,
          color: primary.color,
          bold: primary.bold,
          italic: primary.italic,
          underline: primary.underline,
          align: block.align,
          letterSpacing: block.letterSpacing,
          lineSpacing: block.lineSpacing,
          wrapped: block.wrapped,
          rotation: block.rotation,
          opacity: block.opacity,
          visible: !entry.hidden,
          track: entry.trackIndex,
        });
      });

      replacedClipIds.add(clipId);
      pageReports.push({
        clipId,
        src: entry.clip.src,
        status: 'decomposed',
        textCount: extracted.blocks.length,
        hasGraphic: Boolean(graphicFile),
        ...(graphicFile ? { graphicFile } : {}),
      });
    }
  } finally {
    await probe.close();
    await rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }

  return { graphics, texts, replacedClipIds, pageReports, stage };
}

/**
 * Probe when each extracted text block first becomes visible and last remains visible across
 * animated `<iframe>` pages.
 */
async function probeBlockTimings(film, clipId, at, end, count, animated) {
  const defaultSpan = Array.from({ length: count }, () => ({ startSec: at, endSec: end }));
  if (!animated || count === 0 || end - at < 0.25) return defaultSpan;

  const dur = end - at;
  const fracs = [0.02, 0.08, 0.16, 0.26, 0.38, 0.50, 0.62, 0.74, 0.85, 0.94];
  const sampleTs = fracs.map((f) => at + dur * f);
  /** @type {boolean[][]} */
  const visMatrix = [];

  for (const t of sampleTs) {
    await film.seek(t);
    const vis = await film.page.evaluate((id) => {
      const clips = /** @type {any} */ (window).__filmEditor?.stage?.clips?.() ?? [];
      const c = clips.find((/** @type {any} */ x) => x.id === id && x.kind === 'page');
      const tracked = c?.win?.__ofTracked;
      if (!c?.win || !Array.isArray(tracked)) return [];
      const win = c.win;
      const isElVisible = (/** @type {Element | null} */ el) => {
        for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
          const cs = win.getComputedStyle(cur);
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') < 0.12) {
            return false;
          }
        }
        return true;
      };
      return tracked.map((/** @type {Element} */ el) => isElVisible(el));
    }, clipId);
    if (!vis.length) return defaultSpan;
    visMatrix.push(vis);
  }

  return Array.from({ length: count }, (_, idx) => {
    const firstIdx = visMatrix.findIndex((row) => row[idx]);
    if (firstIdx < 0) return { startSec: at, endSec: end };
    let lastIdx = firstIdx;
    for (let j = visMatrix.length - 1; j >= firstIdx; j--) {
      if (visMatrix[j][idx]) { lastIdx = j; break; }
    }
    const startSec = firstIdx <= 1 ? at : Math.max(at, (sampleTs[firstIdx - 1] + sampleTs[firstIdx]) / 2);
    const endSec = lastIdx >= visMatrix.length - 2 ? end : Math.min(end, (sampleTs[lastIdx] + sampleTs[lastIdx + 1]) / 2);
    return { startSec, endSec: Math.max(startSec + 0.1, endSec) };
  });
}

/* ── Browser-context helpers passed to page.evaluate ─────────────────────── */

function inspectPageInStage({ clipId, stageW, stageH }) {
  const clips = /** @type {any} */ (window).__filmEditor?.stage?.clips?.() ?? [];
  const c = clips.find((/** @type {any} */ x) => x.id === clipId && x.kind === 'page');
  if (!c || !c.win?.document?.body) return null;

  const win = c.win;
  const doc = win.document;
  const body = doc.body;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT', 'TITLE', 'HEAD', 'BR', 'WBR']);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const css = (/** @type {Element} */ el) => win.getComputedStyle(el);

  /* Compute stage transform matrix matching OpenFilm's stage.js `matrixOf`. */
  const elCss = getComputedStyle(c.el);
  const [ox = 0, oy = 0] = elCss.transformOrigin.split(' ').map(parseFloat);
  const M = new DOMMatrix().translateSelf(ox, oy);
  if (elCss.translate && elCss.translate !== 'none') {
    const [tx = '0', ty = '0', tz = '0'] = elCss.translate.split(' ');
    M.translateSelf(parseFloat(tx), parseFloat(ty), parseFloat(tz));
  }
  if (elCss.rotate && elCss.rotate !== 'none') {
    const parts = elCss.rotate.split(' ');
    const deg = parseFloat(parts.pop() ?? '0');
    const axis = parts.length === 3 ? parts.map(Number) : parts[0] === 'x' ? [1, 0, 0] : parts[0] === 'y' ? [0, 1, 0] : [0, 0, 1];
    M.rotateAxisAngleSelf(axis[0], axis[1], axis[2], deg);
  }
  if (elCss.scale && elCss.scale !== 'none') {
    const [sx, sy = sx, sz = '1'] = elCss.scale.split(' ');
    M.scaleSelf(parseFloat(sx), parseFloat(sy), parseFloat(sz));
  }
  M.multiplySelf(new DOMMatrix(elCss.transform === 'none' ? undefined : elCss.transform)).translateSelf(-ox, -oy);

  const iframeScaleY = Math.hypot(M.c, M.d) || 1;
  const iframeRotation = (Math.atan2(M.b, M.a) * 180) / Math.PI;
  const mapPoint = (/** @type {number} */ x, /** @type {number} */ y) => {
    const p = M.transformPoint(new DOMPoint(x, y));
    return { x: p.x, y: p.y };
  };

  const frameRect = c.el.getBoundingClientRect();
  const clipLeft = Math.max(0, Math.floor(frameRect.left));
  const clipTop = Math.max(0, Math.floor(frameRect.top));
  const clipRight = Math.min(stageW, Math.ceil(frameRect.right));
  const clipBottom = Math.min(stageH, Math.ceil(frameRect.bottom));
  const clipBox = clipRight > clipLeft && clipBottom > clipTop
    ? { x: clipLeft, y: clipTop, width: clipRight - clipLeft, height: clipBottom - clipTop }
    : null;

  const effectiveOpacity = (/** @type {Element | null} */ el) => {
    let op = 1;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const s = css(cur);
      if (s.display === 'none' || s.visibility === 'hidden') return 0;
      op *= parseFloat(s.opacity || '1');
      if (op < 0.05) return 0;
    }
    return op;
  };

  const drawnCopy = (/** @type {Element} */ el) => {
    const copy = el.closest('[aria-hidden="true"]');
    return Boolean(copy) && css(copy).pointerEvents === 'none';
  };

  const isInlineElement = (/** @type {Element} */ el) => {
    if (el.tagName === 'BR' || el.tagName === 'WBR') return true;
    if (el.namespaceURI === SVG_NS) return false;
    return css(el).display === 'inline';
  };

  const hasBlockDescendant = (/** @type {Element} */ el) => {
    for (const child of el.children) {
      if (SKIP.has(child.tagName)) continue;
      if (!isInlineElement(child) || hasBlockDescendant(child)) return true;
    }
    return false;
  };

  const rotationOf = (/** @type {Element} */ el) => {
    let deg = iframeRotation;
    for (let cur = el; cur && cur !== doc.documentElement; cur = cur.parentElement) {
      const tr = css(cur).transform;
      if (tr && tr !== 'none') {
        const m = new DOMMatrix(tr);
        deg += (Math.atan2(m.b, m.a) * 180) / Math.PI;
      }
    }
    return Math.abs(deg) < 0.05 ? 0 : Math.round(deg * 100) / 100;
  };

  const styleOf = (/** @type {Element} */ el) => {
    const s = css(el);
    const weight = s.fontWeight === 'bold' ? 700 : parseInt(s.fontWeight, 10) || 400;
    const rawSize = parseFloat(s.fontSize) || 24;
    return {
      color: s.color || '#ffffff',
      bold: weight >= 600,
      italic: s.fontStyle === 'italic' || s.fontStyle === 'oblique',
      underline: /\bunderline\b/i.test(s.textDecorationLine || s.textDecoration || ''),
      fontSize: Math.round(rawSize * iframeScaleY * 100) / 100,
      fontFamily: s.fontFamily || '',
    };
  };

  /** @type {any[]} */
  const blocks = [];
  /** @type {Element[]} */
  const trackedEls = [];
  /** @type {Set<Element>} */
  const hideTargets = new Set();

  const emitBlock = (/** @type {Node[]} */ nodes, /** @type {Element} */ hostEl) => {
    const hostOp = effectiveOpacity(hostEl);
    if (hostOp < 0.05) return;

    /** @type {{ text: string, color: string, bold: boolean, italic: boolean, underline: boolean, fontSize: number, fontFamily: string }[]} */
    const rawPieces = [];
    /** @type {Text[]} */
    const textNodes = [];
    let preserveWs = false;

    const collectPieces = (/** @type {Node} */ node, /** @type {Element} */ parentEl) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = /** @type {Text} */ (node);
        const ws = css(parentEl).whiteSpace || 'normal';
        const pre = ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces';
        if (pre) preserveWs = true;
        const val = pre ? t.data : t.data.replace(/[\r\n\t ]+/g, ' ');
        if (!val) return;
        textNodes.push(t);
        rawPieces.push({ text: val, ...styleOf(parentEl) });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = /** @type {Element} */ (node);
      if (el.tagName === 'BR') {
        rawPieces.push({ text: '\n', ...styleOf(parentEl) });
        return;
      }
      if (SKIP.has(el.tagName) || effectiveOpacity(el) < 0.05 || drawnCopy(el)) return;
      for (const ch of el.childNodes) collectPieces(ch, el);
    };

    for (const n of nodes) {
      const parentEl = n.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (n) : hostEl;
      collectPieces(n, parentEl);
    }

    if (!textNodes.length) return;

    /* Normalize spaces across run boundaries while keeping exact run styles. */
    let fullText = '';
    /** @type {typeof rawPieces} */
    const mergedRuns = [];
    for (const p of rawPieces) {
      let chunk = p.text;
      if (!preserveWs) {
        if ((!fullText || fullText.endsWith('\n') || fullText.endsWith(' ')) && chunk.startsWith(' ')) {
          chunk = chunk.slice(1);
        }
        if (chunk === '\n' && mergedRuns.length && mergedRuns[mergedRuns.length - 1].text.endsWith(' ')) {
          const prev = mergedRuns[mergedRuns.length - 1];
          prev.text = prev.text.replace(/ +$/, '');
          fullText = fullText.replace(/ +$/, '');
        }
      }
      if (!chunk) continue;
      const last = mergedRuns[mergedRuns.length - 1];
      if (last && last.color === p.color && last.bold === p.bold && last.italic === p.italic
        && last.underline === p.underline && last.fontSize === p.fontSize && last.fontFamily === p.fontFamily) {
        last.text += chunk;
      } else {
        mergedRuns.push({ ...p, text: chunk });
      }
      fullText += chunk;
    }

    if (!preserveWs) {
      while (mergedRuns.length && !mergedRuns[mergedRuns.length - 1].text.trim()) {
        mergedRuns.pop();
      }
      if (mergedRuns.length) {
        mergedRuns[mergedRuns.length - 1].text = mergedRuns[mergedRuns.length - 1].text.replace(/ +$/, '');
      }
      fullText = mergedRuns.map((r) => r.text).join('');
    }

    if (!fullText.trim()) return;

    /* Measure actual glyph bounds via Range over all text nodes in this block. */
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let totalLineRects = 0;
    for (const t of textNodes) {
      if (!t.data.trim()) continue;
      const range = doc.createRange();
      range.selectNodeContents(t);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        minX = Math.min(minX, rect.left);
        minY = Math.min(minY, rect.top);
        maxX = Math.max(maxX, rect.right);
        maxY = Math.max(maxY, rect.bottom);
      }
      totalLineRects += range.getClientRects().length;
    }
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return;

    const hostRect = hostEl.getBoundingClientRect();
    const rot = rotationOf(hostEl);
    const center = mapPoint((minX + maxX) / 2, (minY + maxY) / 2);
    const w = (maxX - minX) * (Math.hypot(M.a, M.b) || 1);
    const h = (maxY - minY) * iframeScaleY;

    const hs = css(hostEl);
    const ta = hs.textAlign;
    const align = ta === 'right' || ta === 'end' ? 'right' : ta === 'center' ? 'center' : 'left';
    const rawFs = parseFloat(hs.fontSize) || mergedRuns[0].fontSize || 24;
    const rawLs = parseFloat(hs.letterSpacing);
    const letterSpacing = Number.isFinite(rawLs) ? Math.round((rawLs / rawFs) * 1000) / 1000 : 0;
    const rawLh = parseFloat(hs.lineHeight);
    const lineSpacing = Number.isFinite(rawLh) && rawFs > 0
      ? Math.max(0, Math.round(((rawLh / rawFs) - 1.15) * 1000) / 1000)
      : 0.02;
    const wrapped = !fullText.includes('\n') && totalLineRects > 1 && hostRect.width > w * 0.9;

    hideTargets.add(hostEl);
    for (const t of textNodes) {
      if (t.parentElement) hideTargets.add(t.parentElement);
    }
    trackedEls.push(hostEl);

    blocks.push({
      text: fullText,
      runs: mergedRuns,
      x: Math.round(center.x * 100) / 100,
      y: Math.round(center.y * 100) / 100,
      w: Math.round(w * 100) / 100,
      h: Math.round(h * 100) / 100,
      align,
      letterSpacing,
      lineSpacing,
      wrapped,
      rotation: rot,
      opacity: Math.round(hostOp * 1000) / 1000,
    });
  };

  const walk = (/** @type {Element} */ container) => {
    /** @type {Node[]} */
    let inlineRun = [];
    const flush = () => {
      if (inlineRun.length) {
        emitBlock(inlineRun, container);
        inlineRun = [];
      }
    };

    for (const node of container.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent && node.textContent.trim().length > 0) {
          inlineRun.push(node);
        } else if (inlineRun.length) {
          inlineRun.push(node);
        }
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = /** @type {Element} */ (node);
      if (SKIP.has(el.tagName) || effectiveOpacity(el) < 0.05 || drawnCopy(el)) continue;

      if (el.namespaceURI === SVG_NS) {
        flush();
        for (const svgText of el.querySelectorAll('text')) {
          if (effectiveOpacity(svgText) >= 0.05 && svgText.textContent?.trim()) {
            emitBlock([...svgText.childNodes], svgText);
          }
        }
        continue;
      }

      if (isInlineElement(el) && !hasBlockDescendant(el)) {
        inlineRun.push(el);
      } else {
        flush();
        if (!hasBlockDescendant(el)) {
          emitBlock([...el.childNodes], el);
        } else {
          walk(el);
        }
      }
    }
    flush();
  };

  walk(body);

  win.__ofTracked = trackedEls;
  win.__ofHideTargets = [...hideTargets];

  const animated = Boolean(
    (typeof win.film?.frame === 'function' && win.film.frame.toString().replace(/\s+/g, '').length > 16)
    || (doc.getAnimations?.().length ?? 0) > 0
    || (c.el.getAnimations?.().length ?? 0) > 0
    || elCss.animationName !== 'none',
  );

  return { blocks, clipBox, animated };
}

function prepareTextFreeCapture({ clipId }) {
  const clips = /** @type {any} */ (window).__filmEditor?.stage?.clips?.() ?? [];
  const target = clips.find((/** @type {any} */ x) => x.id === clipId && x.kind === 'page');
  if (!target?.win?.document) return;

  /** @type {{ el: HTMLElement, visibility: string }[]} */
  const hiddenOthers = [];
  for (const c of clips) {
    if (c !== target && c.el) {
      hiddenOthers.push({ el: c.el, visibility: c.el.style.visibility });
      c.el.style.visibility = 'hidden';
    }
  }
  /** @type {any} */ (window).__ofHiddenOthers = hiddenOthers;

  const doc = target.win.document;
  const win = target.win;
  const hideTargets = /** @type {Element[]} */ (win.__ofHideTargets ?? []);
  /** @type {{ el: HTMLElement, prevBorderColor: string }[]} */
  const borderPins = [];

  for (const el of hideTargets) {
    if (!(el instanceof win.HTMLElement) && !(el instanceof win.SVGElement)) continue;
    const cs = win.getComputedStyle(el);
    if (el instanceof win.HTMLElement && cs.borderColor && cs.borderColor === cs.color && (parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0)) {
      borderPins.push({ el, prevBorderColor: el.style.borderColor });
      el.style.borderColor = cs.borderColor;
    }
    el.setAttribute('data-of-hide-text', '1');
  }
  win.__ofBorderPins = borderPins;

  const style = doc.createElement('style');
  style.id = '__of-hide-text-style';
  style.textContent = `
    [data-of-hide-text], [data-of-hide-text] * {
      color: transparent !important;
      -webkit-text-fill-color: transparent !important;
      text-shadow: none !important;
      text-decoration-color: transparent !important;
    }
    svg[data-of-hide-text], svg [data-of-hide-text] {
      fill: transparent !important;
      stroke: transparent !important;
    }
  `;
  (doc.head || doc.documentElement).appendChild(style);
}

function restoreAfterTextFreeCapture({ clipId }) {
  const hiddenOthers = /** @type {any[]} */ (/** @type {any} */ (window).__ofHiddenOthers ?? []);
  for (const item of hiddenOthers) {
    item.el.style.visibility = item.visibility;
  }
  /** @type {any} */ (window).__ofHiddenOthers = null;

  const clips = /** @type {any} */ (window).__filmEditor?.stage?.clips?.() ?? [];
  const target = clips.find((/** @type {any} */ x) => x.id === clipId && x.kind === 'page');
  if (!target?.win?.document) return;

  const win = target.win;
  const doc = win.document;
  doc.getElementById('__of-hide-text-style')?.remove();
  for (const el of win.__ofHideTargets ?? []) {
    el.removeAttribute('data-of-hide-text');
  }
  for (const pin of win.__ofBorderPins ?? []) {
    pin.el.style.borderColor = pin.prevBorderColor;
  }
  win.__ofBorderPins = null;
}

async function cropPngByAlpha({ b64, originX, originY }) {
  const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
  const bmp = await createImageBitmap(blob);
  const w = bmp.width;
  const h = bmp.height;
  if (w < 1 || h < 1) return null;

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const rowOffset = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[rowOffset + x * 4 + 3] > 4) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;

  const pad = 2;
  const cx0 = Math.max(0, minX - pad);
  const cy0 = Math.max(0, minY - pad);
  const cx1 = Math.min(w - 1, maxX + pad);
  const cy1 = Math.min(h - 1, maxY + pad);
  const cropW = cx1 - cx0 + 1;
  const cropH = cy1 - cy0 + 1;

  const outCanvas = new OffscreenCanvas(cropW, cropH);
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) return null;
  outCtx.drawImage(bmp, cx0, cy0, cropW, cropH, 0, 0, cropW, cropH);
  const outBlob = await outCanvas.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await outBlob.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return {
    b64: btoa(bin),
    w: cropW,
    h: cropH,
    stageX: originX + cx0,
    stageY: originY + cy0,
  };
}
