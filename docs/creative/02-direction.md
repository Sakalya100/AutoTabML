# 02 — Creative direction

Input: [01-research.md](01-research.md) (18 principles from Lusion, Unseen, Active Theory, Resn, Immersive Garden, Igloo and the three.js/Spline/Awwwards references).

What the product does, which every direction must make *physically legible*:

> You describe a problem. AutoTinker **thinks of an idea, tries it** in a sandbox, **weighs** the result against the best so far, **keeps only real gains**, and **stops by itself** when what's left is noise. A **locked test** is opened exactly once at the end.

A direction only qualifies if the 3D *is* this loop, not a backdrop for it, and if every visible form comes from a real `RunRecord` field (principle 16: data-driven, never arbitrary).

---

## Three radically different directions

### A. The Tinker's Bench (material and mechanical)
An impossible-scale workbench floating in a black void, lit by one raking work-lamp.
- **The loop:** each experiment is a *contraption* assembled from parts that come from its idea: model family → core (stacked fins for tree ensembles, one blade for linear models, a coil of stages for boosting, clustered cores for ensembles); preprocessing → rings and filters. The contraption goes into a glass **sandbox chamber**, where streams of particles (the CV folds) pass through it.
- **The gate:** a brass **balance** weighs the new contraption against the current best, and it tips only if the paired test says the difference is real. Kept contraptions are mounted on a lineage shelf. Discarded ones are disassembled and their parts fall into a bin, with physics.
- **Interaction verb:** *hold* to run the test, so the particles stream for as long as you hold.
- **Why it's strong:** the name is literally *tinker*. "It weighs the evidence" is a brilliant physical metaphor for a statistical gate. It's very Lusion: materials over models.
- **Risk:** procedural mechanisms can read as kitbash or stock sci-fi unless every part is designed. It needs a physics engine and has the highest art-direction cost per object. The ceiling and the locked test are weaker as images (a gauge, a vault).

