"""
Video Crop & Trim (FFmpeg) - ComfyUI Custom Node
-------------------------------------------------
Provides pixel-precise visual cropping and time/frame-range trimming
of video files.  Accepts either a connected IMAGE tensor (frames) or
a raw file path typed directly into the node, so no separate Load Video
node is required.  An optional AUDIO input lets it take the images/audio
pair straight out of a "Get Video Components" node.

A lightweight HTTP endpoint (/videocropptrim/preview_frame) is also
registered so the frontend JavaScript widget can pull a first-frame
preview for the interactive crop selector.
"""

import os
import base64
import shlex
import tempfile

import ffmpeg
import folder_paths
import numpy as np
import torch
from PIL import Image

try:
    from aiohttp import web
    from server import PromptServer
    _HAS_SERVER = True
except ImportError:          # Running outside ComfyUI (unit tests, etc.)
    _HAS_SERVER = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_video_path(raw_path: str) -> str | None:
    """
    Accept an absolute path or one relative to ComfyUI's input directory.
    Returns the resolved path if it exists, otherwise None.
    """
    if not raw_path:
        return None
    if os.path.exists(raw_path):
        return raw_path
    candidate = os.path.join(folder_paths.get_input_directory(), raw_path)
    if os.path.exists(candidate):
        return candidate
    return None


def _probe_video(video_path: str) -> dict:
    """Return basic metadata for a video file (width, height, fps, duration, frames, audio)."""
    try:
        probe = ffmpeg.probe(video_path)
        vs = next((s for s in probe["streams"] if s["codec_type"] == "video"), None)
        if vs is None:
            return {}
        num, den = vs.get("r_frame_rate", "30/1").split("/")
        fps = float(num) / float(den) if float(den) else 30.0
        nb_frames = int(vs.get("nb_frames", 0))
        duration = float(probe["format"].get("duration", 0))
        if nb_frames == 0 and fps > 0:
            nb_frames = int(duration * fps)

        # Audio stream detection
        as_ = next((s for s in probe["streams"] if s["codec_type"] == "audio"), None)
        return {
            "width":             int(vs.get("width", 0)),
            "height":            int(vs.get("height", 0)),
            "fps":               fps,
            "duration":          duration,
            "nb_frames":         nb_frames,
            "has_audio":         as_ is not None,
            "audio_codec":       as_.get("codec_name", "unknown") if as_ else None,
            "audio_sample_rate": int(as_.get("sample_rate", 0))   if as_ else 0,
            "audio_channels":    int(as_.get("channels", 0))       if as_ else 0,
        }
    except Exception:
        return {}


def _tensor_to_video(tensor: torch.Tensor, output_path: str, fps: float) -> None:
    """
    Save a ComfyUI IMAGE tensor (B, H, W, C) as a temporary video file
    by writing individual PNG frames then encoding with ffmpeg.
    """
    if tensor.ndim != 4:
        raise ValueError(f"Expected 4-D tensor [B,H,W,C], got {tensor.ndim}-D")

    frame_dir = os.path.dirname(output_path)
    frame_pat = os.path.join(frame_dir, "in_%06d.png")
    batch = tensor.shape[0]

    for i in range(batch):
        frame = tensor[i]
        if frame.dtype in (torch.float16, torch.float32, torch.float64):
            frame = (frame * 255).clamp(0, 255).byte()
        arr = frame.cpu().numpy().astype(np.uint8)
        channels = arr.shape[-1] if arr.ndim == 3 else 1
        mode = {3: "RGB", 4: "RGBA"}.get(channels, "L")
        img = Image.fromarray(arr.squeeze() if channels == 1 else arr, mode)
        img.save(frame_pat % (i + 1))

    (
        ffmpeg
        .input(frame_pat, framerate=fps)
        .output(output_path, vcodec="libx264", pix_fmt="yuv420p")
        .run(overwrite_output=True, quiet=True)
    )


