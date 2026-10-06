import { DataTexture, DataUtils, HalfFloatType, LinearFilter, ClampToEdgeWrapping, RGFormat } from "three";
import { buildHeightfield, fieldWindow, sampleField, type FieldWindow } from "@/lib/survey/heightfield";
import type { SurveyLayout } from "@/lib/survey/contract";

/**
 * The GPU-side heightfield: two fixed RG half-float textures (A = what was there, B = the new probe set), blended by
 * `mix` while the ground morphs. Textures are allocated once per resolution and only ever rewritten in place.
 */
export class FieldState {
  win: FieldWindow;
  readonly res: number;
  private a: Float32Array;
  private b: Float32Array;
  private scratch: Float32Array;
  readonly texA: DataTexture;
  readonly texB: DataTexture;
  private dataA: Uint16Array;
  private dataB: Uint16Array;
  /** 0 → showing A, 1 → showing B. */
  t = 1;
  /** Eased blend handed to the shaders. */
  mix = 1;
  key = "";

  constructor(res: number, bounds: SurveyLayout["bounds"]) {
    this.res = res;
    this.win = fieldWindow(bounds, res);
    const n = res * res * 2;
    this.a = new Float32Array(n);
    this.b = new Float32Array(n);
    this.scratch = new Float32Array(n);
    this.dataA = new Uint16Array(n);
    this.dataB = new Uint16Array(n);
    this.texA = makeTex(this.dataA, res);
    this.texB = makeTex(this.dataB, res);
  }

  /** Rebuild for a new probe set. `animate` = morph from what is on screen now; otherwise snap. */
  update(layout: SurveyLayout, bounds: SurveyLayout["bounds"], key: string, animate: boolean) {
    if (key === this.key) return;
    this.key = key;
    const win = fieldWindow(bounds, this.res);
    const moved = win.minX !== this.win.minX || win.minZ !== this.win.minZ || win.size !== this.win.size;
    this.win = win;
    // A := what is on screen now, so a rebuild mid-morph never jumps. When the last morph has settled that is
    // exactly B, and its half-float upload can be copied instead of re-encoded.
    if (animate && !moved) {
      if (this.mix >= 1) {
        this.a.set(this.b);
        this.dataA.set(this.dataB);
      } else {
        const m = this.mix;
        for (let i = 0; i < this.a.length; i++) this.scratch[i] = this.a[i] + (this.b[i] - this.a[i]) * m;
        this.a.set(this.scratch);
        toHalf(this.a, this.dataA);
      }
    }
    buildHeightfield(layout, win, this.b);
    toHalf(this.b, this.dataB);
    if (!animate || moved) {
      this.a.set(this.b);
      this.dataA.set(this.dataB);
    }
    this.texA.needsUpdate = true;
    this.texB.needsUpdate = true;
    this.t = animate && !moved ? 0 : 1;
    this.mix = this.t;
  }

  tick(dt: number, duration = 1.4) {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / duration);
    const t = this.t;
    this.mix = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  }

  /** CPU height (or mask) under (x, z), matching what the GPU displays this frame. */
  sample(x: number, z: number, channel: 0 | 1 = 0): number {
    const b = sampleField(this.b, this.win, x, z, channel);
    if (this.mix >= 1) return b;
    const a = sampleField(this.a, this.win, x, z, channel);
    return a + (b - a) * this.mix;
  }

  /** Target height (after the morph) — for things that should land where the ground will be. */
  sampleTarget(x: number, z: number): number {
    return sampleField(this.b, this.win, x, z, 0);
  }

  dispose() {
    this.texA.dispose();
    this.texB.dispose();
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

function toHalf(src: Float32Array, dst: Uint16Array) {
  const f = DataUtils.toHalfFloat;
  for (let i = 0; i < src.length; i++) dst[i] = f(src[i]);
}
