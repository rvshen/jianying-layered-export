// @ts-check
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  buildTextContentAndMaterial,
  inferNativeTrackSourceIndex,
  jianyingFontSize,
  parseColor,
  patchJianyingDraft,
  stageToJianyingPos,
} from '../lib/export-layered.mjs';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, '..');

test('parseColor parses hex, rgb/rgba, and srgb colors', () => {
  const hex = parseColor('#f5c443');
  assert.equal(hex.hex, '#f5c443');
  assert.equal(hex.alpha, 1);
  assert.deepEqual(hex.rgb.map((v) => Math.round(v * 255)), [245, 196, 67]);

  const rgba = parseColor('rgba(255, 142, 106, 0.5)');
  assert.equal(rgba.hex, '#ff8e6a');
  assert.equal(rgba.alpha, 0.5);

  const srgb = parseColor('color(srgb 1 0 0.5 / 80%)');
  assert.equal(srgb.hex, '#ff0080');
  assert.equal(srgb.alpha, 0.8);
});

test('jianyingFontSize and stageToJianyingPos match OpenFilm 0.4.0 geometry', () => {
  assert.equal(jianyingFontSize(132, 1080, 1920), 17.6);
  assert.equal(jianyingFontSize(56, 1920, 1080), 7.47);
  assert.deepEqual(stageToJianyingPos(540, 960, 1080, 1920), { x: 0, y: 0 });
  assert.deepEqual(stageToJianyingPos(0, 0, 1080, 1920), { x: -1, y: 1 });
  assert.deepEqual(stageToJianyingPos(1080, 1920, 1080, 1920), { x: 1, y: -1 });
});

test('buildTextContentAndMaterial preserves multi-run styles and forward-slash font path', () => {
  const fontsByFamily = new Map([
    ['SongHei', { name: 'SimSun', path: 'C:\\Windows\\Fonts\\simsun.ttc' }],
  ]);
  const { id, material } = buildTextContentAndMaterial(
    {
      id: 'hook-text-1',
      clipId: 'hook',
      name: 'hook-text-1',
      text: '全屋定制\n踩坑实录',
      runs: [
        { text: '全屋定制\n', color: '#fffdf6', bold: true, italic: false, underline: false, fontSize: 132, fontFamily: 'SongHei' },
        { text: '踩坑实录', color: '#ffd9c9', bold: true, italic: false, underline: false, fontSize: 132, fontFamily: 'SongHei' },
      ],
      startMs: 550,
      durMs: 3560,
      x: 540,
      y: 720,
      w: 540,
      h: 280,
      fontSize: 132,
      fontFamily: 'SongHei',
      color: '#fffdf6',
      bold: true,
      italic: false,
      underline: false,
      align: 'left',
      letterSpacing: 0.04,
      lineSpacing: 0,
      wrapped: false,
      rotation: 0,
      opacity: 1,
      visible: true,
      track: 1,
    },
    { stageW: 1080, stageH: 1920, fontsByFamily, defaultFont: null },
  );

  assert.equal(material.id, id);
  assert.equal(material.type, 'text');
  assert.equal(material.add_type, 0);
  assert.equal(material.font_path, 'C:/Windows/Fonts/simsun.ttc');
  const parsed = JSON.parse(material.content);
  assert.equal(parsed.text, '全屋定制\n踩坑实录');
  assert.equal(parsed.styles.length, 2);
  assert.deepEqual(parsed.styles[0].range, [0, 5]);
  assert.deepEqual(parsed.styles[1].range, [5, 9]);
  assert.equal(parsed.styles[1].font.path, 'C:/Windows/Fonts/simsun.ttc');
});

