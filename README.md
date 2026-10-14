# alebridi.it

Personal website, served by GitHub Pages at [alebridi.it](https://alebridi.it).

Plain HTML, CSS and an ES module: no framework, no build step for the page itself.
Everything drawn pixel by pixel on the page (the name in the hero, the glyphr playground,
the pipeline figures) is rendered by [glyphr](https://github.com/Bridiro/glyphr) compiled
to WebAssembly.

## Layout

```
index.html              the page
assets/site.css         styles (tokens at the top, light and dark)
assets/site.js          glyphr loader, hero, playground, figures
assets/glyphr.wasm      built from glyphr-web/
assets/fonts/           Hanken Grotesk, Commit Mono (both OFL)
assets/work/            project figures
glyphr-web/             tiny no_std crate exposing glyphr to the page
```

## Run locally

```sh
python3 -m http.server 8417
```

Then open http://localhost:8417. The page has to be served over HTTP, since browsers
won't load the wasm module from `file://`.

## Rebuild the wasm module

Only needed after changing `glyphr-web/` or bumping glyphr:

```sh
cd glyphr-web
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/glyphr_web.wasm ../assets/glyphr.wasm
```

The module has no wasm-bindgen glue: the page writes UTF-8 into an input buffer,
calls `render`, and reads 8-bit coverage back from linear memory.
