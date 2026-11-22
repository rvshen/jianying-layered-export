// @ts-check
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createIsolatedWorkspace, extractProjectPageLayers } from './extract-layers.mjs';
import { loadOpenFilmModules } from './openfilm-runtime.mjs';

const hex = () => randomUUID().replace(/-/g, '');
const PHOTO_US = 10_800_000_000;
const round6 = (/** @type {number} */ n) => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * Parse hex / rgb() / rgba() / srgb() CSS color into Jianying's 0..1 RGB tuple, alpha, and `#rrggbb`.
 * @param {string | null | undefined} raw
 * @param {string} [fallback]
 * @returns {{ rgb: [number, number, number], alpha: number, hex: string }}
 */
export function parseColor(raw, fallback = '#ffffff') {
  const clamp01 = (/** @type {number} */ n) => Math.max(0, Math.min(1, n));
  const clamp255 = (/** @type {number} */ n) => Math.max(0, Math.min(255, Math.round(n)));
  const hexByte = (/** @type {number} */ n) => clamp255(n).toString(16).padStart(2, '0');
  const fromBytes = (/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b, /** @type {number} */ a = 1) => ({
    rgb: /** @type {[number, number, number]} */ ([
      round6(clamp255(r) / 255),
      round6(clamp255(g) / 255),
      round6(clamp255(b) / 255),
    ]),
    alpha: round6(clamp01(a)),
    hex: `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`,
  });

  const text = String(raw || '').trim();
  const hexMatch = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
  if (hexMatch) {
    const h = hexMatch[1];
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16);
      const g = parseInt(h[1] + h[1], 16);
      const b = parseInt(h[2] + h[2], 16);
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
      return fromBytes(r, g, b, a);
    }
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return fromBytes(r, g, b, a);
  }

  const rgbMatch = /^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(text);
  if (rgbMatch) {
    const ch = (/** @type {string} */ v) => (v.endsWith('%') ? (parseFloat(v) / 100) * 255 : parseFloat(v));
    const r = ch(rgbMatch[1]);
    const g = ch(rgbMatch[2]);
    const b = ch(rgbMatch[3]);
    const rawA = rgbMatch[4];
    const a = rawA == null ? 1 : rawA.endsWith('%') ? parseFloat(rawA) / 100 : parseFloat(rawA);
    if ([r, g, b, a].every(Number.isFinite)) return fromBytes(r, g, b, a);
  }

  const srgbMatch = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(text);
  if (srgbMatch) {
    const r = Number(srgbMatch[1]) * 255;
    const g = Number(srgbMatch[2]) * 255;
    const b = Number(srgbMatch[3]) * 255;
    const rawA = srgbMatch[4];
    const a = rawA == null ? 1 : rawA.endsWith('%') ? parseFloat(rawA) / 100 : parseFloat(rawA);
    if ([r, g, b, a].every(Number.isFinite)) return fromBytes(r, g, b, a);
  }

  if (text.toLowerCase() === 'white') return fromBytes(255, 255, 255, 1);
  if (text.toLowerCase() === 'black') return fromBytes(0, 0, 0, 1);
  return text === fallback ? fromBytes(255, 255, 255, 1) : parseColor(fallback, '#ffffff');
}

/**
 * Convert CSS px font size on stage to Jianying's font size unit using OpenFilm 0.4.0's calibration
 * (`14.4` equals 10% of the stage short edge).
 */
export function jianyingFontSize(/** @type {number} */ fontSizePx, /** @type {number} */ stageW, /** @type {number} */ stageH) {
  const shortEdge = Math.max(1, Math.min(stageW, stageH));
  return Math.max(1, Number(((fontSizePx / shortEdge) * 144).toFixed(2)));
}

/**
 * Convert top-left stage pixels to Jianying half-canvas coordinates (center origin, +y upward).
 */
export function stageToJianyingPos(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ stageW, /** @type {number} */ stageH) {
  return {
    x: round6((x / Math.max(1, stageW) - 0.5) * 2),
    y: round6((0.5 - y / Math.max(1, stageH)) * 2),
  };
}

