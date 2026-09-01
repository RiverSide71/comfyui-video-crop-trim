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
const PAD         = 8;      // Horizontal padding inside the node
const HANDLE_R    = 5;      // Corner-handle hit-radius in pixels
const HANDLE_SZ   = 9;      // Corner-handle draw size
const MIN_W       = 460;    // Minimum node width we enforce
const CANVAS_PAD  = 14;     // Inset padding inside the preview canvas so crop guides have breathing room
const ICONBAR_H   = 44;     // Height of the compact icon-button action row
const ICONBAR_GAP = 6;      // Horizontal gap between icon buttons

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
    iconActiveBg:   "#c87d1a",   // Active/toggled icon-button fill
    iconActiveBord: "#e8a02a",   // Active/toggled icon-button border
    iconActiveText: "#1c1508",   // Text/icon colour on the active fill
    iconHoverText:  "#ffffff",   // Text/icon colour on hover
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

function wrapTextLines(ctx, text, maxWidth) {
    const words = text.split(" ");
    const lines = [];
    let line = "";
    for (const w of words) {
        const test = line ? `${line} ${w}` : w;
        if (line && ctx.measureText(test).width > maxWidth) {
            lines.push(line);
            line = w;
        } else {
            line = test;
        }
    }
    if (line) lines.push(line);
    return lines;
}

const _measureCanvas = document.createElement("canvas");
const _measureCtx    = _measureCanvas.getContext("2d");

