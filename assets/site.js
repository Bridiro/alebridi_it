// alebridi.it
// Everything drawn pixel by pixel on this page goes through glyphr, compiled to
// wasm32 from glyphr-web/ in this repository. No framework, no build step.

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
const DPR_CAP = 2;

/* glyphr ------------------------------------------------------------------- */

async function loadGlyphr(url) {
    let instance;
    try {
        ({ instance } = await WebAssembly.instantiateStreaming(fetch(url)));
    } catch {
        // Servers that don't send application/wasm.
        const bytes = await (await fetch(url)).arrayBuffer();
        ({ instance } = await WebAssembly.instantiate(bytes));
    }
    const e = instance.exports;
    const encoder = new TextEncoder();

    const setInput = (text) => {
        const bytes = encoder.encode(text).slice(0, 256);
        new Uint8Array(e.memory.buffer, e.input_ptr(), bytes.length).set(bytes);
        return bytes.length;
    };

    return {
        clear: (w, h) => e.clear(w, h),

        // Draws `text` on top of the current coverage buffer; returns pixels written and time.
        draw(text, { w, h, size, x, y, align = 0, smoothing = 0.5 }) {
            const len = setInput(text);
            const t0 = performance.now();
            const n = e.render(len, w, h, Math.round(size), Math.round(smoothing * 1000), Math.round(x), Math.round(y), align);
            return { n, ms: performance.now() - t0 };
        },

        // Copy, so later renders don't change what the caller holds.
        coverage: (w, h) => new Uint8Array(e.memory.buffer, e.coverage_ptr(), w * h).slice(),

        measure: (text, size) => e.measure(setInput(text), Math.round(size)),

        field(ch) {
            const wh = e.glyph_field(ch.codePointAt(0));
            if (!wh) return null;
            const w = wh & 0xffff;
            const h = wh >>> 16;
            const data = new Uint8Array(e.memory.buffer, e.coverage_ptr(), w * h).slice();
            return { w, h, data, bytes: e.glyph_bytes(ch.codePointAt(0)) };
        },

        fontBytes: e.font_bytes(),
        glyphCount: e.glyph_count(),
    };
}

/* Colors come from the stylesheet so both themes stay in one place. */

let palette;

function readPalette() {
    const css = getComputedStyle(document.documentElement);
    const rgb = (name) => {
        const hex = css.getPropertyValue(name).trim().replace("#", "");
        return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    };
    palette = {
        plate: rgb("--plate"),
        off: rgb("--cell-off"),
        ink: rgb("--plate-ink"),
        dim: rgb("--plate-dim"),
        lit: rgb("--lit"),
    };
}

const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
const pack = ([r, g, b]) => (255 << 24) | (b << 16) | (g << 8) | r; // little-endian RGBA
const css = ([r, g, b]) => `rgb(${r} ${g} ${b})`;
// Browsers coarsen performance.now(), so tiny renders can read as zero.
const fmtMs = (ms) => (ms < 0.1 ? "<0.1 ms" : `${ms.toFixed(2)} ms`);

// 256-entry lookup from coverage to packed color.
function ramp(from, to) {
    const out = new Uint32Array(256);
    for (let i = 0; i < 256; i++) out[i] = pack(mix(from, to, i / 255));
    return out;
}

/* Canvas helpers ---------------------------------------------------------- */

function sizeCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    return { cssW: rect.width, cssH: rect.height, w, h, dpr };
}

// Paints an fw×fh value buffer as square cells filling the canvas.
// `colors` maps a value (0–255) to a packed color. Cells get a gap once they are big enough to show one.
function paintCells(canvas, values, fw, fh, colors, background) {
    const ctx = canvas.getContext("2d");
    const { width: W, height: H } = canvas;
    const img = ctx.createImageData(W, H);
    const px = new Uint32Array(img.data.buffer);
    px.fill(pack(background));

    const cell = Math.min(W / fw, H / fh);
    const gap = cell >= 4 ? Math.max(1, Math.round(cell * 0.14)) : 0;
    const ox = Math.floor((W - cell * fw) / 2);
    const oy = Math.floor((H - cell * fh) / 2);

    for (let cy = 0; cy < fh; cy++) {
        const y0 = oy + Math.round(cy * cell);
        const y1 = Math.min(H, oy + Math.round((cy + 1) * cell) - gap);
        for (let cx = 0; cx < fw; cx++) {
            const color = colors[values[cy * fw + cx]];
            const x0 = ox + Math.round(cx * cell);
            const x1 = Math.min(W, ox + Math.round((cx + 1) * cell) - gap);
            for (let y = y0; y < y1; y++) {
                px.fill(color, y * W + x0, y * W + x1);
            }
        }
    }
    ctx.putImageData(img, 0, 0);
    return { img, cell, gap, ox, oy };
}

