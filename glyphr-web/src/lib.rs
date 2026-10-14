//! glyphr compiled to `wasm32-unknown-unknown` for the website.
//!
//! No wasm-bindgen, no allocator: the host writes UTF-8 into `INPUT`,
//! calls `render`, and reads 8-bit coverage back out of `COVERAGE`.
//! The same library and the same SDF data that would run on a microcontroller.

#![no_std]

use glyphr::{AlignH, AlignV, Callbacks, Font, Glyphr, RenderConfig, SdfConfig, TextAlign};

glyphr::generate_font! {
    name: HANKEN,
    path: "fonts/HankenGrotesk-Medium.ttf",
    size: 64,
    characters: " -~",
    format: SDF {
        spread: 12.0,
        padding: 0,
    },
}

const MAX_W: usize = 2048;
const MAX_H: usize = 1024;
const MAX_INPUT: usize = 256;

static mut COVERAGE: [u8; MAX_W * MAX_H] = [0; MAX_W * MAX_H];
static mut INPUT: [u8; MAX_INPUT] = [0; MAX_INPUT];

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

fn input(len: u32) -> &'static str {
    let len = (len as usize).min(MAX_INPUT);
    // SAFETY: single-threaded wasm; the host only touches INPUT between calls.
    let all: &[u8; MAX_INPUT] = unsafe { &*(&raw const INPUT) };
    let bytes = &all[..len];
    core::str::from_utf8(bytes).unwrap_or("")
}

fn renderer(size: u32, smoothing_milli: u32) -> Glyphr {
    let sdf = SdfConfig::default()
        .with_size(size.clamp(4, 1024) as u16)
        .with_smoothing(smoothing_milli as f32 / 1000.0);
    Glyphr::with_config(RenderConfig::default().with_color(0x00ff_ffff).with_sdf(sdf))
}

#[unsafe(no_mangle)]
pub extern "C" fn input_ptr() -> *mut u8 {
    (&raw mut INPUT).cast()
}

#[unsafe(no_mangle)]
pub extern "C" fn coverage_ptr() -> *const u8 {
    (&raw const COVERAGE).cast()
}

/// Zeroes the first `w`×`h` bytes of `COVERAGE`.
#[unsafe(no_mangle)]
pub extern "C" fn clear(w: u32, h: u32) {
    let len = ((w as usize).min(MAX_W)) * ((h as usize).min(MAX_H));
    // SAFETY: see `input`.
    let all: &mut [u8; MAX_W * MAX_H] = unsafe { &mut *(&raw mut COVERAGE) };
    all[..len].fill(0);
}

/// Rasterizes `len` bytes of `INPUT` into a `w`×`h` coverage buffer, on top of
/// what is already there (call `clear` first for a fresh frame).
/// `x`/`y` is the pen position; `align` is 0 left, 1 center, 2 right (baseline aligned).
/// Returns the number of pixels written, or -1 on error.
#[unsafe(no_mangle)]
pub extern "C" fn render(
    len: u32,
    w: u32,
    h: u32,
    size: u32,
    smoothing_milli: u32,
    x: i32,
    y: i32,
    align: u32,
) -> i32 {
    let (w, h) = ((w as usize).min(MAX_W), (h as usize).min(MAX_H));
    // SAFETY: see `input`.
    let all: &mut [u8; MAX_W * MAX_H] = unsafe { &mut *(&raw mut COVERAGE) };
    let buf = &mut all[..w * h];

    let mut written = 0i32;
    let mut target = Callbacks::new(w as u16, h as u16, |px, py, argb| {
        let idx = py as usize * w + px as usize;
        if idx >= buf.len() {
            return false;
        }
        let a = (argb >> 24) as u8;
        if a > buf[idx] {
            buf[idx] = a;
            written += 1;
        }
        true
    });

    let halign = match align {
        1 => AlignH::Center,
        2 => AlignH::Right,
        _ => AlignH::Left,
    };
    let res = renderer(size, smoothing_milli).draw_text(
        &mut target,
        input(len),
        HANKEN,
        x,
        y,
        TextAlign::new(halign, AlignV::Baseline),
    );
    match res {
        Ok(()) => written,
        Err(_) => -1,
    }
}

/// Width in pixels of `len` bytes of `INPUT` at `size`.
#[unsafe(no_mangle)]
pub extern "C" fn measure(len: u32, size: u32) -> i32 {
    renderer(size, 500).measure_text(input(len), HANKEN)
}

/// Ascent of the font scaled to `size`, in pixels.
#[unsafe(no_mangle)]
pub extern "C" fn ascent(size: u32) -> i32 {
    HANKEN.ascent as i32 * size as i32 / HANKEN.size as i32
}

/// Decodes the stored signed-distance field of `ch` into `COVERAGE`.
/// Returns `width | height << 16`, or 0 if the glyph is missing.
#[unsafe(no_mangle)]
pub extern "C" fn glyph_field(ch: u32) -> u32 {
    let Some(glyph) = char::from_u32(ch).and_then(|c| HANKEN.find_glyph(c)) else {
        return 0;
    };
    // SAFETY: see `input`.
    let buf = unsafe { &mut *(&raw mut COVERAGE) };
    let mut i = 0;
    for run in glyph.bitmap.chunks_exact(2) {
        let (count, value) = (run[0] as usize, run[1]);
        let end = (i + count).min(buf.len());
        buf[i..end].fill(value);
        i = end;
    }
    glyph.width as u32 | (glyph.height as u32) << 16
}

/// Bytes of RLE-encoded field stored for `ch`.
#[unsafe(no_mangle)]
pub extern "C" fn glyph_bytes(ch: u32) -> u32 {
    char::from_u32(ch)
        .and_then(|c| HANKEN.find_glyph(c))
        .map_or(0, |g| g.bitmap.len() as u32)
}

/// Bytes of glyph data compiled into this module.
#[unsafe(no_mangle)]
pub extern "C" fn font_bytes() -> u32 {
    font_data(HANKEN)
}

fn font_data(font: Font) -> u32 {
    font.glyphs.iter().map(|g| g.bitmap.len() as u32).sum()
}

#[unsafe(no_mangle)]
pub extern "C" fn glyph_count() -> u32 {
    HANKEN.glyphs.len() as u32
}