/**
 * Split a CSS `font-family` declaration into cleaned family names.
 * @param {string | undefined | null} raw
 * @returns {string[]}
 */
export function parseFontFamilies(raw) {
  return (String(raw || '').match(/"[^"]*"|'[^']*'|[^,]+/g) ?? [])
    .map((name) => name.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * Normalize a font descriptor path to forward slashes for Jianying Pro.
 * @param {{ name: string, path: string } | null | undefined} font
 */
function normalizeFont(font) {
  if (!font?.path) return null;
  return { name: font.name, path: font.path.replace(/\\/g, '/') };
}

/**
 * Build a Jianying `materials.texts` entry (`type: 'text'`, `add_type: 0`) with multi-run inline styles.
 * @param {import('./extract-layers.mjs').ExtractedText} item
 * @param {{ stageW: number, stageH: number, fontsByFamily?: Map<string, { name: string, path: string }>, defaultFont?: { name: string, path: string } | null }} opts
 */
export function buildTextContentAndMaterial(item, opts) {
  const { stageW, stageH, fontsByFamily, defaultFont } = opts;
  const id = hex();
  const runs = item.runs?.length
    ? item.runs
    : [{ text: item.text, color: item.color, bold: item.bold, italic: item.italic, underline: item.underline, fontSize: item.fontSize, fontFamily: item.fontFamily }];

  const trimmedRuns = runs.map((r) => ({ ...r }));
  if (trimmedRuns.length) {
    trimmedRuns[0].text = trimmedRuns[0].text.replace(/^\s+/, '');
    const last = trimmedRuns[trimmedRuns.length - 1];
    last.text = last.text.replace(/\s+$/, '');
  }
  const activeRuns = trimmedRuns.filter((r) => r.text.length > 0);
  const fullText = activeRuns.map((r) => r.text).join('') || String(item.text || '').trim();

  const resolveFont = (/** @type {string} */ family) =>
    normalizeFont(fontsByFamily?.get(family) ?? defaultFont);

  let offset = 0;
  /** @type {Record<string, unknown>[]} */
  const styles = [];
  for (const run of activeRuns.length ? activeRuns : [{ text: fullText, color: item.color, bold: item.bold, italic: item.italic, underline: item.underline, fontSize: item.fontSize, fontFamily: item.fontFamily }]) {
    const len = [...run.text].length;
    const fill = parseColor(run.color, '#ffffff');
    const runFont = resolveFont(run.fontFamily);
    const size = jianyingFontSize(run.fontSize || item.fontSize || 32, stageW, stageH);
    styles.push({
      fill: { alpha: 1, content: { render_type: 'solid', solid: { alpha: fill.alpha, color: fill.rgb } } },
      range: [offset, offset + len],
      size,
      bold: Boolean(run.bold),
      italic: Boolean(run.italic),
      underline: Boolean(run.underline),
      ...(runFont ? { font: { id: '', path: runFont.path } } : {}),
    });
    offset += len;
  }

  const primaryRun = activeRuns[0] ?? runs[0];
  const primaryFill = parseColor(primaryRun?.color ?? item.color, '#ffffff');
  const primarySize = jianyingFontSize(primaryRun?.fontSize ?? item.fontSize ?? 32, stageW, stageH);
  const primaryFont = resolveFont(primaryRun?.fontFamily ?? item.fontFamily);
  const align = item.align === 'left' ? 0 : item.align === 'right' ? 2 : 1;

  const material = {
    id,
    type: 'text',
    add_type: 0,
    alignment: align,
    bold_width: primaryRun?.bold ? 0.008 : 0,
    border_alpha: 0,
    border_color: '',
    border_width: 0,
    background_alpha: 0,
    background_color: '',
    background_height: 0.14,
    background_horizontal_offset: 0,
    background_round_radius: 0,
    background_style: 0,
    background_vertical_offset: 0,
    background_width: 0.14,
    caption_template_info: { resource_id: '', path: '' },
    check_flag: 7,
    combo_info: {},
    content: JSON.stringify({ styles, text: fullText }),
    current_words: { start_time: [], end_time: [], text: [] },
    font_size: primarySize,
    ...(primaryFont ? { font_name: primaryFont.name, font_path: primaryFont.path } : {}),
    force_apply_line_max_width: Boolean(item.wrapped && item.w > 0),
    global_alpha: round6(item.opacity ?? 1),
    initial_scale: 1,
    italic_degree: primaryRun?.italic ? 10 : 0,
    layer_weight: 1,
    letter_spacing: round6(item.letterSpacing ?? 0),
    line_feed: 1,
    line_max_width: item.w > 0 ? round6(Math.min(0.95, Math.max(0.12, (item.w / Math.max(1, stageW)) * 1.12))) : 0.82,
    line_spacing: round6(item.lineSpacing ?? 0.02),
    lyrics_template: { resource_id: '', path: '' },
    text_alpha: round6(primaryFill.alpha),
    text_color: primaryFill.hex,
    typesetting: 0,
    words: { start_time: [], end_time: [], text: [] },
  };

  return { id, material };
}

/**
 * Default fallback lane allocation if `allocateLanes` is not injected.
 * @param {readonly { start: number, end: number }[]} items
 */
function fallbackAllocateLanes(items) {
  const order = items.map((_, i) => i).sort((a, b) => items[a].start - items[b].start || a - b);
  /** @type {number[]} */
  const ends = [];
  const out = new Array(items.length).fill(0);
  for (const i of order) {
    let lane = ends.findIndex((end) => end <= items[i].start);
    if (lane < 0) { lane = ends.length; ends.push(items[i].end); }
    else ends[lane] = items[i].end;
    out[i] = lane;
  }
  return out;
}

/**
 * Patch an OpenFilm 0.4.0 native Jianying draft JSON (`info` & `meta`) to insert independent
 * graphic overlay tracks (sorted bottom-to-top preserving z-order) and independent editable text
 * tracks (`flag: 0`), while preserving all native video, audio, and `flag: 1` subtitle tracks.
 *
 * @param {{
 *   info: any,
 *   meta: any,
 *   draftDir: string,
 *   graphics: readonly import('./extract-layers.mjs').ExtractedGraphic[],
 *   texts: readonly import('./extract-layers.mjs').ExtractedText[],
 *   fontsByFamily?: Map<string, { name: string, path: string }>,
 *   defaultFont?: { name: string, path: string } | null,
 *   draftPathPlaceholder?: string,
 *   allocateLanes?: (items: readonly { start: number, end: number }[]) => number[],
 *   nativeTrackSourceIndex?: Map<string, number>,
 *   now?: number,
 * }} opts
 */
export function patchJianyingDraft(opts) {
  const {
    info,
    meta,
    draftDir,
    graphics,
    texts,
    fontsByFamily,
    defaultFont,
    draftPathPlaceholder = '##_draftpath_placeholder_0E685133-18CE-45ED-8CB8-2904A212EC80_##',
    allocateLanes = fallbackAllocateLanes,
    nativeTrackSourceIndex,
    now = Date.now(),
  } = opts;

  const fps = info.fps || 30;
  const stageW = info.canvas_config?.width || 1920;
  const stageH = info.canvas_config?.height || 1080;
  const us = (/** @type {number} */ frame) => Math.round((frame * 1e6) / fps);
  const toFrame = (/** @type {number} */ ms) => Math.round((ms / 1000) * fps);
  const span = (/** @type {number} */ from, /** @type {number} */ to) => ({ start: us(from), duration: us(to) - us(from) });
  const msSpan = (/** @type {number} */ startMs, /** @type {number} */ durMs) => {
    const from = toFrame(startMs);
    const to = Math.max(from + 1, toFrame(startMs + durMs));
    return { from, to, range: span(from, to) };
  };

  info.materials ??= {};
  info.materials.videos ??= [];
  info.materials.speeds ??= [];
  info.materials.texts ??= [];

  meta.draft_materials ??= [{ type: 0, value: [] }];
  let mediaGroup = meta.draft_materials.find((/** @type {any} */ g) => g.type === 0);
  if (!mediaGroup) {
    mediaGroup = { type: 0, value: [] };
    meta.draft_materials.unshift(mediaGroup);
  }
  mediaGroup.value ??= [];

  const speed = () => {
    const id = hex();
    info.materials.speeds.push({ curve_speed: null, id, mode: 0, speed: 1, type: 'speed' });
    return id;
  };

  const baseSegment = (/** @type {Record<string, any>} */ fields) => ({
    enable_adjust: true, enable_color_correct_adjust: false, enable_color_curves: true, enable_color_match_adjust: false,
    enable_color_wheels: true, enable_lut: true, enable_smart_color_adjust: false, last_nonzero_volume: 1, reverse: false,
    track_attribute: 0, track_render_index: 0, visible: true, id: hex(), common_keyframes: [], keyframe_refs: [],
    speed: 1, volume: 1, is_tone_modify: false, ...fields,
  });

  /** @type {Map<string, string>} */
  const graphicMaterialOf = new Map();
  const registerGraphic = (/** @type {import('./extract-layers.mjs').ExtractedGraphic} */ g) => {
    const key = g.fileName;
    const known = graphicMaterialOf.get(key);
    if (known) return known;

    const libId = randomUUID().toUpperCase();
    mediaGroup.value.push({
      ai_group_type: '', create_time: -1, duration: 5_000_000, enter_from: 0,
      extra_info: g.fileName, file_Path: `./media/${g.fileName}`, height: g.h, id: libId,
      import_time: -1, import_time_ms: -1, item_source: 1, material_color_tag: '', md5: '',
      metetype: 'photo', roughcut_time_range: { duration: -1, start: -1 },
      sub_time_range: { duration: -1, start: -1 }, type: 0, width: g.w,
    });

    const matId = hex();
    info.materials.videos.push({
      audio_fade: null, category_id: '', category_name: 'local', check_flag: 63487,
      crop: { upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0, lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 },
      crop_ratio: 'free', crop_scale: 1, duration: PHOTO_US, height: g.h, width: g.w,
      id: matId, local_material_id: libId, material_id: matId, material_name: g.fileName, media_path: '',
      path: `${draftPathPlaceholder}/media/${g.fileName}`, type: 'photo',
    });
    graphicMaterialOf.set(key, matId);
    return matId;
  };

  const existingTracks = Array.isArray(info.tracks) ? info.tracks : [];
  const nativeVideoTracks = existingTracks.filter((/** @type {any} */ t) => t.type === 'video');
  const nativeAudioTracks = existingTracks.filter((/** @type {any} */ t) => t.type === 'audio');
  const nativeSubtitleTracks = existingTracks.filter((/** @type {any} */ t) => t.type === 'text' && t.flag === 1);
  const nativeOtherTextTracks = existingTracks.filter((/** @type {any} */ t) => t.type === 'text' && t.flag !== 1);

  /** @type {number[]} */
  const endFrames = [];
  for (const t of existingTracks) {
    for (const s of t.segments ?? []) {
      const tr = s.target_timerange;
      if (tr && Number.isFinite(tr.start) && Number.isFinite(tr.duration)) {
        endFrames.push(Math.round(((tr.start + tr.duration) / 1e6) * fps));
      }
    }
  }

  /* Build extracted graphic video tracks grouped by original film.html track (descending = bottom-to-top). */
  const validGraphics = graphics.filter((g) => Boolean(g?.fileName && g.durMs > 0 && g.w > 0 && g.h > 0));
  /** @type {{ zTrack: number, isMain?: boolean, track: any }[]} */
  const allVideoEntries = nativeVideoTracks.map((t, idx) => ({
    zTrack: nativeTrackSourceIndex?.get(t.id) ?? (idx === 0 ? 1e9 : 1e6 - idx),
    isMain: idx === 0,
    track: t,
  }));

  if (validGraphics.length) {
    const groups = [...new Set(validGraphics.map((g) => g.track ?? 0))].sort((a, b) => b - a);
    let seq = 0;
    for (const group of groups) {
      const items = validGraphics
        .filter((g) => (g.track ?? 0) === group)
        .map((g) => {
          const s = msSpan(g.startMs, g.durMs);
          endFrames.push(s.to);
          return { item: g, start: s.from, end: s.to, range: s.range };
        })
        .sort((a, b) => a.start - b.start);

      const lanes = allocateLanes(items);
      const count = Math.max(0, ...lanes) + 1;
      for (let lane = 0; lane < count; lane++) {
        seq++;
        const laneItems = items.filter((_, i) => lanes[i] === lane);
        allVideoEntries.push({
          zTrack: group,
          track: {
            attribute: 0,
            flag: 0,
            id: hex(),
            is_default_name: false,
            name: seq === 1 ? 'Graphics' : `Graphics ${seq}`,
            type: 'video',
            segments: laneItems.map(({ item: g, range }) => {
              const fit = Math.min(stageW / g.w, stageH / g.h);
              const scale = round6(1 / fit);
              const pos = stageToJianyingPos(g.x, g.y, stageW, stageH);
              return baseSegment({
                material_id: registerGraphic(g),
                target_timerange: range,
                source_timerange: { start: 0, duration: range.duration },
                visible: g.visible ?? true,
                volume: 0,
                last_nonzero_volume: 1,
                extra_material_refs: [speed()],
                clip: {
                  alpha: round6(g.opacity ?? 1),
                  flip: { horizontal: false, vertical: false },
                  rotation: round6(g.rotation ?? 0),
                  scale: { x: scale, y: scale },
                  transform: { x: pos.x, y: pos.y },
                },
                uniform_scale: { on: true, value: 1 },
                hdr_settings: { intensity: 1, mode: 1, nits: 1000 },
                render_index: 0,
              });
            }),
          },
        });
      }
    }
  }

  /* Ensure at least one empty main video track exists if the project had only overlays. */
  if (nativeVideoTracks.length === 0 && validGraphics.length > 0) {
    allVideoEntries.unshift({
      zTrack: 1e9,
      isMain: true,
      track: { attribute: 0, flag: 0, id: hex(), is_default_name: false, name: 'Main', type: 'video', segments: [] },
    });
  }

  /* Sort bottom-to-top: main track always first (zTrack highest), then descending zTrack. */
  allVideoEntries.sort((a, b) => {
    if (a.isMain && !b.isMain) return -1;
    if (!a.isMain && b.isMain) return 1;
    return b.zTrack - a.zTrack;
  });

  let renderIndex = 0;
  const orderedVideoTracks = allVideoEntries.map((entry) => {
    const idx = renderIndex++;
    for (const seg of entry.track.segments ?? []) {
      seg.render_index = idx;
      seg.track_render_index = 0;
    }
    return entry.track;
  });

  const orderedAudioTracks = nativeAudioTracks.map((t) => {
    const idx = renderIndex++;
    for (const seg of t.segments ?? []) {
      seg.render_index = idx;
      seg.track_render_index = 0;
    }
    return t;
  });

  /* Build editable text tracks (`type: 'text', flag: 0`) above video & audio, separate from `flag: 1` subtitles. */
  let textRenderIndex = 14000;
  /** @type {any[]} */
  const orderedTextTracks = [];
  for (const t of nativeOtherTextTracks) {
    const idx = textRenderIndex++;
    for (const seg of t.segments ?? []) {
      seg.render_index = idx;
      seg.track_render_index = 0;
    }
    orderedTextTracks.push(t);
  }

  const validTexts = texts.filter((t) => Boolean(t?.text?.trim() && t.durMs > 0));
  if (validTexts.length) {
    const groups = [...new Set(validTexts.map((t) => t.track ?? 0))].sort((a, b) => b - a);
    let seq = 0;
    for (const group of groups) {
      const items = validTexts
        .filter((t) => (t.track ?? 0) === group)
        .map((t) => {
          const s = msSpan(t.startMs, t.durMs);
          endFrames.push(s.to);
          return { item: t, start: s.from, end: s.to, range: s.range };
        })
        .sort((a, b) => a.start - b.start);

      const lanes = allocateLanes(items);
      const count = Math.max(0, ...lanes) + 1;
      for (let lane = 0; lane < count; lane++) {
        seq++;
        const idx = textRenderIndex++;
        const laneItems = items.filter((_, i) => lanes[i] === lane);
        orderedTextTracks.push({
          attribute: 0,
          flag: 0,
          id: hex(),
          is_default_name: false,
          name: seq === 1 ? 'Text' : `Text ${seq}`,
          type: 'text',
          segments: laneItems.map(({ item: t, range }) => {
            const { id, material } = buildTextContentAndMaterial(t, {
              stageW,
              stageH,
              fontsByFamily,
              defaultFont,
            });
            info.materials.texts.push(material);
            const pos = stageToJianyingPos(t.x, t.y, stageW, stageH);
            return baseSegment({
              material_id: id,
              target_timerange: range,
              source_timerange: null,
              visible: t.visible ?? true,
              extra_material_refs: [],
              clip: {
                alpha: round6(t.opacity ?? 1),
                flip: { horizontal: false, vertical: false },
                rotation: round6(t.rotation ?? 0),
                scale: { x: 1, y: 1 },
                transform: { x: pos.x, y: pos.y },
              },
              uniform_scale: { on: true, value: 1 },
              render_index: idx,
            });
          }),
        });
      }
    }
  }

  const orderedSubtitleTracks = nativeSubtitleTracks.map((t) => {
    const idx = textRenderIndex++;
    for (const seg of t.segments ?? []) {
      seg.render_index = idx;
      seg.track_render_index = 0;
    }
    return t;
  });

  info.tracks = [
    ...orderedVideoTracks,
    ...orderedAudioTracks,
    ...orderedTextTracks,
    ...orderedSubtitleTracks,
  ];

  const durationUs = Math.max(info.duration || 0, us(Math.max(0, ...endFrames)));
  info.duration = durationUs;

  meta.draft_fold_path = draftDir.replace(/\\/g, '/');
  meta.draft_root_path = dirname(draftDir).replace(/\\/g, '/');
  meta.tm_duration = durationUs;
  meta.tm_draft_create = now * 1000;
  meta.tm_draft_modified = now * 1000;

  return { info, meta };
}

/**
 * Resolve native video track -> original `film.html` track index by matching clip filenames.
 * @param {any} info
 * @param {any} doc
 */
export function inferNativeTrackSourceIndex(info, doc) {
  /** @type {Map<string, number>} */
  const map = new Map();
  const byFile = new Map();
  let captionTi = -1;
  doc.tracks.forEach((/** @type {any} */ track, ti) => {
    if (track.captions && captionTi < 0) captionTi = ti;
    for (const clip of track.clips) {
      if (typeof clip.id === 'string') byFile.set(clip.id.toLowerCase(), ti);
      if (typeof clip.src === 'string') {
        const clean = basename(clip.src.split(/[?#]/, 1)[0]).toLowerCase();
        byFile.set(clean, ti);
      }
    }
  });

  const videoMats = new Map((info.materials?.videos ?? []).map((/** @type {any} */ m) => [m.id, m]));
  for (const t of info.tracks ?? []) {
    if (t.type !== 'video') continue;
    let maxTi = -1;
    let isCaptionsOverlay = false;
    for (const seg of t.segments ?? []) {
      const mat = videoMats.get(seg.material_id);
      if (!mat) continue;
      const matName = String(mat.material_name || basename(mat.path || '')).toLowerCase();
      const stem = matName.replace(/\.[^.]+$/, '');
      if (/^captions-[0-9a-f]+(?:\.[^.]+)?$/.test(matName)) isCaptionsOverlay = true;
      const hit = byFile.get(matName) ?? byFile.get(stem);
      if (hit != null && hit > maxTi) maxTi = hit;
    }
    if (maxTi >= 0) map.set(t.id, maxTi);
    else if (isCaptionsOverlay) map.set(t.id, captionTi >= 0 ? captionTi : -1);
  }
  return map;
}

/**
 * Run layered Jianying Pro export on an OpenFilm project using OpenFilm 0.4.0's native exporter.
 *
 * @param {{
 *   projectDir: string,
 *   draftsDir?: string | null,
 *   name?: string,
 *   fps?: number,
 *   overwrite?: boolean,
 *   onProgress?: (info: { phase: string, progress: number, message?: string }) => void,
 *   signal?: AbortSignal,
 * }} opts
 */
export async function exportLayeredJianying(opts) {
  const { projectDir, fps = 30, overwrite = false, onProgress, signal } = opts;
  const modules = await loadOpenFilmModules();

  const resolvedProject = resolve(projectDir);
  if (!existsSync(join(resolvedProject, 'film.html'))) {
    throw new Error(`No film.html found in ${resolvedProject}`);
  }

  const draftsDir = resolve(
    opts.draftsDir
      || modules.draftsRoot('jianying', {
        home: process.env.USERPROFILE || process.env.HOME || '',
        localAppData: process.env.LOCALAPPDATA,
        exists: existsSync,
      })
      || join(resolvedProject, '.film', 'exports'),
  );
  const draftName = (opts.name?.trim() || basename(resolvedProject)).replace(/[\\/:*?"<>|]+/g, ' ').trim();

  onProgress?.({ phase: 'preparing', progress: 0.05, message: '正在隔离工作区并检查页面图层...' });
  const workspace = await createIsolatedWorkspace(resolvedProject, modules);

  try {
    const stagedMediaDir = join(workspace.workDir, '.film', 'layered-media');
    const reserved = new Set();
    for (const track of workspace.doc.tracks) {
      for (const clip of track.clips) {
        if (typeof clip.src === 'string') {
          reserved.add(basename(clip.src.split(/[?#]/, 1)[0]).toLowerCase());
        }
      }
    }

    onProgress?.({ phase: 'extracting', progress: 0.15, message: '正在拆分 HTML 页面为无文字图形层与可编辑文字层...' });
    const extracted = await extractProjectPageLayers({
      workDir: workspace.workDir,
      doc: workspace.doc,
      markup: workspace.markup,
      stagingMediaDir: stagedMediaDir,
      reservedNames: reserved,
      modules,
      signal,
    });

    /* Rewrite workDir/film.html omitting decomposed/static page clips while keeping all media & animated pure-graphic overlays. */
    const filteredDoc = {
      stage: workspace.doc.stage,
      ...(workspace.doc.keyframes ? { keyframes: workspace.doc.keyframes } : {}),
      tracks: workspace.doc.tracks
        .map((t) => ({
          ...t,
          clips: t.clips.filter((c) => !extracted.replacedClipIds.has(c.id)),
        }))
        .filter((t) => t.captions || t.clips.length > 0),
    };
    await writeFile(join(workspace.workDir, 'film.html'), modules.filmHtml(filteredDoc, workspace.markup), 'utf8');

    /* Safely replace only the exact target draft folder if overwrite is requested. */
    const intendedTarget = resolve(draftsDir, draftName);
    if (overwrite && existsSync(intendedTarget) && dirname(intendedTarget).toLowerCase() === draftsDir.toLowerCase()) {
      await rm(intendedTarget, { recursive: true, force: true });
    }

    onProgress?.({ phase: 'native-export', progress: 0.35, message: '正在调用 OpenFilm 0.4.0 原生引擎导出基础轨道...' });
    const exportsQueue = modules.createExports({
      drafts: (app) => (app === 'jianying' ? draftsDir : null),
      onChange: (job) => {
        if (job.status === 'running') {
          onProgress?.({
            phase: 'native-export',
            progress: Math.min(0.85, 0.35 + (job.progress || 0) * 0.5),
            message: `OpenFilm 原生导出: ${job.phase ?? '处理中'} (${Math.round((job.progress || 0) * 100)}%)`,
          });
        }
      },
    });

    const job = exportsQueue.start(
      { id: 'layered-export', name: draftName, path: workspace.workDir },
      { kind: 'nle', format: 'jianying', fps, audio: 'clips', media: 'copy', subtitles: true, name: draftName },
    );

    const done = await new Promise((resolveDone) => {
      const tick = () => {
        if (signal?.aborted) {
          exportsQueue.cancel(job.id);
        }
        const cur = exportsQueue.list('layered-export').find((j) => j.id === job.id);
        if (cur && ['done', 'failed', 'cancelled'].includes(cur.status)) resolveDone(cur);
        else setTimeout(tick, 120);
      };
      tick();
    });

    if (done.status !== 'done' || !done.out) {
      throw new Error(done.error || `OpenFilm native export ${done.status}`);
    }

    const finalDraftDir = dirname(done.out);
    onProgress?.({ phase: 'patching', progress: 0.88, message: '正在写入独立图形轨与可编辑文字轨...' });

    /* Copy extracted clean graphic PNGs into <finalDraftDir>/media/. */
    const finalMediaDir = join(finalDraftDir, 'media');
    for (const g of extracted.graphics) {
      await copyFile(g.path, join(finalMediaDir, g.fileName));
    }

    /* Resolve font files via OpenFilm 0.4.0 `installedFontFile`. */
    const uniqueFamilies = new Set();
    for (const t of extracted.texts) {
      for (const r of t.runs) {
        if (r.fontFamily) uniqueFamilies.add(r.fontFamily);
      }
      if (t.fontFamily) uniqueFamilies.add(t.fontFamily);
    }

    /** @type {Map<string, { name: string, path: string }>} */
    const fontsByFamily = new Map();
    for (const rawFamily of uniqueFamilies) {
      const names = parseFontFamilies(rawFamily);
      const found = await modules.installedFontFile(names);
      if (found) fontsByFamily.set(rawFamily, found);
    }
    const defaultFont = (await modules.installedFontFile(['Microsoft YaHei', 'PingFang SC', 'SimHei', 'Arial'])) ?? null;

    const infoPath = join(finalDraftDir, 'draft_content.json');
    const draftInfoPath = join(finalDraftDir, 'draft_info.json');
    const metaPath = join(finalDraftDir, 'draft_meta_info.json');

    const info = JSON.parse(await readFile(infoPath, 'utf8'));
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    const nativeTrackSourceIndex = inferNativeTrackSourceIndex(info, workspace.doc);

    patchJianyingDraft({
      info,
      meta,
      draftDir: finalDraftDir,
      graphics: extracted.graphics,
      texts: extracted.texts,
      fontsByFamily,
      defaultFont,
      draftPathPlaceholder: modules.JIANYING_DRAFT_PATH,
      allocateLanes: modules.allocateLanes,
      nativeTrackSourceIndex,
    });

    const serializedInfo = JSON.stringify(info);
    await writeFile(infoPath, serializedInfo, 'utf8');
    await writeFile(draftInfoPath, serializedInfo, 'utf8');
    await writeFile(metaPath, JSON.stringify(meta), 'utf8');

    onProgress?.({ phase: 'done', progress: 1, message: '分层剪映草稿导出完成' });

    const trackSummary = info.tracks.map((/** @type {any} */ t) => ({
      type: t.type,
      flag: t.flag ?? 0,
      name: t.name,
      segments: t.segments?.length ?? 0,
    }));

    return {
      ok: true,
      projectDir: resolvedProject,
      draftDir: finalDraftDir,
      draftName: basename(finalDraftDir),
      graphicsCount: extracted.graphics.length,
      textsCount: extracted.texts.length,
      pageReports: extracted.pageReports,
      tracks: trackSummary,
      subtitleCount: info.materials.texts.filter((/** @type {any} */ m) => m.type === 'subtitle').length,
      editableTextCount: info.materials.texts.filter((/** @type {any} */ m) => m.type === 'text').length,
    };
  } finally {
    await workspace.cleanup();
  }
}
