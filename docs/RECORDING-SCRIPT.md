# Recording script — the tab-edit tour

Everything you need to shoot the README's five GIFs and the 90-second video, in
order, without thinking about it on the day. Total shooting time: ~30 minutes,
including retakes.

Each shot below has: **what the viewer must understand**, the exact keystrokes,
and the file it becomes. The README already has slots for every file — record,
drop the files into `docs/media/`, uncomment the matching `<img>` line, delete the
italic placeholder underneath it, push.

---

## 0. Setup (do this once, 5 min)

**Environment**

```bash
# terminal 1 — the session host
cd remote/host && npm run dev-server

# terminal 2 — the app
cd cm-adapter && npm run app          # http://localhost:5173
```

Or just record against the deployed site once it's live — it looks the same and
saves a terminal.

**Window**

- Browser window at **1440 × 900**, zoom **100%** (⌘0). No bookmarks bar, no
  extensions bar, no other tabs. Hide the OS dock (⌥⌘D).
- macOS: System Settings → Appearance → **Dark** (the app is dark; a light
  system chrome frame around it looks accidental).
- Turn off notifications: **Focus → Do Not Disturb**. One Slack toast ruins a take.
- Font size in the editor is fine at default — the GIF is 900px wide, text stays
  legible.

**Recording tools**

| job | tool | why |
|---|---|---|
| screen capture | **QuickTime → New Screen Recording**, or OBS | QuickTime is fine for silent GIF source |
| video with voice | OBS (or QuickTime + built-in mic) | one take, narration below |
| GIF conversion | `ffmpeg` + `gifski` | best quality per KB |

```bash
brew install ffmpeg gifski     # once
```

**Convert a clip to a README-ready GIF** (900px wide, 20 fps, small):

```bash
ffmpeg -i shot1.mov -vf "fps=20,scale=900:-1:flags=lanczos" -f yuv4mpegpipe - \
  | gifski -o docs/media/hero.gif --fps 20 --quality 90 -
```

Aim for **under ~6 MB** per GIF (GitHub renders bigger ones, but they load slowly
on mobile). If one is too big: shorten it, or drop to `fps=15`.

**Cursor**: keep mouse movement minimal and deliberate. Most shots are typing.

---

## Shot 1 — HERO → `docs/media/hero.gif` (~12 s)

> **What the viewer must understand in 12 seconds:** I type ASCII tab, and music
> comes out.

This is the one people see before they read a word. Nothing else matters as much.

1. Start the app, pick **Blackbird (starter)** from the sample dropdown. Let the
   sheet render. **Pause 1 s** so the viewer sees the "before".
2. Click at the end of the first system's top line, inside the bar.
3. Type these characters at a **steady, human speed** (about 4/second — do not
   rush; the point is that the notation keeps up):

   ```
   --5--7--
   ```

   The staff on the right updates as you type. That's the money moment.
4. Press <kbd>Space</kbd>. Let it play ~3 seconds — the editor selection and the
   sheet cursor move together.
5. Press <kbd>Space</kbd> again to stop. Hold the last frame ~1 s.

**Retake if:** the sheet lagged more than a beat behind your typing (usually
means something else was hogging CPU — close other apps), or your cursor wandered.

---

## Shot 2 — NOTATION → `docs/media/notation.gif` (~8 s)

> **Understand:** the notation is derived, live, from the text — not drawn by hand.

1. Start from the starter tab, sheet rendered, in **TAB** mode.
2. Type a run of frets into one line: `-0-2-3-5-7-`, one character at a time.
3. Click **standard notation** (top-right of the Sheet pane). Let it re-render.
4. Hold 1 s on the standard staff.

**Tip:** the toggle is the punchline here — same text, two engravings.

---

## Shot 3 — PLAYBACK → `docs/media/playback.gif` (~15 s)

> **Understand:** it plays, it follows, and a selection means "just this bit".

1. Load a sample with obvious rhythm — **Backbeat (drums)** or **Tom Sawyer
   (drums)** reads best visually; a guitar sample sounds best if you're also
   capturing audio for the video.
2. Press <kbd>Space</kbd>. Let it play ~5 s: point out (visually) that the editor
   selection and the sheet cursor both track the music.
3. Press <kbd>Space</kbd> to pause.
4. **Drag a rectangle** across 2–3 bars (plain drag, no modifier — it's a column
   selection).
