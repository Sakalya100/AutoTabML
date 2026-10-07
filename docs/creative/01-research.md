# 01 — Creative research: what world-class WebGL work actually does

Scope: design *principles* extracted from top creative-technology studios and galleries, to inform a direction for AutoTinker's site (a self-improving tabular-ML agent: idea → sandboxed trial → statistical gate keeps or reverts → stops at a ceiling → locked test opened once). Not a moodboard; nothing here is meant to be copied.

Method: every studio site below was opened in a real (headless Chromium) browser and driven with wheel / click / click-and-hold. WebGL rendered fine headless for all of them. Screenshots were taken at several scroll depths. Case-study write-ups (Awwwards, studio blogs) were read for the techniques behind what's visible. Screenshots are in the session scratchpad (`scratchpad/refs/`) and are not committed.

---

## 1. Per-reference observations

### Lusion — lusion.co
- **One hero object, many instances, with real physics.** The hero is a heap of identical 4-way pipe connectors in three materials (matte blue, glossy black, satin white) tumbling in a framed dark viewport. It's a single model sold through **material contrast** (rough vs clearcoat) and rigid-body collisions. The cursor pushes the pieces around. It feels expensive because the objects have weight and inertia, not because the model is complex.
- **The WebGL layer ignores DOM boundaries.** Further down, low-poly amethyst crystals float *in front of and outside* a rounded-rect video card ("PLAY REEL"). The 3D canvas is a full-page overlay synced to DOM rects, so 3D objects pass across the edges of the HTML. A cyan tube ribbon later sweeps across the whole page behind the project grid. The page reads as one continuous space rather than "a canvas in a box".
- **Swiss restraint around the spectacle.** A pale lavender-grey page, one grotesk typeface, black pills for UI, tiny "+" registration marks at the grid corners, and a single large headline ("Where Creative Ideas Become Immersive"). The 3D gets all of the colour and the UI stays almost silent.
- **Fake what you can and bake what you can't.** Per their SOTM case study, cloth is pre-simulated in Houdini and stored as vertex-animation textures (11 keyframes interpolated to 66 frames, 16-bit packed, with separate desktop/mobile vertex budgets). Translucency is matcap plus a pre-rendered normal map. The light follows the cursor while camera rotation is clamped to about 1.7°. Their stated rule: *"You don't need to do everything real-time."* (https://www.awwwards.com/case-study-for-lusion-by-lusion-winner-of-site-of-the-month-may.html)
- **Oryzo (SOTM 2026): principles written down.** A fictional cork coaster launched like flagship hardware. Its brief was *"A realistic image. The product at the centre. Seamless transitions. Humour."* It uses about 99% one typeface and four colours, and says *"Design cannot constantly ask for attention."* Early "typical Awwwards" abstract concepts were rejected as lifeless in favour of a lived-in, realistic environment. (https://blog.lusion.co/oryzo-bts-part-3-7-website-ux-ui-and-illustrations)

### Unseen Studio — unseen.co
- **The loader is a ritual with a choice.** A blank blush-pink screen with cartoon eyes, one sentence, an "Enter" button and "ENTER WITHOUT AUDIO". The gate gives the browser time to load, gets a user gesture so audio can play, and sets a playful tone before any 3D appears.
- **One art-directed physical place.** The home page is a pastel architectural room: arches, a staircase, a stone, an iridescent pearl, still water with planar reflections that ripple under the cursor, and a sky seen through doorways. Film grain, chromatic aberration and a vignette sit over everything. A mixed serif-italic + grotesk headline ("*Creating the* unexpected") floats centred in the room as if it belongs there.
- **Pages are rooms, and navigation is travel.** Each page is its own three.js Scene, but the cameras are synced along Blender-authored curves, so moving between pages feels like walking through one building. Reaching the projects page is a *dive under the water*. The projects list is an infinite Z-axis corridor driven by a virtual scroll value, and content waits beyond the fog/far plane until it's needed. (https://www.awwwards.com/unseen-studio-by-unseen-studio-wins-sotm-february-2023.html)
- **Cheap-to-render, expensive-looking.** Lighting is baked into textures, grass is instanced with noise-driven wind, assets use KTX2 + Draco, and text is troika SDF text in the 3D space. There are 90s pixel cursors rebuilt in 3D, and the ambient score was written for the site.

### Active Theory — activetheory.net
- **The intro is a threshold object.** The page opens on a black screen with a single glowing ring (">>>") surrounded by bioluminescent tendrils that react to the pointer. You press into it to enter, and the transition *is* the entrance.
- **One continuous world, travelled by scroll.** Behind the gate is a dark particle volume: thousands of soft bokeh points, jellyfish and mushrooms. Scrolling flies the camera *through* it (DOF does much of the work) into project screens. These are frosted-glass slabs floating at different depths around a spine-like sculpture.
- **The UI is a game HUD.** It uses monospace pixel type, a "WORK ~ CONTACT" toggle, a music track switcher in the nav, and a terminal prompt ("WHAT ARE YOU LOOKING FOR?", "ASK ME ANYTHING…") wired to an AI chat that navigates the portfolio. V6 adds networked multi-user cursor trails rendered as coloured tubes, so other visitors appear as presence (custom Hydra engine; https://github.com/Kayforkind/reimagine-it/blob/main/skills/reimagine-it/references/research/web-craft-2025.md).
- **Case study — Santioni Spirits "Notturno" (SOTD + Developer Award, Oct 2026).** It's a comic grid of full-bleed WebGL panels; each panel is a stage you "hold & move". A custom ink-brush shader gives every scene a hand-drawn finish. The palette is strictly red/black with one cold-blue accent. The score was composed by Plan8 and values were tuned live in Hydra. One art-direction shader unifies everything. (https://abduzeedo.com/active-theory-unveils-santioni-spirits-notturno-experience)

### Resn — resn.co.nz
- **One interaction verb: CLICK & HOLD.** The page is a near-black field with grain and one faceted dark crystal teardrop (RGB-split edge highlights), plus centred thin type ("Resn · Creative Studio, Est. 2004"). Holding builds charge (an underline fills): the crystal fractures and unfolds, the type dissolves, the camera pushes in and sound bends. Releasing commits the action. The verb changes shape, camera, sound and navigation all at once. (https://abduzeedo.com/resn-website-masterclass-web-design-marcus-brown)
- **Dark, monochrome, single specular accent.** Nearly all of the image is shadow. The object is defined only by rim and specular highlights, so the light *is* the form.
- **Anticipation as content.** The hold duration gives a commit moment some weight, so actions have a cost and a payoff.

### Immersive Garden — immersive-g.com
- **A typographic loader counting to 100.** It shows a pale grey field, a serif wordmark, one sentence and a small numeric counter counting up (observed 22, then 97). There's no spinner and no bar, just calm confidence.
- **Bas-relief world: the scene is a surface.** After loading, a monochrome plaster wall *extrudes* sculpted forms (birds, flowers, a bust, a hen) that rise and sink back as you scroll. Everything is one material (white plaster with paper grain), lit by one raking light. The 3D is almost colourless; it reads as sculpture, not CG. "Click to enable sound" sits quietly under the headline. Roman numerals in 3D act as section anchors. (https://www.awwwards.com/case-study-immersive-gardens-new-website.html)
- **The craft is in the pipeline.** Server-side KTX2, channel-packed textures, a gltf-transform + Blender script pipeline, GSAP + Lenis.
- **David Whyte experience:** the camera and environment are authored in Blender and rebuilt in three.js. A fluid-sim watercolour "paints" under the cursor, using a simulation atlas plus a stencil buffer so only the active painting simulates. Long-press reveals video. (https://www.awwwards.com/case-study-david-whyte-experience-by-immersive-garden.html)

### Abeto × Bureaux — Igloo Inc (Awwwards SOTY + Developer SOTY 2024) — igloo.inc
- **A real material world with a diegetic HUD.** It opens on a snowfield and an igloo of rough ice blocks glowing from inside, with blowing snow and fog. Thin white leader lines with numbers (23, 26, 27, 31, 35) annotate blocks like a technical survey. Monospace UI text scrambles in and out (text was caught mid-scramble: "Manifestp", "Lbojk0 Mjg+").
- **Scroll flies the camera into the object.** The igloo dissolves into a frosted portal ring, then project ice blocks each containing a *procedurally grown* crystal (a custom growth algorithm, not hand-modelled), then a particle field in the footer formed from VDB volume data.
- **UI rendered in WebGL.** Text glitches and scrambles are done by shifting SDF glyph offsets in a shader, with no DOM relayout. Transitions mix chromatic aberration, "tech displacement" and a frost effect. The sound design was cut to the particle motion. (https://www.awwwards.com/igloo-inc-case-study.html)

### mesh3d.gallery — www.mesh3d.gallery
- A curated index of 541 three.js sites. Its "selected" set is dominated by the studios above, plus Active Theory's *Cyera AI Guardian*, an AI-product site and a direct category peer. Recurring threads: particles-as-matter, physical materials, scroll-as-camera. The gallery's own chrome is generic (dark, lime CTA, card grid), so the container look isn't where quality lives.

### Spline examples — spline.design/examples
- A **counter-reference**: pastel isometric icons and "3D TEXT" on a purple gradient. They're competent but read as *template*: soft global light, toy materials, objects with no world, and everything equally lit.

### three.js examples — threejs.org/examples
- Building blocks behind all of the above: `gpgpu_birds` / `gpgpu_protoplanet` (GPGPU agents), `gpgpu_water` (cursor ripples), `materials_physical_transmission_alpha` (thickness, attenuation, IOR), `postprocessing_unreal_bloom`, `postprocessing_dof2`, `lights_spotlight` (one cookie light, lots of drama), `volume_cloud` (raymarched 3D texture), `instancing_*`, `batch_lod_bvh`.

### Awwwards WebGL list (Oct 2026) — awwwards.com/websites/webgl
- Recent Developer-award SOTDs (Santioni Spirits, Lidar Drone Scanning, EDOLUS, Butter, The Tie-break) each centre on **one tactile mechanic or one simulated material**. Shopify Editions stages each scroll section as *enter → hold → exit*, with type that scatters and reforms. Cartier uses one room per product with a Web Audio score. Hubtown uses one monolith whose lighting the cursor uncovers. (https://www.utsubo.com/blog/best-threejs-websites-2026)

---

## 2. Synthesis — recurring principles

1. **One world, many camera states.** *Rationale:* continuity of space is what makes it feel like a place rather than slides. *Technique:* one persistent `<Canvas>` across routes, with named camera poses (position, target, fov) and scroll/route mapped to a spline (`CatmullRomCurve3`) or eased blends between poses. Each "page" is a pose, not a remount. (Unseen, Active Theory, Igloo)

2. **Navigation is travel.** *Rationale:* moving between sections should be a physical act (dive, push through, descend), never a cut. *Technique:* author camera paths in Blender and export them as glTF animation, or as curve points sampled by scroll. Cover scene swaps with a full-screen shader transition (displacement, frost or dissolve) at the moment of maximum motion blur.

3. **The interface is the scene.** *Rationale:* HUD and labels drawn in the world (leader lines, numbered callouts, in-world text) make the UI feel diegetic. *Technique:* drei `<Text>` (troika SDF) or MSDF in world space, `Line2` leader lines projected from world points, and DOM overlays synced with drei `<Html transform>` only where accessibility needs real DOM. (Igloo, Active Theory)

4. **One interaction verb, deeply consequential.** *Rationale:* a single learnable gesture (hold, drag, push) that changes shape, camera, light and sound together beats ten hover effects. *Technique:* a shared 0..1 "charge" value (spring-smoothed with `maath/easing.damp`) fed as a uniform to every material, the post stack and an audio filter at once. (Resn hold, Lusion push)

5. **Interaction has physical consequence.** *Rationale:* weight and inertia read as quality, and the cursor should *disturb* matter, not merely highlight it. *Technique:* cursor ray to a world point, then an impulse into a GPGPU velocity texture, a ripple heightfield, or rigid bodies. Fluid or heightfield sims run at low resolution (128²–256²).

6. **Materials over models.** *Rationale:* the best heroes are geometrically simple (a connector, a teardrop, a plaster wall, ice blocks), and the richness is in roughness variation, clearcoat, transmission, grain and subsurface fakes. *Technique:* `MeshPhysicalMaterial` with clearcoat/sheen/iridescence, or matcap + normal map, plus a roughness map and triplanar noise via `onBeforeCompile`. Limit the palette to 2–3 materials per scene.

7. **Light is the narrative.** *Rationale:* where light falls *is* what the viewer reads, and darkness is negative space. *Technique:* one key light (spot with a cookie, or a raking directional), a dim environment, emissive accents on the meaningful object, and `ToneMapping` (AgX/ACES) set deliberately. Animate light intensity or position as a story beat rather than moving objects. (Resn, Immersive Garden, Igloo's glow-from-within)

8. **Restraint: one hero idea per moment.** *Rationale:* every studio pairs maximal 3D with minimal UI (one typeface, 3–4 colours, one headline). The spectacle needs silence around it. *Technique:* a design budget of one type family (plus a mono for data), one accent colour carried by the 3D light, no decorative DOM chrome, and generous empty viewport.

9. **The loader is part of the experience.** *Rationale:* it buys load time, earns the audio gesture and sets tone. *Technique:* a counter, a single sentence, and "Enter / Enter without sound". Precompile shaders (`gl.compile` / `renderer.compileAsync`) and warm the GPU during the gate. Then the first frame *is* the intro shot.

10. **Typography lives in the same space.** *Rationale:* type that is occluded by, lit by or refracted through 3D binds the two together. Type pasted over a canvas reads as a layer. *Technique:* SDF text inside the scene with depth test; headlines behind transmissive objects; scrambles and glitches done in the SDF shader (offset glyph UVs) rather than the DOM.

11. **Scale shifts as story beats.** *Rationale:* moving from the macro view (a landscape or whole structure) to the micro (a crystal inside one block, particles in a volume) signals "now we're going deeper". *Technique:* scroll-driven dolly through a near plane into a nested object, with fog density and DOF focus distance animated together. Swap LOD and particle sets at the threshold.

12. **Matter, not icons: particles as substance.** *Rationale:* particles that *form* things (a logo, a shape, a volume) and disperse feel alive. Random floating dots feel like a screensaver. *Technique:* GPUComputationRenderer with position and velocity textures, target positions sampled from a mesh surface (`MeshSurfaceSampler`) or volume, and curl-noise flowfields between targets. Colour by speed.

13. **Bake heavy work, simulate the reactive part.** *Rationale:* studios ship film-quality looks at 60fps by pre-computing everything that doesn't respond to the user. *Technique:* baked lightmaps/AO, vertex-animation textures for complex motion, KTX2 + Draco/Meshopt, and channel-packed textures. Real-time compute is reserved for what the cursor touches.

14. **A filmic final pass, kept subtle.** *Rationale:* grain, slight chromatic aberration, vignette and soft bloom unify CG with the page and hide banding. Overdone, they're a cliché. *Technique:* `@react-three/postprocessing` with Noise (premultiplied, low opacity), ChromaticAberration with radial modulation, Vignette, Bloom on emissive-only (luminance threshold above 1 under HDR), and SMAA. Toggle the whole stack by GPU tier.

15. **Sound as a parallel channel, opt-in.** *Rationale:* audio cut to motion (Igloo) or a custom ambient score (Unseen) doubles perceived quality. *Technique:* Web Audio with one ambient bed plus a few earcons, and parameters (filter cutoff, pitch) driven by the same uniforms as visuals. Always muted until a gesture, with a persistent toggle.

16. **Data-driven or procedural, never arbitrary.** *Rationale:* Igloo's grown crystals and Lusion's simulated cloth feel inevitable because a process produced them. *Technique:* derive geometry from a generative rule or real data (growth algorithms, L-systems, sim output), seeded and deterministic, so every form has a reason.

17. **Authored camera, constrained freedom.** *Rationale:* free orbit controls feel like a tool. Studios clamp parallax to a few degrees and choreograph everything else. *Technique:* replace OrbitControls with pointer-driven parallax (±1–3°) damped toward the authored pose. Allow drag only where exploring *is* the content.

18. **Graceful tiers.** *Rationale:* a broken or janky mobile experience undoes the craft. *Technique:* drei `PerformanceMonitor` / `AdaptiveDpr`, GPU-tier detection to set particle counts and post stack, a `prefers-reduced-motion` path, and a static poster fallback for no-WebGL.

---

## 3. Anti-patterns

**Generic ones from the brief: why they read as cheap**
- **Floating blobs / metaballs on a gradient.** There's no world, no light source, no scale reference and no reason. The blob is the default output of a shader tutorial, and its motion is noise rather than consequence.
- **Gradient backgrounds (purple → blue mesh gradients).** These signal "template" instantly and flatten depth, since there's no fog, horizon or light falloff. The studios above use near-flat fields (grey plaster, blush, black) and let *light inside the scene* create gradients.
- **Spinning cubes / idle auto-rotate.** Rotation with no cause says "I didn't know what the object should do". Studios hold objects still and move light, camera or matter in response to the user.
- **Glassmorphism.** Blurred translucent DOM cards over a canvas create a second, competing depth system that's flat, rectilinear and not lit by the scene. Active Theory's glass slabs work because they're *in* the 3D world, refracting it, at different depths.
- **Stock 3D (marketplace models, Spline-icon vocabulary).** Pastel toys, uniform soft lighting and isometric framing say "assembled", not "authored". Every studio asset here is custom or procedurally grown.
- **The "AI-startup look".** Black background, neon-violet glow, a sphere of dots or neural-network lines, "Introducing X" plus a waitlist CTA. It's ubiquitous and therefore invisible. It also *claims* intelligence through imagery instead of demonstrating behaviour.
- **Card grids.** The bento or feature grid is a CMS layout, and putting it under a 3D hero makes the 3D decorative. Studios turn the content list into *space*: Unseen's Z-corridor, Igloo's ice blocks, Active Theory's floating slabs.
- **Predictable heroes** (headline left, 3D object right, two buttons). This is a layout people have seen a thousand times, so it reads before it's looked at. Studio heroes are full-bleed scenes with the headline *in* the scene, or a threshold or gate.

**Subtler ones the studios avoid**
- **Free OrbitControls as the main interaction.** It turns an experience into a model viewer.
- **Effects-stacking.** Bloom on everything, heavy CA and a DOF that blurs the subject feel cheap. Studios apply each effect to a specific element for a specific beat.
- **Scroll-jacking without spatial payoff.** Hijacked scroll is forgiven *only* when it moves a camera through meaningful space. Lusion keeps native-feeling scroll with WebGL synced to it.
- **Scene changes with a hard cut or a DOM fade over a frozen canvas.**
- **Unlabelled interactivity.** Resn writes "CLICK & HOLD", Active Theory "SCROLL DOWN", Immersive Garden "Scroll down / Click to enable sound". These are tiny, honest affordances.
- **Equal emphasis everywhere** (everything lit, saturated and moving). The best work is mostly dark, still or empty, with one place of focus.

---

## 4. Technique inventory (three 0.186 / R3F 9 / drei 10 / @react-three/postprocessing 3 — all already installed)

| Technique | Use | Cost |
|---|---|---|
| **GPGPU particles** (`GPUComputationRenderer`) | Particles that form shapes, flowfields, colour-by-speed | Medium. Ping-pong pos/vel RTs. ~64k desktop, ~16k mobile. |
| **InstancedMesh / `<Instances>` / `BatchedMesh`** | Thousands of rigid pieces in one draw call | Low. Per-instance attributes. |
| **ShaderMaterial / `onBeforeCompile` / drei `shaderMaterial`** | Noise, dissolve, growth masks, shared "charge" uniforms on top of PBR | Runtime is free. `onBeforeCompile` is brittle across three versions. |
| **`MeshTransmissionMaterial`** (drei) | Glass, ice, liquid refraction with CA | **High**: extra scene render per object (samples 4–6, res 256–512). Limit to 1–2 heroes. Native `transmission` is cheaper. |
| **Volumetric light** | Shafts, glow-from-within | Low: fresnel cone mesh / drei `SpotLight` volumetric. Medium: `GodRaysEffect`. High: half-res raymarched fog. |
| **DOF** (postprocessing) | Focus pulls as story beats, particle bokeh | Medium-high. Animate focus with the camera; drop on low tier. |
| **Bloom** (mipmap) | Only the meaningful thing glows | Low-medium. Threshold ≥ 1, emissive > 1. |
| **Noise / CA / Vignette / SMAA** | Filmic unification, anti-banding | Low. |
| **Fog** (`FogExp2`, custom height fog) | Depth, reveal-on-approach | Free; high value. |
| **SDF / raymarching** | Organic unions, volumes, infinite fields | High per pixel. Half-res, bounded proxy. One element at most. |
| **Physics: `@react-three/rapier`** (**NOT installed**) | Tumbling, pushing, settling bodies | ~1–2 MB WASM; hundreds of bodies OK. Alternatives: JS verlet/springs, GPGPU, or baked sims. |
| **Morph targets** | A↔B shape blends (bud→open, intact→fractured) | Low. Same topology. |
| **Vertex animation textures** | Baked cloth/fluid/growth/shatter | Low runtime; needs an offline Houdini/Blender pipeline (Lusion's main trick). |
| **Displacement / heightfields** | Relief surfaces, terrain, water ripples | Needs dense mesh; normal map for subtle relief. |
| **Curl-noise flowfields** | Organic drift between formations | Low inside the GPGPU velocity pass. |
| **SDF text** (drei `<Text>` = troika; `<Text3D>`) | Spatial typography, occlusion, shader scramble | Low and sharp at any scale. Extruded text is heavier and rarely needed. |
| **`MeshReflectorMaterial`** | Still water, polished floor | One extra render at ~512. |
| **`Line2` / drei `<Line>`** | Leader lines, ticks, in-world data overlays | Low. |
| **Perf** | `PerformanceMonitor`, `AdaptiveDpr`, `Bvh`, GPU tiering, `compileAsync`, KTX2 + Draco/Meshopt | Mandatory when stacking GPGPU + transmission + DOF. |

Rough budget heuristic seen across the studios: **one expensive signature** (transmission, raymarch, or a large GPGPU sim) plus cheap supporting layers (instancing, fog, emissive + bloom, grain) per scene. Never two expensive signatures on screen at once.