test('patchJianyingDraft preserves z-order, 0.4.0 paths, editable text flag=0, and subtitle flag=1', () => {
  const placeholder = '##_draftpath_placeholder_0E685133-18CE-45ED-8CB8-2904A212EC80_##';
  const info = {
    fps: 30,
    duration: 5_000_000,
    canvas_config: { width: 1080, height: 1920, ratio: 'original' },
    materials: { videos: [], audios: [], speeds: [], texts: [] },
    tracks: [
      { id: 'main-video', type: 'video', flag: 0, name: 'Main', segments: [{ id: 'v1', material_id: 'mv1', target_timerange: { start: 0, duration: 5_000_000 }, render_index: 0 }] },
      { id: 'overlay-mark', type: 'video', flag: 0, name: 'Mark', segments: [{ id: 'v2', material_id: 'mv2', target_timerange: { start: 1_000_000, duration: 2_000_000 }, render_index: 1 }] },
      { id: 'audio-vo', type: 'audio', flag: 0, name: 'VO', segments: [{ id: 'a1', material_id: 'ma1', target_timerange: { start: 0, duration: 5_000_000 }, render_index: 2 }] },
      { id: 'subs', type: 'text', flag: 1, name: 'Subtitles', segments: [{ id: 's1', material_id: 'ms1', target_timerange: { start: 0, duration: 2_000_000 }, render_index: 3 }] },
    ],
  };
  const meta = { draft_materials: [{ type: 0, value: [] }], draft_fold_path: '' };
  const nativeTrackSourceIndex = new Map([
    ['main-video', 7],
    ['overlay-mark', 2],
  ]);

  patchJianyingDraft({
    info,
    meta,
    draftDir: 'D:\\JianyingPro Drafts\\sample-layered',
    draftPathPlaceholder: placeholder,
    nativeTrackSourceIndex,
    defaultFont: { name: 'Microsoft YaHei', path: 'C:\\Windows\\Fonts\\msyh.ttc' },
    graphics: [
      { id: 'g-card', clipId: 'card', name: 'card-graphic', fileName: 'card-graphic.png', path: '/tmp/card.png', startMs: 500, durMs: 3000, w: 960, h: 620, x: 540, y: 920, rotation: 0, opacity: 1, visible: true, track: 1 },
      { id: 'g-scrim', clipId: 'scrim', name: 'scrim-graphic', fileName: 'scrim-graphic.png', path: '/tmp/scrim.png', startMs: 0, durMs: 5000, w: 1080, h: 1920, x: 540, y: 960, rotation: 0, opacity: 1, visible: true, track: 5 },
    ],
    texts: [
      { id: 't1', clipId: 'card', name: 'card-text-1', text: '隐形增项', runs: [{ text: '隐形增项', color: '#211d18', bold: true, italic: false, underline: false, fontSize: 58, fontFamily: 'Microsoft YaHei' }], startMs: 500, durMs: 3000, x: 240, y: 700, w: 230, h: 65, fontSize: 58, fontFamily: 'Microsoft YaHei', color: '#211d18', bold: true, italic: false, underline: false, align: 'left', letterSpacing: 0.03, lineSpacing: 0.02, wrapped: false, rotation: 0, opacity: 1, visible: true, track: 1 },
    ],
    now: 1700000000000,
  });

  const videoTrackOrder = info.tracks.filter((t) => t.type === 'video').map((t) => t.id);
  // Expect Track 7 (main-video) -> Track 5 (scrim) -> Track 2 (overlay-mark) -> Track 1 (card)
  assert.equal(videoTrackOrder[0], 'main-video');
  assert.equal(videoTrackOrder[2], 'overlay-mark');
  assert.equal(info.tracks.filter((t) => t.type === 'video')[1].segments[0].material_id !== 'mv2', true);

  const cardMat = info.materials.videos.find((m) => m.material_name === 'card-graphic.png');
  assert.equal(cardMat.path, `${placeholder}/media/card-graphic.png`);
  assert.equal(cardMat.type, 'photo');
  const libEntry = meta.draft_materials[0].value.find((m) => m.extra_info === 'card-graphic.png');
  assert.equal(libEntry.file_Path, './media/card-graphic.png');

  const textTrack = info.tracks.find((t) => t.type === 'text' && t.flag === 0);
  const subTrack = info.tracks.find((t) => t.type === 'text' && t.flag === 1);
  assert.ok(textTrack);
  assert.ok(subTrack);
  assert.ok(subTrack.segments[0].render_index > textTrack.segments[0].render_index);
  assert.equal(meta.draft_fold_path, 'D:/JianyingPro Drafts/sample-layered');

  const inferred = inferNativeTrackSourceIndex(
    {
      materials: { videos: [{ id: 'c1', material_name: 'captions-abcd1234.mov' }] },
      tracks: [{ id: 'cap-track', type: 'video', segments: [{ material_id: 'c1' }] }],
    },
    { tracks: [{ captions: { src: 'captions.vtt' }, clips: [] }, { clips: [{ id: 'hook', src: 'hook.html' }] }] },
  );
  assert.equal(inferred.get('cap-track'), 0);
});

test('E2E CLI exports layered MVP sample with OpenFilm 0.4.0 native draft format', { timeout: 90_000 }, async () => {
  const sampleProject = join(HERE, 'fixtures', 'jianying-layered-mvp', 'project');
  if (!existsSync(sampleProject)) return;

  const tempDrafts = await mkdtemp(join(tmpdir(), 'openfilm-plugin-e2e-'));
  const tempProject = await mkdtemp(join(tmpdir(), 'openfilm-plugin-proj-'));
  try {
    await cp(sampleProject, tempProject, { recursive: true });
    const rawFilm = await readFile(join(tempProject, 'film.html'), 'utf8');
    await writeFile(
      join(tempProject, 'film.html'),
      rawFilm.replace('<body>', '<body>\n<section>\n  <track kind="captions" src="assets/vo.vtt" srclang="zh-CN" label="中文">\n</section>'),
      'utf8',
    );

    const { stdout } = await execFileP(
      process.execPath,
      [
        join(PLUGIN_DIR, 'bin', 'export.mjs'),
        '--project', tempProject,
        '--drafts-dir', tempDrafts,
        '--name', 'mvp-e2e-test',
        '--overwrite',
        '--json',
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );

    const summary = JSON.parse(stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.graphicsCount, 1);
    assert.equal(summary.editableTextCount, 1);
    assert.equal(summary.subtitleCount, 1);

    const draftDir = join(tempDrafts, 'mvp-e2e-test');
    const content = JSON.parse(await readFile(join(draftDir, 'draft_content.json'), 'utf8'));
    const meta = JSON.parse(await readFile(join(draftDir, 'draft_meta_info.json'), 'utf8'));

    const graphicFile = summary.pageReports[0].graphicFile;
    assert.equal(graphicFile, 'overlay-graphic.png');
    assert.equal(meta.draft_name, 'mvp-e2e-test');
    assert.ok(existsSync(join(draftDir, 'media', graphicFile)));
    assert.ok(content.materials.videos.some((m) => m.type === 'photo' && m.path.startsWith('##_draftpath_placeholder_')));
    assert.ok(meta.draft_materials[0].value.some((m) => m.file_Path === `./media/${graphicFile}`));
    assert.ok(content.tracks.some((t) => t.type === 'text' && t.flag === 0));
    assert.ok(content.tracks.some((t) => t.type === 'text' && t.flag === 1));
  } finally {
    await rm(tempDrafts, { recursive: true, force: true }).catch(() => {});
    await rm(tempProject, { recursive: true, force: true }).catch(() => {});
  }
});
