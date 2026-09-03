# ComfyUI Video Crop & Trim (FFmpeg)

A ComfyUI custom node for pixel-precise, interactive video cropping and time-range trimming - powered by FFmpeg. Draw your crop region directly on a live video preview inside the node, trim by seconds or frame number, and output both video frames and synchronised audio ready for downstream nodes like VHS Video Combine.

---

## Features

**Flexible input**
- Upload a video directly from the node with the **📁 Upload Your Video** button
- Connect a ComfyUI `IMAGE` tensor from any upstream node

**Interactive crop editor**
- Live first-frame preview rendered inside the node canvas
- Draw a new crop region by dragging on empty canvas
- Move the region by dragging inside it
- Resize from any corner handle
- Double-click or press **Reset Crop** to snap back to the full frame
- Rule-of-thirds grid always visible inside the crop region

**Crop output preview**
- Press **🔍 Preview Crop Output** button to fill the canvas with only the cropped region, letterboxed to the correct aspect ratio, so you can verify framing before running the workflow
- Press **⊞ Back to Full Frame** button to return to the editor

**Playback**
- Off-screen `<video>` element streams the source file directly in the node
- Play / pause button and a scrubbable progress bar with time and frame-number display

**Trimming**
- `none` - keep the whole file
- `seconds` - set `trim_start` / `trim_end` in seconds
- `frames` - set `trim_start` / `trim_end` as frame indices

**Audio**
- `strip` - discard audio, output video frames only
- `extract` - trim audio to exactly match the video clip and return it as a standard ComfyUI `AUDIO` tensor (compatible with VHS Video Combine and other audio nodes)

- The info bar shows the detected audio codec, channel count, and sample rate

**Encoding**
- Output formats: `mp4`, `webm`, `avi`, `mov`
- Codecs: `libx264`, `libx265`, `libvpx-vp9`, `prores`
- CRF quality control for H.264 / H.265 / VP9
- Extra FFmpeg argument passthrough for anything else (`-preset fast -tune film -movflags +faststart` etc.)

**Node resizing**
- The preview canvas scales with the node; drag any corner to give yourself more room
- Minimizing node width folds some menus

---

## Installation

**Required**

1. Install ffmpeg if not already installed:

   ```bash
   pip install ffmpeg-python
   ``` 

2. Make sure `ffmpeg` is installed on your system and available on `$PATH`.

**Via ComfyUI Manager** (recommended)

Search for `Video Crop & Trim` and click Install. 

**Manual**

1. Copy the `comfyui-video-crop-trim` folder into your `ComfyUI/custom_nodes/` directory.

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/RiverSide71/comfyui-video-crop-trim
```

2. Restart ComfyUI.

---

## Requirements

| Package | Notes |
|---|---|
| `ffmpeg-python` | Python bindings for FFmpeg |
| `ffmpeg` | System binary - must be on `PATH` |
| `Pillow` | Frame extraction / tensor conversion |
| `numpy` | Tensor math |
| `torch` | Provided by ComfyUI |

Install Python dependencies (Only if not already installed):

```bash
pip install ffmpeg-python Pillow numpy
```

Install the FFmpeg system binary if you don't already have it:

```bash
# macOS
brew install ffmpeg

# Ubuntu / Debian
sudo apt install ffmpeg

# Windows - download a build from https://ffmpeg.org/download.html
# and add the bin/ folder to your PATH
```
---

## Node reference

The node lives under **video/processing** in the ComfyUI node menu.

### Inputs

| Name | Type | Description |
|---|---|---|
| `crop_x` | INT | Left edge of the crop region in pixels (even numbers only) |
| `crop_y` | INT | Top edge of the crop region in pixels (even numbers only) |
| `crop_width` | INT | Width of the crop region in pixels (even numbers only) |
| `crop_height` | INT | Height of the crop region in pixels (even numbers only) |
| `trim_start` | FLOAT | Start of the kept region |
| `trim_end` | FLOAT | End of the kept region (`0` = until end of file) |
| `output_format` | dropdown | `mp4` / `webm` / `avi` / `mov` |
| `codec` | dropdown | `libx264` / `libx265` / `libvpx-vp9` / `prores` |
| `quality` | INT | CRF value - lower is better quality / larger file (0–51) |
| `fps` *(optional)* | FLOAT | Output framerate; auto-detected from file when possible |
| `extra_ffmpeg_args` *(optional)* | STRING | Raw FFmpeg output flags, e.g. `-preset fast -tune film` |
| `audio_mode` *(optional)* | dropdown | `strip` / `extract` (default) |

### Outputs

| Name | Type | Description |
|---|---|---|
| `frames` | IMAGE | Cropped / trimmed video as a `(B, H, W, C)` float32 tensor |
| `audio` | AUDIO | Trimmed audio as `{ waveform: Tensor(1, C, T), sample_rate: int }` - `None` when `audio_mode` is `strip` or the source has no audio |

---

## Usage examples

### Basic crop and save

```
📁 Upload Your Video
        ↓
Video Crop & Trim  →  frames  →  VHS Video Combine  →  saved file
```

1. Click **📁 Upload Your Video** to load your file. The first frame appears in the node canvas automatically.
2. Drag on the canvas to draw your crop region, or adjust the `crop_x` / `crop_y` / `crop_width` / `crop_height` widgets by hand.
3. Click **🔍 Preview Crop Output** to verify framing, then click **⊞ Back to Full Frame** to continue editing.
4. Connect `frames` → VHS Video Combine and queue the prompt.

### Crop + trim + audio for VHS Video Combine

```
Video Crop & Trim
    ├─ frames  →  [images]  VHS Video Combine  →  saved file
    └─ audio   →  [audio]   ↗
```

1. Set `audio_mode` to `extract`.
2. Set `trim_mode` to `seconds` and fill in `trim_start` / `trim_end`.
3. Connect both `frames` and `audio` outputs to VHS Video Combine. The audio is automatically trimmed to match the video segment.

### Re-encode footage from an upstream node

Connect any ComfyUI `IMAGE` tensor (e.g., from an Interpolation or Upscale node) directly to the `images` input. The tensor is encoded to a temporary file first, then cropped, trimmed, and returned as a new tensor.

---

## Keyboard shortcuts / mouse actions (canvas)

| Action | Result |
|---|---|
| Drag on empty area | Draw a new crop rectangle |
| Drag inside crop rect | Move the region |
| Drag a corner handle | Resize from that corner |
| Double-click | Reset crop to full frame |

---

## Tips

- FFmpeg requires even pixel dimensions for most codecs. Odd values are automatically rounded down by one pixel.
- `trim_end = 0` means "until the end of the file" regardless of trim mode.
- Extra FFmpeg args override any conflicting built-in flags, so you can force specific encoder settings without touching the source code.
- When connecting an IMAGE tensor via the `video` input, audio extraction is not available (there is no audio in a tensor). Set `audio_mode` to `strip` in this case.
- If you get a widget-order validation error after updating the node, delete the node from your workflow and re-add it - this resets the saved widget slot positions.

---

## License

MIT
