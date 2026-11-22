---
name: jianying-layered-export
description: Export an OpenFilm project as a Jianying Pro draft where HTML overlay graphics and text are split into independent graphic and editable text tracks instead of being burned into video.
---

# Jianying Layered Export (剪映分层导出)

This plugin extends OpenFilm's native Jianying Pro (`剪映`) draft export. Native video, photo, audio, and caption tracks are exported using OpenFilm's own exporter, while `<iframe>` HTML pages containing text are decomposed into:

1. **Clean Graphic Overlay Tracks (`Graphics`)**: transparent PNG graphics with all text glyphs hidden (zero burned-in text).
2. **Editable Text Tracks (`Text`)**: native Jianying `type: "text"` (`flag: 0`) segments preserving text, inline color/weight spans, position, font size, rotation, and timing — separate from `flag: 1` subtitle tracks.
3. **Pure-Graphic Overlay Pages**: `<iframe>` pages without text (such as animated rings, scrims, or dim layers) remain as independent transparent video overlays.

## CLI Usage

```bash
openfilm jianying-layered-export --project <project-dir> [--drafts-dir <jianying-drafts-dir>] [--name <draft-name>] [--fps 30] [--overwrite] [--json]
```

Or run directly with Node:

```bash
node bin/export.mjs --project "<project-dir>" --drafts-dir "D:\JianyingPro Drafts" --name "<draft-name>" --overwrite
```

## Jianying Pro Note

If Jianying Pro is already open when exporting a new draft folder, **fully close and reopen Jianying Pro** so it scans the drafts directory and shows the new draft on the home screen.