// ─── Crop aspect-ratio presets ───────────────────────────────────────────────

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
        if (name === "quality") {
            const n = Number(value);
            if (!Number.isFinite(n)) return;
            value = clamp(Math.round(n), 0, 51);
        }
        const cur = loadStickySettings();
        cur[name] = value;
        localStorage.setItem(STICKY_KEY, JSON.stringify(cur));
    } catch {
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
        let dynamicMinW = MIN_W;

        const getCanvasH = (widget, nodeWidth) => {
            const h = Number(widget?.computedHeight);
            const fixedH = getModeBarH(nodeWidth) + PLAYBACK_H + TRIM_BAR_H + INFO_H;
            return Number.isFinite(h)
                ? Math.max(CANVAS_H, h - fixedH)
                : CANVAS_H;
        };

        function recalcInfoBarMinW() {
            const ctx = _measureCtx;

            ctx.font = "11px monospace";
            const coordText = videoInfo.width > 0
                ? `x:${videoInfo.width} y:${videoInfo.height} w:${videoInfo.width} h:${videoInfo.height}`
                : "x:0 y:0 w:512 h:512";
            const coordW = ctx.measureText(coordText).width;

            let metaW = 0, audioW = 0;
            if (videoInfo.width > 0) {
                const meta = `${videoInfo.width}×${videoInfo.height}  ${videoInfo.fps.toFixed(3)} fps  ${videoInfo.duration.toFixed(2)} s`;
                ctx.font = "11px monospace";
                metaW = ctx.measureText(meta).width;

                const audioIcon  = videoInfo.has_audio ? "🔊" : "🔇";
                const audioLabel = videoInfo.has_audio
                    ? ` ${(videoInfo.audio_codec || "audio").toUpperCase()} ${videoInfo.audio_channels === 1 ? "mono" : "stereo"} ${(videoInfo.audio_sample_rate / 1000).toFixed(1)}kHz`
                    : " no audio";
                ctx.font = "10px 'Segoe UI', sans-serif";
                audioW = ctx.measureText(audioIcon + audioLabel).width;
            }

            const GAP    = 10;
            const SIDE   = 6;
            const MARGIN = 8;
            const sideW  = Math.max(coordW, metaW);
            const required = Math.ceil(audioW + 2 * (PAD + SIDE + GAP + sideW) + MARGIN);
            dynamicMinW = Math.max(MIN_W, required);
        }

        let lastNodeW = 0;
        let lastNodeH = 0;

        // ── Playback state ──────────────────────────────────────────────────
        let videoEl    = null;
        let isPlaying  = false;
        let rafId      = null;
        let progBarX   = 0;
        let progBarW   = 0;
        let progBarY   = 0;
        let modeToggleX      = 0;
        let modeToggleY      = 0;
        let modeToggleSegW   = 0;
        let modeToggleSegH   = 0;
        let modeToggleSegGap = 0;
        let trimPlaybackMode = false;
        let selectedAspect     = ASPECT_RATIOS[0];
        let aspectDropdownOpen = false;
        let cropBtnX = 0, cropBtnY = 0, cropBtnW = 0, cropBtnH = 0;
        let dropdownX = 0, dropdownY = 0, dropdownW = 0, dropdownH = 0;
        let selectedResizeMethod = RESIZE_METHODS[0];
        let resizeDropdownOpen   = false;
        let resizeBtnX = 0, resizeBtnY = 0, resizeBtnW = 0, resizeBtnH = 0;
        let resizeDropdownX = 0, resizeDropdownY = 0, resizeDropdownW = 0, resizeDropdownH = 0;
        let sliderBarX  = 0;
        let sliderBarW  = 0;
        let sliderBarY  = 0;
        let sliderBarH  = 0;
        let timelineDrag       = null;
        let timelineDragOffset = 0;
        let timelineDragWidth  = 0;
        let dScale  = 1;
        let dOffX   = 0;
        let dOffY   = 0;
        let dWidth  = 0;
        let dHeight = 0;
        let cropPreviewMode = false;
        let dragMode        = null;
        let dragAnchor = null;
        let dragCrop   = null;

        function modeBarLeftW(ctx) {
            ctx.font = "bold 11px 'Segoe UI', sans-serif";
            const modeLabelW = ctx.measureText("Trim Mode").width;
            return 8 + modeLabelW + 4 + (54 * 2 + 2);   // label + gap + two 54px segments
        }
        function modeBarResizeW(ctx) {
            ctx.font = "11px 'Segoe UI', sans-serif";
            return ctx.measureText(`Resize: ${selectedResizeMethod.name}  ▾`).width + 16;
        }
        function modeBarCropW(ctx) {
            ctx.font = "11px 'Segoe UI', sans-serif";
            return ctx.measureText(`⛶  Crop: ${selectedAspect.name}  ▾`).width + 16;
        }
        function getModeBarRows(nodeWidth) {
            const ctx           = _measureCtx;
            const rowAvailable  = nodeWidth - PAD * 2 - 16;
            const leftW         = modeBarLeftW(ctx);
            const rightW        = modeBarResizeW(ctx) + 8 + modeBarCropW(ctx);
            if (leftW + rightW <= rowAvailable) return 1;
            if (rightW <= rowAvailable) return 2;
            return 3;
        }
        function getModeBarH(nodeWidth) {
            return MODE_BAR_H * getModeBarRows(nodeWidth);
        }

        // ── Widget-finding helpers ──────────────────────────────────────────
        const gw = name => node.widgets?.find(w => w.name === name);

        {
            const sticky = loadStickySettings();
            for (const name of STICKY_WIDGETS) {
                const w = gw(name);
                if (!w) continue;
                if (name === "quality") {
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
                        this.value = value;
                    }
                    saveStickySetting(name, value);
                    return prevCallback?.call(this, value, ...rest);
                };
            }
            node.setDirtyCanvas(true, true);
        }

        const getActiveDuration = () => {
            if (videoEl && videoEl.duration > 0) return videoEl.duration;
            const durW = gw("video_duration");
            if (durW && durW.value > 0) return durW.value;
            const s = gw("trim_start")?.value ?? 0;
            const e = gw("trim_end")?.value   ?? 0;
            const maxVal = Math.max(s, e);
            return maxVal > 0 ? Math.max(maxVal, 1.0) : 1.0;
        };

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

        const getEffectiveRatio = () => {
            if (!selectedAspect || selectedAspect.val === 0) return 0;
            if (selectedAspect.val === -1) {
                return (videoInfo.width && videoInfo.height)
                    ? videoInfo.width / videoInfo.height : 0;
            }
            return selectedAspect.val;
        };

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
        const imgToNode = (ix, iy) => ({
            x: ix * dScale + dOffX,
            y: iy * dScale + dOffY,
        });
        const nodeToImg = (nx, ny) => ({
            x: (nx - dOffX) / dScale,
            y: (ny - dOffY) / dScale,
        });

        // ── Hit-test helper ─────────────────────────────────────────────────
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
            last_y:  0,

            computeLayoutSize() {
                return {
                    minHeight: getModeBarH(node.size[0]) + CANVAS_H + PLAYBACK_H + TRIM_BAR_H + INFO_H,
                    minWidth: 0,
                };
            },

            draw(ctx, node, nodeWidth, y /*, _h */) {
                this.last_y = y;
                const canvasH = getCanvasH(this, nodeWidth);

                const W  = nodeWidth - PAD * 2;
                const x0 = PAD;
                const y0 = y;

                // ── Background ─────────────────────────────────────────
                ctx.fillStyle   = C.bg;
                ctx.strokeStyle = C.bgBorder;
                ctx.lineWidth   = 1;
                ctx.fillRect(x0, y0, W, canvasH);
                ctx.strokeRect(x0, y0, W, canvasH);

                const imgSrc = (videoEl && videoEl.readyState >= 2) ? videoEl : previewImg;

                if (imgSrc) {
                    const naturalW = imgSrc instanceof HTMLVideoElement
                        ? imgSrc.videoWidth  : imgSrc.naturalWidth;
                    const naturalH = imgSrc instanceof HTMLVideoElement
                        ? imgSrc.videoHeight : imgSrc.naturalHeight;

                    const c = getCrop();

                    if (cropPreviewMode) {
                        const cropAspect   = c.w / c.h;
                        const canvasAspect = W   / canvasH;
                        let destW, destH, destX, destY;
                        if (cropAspect > canvasAspect) {
                            destW = W;
                            destH = W / cropAspect;
                            destX = x0;
                            destY = y0 + (canvasH - destH) / 2;
                        } else {
                            destH = canvasH;
                            destW = canvasH * cropAspect;
                            destX = x0 + (W - destW) / 2;
                            destY = y0;
                        }

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

                        // Dimension badge - top-left corner
                        const badge = `  ${c.w} × ${c.h} px  `;
                        ctx.font      = "bold 11px monospace";
                        const badgeW  = ctx.measureText(badge).width + 2;
                        const badgeH  = 18;
                        ctx.fillStyle = "rgba(0,0,0,0.55)";
                        ctx.fillRect(destX, destY, badgeW, badgeH);
                        ctx.fillStyle = C.infoText;
                        ctx.textAlign = "left";
                        ctx.fillText(badge, destX + 1, destY + badgeH - 4);

                        // "CROP OUTPUT" label - bottom centre
                        ctx.font      = "10px 'Segoe UI', sans-serif";
                        ctx.fillStyle = C.infoDim;
                        ctx.textAlign = "center";
                        ctx.fillText("CROP OUTPUT PREVIEW", x0 + W / 2, y0 + canvasH - 6);
                        ctx.textAlign = "left";

                        // "TRIMMED OUTPUT PREVIEW" secondary label when also in trim mode
                        if (trimPlaybackMode) {
                            ctx.font      = "10px 'Segoe UI', sans-serif";
                            ctx.fillStyle = "rgba(232,160,42,0.55)";
                            ctx.textAlign = "center";
                            ctx.fillText("✂  TRIMMED OUTPUT PREVIEW", x0 + W / 2, y0 + canvasH - 18);
                            ctx.textAlign = "left";
                        }

                        // Set display transform to safe no-op so mouse handler
                        dScale = 1; dOffX = x0; dOffY = y0; dWidth = W; dHeight = canvasH;

                    } else {
                        const innerW = W - CANVAS_PAD * 2;
                        const innerH = canvasH - CANVAS_PAD * 2;
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
                            ctx.fillText("✂  TRIMMED OUTPUT PREVIEW", x0 + W / 2, y0 + canvasH - 18);
                            ctx.textAlign = "left";
                        }
                    }

                } else {
                    dOffX = x0; dOffY = y0; dScale = 1;

                    const mainText = "Upload a video using the button below to get started.";
                    const subText  = "- or connect IMAGE/AUDIO to the  images  /  audio  inputs -";
                    const maxTextW = Math.max(80, W - CANVAS_PAD * 2);

                    ctx.font = "13px 'Segoe UI', sans-serif";
                    const mainLines = wrapTextLines(ctx, mainText, maxTextW);
                    ctx.font = "11px monospace";
                    const subLines  = wrapTextLines(ctx, subText, maxTextW);

                    ctx.textAlign = "center";
                    if (mainLines.length <= 1 && subLines.length <= 1) {
                        // Fits on one line each - keep the original, exact layout.
                        ctx.fillStyle = C.placeholder;
                        ctx.font      = "13px 'Segoe UI', sans-serif";
                        ctx.fillText(mainText, x0 + W / 2, y0 + canvasH / 2 - 10);
                        ctx.fillStyle = C.placeholderS;
                        ctx.font      = "11px monospace";
                        ctx.fillText(subText, x0 + W / 2, y0 + canvasH / 2 + 12);
                    } else {
                        const MAIN_LH = 16, SUB_LH = 14, BLOCK_GAP = 8;
                        const totalH = mainLines.length * MAIN_LH + BLOCK_GAP + subLines.length * SUB_LH;
                        let ly = y0 + canvasH / 2 - totalH / 2 + MAIN_LH * 0.8;

                        ctx.fillStyle = C.placeholder;
                        ctx.font      = "13px 'Segoe UI', sans-serif";
                        for (const line of mainLines) {
                            ctx.fillText(line, x0 + W / 2, ly);
                            ly += MAIN_LH;
                        }

                        ly += BLOCK_GAP - MAIN_LH + SUB_LH * 0.8;
                        ctx.fillStyle = C.placeholderS;
                        ctx.font      = "11px monospace";
                        for (const line of subLines) {
                            ctx.fillText(line, x0 + W / 2, ly);
                            ly += SUB_LH;
                        }
                    }
                    ctx.textAlign = "left";
                }

                // ── Playback bar ─────────────────────────────────────────
                const py = y0 + canvasH;
                ctx.fillStyle   = C.pbBar;
                ctx.strokeStyle = C.bgBorder;
                ctx.lineWidth   = 1;
                ctx.fillRect(x0, py, W, PLAYBACK_H);
                ctx.strokeRect(x0, py, W, PLAYBACK_H);

                const hasVideo = !!videoEl;
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
                    // No video - draw empty track + placeholder text
                    ctx.fillStyle = C.pbTrack;
                    ctx.beginPath();
                    ctx.roundRect(pbTrackX, pbTrackY, pbTrackW, pbTrackH, pbTrackH / 2);
                    ctx.fill();

                    ctx.fillStyle = C.infoDim;
                    ctx.fillText(hasVideo ? "loading…" : "0:00.00 / 0:00.00", timeX, timeY);
                }
                ctx.textAlign = "left";

                // ── Trim timeline ────────────────────────────────────────

                const ty = py + PLAYBACK_H;
                const RULER_H  = 22;
                const SBOX_H   = 24;
                const TL_PAD   = 8;
                const trimBg   = "#1a1a1a";
                const trimBord = "#2e2e2e";

                ctx.fillStyle   = trimBg;
                ctx.strokeStyle = trimBord;
                ctx.lineWidth   = 1;
                ctx.fillRect(x0, ty, W, TRIM_BAR_H);
                ctx.strokeRect(x0, ty, W, TRIM_BAR_H);

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
                const mbY         = ty + TRIM_BAR_H;
                const modeBarRows = getModeBarRows(nodeWidth);
                const modeBarH    = MODE_BAR_H * modeBarRows;

                ctx.fillStyle   = C.infoBar;
                ctx.strokeStyle = C.bgBorder;
                ctx.lineWidth   = 1;
                ctx.fillRect(x0, mbY, W, modeBarH);
                ctx.strokeRect(x0, mbY, W, modeBarH);
                if (modeBarRows >= 2) {
                    ctx.beginPath();
                    ctx.moveTo(x0, mbY + MODE_BAR_H);
                    ctx.lineTo(x0 + W, mbY + MODE_BAR_H);
                    if (modeBarRows === 3) {
                        ctx.moveTo(x0, mbY + MODE_BAR_H * 2);
                        ctx.lineTo(x0 + W, mbY + MODE_BAR_H * 2);
                    }
                    ctx.stroke();
                }

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
                const cropLabel   = `⛶  Crop: ${selectedAspect.name}  ▾`;
                const resizeLabel = `Resize: ${selectedResizeMethod.name}  ▾`;
                ctx.font = "11px 'Segoe UI', sans-serif";
                cropBtnW   = ctx.measureText(cropLabel).width + 16;
                resizeBtnW = ctx.measureText(resizeLabel).width + 16;
                cropBtnH   = segH;
                resizeBtnH = segH;

                let resizeRowY, cropRowY;
                if (modeBarRows === 3) {
                    resizeRowY = mbY + MODE_BAR_H;
                    cropRowY   = mbY + MODE_BAR_H * 2;
                    resizeBtnX = x0 + W - 8 - resizeBtnW;
                    cropBtnX   = x0 + W - 8 - cropBtnW;
                } else {
                    resizeRowY = cropRowY = modeBarRows === 2 ? mbY + MODE_BAR_H : mbY;
                    cropBtnX   = x0 + W - 8 - cropBtnW;
                    resizeBtnX = cropBtnX - 8 - resizeBtnW;
                }
                resizeBtnY = resizeRowY + 4;
                cropBtnY   = cropRowY + 4;

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

                // ── Info bar ────────────────────────────────────────────
                const iy = mbY + modeBarH;
                ctx.fillStyle   = C.infoBar;
                ctx.strokeStyle = C.bgBorder;
                ctx.lineWidth   = 1;
                ctx.fillRect(x0, iy, W, INFO_H);
                ctx.strokeRect(x0, iy, W, INFO_H);

                const c = getCrop();
                ctx.fillStyle = C.infoText;
                ctx.font      = "11px monospace";
                const coordText = `x:${c.x} y:${c.y} w:${c.w} h:${c.h}`;
                ctx.fillText(coordText, x0 + 6, iy + INFO_H / 2 + 4);
                const coordEndX = x0 + 6 + ctx.measureText(coordText).width;

                if (videoInfo.width > 0) {
                    // ── Right-aligned video metadata ────────────────────
                    ctx.font = "11px monospace";
                    const meta = `${videoInfo.width}×${videoInfo.height}  ${videoInfo.fps.toFixed(3)} fps  ${videoInfo.duration.toFixed(2)} s`;
                    ctx.fillStyle = C.infoDim;
                    const tw = ctx.measureText(meta).width;
                    const metaStartX = x0 + W - tw - 6;
                    ctx.fillText(meta, metaStartX, iy + INFO_H / 2 + 4);

                    // ── Centred audio badge ─────────────────────────────
                    const audioIcon  = videoInfo.has_audio ? "🔊" : "🔇";
                    const audioLabel = videoInfo.has_audio
                        ? ` ${(videoInfo.audio_codec || "audio").toUpperCase()} ${videoInfo.audio_channels === 1 ? "mono" : "stereo"} ${(videoInfo.audio_sample_rate / 1000).toFixed(1)}kHz`
                        : " no audio";
                    ctx.font = "10px 'Segoe UI', sans-serif";
                    const audioText = audioIcon + audioLabel;
                    const audioW    = ctx.measureText(audioText).width;
                    const audioCX   = x0 + W / 2;
                    const GAP       = 10;   // min breathing room on each side

                    const fits = audioCX - audioW / 2 > coordEndX + GAP &&
                                 audioCX + audioW / 2 < metaStartX - GAP;

                    if (fits) {
                        ctx.fillStyle = videoInfo.has_audio ? C.infoText : C.infoDim;
                        ctx.textAlign = "center";
                        ctx.fillText(audioText, audioCX, iy + INFO_H / 2 + 4);
                        ctx.textAlign = "left";
                    } else {
                        const coordW  = coordEndX - (x0 + 6);
                        const sideW   = Math.max(coordW, tw);
                        const needed  = Math.ceil(audioW + 2 * (PAD + 6 + GAP + sideW) + 8);
                        if (needed > nodeWidth && needed > dynamicMinW) {
                            dynamicMinW = needed;
                            if (node.size[0] < needed) {
                                node.setSize([needed, node.size[1]]);
                                node.onResize?.(node.size);
                            }
                        }
                    }
                }

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
                const canvasH = getCanvasH(this, node.size[0]);

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
                    return true;
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
                    return true;
                }

                // ── Playback bar hit region ────────────────────────────
                const pbY0 = this.last_y + canvasH;
                const pbY1 = pbY0 + PLAYBACK_H;

                if (ny >= pbY0 && ny <= pbY1) {
                    if (type === "pointerdown" || type === "mousedown") {
                        const _topRowH = PLAYBACK_H - 4 - 1;
                        const btnSize  = _topRowH - 10;
                        const btnX     = PAD + 6;
                        if (nx >= btnX && nx <= btnX + btnSize) {
                            togglePlayback();
                            return true;
                        }

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
                const tlY0 = this.last_y + canvasH + PLAYBACK_H;
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
                            timelineDrag = "center";
                            const clickVal = ((nx - sliderBarX) / sliderBarW) * activeDur;
                            timelineDragOffset = clickVal - trimStartS;
                            timelineDragWidth  = effectiveEnd - trimStartS;
                        } else {
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
                const modeBarY1 = modeBarY0 + getModeBarH(node.size[0]);

                if (ny >= modeBarY0 && ny <= modeBarY1) {
                    if (type === "pointerdown" || type === "mousedown") {
                        // "Resize" button - opens the resize-method dropdown
                        if (nx >= resizeBtnX && nx <= resizeBtnX + resizeBtnW &&
                            ny >= resizeBtnY && ny <= resizeBtnY + resizeBtnH) {
                            resizeDropdownOpen = true;
                            aspectDropdownOpen = false;
                            node.setDirtyCanvas(true, false);
                            return true;
                        }
                        // "Crop" button - opens the aspect-ratio dropdown
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
                if (cropPreviewMode) return false;

                // Reject if outside the canvas strip
                if (ny < this.last_y || ny > this.last_y + canvasH) return false;
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
        node.widgets.unshift(cropWidget);

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

        // ── Compact icon-button toolbar (replaces 4 stacked text buttons) ──
        function getActionButtons() {
            return [
                {
                    icon:  cropPreviewMode ? "⤢" : "🔍",
                    label: cropPreviewMode ? "Full Frame" : "Crop",
                    active: cropPreviewMode,
                    onClick() {
                        if (!previewImg) {
                            showStatus("⚠  Upload or auto-load a video first.");
                            return;
                        }
                        cropPreviewMode = !cropPreviewMode;
                        node.setDirtyCanvas(true, false);
                    },
                },
                {
                    icon:  (isPlaying && trimPlaybackMode) ? "⏸" : "✂",
                    label: (isPlaying && trimPlaybackMode) ? "Stop" : "Trim",
                    active: isPlaying && trimPlaybackMode,
                    onClick() {
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
                    },
                },
                {
                    icon:  "↺",
                    label: "Reset Crop",
                    active: false,
                    onClick() {
                        if (videoInfo.width > 0) {
                            setCrop(0, 0, videoInfo.width, videoInfo.height);
                        } else {
                            showStatus("⚠  Load a preview first so the frame size is known.");
                        }
                    },
                },
                {
                    icon:  "↺",
                    label: "Reset Trim",
                    active: false,
                    onClick() {
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
                    },
                },
            ];
        }

        const actionIconsWidget = {
            type:    "icon_toolbar",
            name:    "action_icons",
            value:   null,
            options: { serialize: false },
            last_y:  0,
            _rects:  [],
            _hoverIdx: -1,

            computeSize(nodeWidth) {
                return [nodeWidth, ICONBAR_H];
            },

            draw(ctx, node, nodeWidth, y) {
                this.last_y = y;
                const buttons = getActionButtons();
                const n       = buttons.length;
                const totalW  = nodeWidth - PAD * 2;
                const btnW    = (totalW - ICONBAR_GAP * (n - 1)) / n;
                const btnH    = ICONBAR_H - 10;
                const btnY    = y + 5;
                const radius  = 7;

                this._rects = [];

                ctx.save();
                ctx.textBaseline = "middle";
                ctx.textAlign    = "center";

                buttons.forEach((b, i) => {
                    const bx = PAD + i * (btnW + ICONBAR_GAP);
                    this._rects.push({ x: bx, y: btnY, w: btnW, h: btnH });

                    const hovered = this._hoverIdx === i && !b.active;

                    ctx.beginPath();
                    if (ctx.roundRect) ctx.roundRect(bx, btnY, btnW, btnH, radius);
                    else ctx.rect(bx, btnY, btnW, btnH);
                    ctx.fillStyle = b.active ? C.iconActiveBg : (hovered ? C.btnHover : C.btnBg);
                    ctx.fill();
                    ctx.lineWidth   = 1;
                    ctx.strokeStyle = b.active ? C.iconActiveBord : C.bgBorder;
                    ctx.stroke();

                    const iconColor  = b.active ? C.iconActiveText : (hovered ? C.iconHoverText : C.btnText);
                    const labelColor = b.active ? C.iconActiveText : (hovered ? C.iconHoverText : C.pbText);
                    const midX = bx + btnW / 2;

                    ctx.fillStyle = iconColor;
                    ctx.font      = "13px 'Segoe UI', sans-serif";
                    ctx.fillText(b.icon, midX, btnY + btnH / 2 - 6);

                    ctx.fillStyle = labelColor;
                    ctx.font      = "9px 'Segoe UI', sans-serif";
                    ctx.fillText(b.label, midX, btnY + btnH / 2 + 8);
                });

                ctx.textAlign = "left";
                ctx.restore();
            },

            mouse(event, pos, node) {
                const nx = pos[0];
                const ny = pos[1];
                const type = event.type;

                if (ny < this.last_y || ny > this.last_y + ICONBAR_H) {
                    if (this._hoverIdx !== -1) {
                        this._hoverIdx = -1;
                        node.setDirtyCanvas(true, false);
                    }
                    return false;
                }

                let idx = -1;
                for (let i = 0; i < this._rects.length; i++) {
                    const r = this._rects[i];
                    if (nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h) { idx = i; break; }
                }

                if (type === "pointermove" || type === "mousemove") {
                    if (this._hoverIdx !== idx) {
                        this._hoverIdx = idx;
                        node.setDirtyCanvas(true, false);
                    }
                    return idx !== -1;
                }

                if (type === "pointerdown" || type === "mousedown") {
                    if (idx !== -1) {
                        getActionButtons()[idx].onClick();
                        node.setDirtyCanvas(true, false);
                        return true;
                    }
                    return false;
                }

                if (type === "pointerup" || type === "mouseup") {
                    return idx !== -1;
                }

                return false;
            },
        };

        // ── Reorder: keep these action widgets above the ffmpeg-flags text ──
        {
            const actionWidgets = [uploadVideoBtn, actionIconsWidget];
            for (const b of actionWidgets) {
                const i = node.widgets.indexOf(b);
                if (i !== -1) node.widgets.splice(i, 1);
            }
            const fpsIdx = node.widgets.findIndex(w => w.name === "fps");
            const insertAt = fpsIdx !== -1 ? fpsIdx + 1 : node.widgets.length;
            node.widgets.splice(insertAt, 0, ...actionWidgets);
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
                ctx.fillText(_statusMsg, x0 + W / 2, y + getCanvasH(cropWidget, nodeWidth) / 2 + 36);
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

                    setCrop(0, 0, videoInfo.width, videoInfo.height);
                    recalcInfoBarMinW();
                    if (node.size[0] < dynamicMinW) {
                        node.setSize([dynamicMinW, node.size[1]]);
                        node.onResize?.(node.size);
                    }

                    selectedAspect = closestAspectRatio(videoInfo.width, videoInfo.height);
                    applyAspectRatio(selectedAspect);
                    aspectDropdownOpen = false;

                    const fpsW = gw("fps");
                    if (fpsW && videoInfo.fps > 0) {
                        fpsW.value = Math.round(videoInfo.fps * 1000) / 1000;
                    }

                    const durW = gw("video_duration");
                    if (durW && videoInfo.duration > 0) {
                        durW.value = Math.round(videoInfo.duration * 1000) / 1000;
                    }

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
        node.resizable = true;
        const [curW, curH] = node.size;
        node.setSize([Math.max(curW, dynamicMinW), curH]);

        // ── Hide backend-only widgets ──────────────────────────────────────
        queueMicrotask(() => {
            const rmW = gw("resize_method");
            if (rmW) {
                const match = RESIZE_METHODS.find(m => m.val === rmW.value);
                if (match) selectedResizeMethod = match;
                else rmW.value = selectedResizeMethod.val;   // self-heal invalid value
            }

            for (const name of ["video_path", "video_duration", "trim_mode", "resize_method"]) {
                const w = gw(name);
                if (w) {
                    w.hidden = true;
                    w.type   = "hidden";
                    w.computeSize = () => [0, -4];
                }
            }

            node.setDirtyCanvas(true, true);
        });

        queueMicrotask(async () => {
            const pathW = gw("video_path");
            if (pathW?.value?.trim()) {
                await loadPreview(pathW.value.trim());
            }
        });
    },
});