function onVisible(el, cb) {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => cb(e.isIntersecting)));
    io.observe(el);
}

/* Hero: the name, resolving from a coarse grid to the final framebuffer ----- */

function hero(glyphr) {
    const canvas = document.getElementById("hero-canvas");
    const plate = canvas.closest(".plate");
    const stats = document.getElementById("hero-stats");
    const probe = document.getElementById("hero-probe");

    let frame = null; // the last painted frame, for the probe
    let timer = 0;

    function layout(cellCss, size) {
        const fw = Math.max(8, Math.floor(size.cssW / cellCss));
        const fh = Math.max(4, Math.floor(size.cssH / cellCss));
        const lines = size.cssW < 640 ? ["Alessandro", "Bridi"] : ["Alessandro Bridi"];
        const widest = Math.max(...lines.map((l) => glyphr.measure(l, 200) / 200));
        const lineH = 1.02;
        // Fit width with a margin, and height with room above and below.
        const s = Math.min((fw * 0.88) / widest, (fh * 0.64) / (0.72 + lineH * (lines.length - 1)));
        const cap = 0.7 * s;
        const first = fh / 2 + cap / 2 - (lineH * s * (lines.length - 1)) / 2;
        const x = Math.round((fw - widest * s) / 2);
        return { fw, fh, s, lines, x, first, lineH };
    }

    function draw(cellCss) {
        const size = sizeCanvas(canvas);
        const L = layout(cellCss, size);
        glyphr.clear(L.fw, L.fh);
        let n = 0;
        let ms = 0;
        L.lines.forEach((line, i) => {
            const r = glyphr.draw(line, { w: L.fw, h: L.fh, size: L.s, x: L.x, y: L.first + i * L.lineH * L.s });
            n += Math.max(0, r.n);
            ms += r.ms;
        });
        const values = glyphr.coverage(L.fw, L.fh);
        const painted = paintCells(canvas, values, L.fw, L.fh, ramp(palette.off, palette.lit), palette.plate);
        frame = { ...L, ...painted, values };
        return { n, ms, fw: L.fw, fh: L.fh };
    }

    const finalCell = () => (canvas.getBoundingClientRect().width < 640 ? 4 : 5);

    function settle() {
        const r = draw(finalCell());
        stats.textContent = `${r.fw}×${r.fh} framebuffer · ${r.n.toLocaleString("en")} px in ${fmtMs(r.ms)}`;
    }

    function resolve() {
        clearTimeout(timer);
        const h = canvas.getBoundingClientRect().height;
        const steps = [12, 18, 28, 40].map((rows) => h / rows).filter((c) => c > finalCell() * 1.3);
        if (reduceMotion.matches || !steps.length) return settle();
        let i = 0;
        const next = () => {
            if (i < steps.length) {
                draw(steps[i++]);
                timer = setTimeout(next, 110);
            } else {
                settle();
            }
        };
        next();
    }

    // Probe: read back the coverage of the pixel under the pointer.
    let pending = false;
    canvas.addEventListener("pointermove", (ev) => {
        if (!frame || pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            const rect = canvas.getBoundingClientRect();
            const dx = ((ev.clientX - rect.left) / rect.width) * canvas.width;
            const dy = ((ev.clientY - rect.top) / rect.height) * canvas.height;
            const fx = Math.floor((dx - frame.ox) / frame.cell);
            const fy = Math.floor((dy - frame.oy) / frame.cell);
            if (fx < 0 || fy < 0 || fx >= frame.fw || fy >= frame.fh) return;
            const a = frame.values[fy * frame.fw + fx];
            probe.textContent = `x ${String(fx).padStart(3, " ")}  y ${String(fy).padStart(2, " ")}  α 0x${a.toString(16).padStart(2, "0").toUpperCase()}`;
            const ctx = canvas.getContext("2d");
            ctx.putImageData(frame.img, 0, 0);
            ctx.strokeStyle = css(palette.ink);
            ctx.lineWidth = Math.max(1, Math.round(frame.cell * 0.12));
            const s = frame.cell;
            ctx.strokeRect(frame.ox + fx * s - s * 0.5, frame.oy + fy * s - s * 0.5, s * 2 - frame.gap, s * 2 - frame.gap);
        });
    });
    canvas.addEventListener("pointerleave", () => {
        if (frame) canvas.getContext("2d").putImageData(frame.img, 0, 0);
        probe.textContent = "Point at a pixel";
    });

    let lastW = 0;
    new ResizeObserver(() => {
        const w = Math.round(canvas.getBoundingClientRect().width);
        if (w === lastW) return;
        const first = lastW === 0;
        lastW = w;
        first ? resolve() : settle();
    }).observe(canvas);

    plate.classList.add("is-ready");
    return settle;
}