def _video_to_tensor(video_path: str, frame_dir: str) -> torch.Tensor:
    """Extract every frame of a video into a (B, H, W, C) float32 tensor."""
    frame_pat = os.path.join(frame_dir, "out_%06d.png")
    (
        ffmpeg
        .input(video_path)
        .output(frame_pat)
        .run(overwrite_output=True, quiet=True)
    )

    frames = []
    idx = 1
    while True:
        p = frame_pat % idx
        if not os.path.exists(p):
            break
        img = Image.open(p).convert("RGB")
        frames.append(np.array(img, dtype=np.float32) / 255.0)
        idx += 1

    if not frames:
        raise RuntimeError("No frames could be extracted from the output video.")
    return torch.from_numpy(np.stack(frames))   # (B, H, W, C)


def _parse_extra_args(extra: str) -> dict:
    """
    Convert a string like '-preset fast -tune film' into a dict that
    ffmpeg-python's output() can consume as keyword arguments.
    Flags without values are stored as empty-string values.
    """
    result = {}
    if not extra.strip():
        return result
    parts = shlex.split(extra.strip())
    i = 0
    while i < len(parts):
        token = parts[i]
        if token.startswith("-"):
            key = token.lstrip("-")
            # Peek at next token: if it doesn't start with '-', it's the value
            if i + 1 < len(parts) and not parts[i + 1].startswith("-"):
                result[key] = parts[i + 1]
                i += 2
            else:
                result[key] = ""
                i += 1
        else:
            i += 1
    return result


def _trim_audio_tensor(audio: dict, start_s: float, end_s: float) -> dict:
    """
    Slice a ComfyUI AUDIO dict { "waveform": Tensor(1, C, T), "sample_rate": int }
    down to the [start_s, end_s) window (seconds). end_s <= start_s (including
    the default 0.0) means "until the end of the audio", matching trim_end's
    "0 = until end of video" convention.
    """
    waveform    = audio["waveform"]
    sample_rate = audio["sample_rate"]
    total       = waveform.shape[-1]

    start_idx = min(max(0, int(round(start_s * sample_rate))), total)
    end_idx   = min(int(round(end_s * sample_rate)), total) if end_s > start_s else total
    end_idx   = max(end_idx, start_idx)

    return {"waveform": waveform[..., start_idx:end_idx], "sample_rate": sample_rate}


def _load_audio_tensor(wav_path: str) -> dict:
    """
    Read a 16-bit PCM WAV produced by ffmpeg and return a ComfyUI AUDIO dict:
        { "waveform": Tensor(1, C, T),  "sample_rate": int }

    Uses only Python stdlib + numpy + torch — no extra dependencies.
    """
    import wave

    with wave.open(wav_path, "rb") as wf:
        sr         = wf.getframerate()
        channels   = wf.getnchannels()
        sampwidth  = wf.getsampwidth()
        n_frames   = wf.getnframes()
        raw        = wf.readframes(n_frames)

    dtype_map = {1: np.uint8, 2: np.int16, 4: np.int32}
    dtype = dtype_map.get(sampwidth, np.int16)
    data  = np.frombuffer(raw, dtype=dtype)

    # Reshape to (samples, channels)
    if channels > 1:
        data = data.reshape(-1, channels)
    else:
        data = data[:, np.newaxis]

    # Normalise to float32 in [-1, 1]
    if dtype == np.uint8:
        data = (data.astype(np.float32) - 128.0) / 128.0
    elif dtype == np.int16:
        data = data.astype(np.float32) / 32768.0
    else:                                      # int32
        data = data.astype(np.float32) / 2_147_483_648.0

    # ComfyUI AUDIO shape: (batch=1, channels, samples)
    waveform = torch.from_numpy(data.T).unsqueeze(0)   # (1, C, T)
    return {"waveform": waveform, "sample_rate": sr}


# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------

