/**
 * Video Crop & Trim (FFmpeg) - ComfyUI Frontend Extension
 * ========================================================
  */

import { app } from "../../scripts/app.js";

// ─── Layout constants ────────────────────────────────────────────────────────
const CANVAS_H    = 290;    // Height of the video-preview canvas
const MODE_BAR_H  = 26;     // Height of the "Trim Mode" Seconds/Frames toggle bar
const PLAYBACK_H  = 36;     // Height of the play/pause + time/frame bar
const TRIM_BAR_H  = 62;     // Height of the trim-range timeline (ruler + slider)
const INFO_H      = 34;     // Height of the coordinate / metadata bar
const WIDGET_H    = MODE_BAR_H + CANVAS_H + PLAYBACK_H + TRIM_BAR_H + INFO_H;
const PAD         = 8;      // Horizontal padding inside the node
const HANDLE_R    = 5;      // Corner-handle hit-radius in pixels
const HANDLE_SZ   = 9;      // Corner-handle draw size
const MIN_W       = 460;    // Minimum node width we enforce
const CANVAS_PAD  = 14;     // Inset padding inside the preview canvas so crop guides have breathing room

// ─── Colour palette ──────────────────────────────────────────────────────────
const C = {
    bg:          "#1c1c1c",
    bgBorder:    "#3a3a3a",
    overlay:     "rgba(0,0,0,0.48)",
    cropBorder:  "#e8a02a",
    cropBorderD: "rgba(232,160,42,0.25)",
    handle:      "#e8a02a",
    handleBg:    "#3a2800",
    thirds:      "rgba(232,160,42,0.18)",
    infoBar:     "#2b2b2b",
    infoText:    "#e8a02a",
    infoDim:     "#737373",
    placeholder: "#6a6a6a",
    placeholderS:"#4a4a4a",
    btnBg:       "#3a3a3a",
    btnHover:    "#484848",
    btnText:     "#c8c8c8",
    pbBar:       "#232323",       // Playback bar background
    pbProgress:  "#e8a02a",       // Progress bar fill
    pbTrack:     "#3a3a3a",       // Progress bar track
    pbBtn:       "#c87d1a",       // Play/pause button fill
    pbBtnHov:    "#e8a02a",       // Play/pause button hover
    pbText:      "#737373",       // Time/frame text
    pbTextBr:    "#c8c8c8",       // Time/frame text – bright part
};

// ─── Utility ─────────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const even  = v => Math.round(v) % 2 === 0 ? Math.round(v) : Math.round(v) - 1;

// ─── Crop aspect-ratio presets ───────────────────────────────────────────────
// val: 0 = Freeform (no lock), -1 = Original (locked to the loaded video's
// own native ratio), otherwise a fixed width/height ratio.
const ASPECT_RATIOS = [
    { name: "Freeform", val: 0 },
    { name: "Original", val: -1 },
    { name: "1:1",  val: 1 },
    { name: "4:5",  val: 4 / 5 },
    { name: "5:4",  val: 5 / 4 },
    { name: "16:9", val: 16 / 9 },
    { name: "9:16", val: 9 / 16 },
    { name: "4:3",  val: 4 / 3 },
    { name: "3:4",  val: 3 / 4 },
    { name: "3:2",  val: 3 / 2 },
    { name: "2:3",  val: 2 / 3 },
    { name: "2:1",  val: 2 },
    { name: "1:2",  val: 1 / 2 },
];
const DROPDOWN_ITEM_H = 20;
const DROPDOWN_W      = 108;

// ─── Resize-method presets (standard ComfyUI image-resize methods) ──────────
const RESIZE_METHODS = [
    { name: "Crop",    val: "crop" },
    { name: "Contain", val: "contain" },
    { name: "Pad",     val: "pad" },
    { name: "Stretch", val: "stretch" },
];
const RESIZE_DROPDOWN_W = 100;

// Find the fixed named ratio (excluding Freeform/Original) closest to a
// given width/height — used to pick the default selection for a new video.
function closestAspectRatio(w, h) {
    if (!w || !h) return ASPECT_RATIOS[0];
    const target = w / h;
    let best = ASPECT_RATIOS[2];
    let bestDiff = Infinity;
    for (const r of ASPECT_RATIOS) {
        if (r.val <= 0) continue;
        const diff = Math.abs(r.val - target);
        if (diff < bestDiff) { bestDiff = diff; best = r; }
    }
    return best;
}

// ─── Sticky "last used" encode/trim settings ─────────────────────────────────

const STICKY_KEY     = "VideoCropTrim.lastSettings";
const STICKY_WIDGETS = ["trim_mode", "output_format", "codec", "quality", "audio_mode"];
// Class defaults, mirrored here so a widget can self-heal (e.g. if it's ever
// found holding an invalid value like NaN) without needing to consult Python.
const STICKY_DEFAULTS = {
    trim_mode:     "seconds",
    output_format: "mp4",
    codec:         "libx264",
    quality:       23,
    audio_mode:    "extract",
};

function loadStickySettings() {
    try {
        return JSON.parse(localStorage.getItem(STICKY_KEY)) || {};
    } catch {
        return {};
    }
}

function saveStickySetting(name, value) {
    try {
        // quality is numeric — clamp to its valid 0–51 range and refuse to
        // persist anything that isn't a finite number, so a bad in-flight
        // value can never get written back out and reappear on new nodes.
        if (name === "quality") {
            const n = Number(value);
            if (!Number.isFinite(n)) return;
            value = clamp(Math.round(n), 0, 51);
        }
        const cur = loadStickySettings();
        cur[name] = value;
        localStorage.setItem(STICKY_KEY, JSON.stringify(cur));
    } catch {
        // localStorage unavailable (private mode, quota, etc.) — not fatal,
        // just means stickiness won't persist this session.
    }
}

