# Codex glass material

The Codex preset keeps the existing React, Radix and TanStack UI/data stack. Its
glass material samples live browser pixels, with no DOM snapshots, duplicate
messages, per-frame JavaScript loop or new storage.

On Blink, each visible control has a local SVG backdrop filter. Source blur and
saturation precede rounded-rim refraction; foreground text is never filtered.
Other engines use one bounded SourceGraphic filter on the visible chat area.
That path still needs engine-specific pixel and performance acceptance. Native
blur remains available if workers cannot produce a map. Reduced transparency
and increased contrast use solid surfaces.

`GlassScene` measures header/composer insets before painting, observes controls
and portaled surfaces, and keeps a geometry cache/worker for the mounted scene.
The worker receives only width, height and radius. Texture resolution is capped
independently of DPR and history length; shape changes rebuild maps, while
scrolling and streaming reuse them. Filters and observers are removed with the
scene. `GlassSource` preserves the original scroll owner and virtual message DOM.

The independently written optical math uses a rounded rectangle SDF and Snell
refraction, with a flat center. Its design was informed by Telegram Android's
[glass shader](https://github.com/DrKLO/Telegram/blob/master/TMessagesProj/src/main/res/raw/liquid_glass_shader.agsl)
and [shared glass renderer](https://github.com/DrKLO/Telegram/blob/master/TMessagesProj/src/main/java/org/telegram/utils/glass/GlassEngine.java).
The implementation is not a copied native shader or a vendored MIT library.
Chrome's neutral-map border and local-coordinate approach also draws on the
public implementation in [samasante/liquid-glass](https://github.com/samasante/liquid-glass).

Source review considered liquid-glass-react, samasante/liquid-glass,
simple-liquid-glass, ybouane/liquidglass and liquidGL. None established a mature,
low-cost, live DOM backdrop suitable for HAPI on every browser. In particular,
HTML rasterization and perpetual frame capture were unsuitable for virtualized
long conversations. This conclusion does not make our implementation accepted:
real app pixel, interaction and rendering-cost comparisons are still required.