class VideoCropTrim:
    """
    ComfyUI node - Video Crop & Trim (FFmpeg)

    • Load frames from a connected IMAGE tensor  OR  by typing a file path
    • Optionally take a matching AUDIO input directly (e.g. from a
      "Get Video Components" node) instead of extracting audio from a file
    • Visually select the crop region in the frontend widget
    • Trim by seconds or by frame number
    • Full ffmpeg codec / quality / format control
    • Optional extra ffmpeg argument passthrough
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # ── Crop ────────────────────────────────────────────────────
                "crop_x": ("INT", {
                    "default": 0, "min": 0, "max": 8192, "step": 2,
                    "display": "number",
                    "tooltip": "Left edge of the crop region (pixels, even numbers only)"
                }),
                "crop_y": ("INT", {
                    "default": 0, "min": 0, "max": 8192, "step": 2,
                    "display": "number",
                    "tooltip": "Top edge of the crop region (pixels, even numbers only)"
                }),
                "crop_width": ("INT", {
                    "default": 512, "min": 2, "max": 8192, "step": 2,
                    "display": "number",
                    "tooltip": "Width of the crop region (pixels, even numbers only)"
                }),
                "crop_height": ("INT", {
                    "default": 512, "min": 2, "max": 8192, "step": 2,
                    "display": "number",
                    "tooltip": "Height of the crop region (pixels, even numbers only)"
                }),
                # ── Trim ────────────────────────────────────────────────────
                "trim_mode": (["seconds", "none", "frames"], {
                    "default": "seconds",
                    "tooltip": "How trim_start / trim_end are interpreted"
                }),
                "trim_start": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 86400.0, "step": 0.01,
                    "display": "number",
                    "tooltip": "Start of the kept region (seconds or frame index)"
                }),
                "trim_end": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 86400.0, "step": 0.01,
                    "display": "number",
                    "tooltip": "End of the kept region (seconds or frame index). 0 = until end of video."
                }),
                "video_duration": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 86400.0, "step": 0.01,
                    "display": "number",
                    "tooltip": (
                        "Total duration of the source video in seconds. "
                        "Written automatically by the frontend UI when a video is loaded; "
                        "used as the timeline range for the trim scrubber."
                    )
                }),
                # ── Encoding ────────────────────────────────────────────────
                "output_format": (["mp4", "webm", "avi", "mov"], {
                    "default": "mp4",
                    "tooltip": "Container format for the encoded output video file."
                }),
                "codec": (["libx264", "libx265", "libvpx-vp9", "prores"], {
                    "default": "libx264",
                    "tooltip": (
                        "Video codec used to encode the output:\n"
                        "libx264 – H.264, broad compatibility\n"
                        "libx265 – H.265/HEVC, smaller files at equal quality\n"
                        "libvpx-vp9 – VP9, used for webm output\n"
                        "prores – ProRes 422, editing-friendly"
                    )
                }),
                "quality": ("INT", {
                    "default": 23, "min": 0, "max": 51, "step": 1,
                    "display": "number",
                    "tooltip": "CRF value - lower = better quality / larger file"
                }),
                # ── Audio ────────────────────────────────────────────────────
                "audio_mode": (["extract", "strip"], {
                    "default": "extract",
                    "tooltip": (
                        "strip  – discard audio entirely (video frames only).\n"
                        "extract – trim audio to match the video clip and output it "
                        "as a separate AUDIO tensor compatible with VHS Video Combine."
                    )
                }),
            },
            "optional": {
                # ── Input source ────────────────────────────────────────────
                "images": ("IMAGE", {
                    "tooltip": (
                        "Connect IMAGE frames here — e.g. the 'images' output of a "
                        "'Get Video Components' node (takes priority over video_path)"
                    )
                }),
                "audio": ("AUDIO", {
                    "tooltip": (
                        "Connect AUDIO here — e.g. the 'audio' output of a "
                        "'Get Video Components' node. Trimmed to match the kept "
                        "video window when audio_mode='extract'."
                    )
                }),
                "video_path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "Upload a video or enter a path manually…",
                    "tooltip": "Video file path. Can be filled automatically using the Upload Your Video button."
                }),
                # ── Advanced ────────────────────────────────────────────────
                "fps": ("FLOAT", {
                    "default": 30.0, "min": 1.0, "max": 240.0, "step": 0.001,
                    "display": "number",
                    "tooltip": "Output framerate (also used to convert frame-based trim values)"
                }),
                "extra_ffmpeg_args": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "placeholder": "-preset fast  -tune film  -movflags +faststart",
                    "tooltip": "Extra ffmpeg output arguments passed verbatim"
                }),
            },
        }

    RETURN_TYPES  = ("IMAGE", "AUDIO")
    RETURN_NAMES  = ("frames", "audio")
    OUTPUT_TOOLTIPS = (
        "Cropped and trimmed video frames.",
        "Audio trimmed to match the kept video window. "
        "None when audio_mode='strip' or no audio was available.",
    )
    FUNCTION      = "process_video"
    CATEGORY      = "video/processing"
    OUTPUT_NODE   = True

    # ------------------------------------------------------------------ #
    # Main execution                                                       #
    # ------------------------------------------------------------------ #

    def process_video(
        self,
        crop_x, crop_y, crop_width, crop_height,
        trim_mode, trim_start, trim_end,
        video_duration=0.0,
        output_format="mp4", codec="libx264", quality=23,
        audio_mode="extract",
        images=None, audio=None, video_path="", fps=30.0, extra_ffmpeg_args=""
    ):
        with tempfile.TemporaryDirectory() as tmp:
            # ── 1. Resolve input ────────────────────────────────────────
            input_path = None

            if images is not None:
                input_path = os.path.join(tmp, f"input.{output_format}")
                _tensor_to_video(images, input_path, fps)
            else:
                input_path = _resolve_video_path(video_path)

            if input_path is None:
                raise ValueError(
                    "No valid video source found.\n"
                    "Connect an IMAGE tensor to the 'images' input, or set 'video_path' "
                    "to an existing file."
                )

            # Auto-detect fps from file when tensor wasn't provided
            if images is None:
                meta = _probe_video(input_path)
                if meta.get("fps") and fps == 30.0:
                    fps = meta["fps"]

            # ── 2. Build ffmpeg input (with optional trim via seek) ──────
            input_kwargs: dict = {}
            start_s = 0.0
            end_s   = 0.0

            if trim_mode != "none":
                start_s = trim_start / fps if trim_mode == "frames" else float(trim_start)
                end_s   = trim_end   / fps if trim_mode == "frames" else float(trim_end)

                if start_s > 0:
                    input_kwargs["ss"] = start_s          # fast-seek to start

                if end_s > 0 and end_s > start_s:
                    input_kwargs["to"] = end_s            # hard end time

            stream = ffmpeg.input(input_path, **input_kwargs)

            # ── 3. Crop filter ──────────────────────────────────────────
            # FFmpeg requires even dimensions for most codecs
            cw = crop_width  if crop_width  % 2 == 0 else crop_width  - 1
            ch = crop_height if crop_height % 2 == 0 else crop_height - 1
            stream = ffmpeg.crop(stream, crop_x, crop_y, cw, ch)

            # ── 4. Output options ───────────────────────────────────────
            out_args: dict = {
                "vcodec":  codec,
                "r":       fps,
                "pix_fmt": "yuv420p",
                "an":      None,   # no audio track in the video output; audio
                                   # is returned separately via the AUDIO output
            }

            if codec in ("libx264", "libx265"):
                out_args["crf"] = quality
            elif codec == "libvpx-vp9":
                out_args["crf"] = quality
                out_args["b:v"] = "0"          # constrained-quality mode
            elif codec == "prores":
                out_args["profile:v"] = "2"    # ProRes 422

            # Merge extra user-supplied args (override any conflicting keys)
            out_args.update(_parse_extra_args(extra_ffmpeg_args))

            output_path = os.path.join(tmp, f"cropped.{output_format}")
            (
                ffmpeg
                .output(stream, output_path, **out_args)
                .run(overwrite_output=True, quiet=True)
            )

            # ── 5. Audio extraction ─────────────────────────────────────
            # Build audio data to satisfy the AUDIO return slot.
            # When audio_mode is "strip" (or no audio is available) we
            # return None so downstream nodes gracefully receive nothing.
            audio_data: dict | None = None

            if audio_mode == "extract":
                if audio is not None:
                    # A separate AUDIO input was connected directly (e.g. from
                    # a "Get Video Components" node) — trim it to match the
                    # kept video window instead of extracting from a file.
                    try:
                        audio_data = _trim_audio_tensor(audio, start_s, end_s)
                    except Exception as exc:
                        import warnings
                        warnings.warn(
                            f"[VideoCropTrim] failed to trim the connected AUDIO "
                            f"input — AUDIO output will be None.\n{exc}",
                            stacklevel=2,
                        )
                elif images is None:
                    # No AUDIO input was connected and frames came from a file
                    # path — probe and extract the trimmed audio from it.
                    source_info = _probe_video(input_path)
                    if not source_info.get("has_audio", False):
                        import warnings
                        warnings.warn(
                            "[VideoCropTrim] audio_mode='extract' but the source "
                            "file has no audio stream — AUDIO output will be None.",
                            stacklevel=2,
                        )
                    else:
                        # Extract the *trimmed* audio segment as 16-bit stereo WAV.
                        # We reuse input_kwargs so the same ss/to window applies.
                        try:
                            audio_path = os.path.join(tmp, "audio.wav")
                            audio_in   = ffmpeg.input(input_path, **input_kwargs).audio
                            (
                                ffmpeg
                                .output(
                                    audio_in, audio_path,
                                    acodec="pcm_s16le",   # lossless PCM for accurate waveform
                                    ar=44100,             # normalise to 44.1 kHz
                                    ac=2,                 # stereo (mono is up-mixed)
                                )
                                .run(overwrite_output=True, quiet=True)
                            )
                            audio_data = _load_audio_tensor(audio_path)
                        except ffmpeg.Error as exc:
                            stderr = exc.stderr.decode() if exc.stderr else str(exc)
                            import warnings
                            warnings.warn(
                                f"[VideoCropTrim] audio extraction failed — "
                                f"AUDIO output will be None.\nFFmpeg stderr: {stderr}",
                                stacklevel=2,
                            )
                # else: frames came from a connected IMAGE tensor and no AUDIO
                # input was provided — nothing to extract, AUDIO stays None.

            # ── 6. Return frames + audio ────────────────────────────────
            tensor = _video_to_tensor(output_path, tmp)
            return (tensor, audio_data)


# ---------------------------------------------------------------------------
# API endpoint - preview frame
# ---------------------------------------------------------------------------

def _setup_routes() -> None:
    """
    Register a POST endpoint that the frontend uses to fetch the first frame
    of a video file for the interactive crop preview widget.

    Request body (JSON):
        { "video_path": "/absolute/or/relative/path.mp4" }

    Response (JSON):
        {
            "frame": "<base64-PNG>",
            "info":  { "width": N, "height": N, "fps": N,
                       "duration": N, "nb_frames": N }
        }
    """
    @PromptServer.instance.routes.get("/videocropptrim/serve_video")
    async def _serve_video(request):
        """
        Serve a video file for browser-native playback.  aiohttp's FileResponse
        handles Range / partial-content requests automatically, so the frontend
        <video> element can seek freely without extra server logic.

        Query params:
            path  – absolute or input-relative video path
        """
        try:
            raw  = request.rel_url.query.get("path", "").strip()
            path = _resolve_video_path(raw)
            if not path:
                return web.Response(status=404, text=f"Video not found: {raw!r}")
            return web.FileResponse(path)
        except Exception as exc:
            return web.Response(status=500, text=str(exc))

    @PromptServer.instance.routes.post("/videocropptrim/preview_frame")
    async def _preview_frame(request):
        try:
            body = await request.json()
            raw  = body.get("video_path", "").strip()
            path = _resolve_video_path(raw)

            if not path:
                return web.json_response(
                    {"error": f"Video not found: {raw!r}"},
                    status=404
                )

            with tempfile.TemporaryDirectory() as tmp:
                frame_path = os.path.join(tmp, "preview.png")

                # Extract a single frame at the very start of the file
                (
                    ffmpeg
                    .input(path, ss=0)
                    .output(frame_path, vframes=1)
                    .run(overwrite_output=True, quiet=True)
                )

                if not os.path.exists(frame_path):
                    return web.json_response(
                        {"error": "Frame extraction failed"},
                        status=500
                    )

                with open(frame_path, "rb") as f:
                    b64 = base64.b64encode(f.read()).decode()

            return web.json_response({
                "frame": b64,
                "info":  _probe_video(path),
            })

        except ffmpeg.Error as exc:
            stderr = exc.stderr.decode() if exc.stderr else str(exc)
            return web.json_response({"error": stderr}, status=500)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)


if _HAS_SERVER:
    _setup_routes()


# ---------------------------------------------------------------------------
# ComfyUI registration
# ---------------------------------------------------------------------------

NODE_CLASS_MAPPINGS = {
    "VideoCropTrim": VideoCropTrim,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoCropTrim": "Video Crop & Trim (FFmpeg)",
}