### B. Terra Incognita: The Survey (landscape and light) ✅
The run is an **expedition across an unknown fitness landscape**, the literal picture of what the algorithm does (hill-climbing on a score surface).
- **Unexplored terrain is darkness.** Each experiment is a **probe** sunk into the dark; where it lands, ground is revealed. Its **height is the real CV score**, and the surface the agent has mapped so far is interpolated between real probes, so the land *is* the run.
- **The agent is a bead of mercury** sitting on the best-known point. It rolls uphill only when the gate keeps a probe. Discarded probes leave dim survey stakes on lower ground, and crashes collapse into a small crater of sparks.
- **The noise is a low mist** hugging the ground (thickness = the best's standard error). **The ceiling is a cloud deck:** when the stop rule fires, the clouds descend and settle exactly at the fitted asymptote, just above the summit. *The rest is in the clouds.*
- **The locked test:** at the end, one cold beam of "truth light" sweeps the summit once. It reveals the true height (the test score) as a second marker beside the bead, and the gap between them is the optimism gap.
- **Interaction verb:** *hold* sends a **sonar pulse** from the cursor. The ring travels across the land, briefly lighting contour lines and drawing in-world labels (score, experiment, idea) on the probes it passes.
- **Why it's strong:** it is the algorithm, not a metaphor for it. Every element is data-driven, and it gives us the best of the research: one world with many camera states, travel as navigation (descending *through* the cloud ceiling), scale shifts (a speck in the void → a continent → one probe), light as narrative, and typography lying on the land.
- **Risk:** the probes' x/z positions are a projection, not data (only height is measured). We say so ("map projection: bearing = idea family, step = size of the change"). Terrain shaders can look like a generic synthwave grid if done lazily, so the contour language and materials must be restrained and photographic, never neon.

### C. Arboretum (organic and continuous)
Evolve the existing tree into a glasshouse at impossible scale.
- **The concept:** the dataset arrives as pollen-like particles that crystallise into wood. Kept limbs bloom, and discards petrify. The ceiling is the glasshouse roof the crown presses against. The locked test is a single seed sealed in amber.
- **Interaction verb:** *drag* to wind the season (time scrubbing).
- **Why it's strong:** continuity with what exists, and lowest risk.
- **Risk:** least radical, since it is the current idea with better lighting. A tree is a familiar "growth" cliché, and the gate and the stop rule stay implicit rather than physical.

## Decision: **B, Terra Incognita**

- **Most honest:** the landscape *is* the optimisation problem the agent solves. Hill-climbing, plateaus, a ceiling and noise are all native features of terrain, so nothing needs a caption to be understood.
- **Most coherent world:** one continuous space supports every page. The landing page is a descent from orbit to the summit. A run page is the live survey being drawn. The gallery is a set of islands, each run's mapped terrain seen from above as a contour chart.
- **Best ratio of quality to risk:** terrain, contour shaders, fog, mercury and light sweeps reach studio quality through *materials and light* (principles 6 and 7) rather than modelling hundreds of bespoke objects (A's main risk).
- **A's best idea survives:** the balance becomes how the gate is visualised in the run feed. C is retired.

---

## Visual system

**Mood:** a night survey of an unknown land, like cartography by headlamp. It's quiet, precise and cold, with one warm signal.

| Token | Value | Use |
|---|---|---|
| `void` | `#05070a` | everything unexplored; the page itself |
| `basalt` | `#0d1117` → `#1b222b` | revealed terrain albedo (rough, dielectric, triplanar grain) |
| `contour` | bone `#d9d3c4` @ 18–35% | isolines every Δscore; major line every 5th |
| `mercury` | physical: metalness 1, roughness 0.05, clearcoat 1 | the agent / best solution |
| `signal` | amber `#ffb547` | the only warm colour: kept probes, the climb path, the CTA |
| `mist` | cold teal `#7fd6d0` @ low alpha | noise floor (SE) |
| `cloud` | moonlit grey `#aab4c0` | ceiling deck |
| `truth` | ice white `#eaf6ff` | locked-test beam, used once |
| `crash` | ember `#ff5a3c` | only on crashes |

- **Light:**
  - one key "moon" (cold, high, raking low across ridges so relief reads), a faint fill, and the mercury reflecting a procedural studio environment (drei `Lightformer`s, no HDR download)
  - emissive only on probes and the signal path
  - tone mapping: AgX
- **Type:**
  - the existing display serif (Instrument Serif) for headlines, and JetBrains Mono for in-world data
  - headlines are **SDF text in the scene** (drei `<Text>`) where they belong to a place, e.g. the hero line lies on the plain and is occluded by ridges
  - DOM text only for accessibility and long copy, with the same text also present as hidden DOM for screen readers
- **Motion:**
  - everything critically damped; nothing bounces except mercury (surface tension wobble)
  - camera moves are long and slow (1.6–2.4 s); interaction responses are immediate (< 100 ms)
- **Post:**
  - AgX, Bloom (threshold > 1, emissive only), DOF only in the intro and the probe close-up, subtle Noise, radial ChromaticAberration at edges, Vignette, SMAA
  - tier-gated (principle 18)
- **Sound:** out of scope for v1; design uniforms so an audio bed can bind to them later (principle 15).
- **Anti-patterns banned here:** neon synthwave grids, gradient skies, floating UI cards over the canvas, glassmorphism panels, random particles, OrbitControls free-spin.

## 3D interaction model

**One world, named camera poses, scroll = travel (landing):**

| # | Pose | Scroll beat | What the viewer learns |
|---|---|---|---|
| 0 | **Orbit** | gate/loader: "Surveying…" counter while shaders compile | the island is a speck in the void (impossible scale) |
| 1 | **Approach** | hero: "Models that tinker themselves." SDF on the plain | the land is a model's score; up = better |
| 2 | **First probe** | camera at ground level, probe e000 lands, ground revealed | each experiment reveals ground |
| 3 | **The climb** | pinned; scroll scrubs the replay; camera tracks the bead | ideas → probes → mercury moves only on a keep |
| 4 | **The mist** | low pass through the noise layer | gains smaller than the mist are noise |
| 5 | **The ceiling** | rise *through* the cloud deck, look down | stop rule: clouds settle at the fitted asymptote |
| 6 | **The truth** | beam sweeps once; two markers; the gap | locked test, optimism gap |
| 7 | **Chart** | top-down: the whole survey becomes a contour map; CTA engraved | your data → your map. "Start a survey" |

- **Verb: hold.** Holding the pointer (or a long touch) charges a sonar pulse from the cursor's ground point; the 0..1 charge is fed as one uniform to terrain, probes and post.
  - **Release:** the ring expands at a speed proportional to the charge, lighting contours and pinning in-world labels on probes it crosses, which fade after about 3 s.
  - **On run pages:** the pulse also *selects* the probe nearest the release point, syncing the feed and detail panel.
- **Pointer parallax:** ±2° damped toward the authored pose, with no free orbit on the landing (principle 17). Run pages allow a constrained drag-orbit (yaw ±60°, pitch clamped), because exploring is the content there.
- **Data mapping (pure, unit-tested, deterministic):**
  - **probe (x, z):** a deterministic map projection of the idea tree. Bearing comes from the idea category (8 categories on a compass rose plus a per-id jitter), step length grows with the change's size (diff lines, clamped), and each probe is placed relative to its parent. Probes keep a minimum separation.
  - **probe height:** the real oriented CV mean, normalised over the run's domain (`domainView` for replays, so nothing rescales during playback). Live runs ease the scale smoothly.
  - **terrain:** CPU-interpolated heightfield (Gaussian RBF through probes plus a gentle base) in a 256² DataTexture. It is rebuilt only when a probe lands, in about 2 ms on the main thread.
  - **revealed mask:** a separate channel; each probe reveals a radius; unrevealed ground fades into void.
  - **mist thickness:** the best's SE. **Cloud deck height:** asymptote = bestMean + saturation.value (fallback bestMean + SE), set only after `stopped`.
  - **truth marker:** test score; **select marker:** select score; the gap line is drawn between them.
- **Run pages:** the same world in "survey" mode beside the agent feed: probes land one per completed step, the bead rolls on keep, and the clouds descend when the stop rule fires.
- **Gallery:** each replay is its terrain seen from straight above as a contour chart (one shared context; static frames rendered once, then cached as images).
- **Tiers:**
  - *full:* post stack, 256² terrain, soft shadows on the bead
  - *lite* (mobile or low GPU): no DOF or CA, 128² terrain, no shadows
  - *reduced motion:* no scroll scrubbing; each section shows its pose statically
  - *no WebGL:* a pre-rendered poster image per pose plus the 2D chart

## Implementation plan
1. `src/lib/survey/` (pure): projection, heightfield, reveal mask, poses and the stop/ceiling mapping, with vitest tests on real replays.
2. `src/components/survey/`: the R3F world (terrain + contour shader, probes, mercury, mist, cloud deck, truth beam, sonar, SDF type, camera rig, post, tiers), exported as `<SurveyCanvas>` with the same prop contract as today's `ReefCanvas` plus `pose`.
3. Landing: loader gate → poses 0–7, scroll-driven, built on the existing single-column copy.
4. Run pages and gallery: swap the reef for the survey; the feed stays.
5. Remove the reef/tree code once nothing imports it.
