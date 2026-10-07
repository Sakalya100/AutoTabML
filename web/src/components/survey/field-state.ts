import { DataTexture, DataUtils, HalfFloatType, LinearFilter, ClampToEdgeWrapping, RGFormat } from "three";
import { buildHeightfield, fieldWindow, sampleField, type FieldWindow } from "@/lib/survey/heightfield";
import type { SurveyLayout } from "@/lib/survey/contract";

/**
 * The GPU-side heightfield: ONE RG half-float texture holding exactly what is on screen.
 *
 * When a probe lands, the ground morphs from what is shown now (`from`) to the new probe set (`to`) over ~1.4 s. The
 * blend is done on the CPU each frame of the morph (~1 ms at 256²) and uploaded into the same texture. An earlier
 * version blended two textures in the shader; during continuous scrolling (a new probe every few frames, so the morph
 * never settled) the "previous" texture rendered as void and the whole land went black until scrolling stopped.
 *
 * The shaders still read `uFieldA`/`uFieldB` mixed by `uMix`; both point at this one texture and `mix` stays 1.
 *
 * The landing never morphs at all: it hands the world the complete run once, so the ground is built at load and the
 * texture is never touched again while scrolling (only the bead, camera and section moments move).
 */
export class FieldState {
  win: FieldWindow;
  readonly res: number;
  private from: Float32Array;
  private to: Float32Array;
  private cur: Float32Array;
  private data: Uint16Array;
  private readonly tex: DataTexture;
  /** Morph progress 0 → 1. */
  t = 1;
  /** Shader blend between uFieldA and uFieldB: always 1 (they are the same texture). */
  readonly mix = 1;
  key = "";
  private duration = 1.4;

  constructor(res: number, bounds: SurveyLayout["bounds"]) {
    this.res = res;
    this.win = fieldWindow(bounds, res);
    const n = res * res * 2;
    this.from = new Float32Array(n);
    this.to = new Float32Array(n);
    this.cur = new Float32Array(n);
    this.data = new Uint16Array(n);
    this.tex = makeTex(this.data, res);
  }

  get texA(): DataTexture {
    return this.tex;
  }
  get texB(): DataTexture {
    return this.tex;
  }

  /** Rebuild for a new probe set. `animate` = morph from what is on screen now; otherwise snap. */
  update(layout: SurveyLayout, bounds: SurveyLayout["bounds"], key: string, animate: boolean) {
    if (key === this.key) return;
    const first = this.key === "";
    this.key = key;
    const win = fieldWindow(bounds, this.res);
    const moved = win.minX !== this.win.minX || win.minZ !== this.win.minZ || win.size !== this.win.size;
    this.win = win;
    buildHeightfield(layout, win, this.to);
    if (animate && !moved && !first) {
      // Start from exactly what is displayed now, so a new probe mid-morph never jumps.
      this.from.set(this.cur);
      this.t = 0;
    } else {
      this.cur.set(this.to);
      this.t = 1;
      this.upload();
    }
  }

  /** Advance the morph and upload the blended ground. No work once settled. */
  tick(dt: number) {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / this.duration);
    const t = this.t;
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const { from, to, cur } = this;
    for (let i = 0; i < cur.length; i++) cur[i] = from[i] + (to[i] - from[i]) * e;
    this.upload();
  }

  /** CPU height (or mask) under (x, z), matching what the GPU displays this frame. */
  sample(x: number, z: number, channel: 0 | 1 = 0): number {
    return sampleField(this.cur, this.win, x, z, channel);
  }

  /** Target height (after the morph) — for things that should land where the ground will be. */
  sampleTarget(x: number, z: number): number {
    return sampleField(this.to, this.win, x, z, 0);
  }

  dispose() {
    this.tex.dispose();
  }

  private upload() {
    const f = DataUtils.toHalfFloat;
    const { cur, data } = this;
    for (let i = 0; i < cur.length; i++) data[i] = f(cur[i]);
    this.tex.needsUpdate = true;
  }
}

function makeTex(data: Uint16Array, res: number): DataTexture {
  const t = new DataTexture(data, res, res, RGFormat, HalfFloatType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
