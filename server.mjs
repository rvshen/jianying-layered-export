// @ts-check
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureOpenFilmEnv, ensureElectronRuntime, loadOpenFilmModules } from './lib/openfilm-runtime.mjs';

const SELF = fileURLToPath(import.meta.url);
if (await ensureElectronRuntime(SELF, process.argv.slice(2))) {
  process.exit(process.exitCode ?? 0);
}

configureOpenFilmEnv();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 0);
const DEFAULT_PROJECT = process.env.OPENFILM_PROJECT || '';

/** @type {{ state: 'idle' | 'running' | 'done' | 'error', phase: string, progress: number, message: string, result?: any, error?: string }} */
let currentJob = { state: 'idle', phase: 'idle', progress: 0, message: '' };

function readBody(/** @type {import('node:http').IncomingMessage} */ req) {
  return new Promise((resolveBody, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const txt = Buffer.concat(chunks).toString('utf8').trim();
        resolveBody(txt ? JSON.parse(txt) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(/** @type {import('node:http').ServerResponse} */ res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function renderHtml(projectDir) {
  const safeName = projectDir ? basename(projectDir).replace(/[<>&"]/g, '') : '';
  const defaultDraftName = safeName ? `${safeName}-分层版` : 'openfilm-layered';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>剪映分层导出 · Jianying Layered Export</title>
<style>
  :root {
    --bg: #111215;
    --panel: #191b20;
    --border: #2a2d35;
    --text: #eef0f4;
    --muted: #9aa0ae;
    --accent: #3b82f6;
    --ok: #22c55e;
    --warn: #f59e0b;
    --err: #ef4444;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 14px;
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    line-height: 1.5;
  }
  .wrap { max-width: 780px; margin: 0 auto; display: grid; gap: 16px; }
  .card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 12px; padding: 18px 20px;
  }
  h1 { margin: 0 0 6px; font-size: 20px; }
  p.sub { margin: 0; color: var(--muted); font-size: 13px; }
  label { display: block; font-size: 13px; color: var(--muted); margin: 12px 0 6px; }
  input[type=text], input[type=number] {
    width: 100%; padding: 9px 12px; border-radius: 8px;
    border: 1px solid var(--border); background: #0d0e11; color: var(--text);
    font-size: 14px;
  }
  .row { display: flex; gap: 12px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
  .btn {
    background: var(--accent); color: #fff; border: 0; border-radius: 8px;
    padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-ghost {
    background: transparent; border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: 9px 14px; font-size: 13px; cursor: pointer;
  }
  .pill { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 99px; background: #232732; color: var(--muted); }
  .pill.ok { background: rgba(34,197,94,.16); color: #4ade80; }
  .pill.warn { background: rgba(245,158,11,.16); color: #fbbf24; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  .status { font-size: 13px; color: var(--muted); margin-top: 10px; white-space: pre-wrap; }
  .notice { font-size: 12px; color: var(--warn); background: rgba(245,158,11,.08); border: 1px solid rgba(245,158,11,.25); padding: 10px 12px; border-radius: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>剪映分层导出（图形 + 可编辑文字）</h1>
    <p class="sub">基于 OpenFilm 0.4.0 原生剪映草稿导出，自动把 HTML 页面拆分为独立透明图形轨与剪映原生可编辑文字轨，不再烧录进视频。</p>
  </div>

  <div class="card">
    <label>当前 OpenFilm 工程目录</label>
    <input id="projectDir" type="text" value="${projectDir.replace(/"/g, '&quot;')}">
    <div class="row">
      <div style="flex:1;min-width:140px">
        <label>草稿名称</label>
        <input id="draftName" type="text" value="${defaultDraftName.replace(/"/g, '&quot;')}">
      </div>
      <div style="width:120px">
        <label>帧率 (fps)</label>
        <input id="fps" type="number" value="30" min="1" max="120">
      </div>
    </div>
    <div class="row">
      <label style="display:flex;align-items:center;gap:8px;margin:0;color:var(--text);cursor:pointer">
        <input id="overwrite" type="checkbox" checked> 覆盖同名旧草稿（仅替换目标草稿，不动其他草稿）
      </label>
    </div>
    <div class="row">
      <button id="inspectBtn" class="btn-ghost" type="button">检查工程页面</button>
      <button id="exportBtn" class="btn" type="button">一键导出分层剪映草稿</button>
    </div>
    <div id="statusBox" class="status"></div>
  </div>

  <div id="previewCard" class="card" style="display:none">
    <strong>页面拆层预览</strong>
    <div id="previewBody"></div>
  </div>

  <div class="notice">
    提示：如果剪映 Pro 当前正在运行，导出完成后请<strong>先完全退出并重启剪映 Pro</strong>，新的草稿就会出现在剪映首页列表中。
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
async function inspectProject() {
  const projectDir = $('projectDir').value.trim();
  $('statusBox').textContent = '正在分析 film.html 页面结构...';
  const res = await fetch('/api/inspect?project=' + encodeURIComponent(projectDir));
  const data = await res.json();
  if (!res.ok) { $('statusBox').textContent = '检查失败: ' + (data.error || res.status); return; }
  $('previewCard').style.display = 'block';
  const rows = (data.pages || []).map(p =>
    '<tr><td>' + p.id + '</td><td>' + p.src + '</td><td>track ' + p.track + '</td></tr>'
  ).join('');
  $('previewBody').innerHTML =
    '<p class="sub">画布: ' + data.stage.w + '×' + data.stage.h + ' · 检测到 ' + data.pages.length + ' 个 HTML 页面片段</p>' +
    (rows ? '<table><thead><tr><th>Clip ID</th><th>页面</th><th>轨道</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="sub">未发现 iframe HTML 页面片段。</p>');
  $('statusBox').textContent = '检查完成，点击「一键导出分层剪映草稿」开始。';
}

async function runExport() {
  $('exportBtn').disabled = true;
  $('statusBox').textContent = '正在启动分层导出...';
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectDir: $('projectDir').value.trim(),
        name: $('draftName').value.trim(),
        fps: Number($('fps').value) || 30,
        overwrite: $('overwrite').checked,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('statusBox').textContent = '导出失败: ' + (data.error || res.status);
      $('exportBtn').disabled = false;
      return;
    }
    const timer = setInterval(async () => {
      const s = await (await fetch('/api/status')).json();
      if (s.state === 'running') {
        $('statusBox').textContent = '[' + Math.round((s.progress || 0) * 100) + '%] ' + (s.message || s.phase);
      } else {
        clearInterval(timer);
        $('exportBtn').disabled = false;
        if (s.state === 'done' && s.result) {
          const r = s.result;
          $('statusBox').textContent =
            '导出成功！\\n草稿目录: ' + r.draftDir +
            '\\n图形 PNG: ' + r.graphicsCount + ' 个 · 可编辑文字: ' + r.editableTextCount + ' 段 · 字幕: ' + r.subtitleCount + ' 条';
        } else {
          $('statusBox').textContent = '导出失败: ' + (s.error || '未知错误');
        }
      }
    }, 400);
  } catch (err) {
    $('statusBox').textContent = '请求出错: ' + err.message;
    $('exportBtn').disabled = false;
  }
}

$('inspectBtn').addEventListener('click', inspectProject);
$('exportBtn').addEventListener('click', runExport);
if ($('projectDir').value.trim()) inspectProject();
</script>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderHtml(DEFAULT_PROJECT));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, currentJob);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/inspect') {
      const target = resolve(url.searchParams.get('project') || DEFAULT_PROJECT);
      const filmPath = join(target, 'film.html');
      if (!target || !existsSync(filmPath)) {
        sendJson(res, 404, { error: `找不到 film.html: ${target}` });
        return;
      }
      const modules = await loadOpenFilmModules();
      const parsed = modules.readFilmFile(readFileSync(filmPath, 'utf8'));
      if (!parsed.doc) {
        sendJson(res, 400, { error: parsed.problems?.[0] || 'film.html 解析失败' });
        return;
      }
      const pages = [];
      parsed.doc.tracks.forEach((t, ti) => {
        for (const c of t.clips) {
          if (modules.kindOf(c) === 'page') pages.push({ id: c.id, src: c.src, track: ti });
        }
      });
      sendJson(res, 200, { projectDir: target, stage: parsed.doc.stage, pages });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/export') {
      if (currentJob.state === 'running') {
        sendJson(res, 409, { error: '已有导出任务正在运行' });
        return;
      }
      const body = await readBody(req);
      const target = resolve(String(body.projectDir || DEFAULT_PROJECT));
      if (!target || !existsSync(join(target, 'film.html'))) {
        sendJson(res, 400, { error: `找不到 film.html: ${target}` });
        return;
      }
      const { exportLayeredJianying } = await import('./lib/export-layered.mjs');
      currentJob = { state: 'running', phase: 'preparing', progress: 0.02, message: '正在准备导出...' };
      void exportLayeredJianying({
        projectDir: target,
        draftsDir: body.draftsDir || undefined,
        name: body.name || undefined,
        fps: Number(body.fps) || 30,
        overwrite: body.overwrite !== false,
        onProgress: (info) => {
          currentJob = {
            state: 'running',
            phase: info.phase,
            progress: info.progress,
            message: info.message || info.phase,
          };
        },
      }).then((result) => {
        currentJob = { state: 'done', phase: 'done', progress: 1, message: '导出完成', result };
      }).catch((err) => {
        currentJob = { state: 'error', phase: 'error', progress: 0, message: err.message, error: err.message };
      });
      sendJson(res, 202, { accepted: true });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`Jianying Layered Export plugin listening on http://${HOST}:${actualPort}/`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, shutdown);