// ─── Extension registration ───────────────────────────────────────────────────
app.registerExtension({
    name: "Comfy.VideoCropTrim",

    async nodeCreated(node) {
        if (node.comfyClass !== "VideoCropTrim") return;

        // ── Per-node state ──────────────────────────────────────────────────
        let previewImg  = null;
        let videoInfo   = { width: 0, height: 0, fps: 30, duration: 0, nb_frames: 0, has_audio: false, audio_codec: null, audio_sample_rate: 0, audio_channels: 0 };

        // Canvas height grows when the node is enlarged; the playback bar,
        // trim bar, and info bar heights are always fixed.
        let dynamicCanvasH = CANVAS_H;

        // Tracks last-seen node dimensions so draw() can detect a resize even
        // when onResize hasn't fired yet (e.g. mid-drag in some ComfyUI builds).
        let lastNodeW = 0;
        let lastNodeH = 0;

        // ── Playback state ──────────────────────────────────────────────────
        let videoEl    = null;   // Off-screen <video> element (never in DOM)
        let isPlaying  = false;
        let rafId      = null;
        // Cached progress-bar rect (node-local coords) for hit-testing
        let progBarX   = 0;
        let progBarW   = 0;
        let progBarY   = 0;

        // ── "Trim Mode" toggle state (replaces the native trim_mode combo) ──
        // Cached bounding rect of the first ("Seconds") segment; the second
        // ("Frames") segment sits immediately to its right.
        let modeToggleX      = 0;
        let modeToggleY      = 0;
        let modeToggleSegW   = 0;
        let modeToggleSegH   = 0;
        let modeToggleSegGap = 0;

        // Trim playback mode: when true, playback is bounded to [trim_start, trim_end]
        let trimPlaybackMode = false;

        // ── "Crop" aspect-ratio button + dropdown state ──────────────────────
        let selectedAspect     = ASPECT_RATIOS[0];   // Freeform until a video loads
        let aspectDropdownOpen = false;
        // Cached bounding rect of the "Crop" button (drawn opposite Trim Mode)
        let cropBtnX = 0, cropBtnY = 0, cropBtnW = 0, cropBtnH = 0;
        // Cached bounding rect of the dropdown list (drawn as an overlay, only
        // valid while aspectDropdownOpen is true)
        let dropdownX = 0, dropdownY = 0, dropdownW = 0, dropdownH = 0;

        // ── "Resize" method button + dropdown state (drawn immediately to
        // the left of the "Crop" button) ─────────────────────────────────
        let selectedResizeMethod = RESIZE_METHODS[0];   // "Crop" by default
        let resizeDropdownOpen   = false;
        // Cached bounding rect of the "Resize" button
        let resizeBtnX = 0, resizeBtnY = 0, resizeBtnW = 0, resizeBtnH = 0;
        // Cached bounding rect of the resize-method dropdown list overlay
        let resizeDropdownX = 0, resizeDropdownY = 0, resizeDropdownW = 0, resizeDropdownH = 0;

        // ── Trim timeline state (scrubbing slider below playback bar) ───────
        // Cached bounding rect of the timeline slider box (node-local coords)
        let sliderBarX  = 0;
        let sliderBarW  = 0;
        let sliderBarY  = 0;
        let sliderBarH  = 0;
        // Which timeline handle is being dragged: null | "start" | "end" | "center"
        let timelineDrag       = null;
        let timelineDragOffset = 0;    // offset from handle to mouse (for "center" pan)
        let timelineDragWidth  = 0;    // selection width at drag-start (for "center" pan)

        // Display-space transform (image px → node-local px)
        // Updated every draw call so mouse handler can use them.
        let dScale  = 1;
        let dOffX   = 0;   // In node-local coords
        let dOffY   = 0;   // In node-local coords (includes widget.last_y)
        let dWidth  = 0;
        let dHeight = 0;

        // Drag / preview state
        let cropPreviewMode = false;  // true = canvas shows only the cropped region
        let dragMode        = null;   // null | "create" | "move" | "tl" | "tr" | "bl" | "br"
        let dragAnchor = null;  // { x, y } in node-local coords where drag began
        let dragCrop   = null;  // snapshot of crop at drag-start

        // ── Widget-finding helpers ──────────────────────────────────────────
        const gw = name => node.widgets?.find(w => w.name === name);

        // ── Apply sticky last-used settings (falls back to class defaults) ──
        // If a saved workflow loads this node, ComfyUI's configure() call
        // (which runs after nodeCreated) will overwrite these with the
        // workflow's own values, so this only affects genuinely new nodes.
        {
            const sticky = loadStickySettings();
            for (const name of STICKY_WIDGETS) {
                const w = gw(name);
                if (!w) continue;

                if (name === "quality") {
                    // Numeric widget — only accept a finite in-range value
                    // from storage; clamp it, and self-heal if the widget's
                    // own current value is already broken (e.g. NaN).
                    if (Object.prototype.hasOwnProperty.call(sticky, "quality")) {
                        const n = Number(sticky.quality);
                        if (Number.isFinite(n)) w.value = clamp(Math.round(n), 0, 51);
                    }
                    if (!Number.isFinite(Number(w.value))) {
                        w.value = STICKY_DEFAULTS.quality;
                    }
                } else if (Object.prototype.hasOwnProperty.call(sticky, name)) {
                    w.value = sticky[name];
                }

                const prevCallback = w.callback;
                w.callback = function (value, ...rest) {
                    if (name === "quality") {
                        const n = Number(value);
                        value = Number.isFinite(n) ? clamp(Math.round(n), 0, 51) : STICKY_DEFAULTS.quality;
                        this.value = value;   // keep the widget itself in range, never NaN
                    }
                    saveStickySetting(name, value);
                    return prevCallback?.call(this, value, ...rest);
                };
            }
            node.setDirtyCanvas(true, true);
        }

        // Return the best available timeline duration in seconds:
        //  1. Live video element duration (most authoritative)
        //  2. video_duration widget value (set by UI on load)
        //  3. Highest of trim_start / trim_end values (fallback)
        //  4. 1.0 floor so the empty timeline still renders
        const getActiveDuration = () => {
            if (videoEl && videoEl.duration > 0) return videoEl.duration;
            const durW = gw("video_duration");
            if (durW && durW.value > 0) return durW.value;
            const s = gw("trim_start")?.value ?? 0;
            const e = gw("trim_end")?.value   ?? 0;
            const maxVal = Math.max(s, e);
            return maxVal > 0 ? Math.max(maxVal, 1.0) : 1.0;
        };

        // Return trim start/end in seconds, converting from frames if needed.
        const getTrimSeconds = () => {
            const mode = gw("trim_mode")?.value ?? "seconds";
            const fps  = videoInfo.fps || gw("fps")?.value || 30;
            const s    = gw("trim_start")?.value ?? 0;
            const e    = gw("trim_end")?.value   ?? 0;
            if (mode === "frames") {
                return { start: s / fps, end: e / fps };
            }
            return { start: s, end: e };
        };

        // Write trim start/end back, converting to frames if needed.
        const setTrimSeconds = (startS, endS) => {
            const mode = gw("trim_mode")?.value ?? "seconds";
            const fps  = videoInfo.fps || gw("fps")?.value || 30;
            const sw = gw("trim_start");
            const ew = gw("trim_end");
            if (mode === "frames") {
                if (sw) sw.value = Math.round(startS * fps);
                if (ew) ew.value = Math.round(endS   * fps);
            } else if (mode === "seconds") {
                if (sw) sw.value = Math.round(startS * 100) / 100;
                if (ew) ew.value = Math.round(endS   * 100) / 100;
            }
            // "none" mode — nothing to write
            node.setDirtyCanvas(true, false);
        };

        const getCrop = () => ({
            x: gw("crop_x")?.value     ?? 0,
            y: gw("crop_y")?.value     ?? 0,
            w: gw("crop_width")?.value  ?? 512,
            h: gw("crop_height")?.value ?? 512,
        });

        const setCrop = (x, y, w, h) => {
            const maxW = videoInfo.width  || 8192;
            const maxH = videoInfo.height || 8192;
            x = clamp(even(x), 0, maxW - 2);
            y = clamp(even(y), 0, maxH - 2);
            w = clamp(even(w), 2, maxW - x);
            h = clamp(even(h), 2, maxH - y);
            const wx = gw("crop_x");     if (wx) wx.value = x;
            const wy = gw("crop_y");     if (wy) wy.value = y;
            const ww = gw("crop_width"); if (ww) ww.value = w;
            const wh = gw("crop_height");if (wh) wh.value = h;
            node.setDirtyCanvas(true, false);
        };

        // Resolve the currently-selected aspect preset to a numeric W/H ratio.
        // Returns 0 for Freeform (i.e. no lock should be applied).
        const getEffectiveRatio = () => {
            if (!selectedAspect || selectedAspect.val === 0) return 0;
            if (selectedAspect.val === -1) {
                return (videoInfo.width && videoInfo.height)
                    ? videoInfo.width / videoInfo.height : 0;
            }
            return selectedAspect.val;
        };

        // Re-fit the current crop rectangle to a given aspect ratio preset,
        // keeping it centred on the crop's current centre and as large as
        // possible within the video frame.
        const applyAspectRatio = (ratioObj) => {
            if (!videoInfo.width || !videoInfo.height) return;
            if (!ratioObj || ratioObj.val === 0) return;   // Freeform: leave as-is
            const ratio = ratioObj.val === -1
                ? videoInfo.width / videoInfo.height
                : ratioObj.val;

            const vw = videoInfo.width, vh = videoInfo.height;
            const c  = getCrop();

            let newW = c.w;
            let newH = newW / ratio;
            if (newH > vh) { newH = vh; newW = newH * ratio; }
            if (newW > vw) { newW = vw; newH = newW / ratio; }

            const cx = c.x + c.w / 2;
            const cy = c.y + c.h / 2;
            let newX = cx - newW / 2;
            let newY = cy - newH / 2;
            newX = clamp(newX, 0, vw - newW);
            newY = clamp(newY, 0, vh - newH);

            setCrop(newX, newY, newW, newH);
        };

        // ── Playback helpers ────────────────────────────────────────────────
        function scheduleRaf() {
            if (!isPlaying) return;
            // Enforce trim_end boundary during trim playback
            if (trimPlaybackMode && videoEl && videoEl.duration > 0) {
                const { end } = getTrimSeconds();
                const effectiveEnd = (end > 0) ? Math.min(end, videoEl.duration) : videoEl.duration;
                if (videoEl.currentTime >= effectiveEnd) {
                    pausePlayback();
                    trimPlaybackMode = false;
                    return;
                }
            }
            node.setDirtyCanvas(true, false);
            rafId = requestAnimationFrame(scheduleRaf);
        }

        function startPlayback(fromTrimStart = false) {
            if (!videoEl) return;
            if (fromTrimStart) {
                const { start } = getTrimSeconds();
                videoEl.currentTime = start;
            }
            videoEl.play().then(() => {
                isPlaying = true;
                scheduleRaf();
            }).catch(err => {
                console.error("[VideoCropTrim] play() failed:", err);
                isPlaying = false;
            });
        }

        function pausePlayback() {
            if (videoEl) videoEl.pause();
            isPlaying = false;
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            node.setDirtyCanvas(true, false);
        }

        function togglePlayback() {
            if (!videoEl) return;
            trimPlaybackMode = false;
            if (isPlaying) pausePlayback(); else startPlayback();
        }

        function toggleTrimPlayback() {
            if (!videoEl) return;
            if (isPlaying && trimPlaybackMode) {
                pausePlayback();
                trimPlaybackMode = false;
            } else {
                trimPlaybackMode = true;
                startPlayback(true);
            }
        }

        // ── Coordinate conversions ──────────────────────────────────────────
        // All values in *node-local* coordinates (origin = node top-left).
        const imgToNode = (ix, iy) => ({
            x: ix * dScale + dOffX,
            y: iy * dScale + dOffY,
        });
        const nodeToImg = (nx, ny) => ({
            x: (nx - dOffX) / dScale,
            y: (ny - dOffY) / dScale,
        });

        // ── Hit-test helper ─────────────────────────────────────────────────
        /**
         * Given a node-local cursor position, return the drag mode:
         *   "tl" | "tr" | "bl" | "br"  → corner handle
         *   "move"                       → inside the crop rectangle
         *   "create"                     → anywhere else
         */
        const hitTest = (nx, ny) => {
            const c  = getCrop();
            const tl = imgToNode(c.x,       c.y);
            const br = imgToNode(c.x + c.w, c.y + c.h);

            const corners = [
                ["tl", tl.x, tl.y],
                ["tr", br.x, tl.y],
                ["bl", tl.x, br.y],
                ["br", br.x, br.y],
            ];
            for (const [mode, hx, hy] of corners) {
                if (Math.hypot(nx - hx, ny - hy) <= HANDLE_R + 4) return mode;
            }
            if (nx >= tl.x && nx <= br.x && ny >= tl.y && ny <= br.y) return "move";
            return "create";
        };

        // ── Draw helpers ────────────────────────────────────────────────────
        const drawHandle = (ctx, hx, hy) => {
            ctx.fillStyle   = C.handle;
            ctx.strokeStyle = C.handleBg;
            ctx.lineWidth   = 1.5;
            ctx.fillRect(hx - HANDLE_SZ / 2, hy - HANDLE_SZ / 2, HANDLE_SZ, HANDLE_SZ);
            ctx.strokeRect(hx - HANDLE_SZ / 2, hy - HANDLE_SZ / 2, HANDLE_SZ, HANDLE_SZ);
        };

        // ── The main custom widget ──────────────────────────────────────────
        const cropWidget = {
            type:    "crop_canvas",
            name:    "visual_crop",
            value:   null,
            options: { serialize: false },
            last_y:  0,     // Y of this widget's top inside the node (set each draw)

            computeSize(nodeWidth) {
                // Return the current dynamic total so ComfyUI's layout engine
                // always allocates exactly the right height for this widget.
                return [nodeWidth, MODE_BAR_H + dynamicCanvasH + PLAYBACK_H + TRIM_BAR_H + INFO_H];
            },

            draw(ctx, node, nodeWidth, y /*, _h */) {
                this.last_y = y;

                // ── Sync dynamicCanvasH whenever the node has been resized ──
                // onResize handles the primary update path, but ComfyUI may call
                // computeSize() before onResize() fires during a live drag.
                // Checking here (every frame) catches those in-between states so
                // the video and crop guide always fill the current node size.
                const curW = node.size[0];
                const curH = node.size[1];
                if (curW !== lastNodeW || curH !== lastNodeH) {
                    lastNodeW = curW;
                    lastNodeH = curH;
                    recalcCanvasH(curW, curH);
                }

                const W  = nodeWidth - PAD * 2;   // usable width
                const x0 = PAD;                    // left edge
                const y0 = y;                      // top of canvas area

                // ── Background ─────────────────────────────────────────
                ctx.fillStyle   = C.bg;
                ctx.strokeStyle = C.bgBorder;
                ctx.lineWidth   = 1;
                ctx.fillRect(x0, y0, W, dynamicCanvasH);
                ctx.strokeRect(x0, y0, W, dynamicCanvasH);

                // Decide which image source to paint (live video or static first-frame)
                const imgSrc = (videoEl && videoEl.readyState >= 2) ? videoEl : previewImg;

                if (imgSrc) {
                    const naturalW = imgSrc instanceof HTMLVideoElement
                        ? imgSrc.videoWidth  : imgSrc.naturalWidth;
                    const naturalH = imgSrc instanceof HTMLVideoElement
                        ? imgSrc.videoHeight : imgSrc.naturalHeight;

                    const c = getCrop();

                    if (cropPreviewMode) {
                        // ── Crop-preview mode: fill canvas with cropped region ──
                        // Letterbox the crop rect into the available canvas area
                        // so the user sees exactly what the output frame will look like.
                        const cropAspect   = c.w / c.h;
                        const canvasAspect = W   / dynamicCanvasH;
                        let destW, destH, destX, destY;
                        if (cropAspect > canvasAspect) {
                            destW = W;
                            destH = W / cropAspect;
                            destX = x0;
                            destY = y0 + (dynamicCanvasH - destH) / 2;
                        } else {
                            destH = dynamicCanvasH;
                            destW = dynamicCanvasH * cropAspect;
                            destX = x0 + (W - destW) / 2;
                            destY = y0;
                        }

                        // Draw only the cropped source region
                        ctx.drawImage(imgSrc, c.x, c.y, c.w, c.h, destX, destY, destW, destH);

                        // Rule-of-thirds grid over the full preview area
                        ctx.strokeStyle = C.thirds;
                        ctx.lineWidth   = 0.8;
                        ctx.beginPath();
                        for (let i = 1; i <= 2; i++) {
                            ctx.moveTo(destX + destW * i / 3, destY);
                            ctx.lineTo(destX + destW * i / 3, destY + destH);
                            ctx.moveTo(destX,         destY + destH * i / 3);
                            ctx.lineTo(destX + destW, destY + destH * i / 3);
                        }
                        ctx.stroke();

                        // Dimension badge — top-left corner
                        const badge = `  ${c.w} × ${c.h} px  `;
                        ctx.font      = "bold 11px monospace";
                        const badgeW  = ctx.measureText(badge).width + 2;
                        const badgeH  = 18;
                        ctx.fillStyle = "rgba(0,0,0,0.55)";
                        ctx.fillRect(destX, destY, badgeW, badgeH);
                        ctx.fillStyle = C.infoText;
                        ctx.textAlign = "left";
                        ctx.fillText(badge, destX + 1, destY + badgeH - 4);

                        // "CROP OUTPUT" label — bottom centre
                        ctx.font      = "10px 'Segoe UI', sans-serif";
                        ctx.fillStyle = C.infoDim;
                        ctx.textAlign = "center";
                        ctx.fillText("CROP OUTPUT PREVIEW", x0 + W / 2, y0 + dynamicCanvasH - 6);
                        ctx.textAlign = "left";

                        // "TRIMMED OUTPUT PREVIEW" secondary label when also in trim mode
                        if (trimPlaybackMode) {
                            ctx.font      = "10px 'Segoe UI', sans-serif";
                            ctx.fillStyle = "rgba(232,160,42,0.55)";
                            ctx.textAlign = "center";
                            ctx.fillText("✂  TRIMMED OUTPUT PREVIEW", x0 + W / 2, y0 + dynamicCanvasH - 18);
                            ctx.textAlign = "left";
                        }

                        // Set display transform to safe no-op so mouse handler
                        // boundary checks still pass cleanly (drag is blocked below).
                        dScale = 1; dOffX = x0; dOffY = y0; dWidth = W; dHeight = dynamicCanvasH;

                    } else {
                        // ── Normal mode: full-frame view with crop overlay ──────
                        // Compute display transform — inset by CANVAS_PAD on every
                        // side so crop handles and dashed guidelines are never flush
                        // against the canvas border.
                        const innerW = W - CANVAS_PAD * 2;
                        const innerH = dynamicCanvasH - CANVAS_PAD * 2;
                        const sX = innerW / naturalW;
                        const sY = innerH / naturalH;
                        dScale  = Math.min(sX, sY);
                        dWidth  = naturalW * dScale;
                        dHeight = naturalH * dScale;
                        dOffX   = x0 + CANVAS_PAD + (innerW - dWidth)  / 2;
                        dOffY   = y0 + CANVAS_PAD + (innerH - dHeight) / 2;

                        // Draw full video frame
                        ctx.drawImage(imgSrc, dOffX, dOffY, dWidth, dHeight);

                        // Darken everything outside the crop rect
                        const tl = imgToNode(c.x,       c.y);
                        const br = imgToNode(c.x + c.w, c.y + c.h);

                        ctx.fillStyle = C.overlay;
                        ctx.fillRect(dOffX, dOffY,  dWidth,       tl.y - dOffY);           // top
                        ctx.fillRect(dOffX, br.y,   dWidth,       dOffY + dHeight - br.y); // bottom
                        ctx.fillRect(dOffX, tl.y,   tl.x - dOffX, br.y - tl.y);           // left
                        ctx.fillRect(br.x,  tl.y,   dOffX + dWidth - br.x, br.y - tl.y);  // right

                        // Rule-of-thirds grid inside crop
                        ctx.strokeStyle = C.thirds;
                        ctx.lineWidth   = 0.8;
                        ctx.beginPath();
                        for (let i = 1; i <= 2; i++) {
                            const gx = tl.x + (br.x - tl.x) * i / 3;
                            const gy = tl.y + (br.y - tl.y) * i / 3;
                            ctx.moveTo(gx, tl.y); ctx.lineTo(gx, br.y);
                            ctx.moveTo(tl.x, gy); ctx.lineTo(br.x, gy);
                        }
                        ctx.stroke();

                        // Crop border
                        ctx.strokeStyle = C.cropBorder;
                        ctx.lineWidth   = 1.5;
                        ctx.setLineDash([6, 3]);
                        ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
                        ctx.setLineDash([]);

                        // Corner handles
                        for (const [hx, hy] of [
                            [tl.x, tl.y], [br.x, tl.y],
                            [tl.x, br.y], [br.x, br.y],
                        ]) {
                            drawHandle(ctx, hx, hy);
                        }

                        // "TRIMMED OUTPUT PREVIEW" label when trim playback is active
                        if (trimPlaybackMode) {
                            ctx.font      = "10px 'Segoe UI', sans-serif";
                            ctx.fillStyle = "rgba(232,160,42,0.55)";
                            ctx.textAlign = "center";
                            ctx.fillText("✂  TRIMMED OUTPUT PREVIEW", x0 + W / 2, y0 + dynamicCanvasH - 18);
                            ctx.textAlign = "left";
                        }
                    }

                } else {
                    // ── Placeholder ─────────────────────────────────────
                    // Reset display transform to identity so mouse events are
                    // safely rejected (previewImg is null check handles it)
                    dOffX = x0; dOffY = y0; dScale = 1;

                    ctx.fillStyle = C.placeholder;
                    ctx.font      = "13px 'Segoe UI', sans-serif";
                    ctx.textAlign = "center";
                    ctx.fillText(
                        "Upload a video using the button below to get started.",
                        x0 + W / 2,
                        y0 + dynamicCanvasH / 2 - 10,
                    );
                    ctx.fillStyle = C.placeholderS;
                    ctx.font      = "11px monospace";
                    ctx.fillText(
                        "- or connect IMAGE/AUDIO to the  images  /  audio  inputs -",
                        x0 + W / 2,
                        y0 + dynamicCanvasH / 2 + 12,
                    );
                    ctx.textAlign = "left";
                }

                // ── Playback bar ─────────────────────────────────────────
                const py = y0 + dynamicCanvasH;
                ctx.fillStyle   = C.pbBar;
                ctx.strokeStyle = C.bgBorder;
                ctx.lineWidth   = 1;
                ctx.fillRect(x0, py, W, PLAYBACK_H);
                ctx.strokeRect(x0, py, W, PLAYBACK_H);

                const hasVideo = !!videoEl;

                // ── Playback bar layout ──────────────────────────────────
                // Row 1 (top half): ▶/⏸ button  |  time label  |  (spacer)
                // Row 2 (bottom):   full-width progress track (x0→x0+W)
                //
                // The progress track spans the full inner width so its pixel
                // positions match the trim-timeline ruler 1-to-1.
                const _TL_PAD = 8;
                const pbTrackH  = 4;
                const pbTrackY  = py + PLAYBACK_H - pbTrackH - 1;  // flush to bottom of bar
                const pbTrackX  = x0 + _TL_PAD;
                const pbTrackW  = W - _TL_PAD * 2;

                // Store for mouse hit-test (covers full bar height for ease of use)
                progBarX = pbTrackX;
                progBarW = pbTrackW;
                progBarY = pbTrackY;

                // ── Row 1: play/pause button + time label ───────────────
                const topRowH  = PLAYBACK_H - pbTrackH - 1;
                const btnSize  = topRowH - 10;   // smaller play/pause button
                const btnX     = x0 + 6;
                const btnY     = py + (topRowH - btnSize) / 2;

                // Button background
                ctx.fillStyle = hasVideo ? C.pbBtn : C.infoDim;
                ctx.beginPath();
                ctx.roundRect(btnX, btnY, btnSize, btnSize, 3);
                ctx.fill();

                // Button icon
                ctx.fillStyle    = C.bg;
                ctx.textAlign    = "center";
                ctx.textBaseline = "middle";
                if (isPlaying) {
                    const bw = 3, bh = btnSize * 0.5, bTop = btnY + btnSize / 2 - bh / 2;
                    const cx = btnX + btnSize / 2;
                    ctx.fillRect(cx - bw - 1, bTop, bw, bh);
                    ctx.fillRect(cx + 1,      bTop, bw, bh);
                } else {
                    const cx = btnX + btnSize / 2 + 1;
                    const cy = btnY + btnSize / 2;
                    const th = btnSize * 0.45;
                    ctx.beginPath();
                    ctx.moveTo(cx - th * 0.5, cy - th * 0.6);
                    ctx.lineTo(cx + th * 0.6, cy);
                    ctx.lineTo(cx - th * 0.5, cy + th * 0.6);
                    ctx.closePath();
                    ctx.fill();
                }
                ctx.textAlign    = "left";
                ctx.textBaseline = "alphabetic";

                // Time label (current / total), left of centre after the button
                const timeX   = btnX + btnSize + 6;
                const timeY   = btnY + btnSize / 2 + 4;
                ctx.font      = "11px monospace";

                if (videoEl && videoEl.duration > 0) {
                    const dur  = videoEl.duration;
                    const cur  = videoEl.currentTime;
                    const fps  = videoInfo.fps || 30;
                    const fmtT = t => {
                        const m = Math.floor(t / 60);
                        const s = (t % 60).toFixed(2).padStart(5, "0");
                        return `${m}:${s}`;
                    };
                    const { start: trimStartS, end: trimEndS } = getTrimSeconds();
                    const trimMode = gw("trim_mode")?.value ?? "seconds";

                    let curLabel, totLabel;
                    if (trimMode === "frames") {
                        const fps2    = videoInfo.fps || 30;
                        const sw      = gw("trim_start")?.value ?? 0;
                        const ew      = gw("trim_end")?.value   ?? 0;
                        const totalF  = videoInfo.nb_frames || Math.round(dur * fps2);
                        const curF    = Math.floor(cur * fps2);
                        const winEndF = (ew > 0 && ew <= totalF) ? ew : totalF;
                        curLabel = `f ${curF}`;
                        totLabel = `f ${winEndF}`;
                    } else {
                        const windowEnd = (trimEndS > 0 && trimEndS <= dur) ? trimEndS : dur;
                        curLabel = fmtT(cur);
                        totLabel = fmtT(windowEnd);
                    }

                    ctx.fillStyle = C.pbTextBr;
                    ctx.fillText(curLabel, timeX, timeY);
                    ctx.fillStyle = C.pbText;
                    ctx.fillText(` / ${totLabel}`, timeX + ctx.measureText(curLabel).width, timeY);

                    // ── Row 2: progress track ───────────────────────────
                    const trimMode2   = trimMode;
                    const startFrac   = clamp(trimStartS / dur, 0, 1);
                    const effectiveEnd = (trimEndS > 0 && trimEndS <= dur) ? trimEndS : dur;
                    const endFrac     = clamp(effectiveEnd / dur, 0, 1);
                    const pct         = clamp(cur / dur, 0, 1);

                    // Track background
                    ctx.fillStyle = C.pbTrack;
                    ctx.beginPath();
                    ctx.roundRect(pbTrackX, pbTrackY, pbTrackW, pbTrackH, pbTrackH / 2);
                    ctx.fill();

                    // Trim region highlight
                    if (trimMode2 !== "none") {
                        ctx.fillStyle = "rgba(232,160,42,0.22)";
                        ctx.beginPath();
                        ctx.roundRect(
                            pbTrackX + pbTrackW * startFrac, pbTrackY,
                            pbTrackW * (endFrac - startFrac), pbTrackH,
                            pbTrackH / 2
                        );
                        ctx.fill();
                    }

                    // Progress fill
                    ctx.fillStyle = C.pbProgress;
                    ctx.beginPath();
                    ctx.roundRect(pbTrackX, pbTrackY, pbTrackW * pct, pbTrackH, pbTrackH / 2);
                    ctx.fill();

                    // Scrub head
                    const headX = pbTrackX + pbTrackW * pct;
                    ctx.fillStyle = "#ffffff";
                    ctx.beginPath();
                    ctx.arc(headX, pbTrackY + pbTrackH / 2, pbTrackH + 1, 0, Math.PI * 2);
                    ctx.fill();

                    // Trim bracket handles on track
                    if (trimMode2 !== "none") {
                        const startX = pbTrackX + pbTrackW * startFrac;
                        const endX   = pbTrackX + pbTrackW * endFrac;
                        const TH     = pbTrackH + 4;   // bracket height
                        const ty2    = pbTrackY - 2;

                        ctx.strokeStyle = "#c87d1a";
                        ctx.lineWidth   = 2;
                        ctx.beginPath();
                        ctx.moveTo(startX, ty2); ctx.lineTo(startX, ty2 + TH);
                        ctx.stroke();

                        ctx.strokeStyle = "#e8a02a";
                        ctx.beginPath();
                        ctx.moveTo(endX, ty2); ctx.lineTo(endX, ty2 + TH);
                        ctx.stroke();

                        ctx.lineWidth = 1;
                    }

                } else {
                    // No video — draw empty track + placeholder text
                    ctx.fillStyle = C.pbTrack;
                    ctx.beginPath();
                    ctx.roundRect(pbTrackX, pbTrackY, pbTrackW, pbTrackH, pbTrackH / 2);
                    ctx.fill();

                    ctx.fillStyle = C.infoDim;
                    ctx.fillText(hasVideo ? "loading…" : "0:00.00 / 0:00.00", timeX, timeY);
                }
                ctx.textAlign = "left";

                // ── Trim timeline ────────────────────────────────────────
                // A scrubbing panel with a time/frame ruler and a dual-handle
                // range slider that directly drives trim_start / trim_end.
                const ty = py + PLAYBACK_H;    // top of the trim timeline area
                const RULER_H  = 22;           // ruler height inside trim area
                const SBOX_H   = 24;           // slider box height
                const TL_PAD   = 8;            // inner horizontal padding
                const trimBg   = "#1a1a1a";
                const trimBord = "#2e2e2e";

                ctx.fillStyle   = trimBg;
                ctx.strokeStyle = trimBord;
                ctx.lineWidth   = 1;
                ctx.fillRect(x0, ty, W, TRIM_BAR_H);
                ctx.strokeRect(x0, ty, W, TRIM_BAR_H);

                // tl_x / tl_w define the shared horizontal track extents.
                // The playback bar track (above) is drawn using these same
                // values so the scrub head always lines up with the ruler.
                const tl_x = x0 + TL_PAD;
                const tl_w = W - TL_PAD * 2;
                const activeDur = getActiveDuration();
                const trimMode  = gw("trim_mode")?.value ?? "seconds";
                const fps       = videoInfo.fps || gw("fps")?.value || 30;

                // ── Time / frame ruler ──────────────────────────────────
                const rulerY = ty + 2;
                ctx.font      = "10px monospace";
                ctx.fillStyle = "#777";
                const NUM_MAJOR = 5;
                const NUM_SUB   = 4;
                const TOTAL_TICK = (NUM_MAJOR - 1) * NUM_SUB;

                for (let i = 0; i <= TOTAL_TICK; i++) {
                    const pct    = i / TOTAL_TICK;
                    const t      = activeDur * pct;
                    const isMajor = i % NUM_SUB === 0;
                    const tx     = tl_x + tl_w * pct;
                    const tickH  = isMajor ? 6 : 4;
                    ctx.fillStyle = isMajor ? "#999" : "#444";
                    ctx.fillRect(tx - (isMajor ? 1 : 0.5), rulerY, isMajor ? 2 : 1, tickH);

                    if (isMajor) {
                        let label;
                        if (trimMode === "frames") {
                            label = String(Math.round(t * fps));
                        } else {
                            const mm = Math.floor(t / 60);
                            const ss = Math.floor(t % 60);
                            label = `${mm}:${ss.toString().padStart(2, "0")}`;
                        }
                        ctx.fillStyle = "#888";
                        ctx.textAlign = i === 0 ? "left" : i === TOTAL_TICK ? "right" : "center";
                        ctx.fillText(label, tx, rulerY + tickH + 10);
                    }
                }
                ctx.textAlign = "left";

                // ── Slider box ──────────────────────────────────────────
                const sboxY = ty + RULER_H;

                // Cache for mouse handler
                sliderBarX = tl_x;
                sliderBarW = tl_w;
                sliderBarY = sboxY;
                sliderBarH = SBOX_H;

                // Track background
                ctx.fillStyle = "#111";
                ctx.beginPath();
                ctx.roundRect(tl_x, sboxY, tl_w, SBOX_H, 4);
                ctx.fill();
                ctx.strokeStyle = "#2a2a2a";
                ctx.lineWidth = 1;
                ctx.stroke();

                // Compute trim handle positions
                const { start: trimStartS, end: trimEndS } = getTrimSeconds();
                const startFrac  = clamp(trimStartS / activeDur, 0, 1);
                const visualEnd  = (trimEndS > 0 && trimEndS <= activeDur) ? trimEndS : activeDur;
                const endFrac    = clamp(visualEnd / activeDur, 0, 1);
                const startPx    = tl_x + tl_w * startFrac;
                const endPx      = tl_x + tl_w * endFrac;

                // Fill between handles
                ctx.fillStyle = "rgba(232,160,42,0.18)";
                ctx.beginPath();
                ctx.roundRect(startPx, sboxY, endPx - startPx, SBOX_H, 4);
                ctx.fill();

                // Handle bars (thick vertical strips)
                const HW = 8;   // handle width
                ctx.fillStyle = "#c87d1a";
                ctx.beginPath();
                ctx.roundRect(startPx - HW / 2, sboxY, HW, SBOX_H, 2);
                ctx.fill();
                ctx.fillStyle = "#e8a02a";
                ctx.beginPath();
                ctx.roundRect(endPx - HW / 2, sboxY, HW, SBOX_H, 2);
                ctx.fill();

                // Trimmed-length label centred in the filled region
                const midPx = (startPx + endPx) / 2;
                const trimmedSec = Math.max(0, visualEnd - trimStartS);
                let trimLabel;
                if (trimMode === "frames") {
                    trimLabel = `${Math.round(trimmedSec * fps)} fr`;
                } else {
                    const mm = Math.floor(trimmedSec / 60);
                    const ss = (trimmedSec % 60).toFixed(2).padStart(5, "0");
                    trimLabel = `${mm}:${ss}`;
                }
                const lblW = ctx.measureText(trimLabel).width + 2;
                const fillW = endPx - startPx;
                if (fillW > lblW + 8) {   // only draw if there's room
                    ctx.font      = "bold 10px monospace";
                    ctx.fillStyle = "rgba(232,160,42,0.85)";
                    ctx.textAlign = "center";
                    ctx.fillText(trimLabel, midPx, sboxY + SBOX_H / 2 + 4);
                    ctx.textAlign = "left";
                }

                // ── "Trim Mode" toggle bar (replaces the native trim_mode combo) ──
                const mbY = ty + TRIM_BAR_H;
                ctx.fillStyle   = C.infoBar;
                ctx.strokeStyle = C.bgBorder;
                ctx.lineWidth   = 1;
                ctx.fillRect(x0, mbY, W, MODE_BAR_H);
                ctx.strokeRect(x0, mbY, W, MODE_BAR_H);

                const modeLabel = "Trim Mode";
                ctx.font         = "bold 11px 'Segoe UI', sans-serif";
                ctx.fillStyle    = C.infoText;
                ctx.textAlign    = "left";
                ctx.textBaseline = "middle";
                ctx.fillText(modeLabel, x0 + 8, mbY + MODE_BAR_H / 2);
                const modeLabelW = ctx.measureText(modeLabel).width;

                const trimModeVal = gw("trim_mode")?.value ?? "seconds";
                const isFrames    = trimModeVal === "frames";

                const segH   = MODE_BAR_H - 8;
                const segY   = mbY + 4;
                const segW   = 54;
                const segGap = 2;
                const segX0  = x0 + 8 + modeLabelW + 4;

                modeToggleX      = segX0;
                modeToggleY      = segY;
                modeToggleSegW   = segW;
                modeToggleSegH   = segH;
                modeToggleSegGap = segGap;

                [["Seconds", !isFrames], ["Frames", isFrames]].forEach(([label, active], i) => {
                    const sx = segX0 + i * (segW + segGap);
                    ctx.fillStyle = active ? C.pbBtn : C.btnBg;
                    ctx.beginPath();
                    ctx.roundRect(sx, segY, segW, segH, 4);
                    ctx.fill();
                    ctx.fillStyle = active ? C.bg : C.btnText;
                    ctx.font      = "11px 'Segoe UI', sans-serif";
                    ctx.textAlign = "center";
                    ctx.fillText(label, sx + segW / 2, segY + segH / 2);
                });
                ctx.textAlign    = "left";
                ctx.textBaseline = "alphabetic";

                // ── "Crop" aspect-ratio button (right side, opposite Trim Mode) ──
                const cropLabel = `⛶  Crop: ${selectedAspect.name}  ▾`;
                ctx.font = "11px 'Segoe UI', sans-serif";
                const cropLabelW = ctx.measureText(cropLabel).width;
                cropBtnW = cropLabelW + 16;
                cropBtnH = segH;
                cropBtnX = x0 + W - 8 - cropBtnW;
                cropBtnY = segY;

                ctx.fillStyle = aspectDropdownOpen ? C.pbBtn : C.btnBg;
                ctx.beginPath();
                ctx.roundRect(cropBtnX, cropBtnY, cropBtnW, cropBtnH, 4);
                ctx.fill();
                ctx.fillStyle    = aspectDropdownOpen ? C.bg : C.btnText;
                ctx.textAlign    = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(cropLabel, cropBtnX + cropBtnW / 2, cropBtnY + cropBtnH / 2 + 1);
                ctx.textAlign    = "left";
                ctx.textBaseline = "alphabetic";

                // ── "Resize" method button (immediately left of "Crop") ──────
                const resizeLabel = `Resize: ${selectedResizeMethod.name}  ▾`;
                ctx.font = "11px 'Segoe UI', sans-serif";
                const resizeLabelW = ctx.measureText(resizeLabel).width;
                resizeBtnW = resizeLabelW + 16;
                resizeBtnH = segH;
                resizeBtnX = cropBtnX - 8 - resizeBtnW;
                resizeBtnY = segY;

                ctx.fillStyle = resizeDropdownOpen ? C.pbBtn : C.btnBg;
                ctx.beginPath();
                ctx.roundRect(resizeBtnX, resizeBtnY, resizeBtnW, resizeBtnH, 4);
                ctx.fill();
                ctx.fillStyle    = resizeDropdownOpen ? C.bg : C.btnText;
                ctx.textAlign    = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(resizeLabel, resizeBtnX + resizeBtnW / 2, resizeBtnY + resizeBtnH / 2 + 1);
                ctx.textAlign    = "left";
                ctx.textBaseline = "alphabetic";

                // ── Info bar ────────────────────────────────────────────
                const iy = mbY + MODE_BAR_H;
                ctx.fillStyle   = C.infoBar;
                ctx.strokeStyle = C.bgBorder;
                ctx.lineWidth   = 1;
                ctx.fillRect(x0, iy, W, INFO_H);
                ctx.strokeRect(x0, iy, W, INFO_H);

                const c = getCrop();
                ctx.fillStyle = C.infoText;
                ctx.font      = "11px monospace";
                ctx.fillText(
                    `  x: ${c.x}  y: ${c.y}  w: ${c.w}  h: ${c.h}`,
                    x0 + 6,
                    iy + INFO_H / 2 + 4,
                );

                if (videoInfo.width > 0) {
                    // ── Right-aligned video metadata ────────────────────
                    const meta = `${videoInfo.width}×${videoInfo.height}  ${videoInfo.fps.toFixed(3)} fps  ${videoInfo.duration.toFixed(2)} s  `;
                    ctx.fillStyle = C.infoDim;
                    const tw = ctx.measureText(meta).width;
                    ctx.fillText(meta, x0 + W - tw - 2, iy + INFO_H / 2 + 4);

                    // ── Centred audio badge ─────────────────────────────
                    const audioIcon  = videoInfo.has_audio ? "🔊" : "🔇";
                    const audioLabel = videoInfo.has_audio
                        ? ` ${(videoInfo.audio_codec || "audio").toUpperCase()}  ${videoInfo.audio_channels === 1 ? "mono" : "stereo"}  ${(videoInfo.audio_sample_rate / 1000).toFixed(1)} kHz`
                        : "  no audio";
                    ctx.font      = "10px 'Segoe UI', sans-serif";
                    ctx.fillStyle = videoInfo.has_audio ? C.infoText : C.infoDim;
                    ctx.textAlign = "center";
                    ctx.fillText(audioIcon + audioLabel, x0 + W / 2, iy + INFO_H / 2 + 4);
                    ctx.textAlign = "left";
                }

                // ── Aspect-ratio dropdown overlay ────────────────────────
                // Drawn last so it floats above everything else in this
                // widget. Positioned centred horizontally, just above the
                // Trim Mode / Crop bar (over the canvas/playback/trim area,
                // which has plenty of room for the full list).
                if (aspectDropdownOpen) {
                    dropdownW = DROPDOWN_W;
                    dropdownH = ASPECT_RATIOS.length * DROPDOWN_ITEM_H;
                    dropdownX = x0 + W / 2 - dropdownW / 2;
                    dropdownY = mbY - 4 - dropdownH;

                    ctx.fillStyle   = "#1a1a1a";
                    ctx.strokeStyle = "#3a3a3a";
                    ctx.lineWidth   = 1;
                    ctx.shadowColor = "rgba(0,0,0,0.5)";
                    ctx.shadowBlur  = 10;
                    ctx.beginPath();
                    ctx.roundRect(dropdownX, dropdownY, dropdownW, dropdownH, 6);
                    ctx.fill();
                    ctx.shadowBlur  = 0;
                    ctx.stroke();

                    ASPECT_RATIOS.forEach((r, i) => {
                        const ry = dropdownY + i * DROPDOWN_ITEM_H;
                        const isSelected = r === selectedAspect;
                        if (isSelected) {
                            ctx.fillStyle = C.pbBtn;
                            ctx.fillRect(dropdownX + 1, ry, dropdownW - 2, DROPDOWN_ITEM_H);
                        }
                        ctx.fillStyle    = isSelected ? C.bg : C.btnText;
                        ctx.font         = isSelected ? "bold 11px 'Segoe UI', sans-serif" : "11px 'Segoe UI', sans-serif";
                        ctx.textAlign    = "left";
                        ctx.textBaseline = "middle";
                        ctx.fillText(r.name, dropdownX + 10, ry + DROPDOWN_ITEM_H / 2 + 1);
                    });
                    ctx.textAlign    = "left";
                    ctx.textBaseline = "alphabetic";
                }

                // ── Resize-method dropdown overlay ───────────────────────
                // Drawn last, floating above everything else. Positioned
                // centred over the "Resize" button, just above the
                // Trim Mode / Crop / Resize bar.
                if (resizeDropdownOpen) {
                    resizeDropdownW = RESIZE_DROPDOWN_W;
                    resizeDropdownH = RESIZE_METHODS.length * DROPDOWN_ITEM_H;
                    resizeDropdownX = clamp(
                        resizeBtnX + resizeBtnW / 2 - resizeDropdownW / 2,
                        x0, x0 + W - resizeDropdownW,
                    );
                    resizeDropdownY = mbY - 4 - resizeDropdownH;

                    ctx.fillStyle   = "#1a1a1a";
                    ctx.strokeStyle = "#3a3a3a";
                    ctx.lineWidth   = 1;
                    ctx.shadowColor = "rgba(0,0,0,0.5)";
                    ctx.shadowBlur  = 10;
                    ctx.beginPath();
                    ctx.roundRect(resizeDropdownX, resizeDropdownY, resizeDropdownW, resizeDropdownH, 6);
                    ctx.fill();
                    ctx.shadowBlur  = 0;
                    ctx.stroke();

                    RESIZE_METHODS.forEach((m, i) => {
                        const ry = resizeDropdownY + i * DROPDOWN_ITEM_H;
                        const isSelected = m === selectedResizeMethod;
                        if (isSelected) {
                            ctx.fillStyle = C.pbBtn;
                            ctx.fillRect(resizeDropdownX + 1, ry, resizeDropdownW - 2, DROPDOWN_ITEM_H);
                        }
                        ctx.fillStyle    = isSelected ? C.bg : C.btnText;
                        ctx.font         = isSelected ? "bold 11px 'Segoe UI', sans-serif" : "11px 'Segoe UI', sans-serif";
                        ctx.textAlign    = "left";
                        ctx.textBaseline = "middle";
                        ctx.fillText(m.name, resizeDropdownX + 10, ry + DROPDOWN_ITEM_H / 2 + 1);
                    });
                    ctx.textAlign    = "left";
                    ctx.textBaseline = "alphabetic";
                }
            },

            // ── Mouse handler ─────────────────────────────────────────────
            mouse(event, pos, node) {
                // pos is [x, y] in node-local coordinates
                const nx = pos[0];
                const ny = pos[1];

                const type = event.type;

                // ── Resize-method dropdown (overlay; highest hit-test priority) ──
                if (resizeDropdownOpen) {
                    if (type === "pointerdown" || type === "mousedown") {
                        if (nx >= resizeDropdownX && nx <= resizeDropdownX + resizeDropdownW &&
                            ny >= resizeDropdownY && ny <= resizeDropdownY + resizeDropdownH) {
                            const idx = Math.floor((ny - resizeDropdownY) / DROPDOWN_ITEM_H);
                            const methodObj = RESIZE_METHODS[idx];
                            if (methodObj) {
                                selectedResizeMethod = methodObj;
                                const w = gw("resize_method");
                                if (w) {
                                    w.value = methodObj.val;
                                    w.callback?.call(w, methodObj.val);
                                }
                            }
                        }
                        resizeDropdownOpen = false;
                        node.setDirtyCanvas(true, false);
                        return true;
                    }
                    return true;   // swallow all other events while open
                }

                // ── Aspect-ratio dropdown (overlay; highest hit-test priority) ──
                if (aspectDropdownOpen) {
                    if (type === "pointerdown" || type === "mousedown") {
                        if (nx >= dropdownX && nx <= dropdownX + dropdownW &&
                            ny >= dropdownY && ny <= dropdownY + dropdownH) {
                            const idx = Math.floor((ny - dropdownY) / DROPDOWN_ITEM_H);
                            const ratioObj = ASPECT_RATIOS[idx];
                            if (ratioObj) {
                                selectedAspect = ratioObj;
                                applyAspectRatio(ratioObj);
                            }
                        }
                        aspectDropdownOpen = false;
                        node.setDirtyCanvas(true, false);
                        return true;
                    }
                    return true;   // swallow all other events while open
                }

                // ── Playback bar hit region ────────────────────────────
                const pbY0 = this.last_y + dynamicCanvasH;
                const pbY1 = pbY0 + PLAYBACK_H;

                if (ny >= pbY0 && ny <= pbY1) {
                    if (type === "pointerdown" || type === "mousedown") {
                        // Play/pause button — matches draw(): btnX = x0+6, btnSize = topRowH-10
                        const _topRowH = PLAYBACK_H - 4 - 1;
                        const btnSize  = _topRowH - 10;
                        const btnX     = PAD + 6;
                        if (nx >= btnX && nx <= btnX + btnSize) {
                            togglePlayback();
                            return true;
                        }
                        // Progress-bar scrub. The playback bar only ever seeks
                        // (moves the play head) — it never writes trim_start/
                        // trim_end. The trim handles drawn on this bar are a
                        // read-only reference; drag them from the trim
                        // timeline below to actually change the trim window.
                        if (videoEl && videoEl.duration > 0 &&
                            nx >= progBarX - 10 && nx <= progBarX + progBarW + 10) {

                            const dur = videoEl.duration;
                            const pct = clamp((nx - progBarX) / progBarW, 0, 1);
                            videoEl.currentTime = pct * dur;
                            node.setDirtyCanvas(true, false);
                            return true;
                        }
                    }
                    if ((type === "pointermove" || type === "mousemove") &&
                            event.buttons === 1 &&
                            videoEl && videoEl.duration > 0) {

                        const dur = videoEl.duration;

                        // Drag-scrub (pointer started in bar — buttons===1).
                        // Seek only; never touches trim_start/trim_end.
                        if (nx >= progBarX - 8 && nx <= progBarX + progBarW + 8) {
                            const pct = clamp((nx - progBarX) / progBarW, 0, 1);
                            videoEl.currentTime = pct * dur;
                            node.setDirtyCanvas(true, false);
                            return true;
                        }
                    }
                    if (type === "pointerup" || type === "mouseup") {
                        return false;
                    }
                    return false;
                }

                // ── Trim timeline: drag move/release follows cursor anywhere ─
                // Once a drag is in progress, process moves and releases
                // regardless of whether the cursor is still inside the strip.
                if (timelineDrag) {
                    if (type === "pointerup" || type === "mouseup") {
                        timelineDrag = null;
                        return true;
                    }
                    if (type === "pointermove" || type === "mousemove") {
                        const activeDur = getActiveDuration();
                        const val = clamp(((nx - sliderBarX) / sliderBarW) * activeDur, 0, activeDur);
                        const { start: trimStartS, end: trimEndS } = getTrimSeconds();
                        const effectiveEnd = (trimEndS > 0) ? trimEndS : activeDur;

                        if (timelineDrag === "start") {
                            const newStart = clamp(val, 0, effectiveEnd - 0.01);
                            setTrimSeconds(newStart, effectiveEnd);
                            if (videoEl) videoEl.currentTime = newStart;
                        } else if (timelineDrag === "end") {
                            const newEnd = clamp(val, trimStartS + 0.01, activeDur);
                            setTrimSeconds(trimStartS, newEnd);
                            if (videoEl) videoEl.currentTime = newEnd;
                        } else if (timelineDrag === "center") {
                            let newStart = val - timelineDragOffset;
                            let newEnd   = newStart + timelineDragWidth;
                            if (newStart < 0) { newStart = 0; newEnd = timelineDragWidth; }
                            if (newEnd > activeDur) { newEnd = activeDur; newStart = activeDur - timelineDragWidth; }
                            setTrimSeconds(newStart, newEnd);
                            if (videoEl) videoEl.currentTime = newStart;
                        }
                        node.setDirtyCanvas(true, false);
                        return true;
                    }
                }

                // ── Trim timeline hit region (pointerdown only) ────────
                const tlY0 = this.last_y + dynamicCanvasH + PLAYBACK_H;
                const tlY1 = tlY0 + TRIM_BAR_H;

                if (ny >= tlY0 && ny <= tlY1 && ny >= sliderBarY && ny <= sliderBarY + sliderBarH) {
                    if (type === "pointerdown" || type === "mousedown") {
                        const activeDur = getActiveDuration();
                        const { start: trimStartS, end: trimEndS } = getTrimSeconds();
                        const effectiveEnd = (trimEndS > 0 && trimEndS <= activeDur) ? trimEndS : activeDur;

                        const startFrac = clamp(trimStartS / activeDur, 0, 1);
                        const endFrac   = clamp(effectiveEnd / activeDur, 0, 1);
                        const startPx   = sliderBarX + sliderBarW * startFrac;
                        const endPx     = sliderBarX + sliderBarW * endFrac;

                        const HANDLE_HIT = 12;  // px hit tolerance for handles

                        if (Math.abs(nx - startPx) <= HANDLE_HIT) {
                            timelineDrag = "start";
                        } else if (Math.abs(nx - endPx) <= HANDLE_HIT) {
                            timelineDrag = "end";
                        } else if (nx > startPx + HANDLE_HIT && nx < endPx - HANDLE_HIT) {
                            // Click inside the selected region — pan the whole window
                            timelineDrag = "center";
                            const clickVal = ((nx - sliderBarX) / sliderBarW) * activeDur;
                            timelineDragOffset = clickVal - trimStartS;
                            timelineDragWidth  = effectiveEnd - trimStartS;
                        } else {
                            // Click outside selection — move nearest handle
                            const clickVal = ((nx - sliderBarX) / sliderBarW) * activeDur;
                            if (Math.abs(clickVal - trimStartS) < Math.abs(clickVal - effectiveEnd)) {
                                timelineDrag = "start";
                                setTrimSeconds(clamp(clickVal, 0, effectiveEnd - 0.01), effectiveEnd);
                            } else {
                                timelineDrag = "end";
                                setTrimSeconds(trimStartS, clamp(clickVal, trimStartS + 0.01, activeDur));
                            }
                        }
                        if (videoEl && videoEl.duration > 0) {
                            const { start: s } = getTrimSeconds();
                            videoEl.currentTime = s;
                        }
                        node.setDirtyCanvas(true, false);
                        return true;
                    }
                    return false;
                }

                // ── "Trim Mode" toggle hit region (below the trim bar) ─────
                const modeBarY0 = tlY1;
                const modeBarY1 = modeBarY0 + MODE_BAR_H;

                if (ny >= modeBarY0 && ny <= modeBarY1) {
                    if (type === "pointerdown" || type === "mousedown") {
                        // "Resize" button — opens the resize-method dropdown
                        if (nx >= resizeBtnX && nx <= resizeBtnX + resizeBtnW &&
                            ny >= resizeBtnY && ny <= resizeBtnY + resizeBtnH) {
                            resizeDropdownOpen = true;
                            aspectDropdownOpen = false;
                            node.setDirtyCanvas(true, false);
                            return true;
                        }
                        // "Crop" button — opens the aspect-ratio dropdown
                        if (nx >= cropBtnX && nx <= cropBtnX + cropBtnW &&
                            ny >= cropBtnY && ny <= cropBtnY + cropBtnH) {
                            aspectDropdownOpen = true;
                            resizeDropdownOpen = false;
                            node.setDirtyCanvas(true, false);
                            return true;
                        }
                        for (let i = 0; i < 2; i++) {
                            const sx = modeToggleX + i * (modeToggleSegW + modeToggleSegGap);
                            if (nx >= sx && nx <= sx + modeToggleSegW &&
                                ny >= modeToggleY && ny <= modeToggleY + modeToggleSegH) {
                                const newVal = i === 0 ? "seconds" : "frames";
                                const w = gw("trim_mode");
                                if (w && w.value !== newVal) {
                                    // Convert trim_start/trim_end so the same real-world
                                    // window is preserved across the unit switch: read
                                    // the current window in seconds under the OLD mode,
                                    // flip the mode, then re-write it in the NEW mode's
                                    // units via setTrimSeconds (which is mode-aware).
                                    const { start, end } = getTrimSeconds();
                                    w.value = newVal;
                                    w.callback?.call(w, newVal);
                                    setTrimSeconds(start, end);
                                    if (videoEl && videoEl.duration > 0) {
                                        videoEl.currentTime = start;
                                    }
                                }
                                node.setDirtyCanvas(true, false);
                                return true;
                            }
                        }
                    }
                    return true;   // swallow all events inside the mode bar
                }

                // ── Canvas drag region ─────────────────────────────────
                if (!previewImg) return false;

                // Crop-preview mode shows the output frame; dragging makes no
                // sense there, so forward nothing to the drag machinery.
                if (cropPreviewMode) return false;

                // Reject if outside the canvas strip
                if (ny < this.last_y || ny > this.last_y + dynamicCanvasH) return false;
                if (nx < dOffX - 2   || nx > dOffX + dWidth + 2)     return false;

                // ── Drag start ─────────────────────────────────────────
                if (type === "pointerdown" || type === "mousedown") {
                    dragMode   = hitTest(nx, ny);
                    dragAnchor = { x: nx, y: ny };
                    dragCrop   = getCrop();

                    // Double-click → reset to full frame
                    if (event.detail === 2 && videoInfo.width > 0) {
                        setCrop(0, 0, videoInfo.width, videoInfo.height);
                        dragMode = null;
                    }
                    return true;
                }

                // ── Drag move ──────────────────────────────────────────
                if ((type === "pointermove" || type === "mousemove") && dragMode) {
                    const dx  = (nx - dragAnchor.x) / dScale;   // Δ in image pixels
                    const dy  = (ny - dragAnchor.y) / dScale;
                    const sc  = dragCrop;

                    const R = getEffectiveRatio();   // 0 = Freeform, no lock

                    if (dragMode === "create") {
                        const a = nodeToImg(dragAnchor.x, dragAnchor.y);
                        const b = nodeToImg(nx, ny);
                        let ix = Math.min(a.x, b.x);
                        let iy = Math.min(a.y, b.y);
                        let iw = Math.abs(b.x - a.x);
                        let ih = Math.abs(b.y - a.y);
                        if (R > 0) {
                            ih = iw / R;
                            iy = (b.y < a.y) ? (a.y - ih) : a.y;
                        }
                        if (iw > 2 && ih > 2) setCrop(ix, iy, iw, ih);

                    } else if (dragMode === "move") {
                        setCrop(sc.x + dx, sc.y + dy, sc.w, sc.h);

                    } else if (dragMode === "tl" || dragMode === "tr" ||
                               dragMode === "bl" || dragMode === "br") {
                        let newW, newH;
                        if (dragMode === "tl")      { newW = sc.w - dx; newH = sc.h - dy; }
                        else if (dragMode === "tr") { newW = sc.w + dx; newH = sc.h - dy; }
                        else if (dragMode === "bl") { newW = sc.w - dx; newH = sc.h + dy; }
                        else                        { newW = sc.w + dx; newH = sc.h + dy; }

                        if (R > 0) newH = newW / R;   // lock aspect ratio

                        let newX, newY;
                        if (dragMode === "tl")      { newX = sc.x + sc.w - newW; newY = sc.y + sc.h - newH; }
                        else if (dragMode === "tr") { newX = sc.x;               newY = sc.y + sc.h - newH; }
                        else if (dragMode === "bl") { newX = sc.x + sc.w - newW; newY = sc.y; }
                        else                        { newX = sc.x;               newY = sc.y; }

                        setCrop(newX, newY, newW, newH);
                    }
                    return true;
                }

                // ── Drag end ───────────────────────────────────────────
                if (type === "pointerup" || type === "mouseup") {
                    dragMode   = null;
                    dragAnchor = null;
                    dragCrop   = null;
                    return true;
                }

                return false;
            },
        }; // end cropWidget

        // ── Attach the widget BEFORE the built-in numeric widgets ──────────
        // We prepend it so it sits at the top of the node body.
        node.widgets.unshift(cropWidget);

        // ── Shared helper: recompute dynamicCanvasH from a given node size ──
        // Called from both onResize and draw() so the canvas always reflects
        // the actual node dimensions, even mid-drag before onResize fires.
        function recalcCanvasH(nodeW, nodeH) {
            const titleH = (typeof LiteGraph !== "undefined"
                ? LiteGraph.NODE_TITLE_HEIGHT : null) ?? 30;
            const otherH = node.widgets.reduce((sum, w) => {
                if (w === cropWidget) return sum;
                try {
                    const s = w.computeSize ? w.computeSize(nodeW) : null;
                    return sum + (Array.isArray(s) ? (s[1] || 28) : 28);
                } catch { return sum + 28; }
            }, 0);
            const available = nodeH - titleH - otherH - MODE_BAR_H - PLAYBACK_H - TRIM_BAR_H - INFO_H;
            dynamicCanvasH  = Math.max(CANVAS_H, available);
        }

        // ── Resize hook: canvas grows, fixed bars stay put ─────────────────
        // When the user drags a corner to enlarge the node, all extra vertical
        // space goes to the video-preview canvas.  PLAYBACK_H and INFO_H are
        // always fixed.  The canvas never shrinks below its initial CANVAS_H.
        const _origOnResize = node.onResize?.bind(node);
        node.onResize = function (size) {
            if (_origOnResize) _origOnResize(size);

            // Enforce minimum width during resize (mirrors the creation-time clamp).
            if (size[0] < MIN_W) size[0] = MIN_W;

            recalcCanvasH(size[0], size[1]);
            lastNodeW = size[0];
            lastNodeH = size[1];

            node.setDirtyCanvas(true, false);
        };


        const uploadVideoBtn = node.addWidget("button", "📁  Upload Your Video", null, async () => {
            try {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = "video/*,.mp4,.mov,.webm,.avi,.mkv";

                input.onchange = async () => {
                    const file = input.files?.[0];
                    if (!file) return;

                    showStatus("⏳  Uploading video…");

                    try {
                        const formData = new FormData();
                        formData.append("image", file);
                        formData.append("type", "input");
                        formData.append("overwrite", "true");

                        const resp = await fetch("/upload/image", {
                            method: "POST",
                            body: formData,
                        });

                        if (!resp.ok) {
                            showStatus("✖  Upload failed.");
                            return;
                        }

                        const data = await resp.json();
                        const uploadedPath = data.name || file.name;

                        const pathW = gw("video_path");
                        if (pathW) {
                            pathW.value = uploadedPath;
                        }

                        node.setDirtyCanvas(true, true);

                        showStatus("✔  Upload complete.");

                        await loadPreview(uploadedPath);

                    } catch (err) {
                        console.error("[VideoCropTrim] upload error:", err);
                        showStatus(`✖  ${err.message}`);
                    }
                };

                input.click();

            } catch (err) {
                console.error("[VideoCropTrim] file picker error:", err);
                showStatus(`✖  ${err.message}`);
            }
        }, { serialize: false });

        // ── "Preview Crop" toggle button ──────────────────────────────────
        // Switches the canvas between full-frame-with-overlay and a letterboxed
        // view of only the cropped region, so you can judge the output without
        // running the full workflow.
        const previewCropBtn = node.addWidget("button", "🔍  Preview Crop Output", null, () => {
            if (!previewImg) {
                showStatus("⚠  Upload or auto-load a video first.");
                return;
            }
            cropPreviewMode = !cropPreviewMode;
            previewCropBtn.name = cropPreviewMode
                ? "⊞  Back to Full Frame"
                : "🔍  Preview Crop Output";
            node.setDirtyCanvas(true, false);
        }, { serialize: false });

        // ── "Preview Trimmed Output" button ───────────────────────────────
        // Plays the video from trim_start to trim_end so the user can preview
        // the trimmed segment without running the full workflow.
        const previewTrimBtn = node.addWidget("button", "✂  Preview Trimmed Output", null, () => {
            if (!videoEl) {
                showStatus("⚠  Upload or auto-load a video first.");
                return;
            }
            const trimMode = gw("trim_mode")?.value ?? "seconds";
            if (trimMode === "none") {
                showStatus("⚠  Set trim_mode to 'seconds' or 'frames' to use trim preview.");
                return;
            }
            toggleTrimPlayback();
        }, { serialize: false });

        // ── "Reset Crop" button ────────────────────────────────────────────
        const resetCropBtn = node.addWidget("button", "⊡  Reset Crop to Full Frame", null, () => {
            if (videoInfo.width > 0) {
                setCrop(0, 0, videoInfo.width, videoInfo.height);
            } else {
                showStatus("⚠  Load a preview first so the frame size is known.");
            }
        }, { serialize: false });

        // ── "Reset Trim to Full Video" button ──────────────────────────────
        const resetTrimBtn = node.addWidget("button", "⊡  Reset Trim to Full Video", null, () => {
            const trimMode = gw("trim_mode")?.value ?? "seconds";
            if (trimMode === "none") {
                showStatus("⚠  Set trim_mode to 'seconds' or 'frames' first.");
                return;
            }
            const dur = videoEl?.duration || videoInfo.duration || 0;
            if (dur <= 0) {
                showStatus("⚠  Load a preview first so the duration is known.");
                return;
            }
            const fps = videoInfo.fps || gw("fps")?.value || 30;
            const sw = gw("trim_start");
            const ew = gw("trim_end");
            if (trimMode === "frames") {
                const totalF = videoInfo.nb_frames || Math.round(dur * fps);
                if (sw) sw.value = 0;
                if (ew) ew.value = totalF;
            } else {
                if (sw) sw.value = 0;
                if (ew) ew.value = Math.round(dur * 100) / 100;
            }
            node.setDirtyCanvas(true, false);
        }, { serialize: false });

        // ── Reorder: keep these action buttons above the ffmpeg-flags text ──
        // addWidget() always appends to the end of node.widgets, which puts
        // them after any Python-defined widgets — including the multi-line
        // ffmpeg-flags textbox. Move them back up so they sit directly below
        // the last numeric widget (fps) and above that textbox.
        {
            const actionButtons = [uploadVideoBtn, previewCropBtn, previewTrimBtn, resetCropBtn, resetTrimBtn];
            for (const b of actionButtons) {
                const i = node.widgets.indexOf(b);
                if (i !== -1) node.widgets.splice(i, 1);
            }
            const fpsIdx = node.widgets.findIndex(w => w.name === "fps");
            const insertAt = fpsIdx !== -1 ? fpsIdx + 1 : node.widgets.length;
            node.widgets.splice(insertAt, 0, ...actionButtons);
            node.setDirtyCanvas(true, true);
        }

        // ── Minimal status overlay (written to the canvas placeholder area) ─
        let _statusMsg = "";
        function showStatus(msg) {
            _statusMsg = msg;
            node.setDirtyCanvas(true, false);
            setTimeout(() => { _statusMsg = ""; node.setDirtyCanvas(true, false); }, 4000);
        }

        // Patch draw to overlay status messages over the placeholder text
        const _origDraw = cropWidget.draw.bind(cropWidget);
        cropWidget.draw = function (ctx, node, nodeWidth, y) {
            _origDraw(ctx, node, nodeWidth, y);
            if (_statusMsg && !previewImg) {
                const x0 = PAD;
                const W  = nodeWidth - PAD * 2;
                ctx.fillStyle = C.infoText;
                ctx.font      = "12px 'Segoe UI', sans-serif";
                ctx.textAlign = "center";
                ctx.fillText(_statusMsg, x0 + W / 2, y + dynamicCanvasH / 2 + 36);
                ctx.textAlign = "left";
            }
        };

        // ── loadPreview ────────────────────────────────────────────────────
        async function loadPreview(videoPath) {
            try {
                const resp = await fetch("/videocropptrim/preview_frame", {
                    method:  "POST",
                    headers: { "Content-Type": "application/json" },
                    body:    JSON.stringify({ video_path: videoPath }),
                });

                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({ error: resp.statusText }));
                    showStatus(`✖  ${err.error ?? "Server error"}`);
                    return;
                }

                const data = await resp.json();

                const img  = new Image();
                img.onload = () => {
                    previewImg      = img;
                    cropPreviewMode = false;            // return to full-frame view
                    if (previewCropBtn)                 // reset button label
                        previewCropBtn.name = "🔍  Preview Crop Output";

                    // Populate video metadata
                    const info = data.info ?? {};
                    videoInfo = {
                        width:            info.width     || img.naturalWidth,
                        height:           info.height    || img.naturalHeight,
                        fps:              info.fps       || 30,
                        duration:         info.duration  || 0,
                        nb_frames:        info.nb_frames || 0,
                        has_audio:        info.has_audio        ?? false,
                        audio_codec:      info.audio_codec      ?? null,
                        audio_sample_rate:info.audio_sample_rate ?? 0,
                        audio_channels:   info.audio_channels    ?? 0,
                    };

                    // Always reset crop to the new video's full frame on load.
                    // A stale crop from a previous video would otherwise remain.
                    setCrop(0, 0, videoInfo.width, videoInfo.height);

                    // Default the aspect-ratio lock to whichever preset most
                    // closely matches the loaded video, then fit the crop to it.
                    selectedAspect = closestAspectRatio(videoInfo.width, videoInfo.height);
                    applyAspectRatio(selectedAspect);
                    aspectDropdownOpen = false;

                    // Sync fps widget with the video's native frame rate
                    const fpsW = gw("fps");
                    if (fpsW && videoInfo.fps > 0) {
                        fpsW.value = Math.round(videoInfo.fps * 1000) / 1000;
                    }

                    // Write video_duration so the timeline and Python backend always
                    // know the total clip length, even before playback starts.
                    const durW = gw("video_duration");
                    if (durW && videoInfo.duration > 0) {
                        durW.value = Math.round(videoInfo.duration * 1000) / 1000;
                    }

                    // Always reset trim_start / trim_end to the full video range on
                    // every load so stale values from a previous video are cleared.
                    {
                        const modeW  = gw("trim_mode");
                        const startW = gw("trim_start");
                        const endW   = gw("trim_end");
                        if (videoInfo.duration > 0) {
                            const _dur  = videoInfo.duration;
                            const _fps  = videoInfo.fps || 30;
                            if (modeW?.value === "frames") {
                                const totalF = videoInfo.nb_frames || Math.round(_dur * _fps);
                                if (startW) startW.value = 0;
                                if (endW)   endW.value   = totalF;
                            } else {
                                // covers "seconds" and "none"
                                if (startW) startW.value = 0;
                                if (endW)   endW.value   = Math.round(_dur * 100) / 100;
                            }
                        }
                    }

                    // ── Set up off-screen video element for playback ────
                    pausePlayback();   // stop any previous playback
                    const vel = document.createElement("video");
                    vel.preload     = "auto";
                    vel.muted       = true;        // required for autoplay policy
                    vel.playsInline = true;
                    vel.crossOrigin = "anonymous";
                    vel.src = `/videocropptrim/serve_video?path=${encodeURIComponent(videoPath)}`;
                    vel.addEventListener("ended", () => {
                        isPlaying = false;
                        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
                        node.setDirtyCanvas(true, false);
                    });
                    vel.addEventListener("canplay", () => {
                        // Seek to start so the scrub head always shows 0 on new load.
                        // { once: true } is critical: "canplay" also re-fires during
                        // normal playback (after buffering/stalls), and without this
                        // guard every re-fire snapped the video back to time 0,
                        // making playback look completely broken.
                        vel.currentTime = 0;
                        node.setDirtyCanvas(true, false);
                    }, { once: true });
                    videoEl = vel;

                    node.setDirtyCanvas(true, true);
                };
                img.onerror = () => showStatus("✖  Could not decode preview image.");
                img.src = `data:image/png;base64,${data.frame}`;

            } catch (err) {
                console.error("[VideoCropTrim] loadPreview error:", err);
                showStatus(`✖  ${err.message}`);
            }
        }

        // ── Enforce minimum node width ─────────────────────────────────────
        const [curW, curH] = node.size;
        node.setSize([Math.max(curW, MIN_W), curH]);

        // ── Hide backend-only widgets ──────────────────────────────────────
        // video_path and video_duration are serialized by ComfyUI for the
        // Python backend, but the UI manages their values automatically so
        // they should not clutter the widget list with editable fields.
        queueMicrotask(() => {
            // Sync the "Resize" button's initial selection from the native
            // resize_method widget's value (e.g. a saved workflow), before
            // that widget is hidden below.
            const rmW = gw("resize_method");
            if (rmW) {
                const match = RESIZE_METHODS.find(m => m.val === rmW.value);
                if (match) selectedResizeMethod = match;
                else rmW.value = selectedResizeMethod.val;   // self-heal invalid value
            }

            // trim_mode is hidden here too: it's now driven by the "Trim Mode"
            // Seconds/Frames toggle drawn at the top of the canvas widget,
            // not by the native combo dropdown. resize_method is likewise
            // driven by the custom "Resize" button/dropdown.
            for (const name of ["video_path", "video_duration", "trim_mode", "resize_method"]) {
                const w = gw(name);
                if (w) {
                    w.hidden = true;
                    w.type   = "hidden";
                    w.computeSize = () => [0, -4];   // suppress layout gap
                }
            }
            node.setDirtyCanvas(true, true);
        });

        // ── Auto-load preview when node is first created with a path set ───
        // (Useful when duplicating a node or loading a saved workflow.)
        queueMicrotask(async () => {
            const pathW = gw("video_path");
            if (pathW?.value?.trim()) {
                await loadPreview(pathW.value.trim());
            }
        });
    }, // end nodeCreated
}); // end registerExtension