/* Playground ---------------------------------------------------------------- */

function playground(glyphr) {
    const canvas = document.getElementById("pg-canvas");
    const fieldCanvas = document.getElementById("pg-field");
    const fieldLabel = document.getElementById("pg-field-label");
    const input = document.getElementById("pg-input");
    const sizeIn = document.getElementById("pg-size");
    const smoothIn = document.getElementById("pg-smooth");
    const sizeOut = document.getElementById("pg-size-out");
    const smoothOut = document.getElementById("pg-smooth-out");
    const statsOut = document.getElementById("pg-stats");
    const zoomButtons = [...document.querySelectorAll("[data-zoom]")];
    let zoom = 4;

    function render() {
        const size = +sizeIn.value;
        const smoothing = +smoothIn.value / 100;
        sizeOut.textContent = size;
        smoothOut.textContent = smoothing.toFixed(2);

        const c = sizeCanvas(canvas);
        const fw = Math.max(1, Math.floor(c.w / zoom));
        const fh = Math.max(1, Math.floor(c.h / zoom));
        const text = input.value || " ";
        glyphr.clear(fw, fh);
        const r = glyphr.draw(text, { w: fw, h: fh, size, x: fw / 2, y: fh / 2 + size * 0.35, align: 1, smoothing });
        paintCells(canvas, glyphr.coverage(fw, fh), fw, fh, ramp(palette.off, palette.lit), palette.plate);
        statsOut.textContent = `${fw}×${fh} at ${zoom}× · ${Math.max(0, r.n).toLocaleString("en")} px in ${fmtMs(r.ms)}`;

        const last = [...text].reverse().find((ch) => ch.trim() && glyphr.field(ch)) || "a";
        drawField(fieldCanvas, glyphr.field(last));
        const f = glyphr.field(last);
        fieldLabel.textContent = `Stored field for “${last}”: ${f.w}×${f.h}, ${f.bytes.toLocaleString("en")} bytes`;
    }

    let queued = false;
    const schedule = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            render();
        });
    };

    [input, sizeIn, smoothIn].forEach((el) => el.addEventListener("input", schedule));
    zoomButtons.forEach((b) =>
        b.addEventListener("click", () => {
            zoom = +b.dataset.zoom;
            zoomButtons.forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
            schedule();
        }),
    );
    new ResizeObserver(schedule).observe(canvas);
    return schedule;
}

// A distance field: brightness is distance inside the edge, the edge itself is lit.
function drawField(canvas, f) {
    if (!f) return;
    sizeCanvas(canvas);
    const EDGE = 255;
    const colors = new Uint32Array(256);
    for (let v = 0; v < EDGE; v++) colors[v] = pack(mix(palette.off, palette.dim, Math.pow(v / 254, 1.6)));
    colors[EDGE] = pack(palette.lit);

    // Texels inside the glyph with a neighbour outside it: the edge glyphr reconstructs.
    const { w, h, data } = f;
    const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] >= 128;
    const values = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const edge = inside(x, y) && !(inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1));
            values[y * w + x] = edge ? EDGE : Math.min(254, data[y * w + x]);
        }
    }
    paintCells(canvas, values, w, h, colors, palette.plate);
}

/* Pipeline figures ---------------------------------------------------------- */

const OUTLINE_ON = "390,0 382,-91 382,-310 265,-418 119,-350 58,-413 272,-502 480,-310 480,0 231,9 46,-149 107,-265 234,-294 391,-294 391,-220 248,-220 170,-202 144,-148 243,-71 382,-206 417,-160";
const OUTLINE_OFF = "382,-362 322,-418 225,-418 152,-386 102,-459 209,-502 371,-502 480,-401 176,9 92,-31 46,-102 46,-190 80,-249 132,-281 197,-294 228,-220 185,-213 158,-193 144,-166 144,-113 198,-71 281,-71 344,-106 382,-167 408,-108 356,-31 279,9";