5. Press <kbd>Space</kbd>. Only that region plays. Let it finish.

**Retake if:** the drag selected whole lines instead of a column block — start the
drag inside the lattice, not in the left margin.

---

## Shot 4 — FIX → `docs/media/fix.gif` (~10 s)

> **Understand:** it finds the mistake and can repair it for me.

1. Load the starter tab. Find a named line, e.g. `E|`.
2. **Delete the string name** — put the caret after `E`, press Backspace. The line
   is now unnamed.
3. Wait ~1 s: a diagnostic tint appears on that line and a marker shows in the
   gutter.
4. **Hover** the tinted text so the tooltip appears — the message says the line is
   unnamed while its neighbours are named.
5. Click the fix action (**Name this line "E"**). The letter reappears, the tint
   clears. Hold 1 s.

**Retake if:** the tooltip didn't appear before you clicked — hover a beat longer;
this is the shot's whole point.

---

## Shot 5 — EXPORT → `docs/media/export.gif` (~12 s)

> **Understand:** the output is a real file that real software opens.

1. In the app: **Export MusicXML**. The browser download appears.
2. Cut (or just continue) to **MuseScore**: File → Open → the downloaded
   `tab.musicxml`.
3. Let MuseScore render. Hold 2 s on the score.
4. Optional and very effective: hit play in MuseScore for 2 s.

**Note:** this shot spans two apps, so record it as one continuous screen capture
of the full display, then crop in post if needed. Keep the MuseScore window at a
similar size to the browser so the GIF doesn't jump scale.

---

## The 90-second video

Same shots, in the same order, with narration. Record **video and audio in one
take** if you can — natural beats polished, and the whole thing is 90 seconds.

### Narration script

> *(00:00 — the editor with a tab on screen)*
> "This is guitar tab. Every guitarist can read it, and every piece of music
> software treats it as plain text."
>
> *(00:08 — start typing frets; notation updates)*
> "tab-edit reads it as music. The columns are time, the numbers are frets on
> named strings — so as I type, this is a real score."
>
> *(00:20 — press play; cursors follow)*
> "Which means it plays. The editor and the notation follow the same playhead."
>
> *(00:32 — drag a column selection, play again)*
> "Selections are time and voice, not characters — so I can loop just these two
> bars, or solo one string."
>
> *(00:45 — delete a line name; diagnostic appears; apply the fix)*
> "It knows when something's off, and when the fix is obvious, it just does it."
>
> *(00:58 — load a messy real-world tab from the samples)*
> "And it's built for the tabs people actually post — chord rows, lyrics, count
> rows, repeats, weird tunings. The parser is tested against a corpus of real,
> unedited files."
>
> *(01:12 — export; MuseScore opens the file)*
> "When you're done: MusicXML and MIDI that open in MuseScore, or any DAW —
> hammer-ons, slides and bends included."
>
> *(01:25 — back to the editor, hold)*
> "No note entry. No project format. Just the tab you'd have typed anyway.
> Link's below — try it."

### Delivery notes

- **Don't sell.** Describe. The demo is the argument; the voice just points.
- Keep the mouse still while you talk. Movement pulls the eye off the text.
- One breath between sentences — silence is fine, and makes editing easy.
- If you fluff a line, pause 2 s and say it again from the start of the sentence.
  Trivial to cut.

### Publish

1. Upload to YouTube (unlisted is fine to start) or Loom.
2. Grab a thumbnail frame — the moment notation appears is the best one — and
   save it as `docs/media/video-thumb.jpg` (1280 × 720).
3. In the README's **🎥 Watch it** section: uncomment the badge line, replace
   `REPLACE_ME` with the video id, delete the italic placeholder.

---

## Final checklist

- [ ] `docs/media/hero.gif` (< ~6 MB) — README hero slot uncommented
- [ ] `docs/media/notation.gif`
- [ ] `docs/media/playback.gif`
- [ ] `docs/media/fix.gif`
- [ ] `docs/media/export.gif`
- [ ] `docs/media/video-thumb.jpg` + video URL in the README
- [ ] Every italic `🎬 …` placeholder line deleted
- [ ] The live link at the top of the README points at the deployed app
- [ ] Open the README on **GitHub mobile** once — that's where most first
      impressions happen