function outlinePoints() {
    const g = document.getElementById("outline-points");
    const ns = "http://www.w3.org/2000/svg";
    const pts = (s) => s.split(" ").map((p) => p.split(",").map(Number));
    for (const [x, y] of pts(OUTLINE_OFF)) {
        const c = document.createElementNS(ns, "circle");
        c.setAttribute("cx", x);
        c.setAttribute("cy", y);
        c.setAttribute("r", 9);
        c.setAttribute("class", "off");
        g.append(c);
    }
    for (const [x, y] of pts(OUTLINE_ON)) {
        const r = document.createElementNS(ns, "rect");
        r.setAttribute("x", x - 9);
        r.setAttribute("y", y - 9);
        r.setAttribute("width", 18);
        r.setAttribute("height", 18);
        r.setAttribute("class", "on");
        g.append(r);
    }
}

function pipeline(glyphr) {
    const field = document.getElementById("fig-field");
    const coverage = document.getElementById("fig-coverage");
    const draw = () => {
        drawField(field, glyphr.field("a"));
        const n = 16;
        sizeCanvas(coverage);
        glyphr.clear(n, n);
        glyphr.draw("a", { w: n, h: n, size: 24, x: n / 2, y: 14, align: 1 });
        paintCells(coverage, glyphr.coverage(n, n), n, n, ramp(palette.off, palette.lit), palette.plate);
    };
    new ResizeObserver(draw).observe(coverage);
    return draw;
}

/* libraster: partial vs full redraw ---------------------------------------- */

function dashboard() {
    const root = document.getElementById("dash");
    const out = document.getElementById("dash-stats");
    const buttons = [...document.querySelectorAll("[data-mode]")];
    const boxes = new Map([...root.querySelectorAll(".dash-box")].map((el) => [el.dataset.key, el]));
    const totalArea = [...boxes.values()].reduce((a, el) => a + +el.dataset.area, 0);

    const state = { mot: 23, lv: 82, inv: 26, hv: 80, hvt: 40, lap: 0 };
    const sensors = ["mot", "inv", "hvt", "lv", "hv"];
    let mode = "partial";
    let frameNo = 0;
    let running = false;
    let timer = 0;
    const TICK = 700;

    function step() {
        frameNo++;
        state.lap = +(state.lap + TICK / 1000).toFixed(1);
        const changed = new Set(["lap"]);
        const k = Math.floor(Math.random() * 3); // 0–2 sensor updates this frame
        for (let i = 0; i < k; i++) {
            const key = sensors[Math.floor(Math.random() * sensors.length)];
            const drift = key === "lv" || key === "hv" ? -1 : Math.random() < 0.6 ? 1 : -1;
            state[key] = Math.max(0, state[key] + drift);
            changed.add(key);
        }

        const redrawn = mode === "full" ? [...boxes.keys()] : [...changed];
        let area = 0;
        for (const key of redrawn) {
            const el = boxes.get(key);
            if (key in state) el.querySelector("b").textContent = key === "lap" ? state.lap.toFixed(1) : state[key];
            area += +el.dataset.area;
            el.classList.add("is-drawn");
        }
        // Drop the highlight on the next tick of the event loop so it fades out.
        setTimeout(() => redrawn.forEach((key) => boxes.get(key).classList.remove("is-drawn")), 140);

        out.textContent = `frame ${String(frameNo).padStart(4, "0")} · ${redrawn.length} of ${boxes.size} boxes · ${Math.round((area / totalArea) * 100)}% of screen`;
    }

    function loop() {
        step();
        timer = setTimeout(loop, TICK);
    }

    function setRunning(on) {
        if (on === running) return;
        running = on;
        clearTimeout(timer);
        if (on) loop();
    }

    buttons.forEach((b) =>
        b.addEventListener("click", () => {
            mode = b.dataset.mode;
            buttons.forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
            if (reduceMotion.matches) step();
        }),
    );

    step();
    if (!reduceMotion.matches) onVisible(root, setRunning);
}

/* Boot ----------------------------------------------------------------------- */

readPalette();
outlinePoints();
dashboard();

loadGlyphr(new URL("glyphr.wasm", import.meta.url))
    .then((glyphr) => {
        const kb = (glyphr.fontBytes / 1024).toFixed(0);
        document.getElementById("glyphr-size").textContent =
            `The module carries ${glyphr.glyphCount} glyphs as ${kb} KB of distance fields.`;

        const redraws = [hero(glyphr), playground(glyphr), pipeline(glyphr)];
        darkScheme.addEventListener("change", () => {
            readPalette();
            redraws.forEach((r) => r());
        });
    })
    .catch((err) => {
        console.error("glyphr failed to load", err);
        document.getElementById("pg-stats").textContent = "glyphr couldn't load in this browser.";
    });
