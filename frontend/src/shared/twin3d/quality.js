// Adaptive render resolution for the 3D twin (pure, no Three.js). While frames are drawn continuously (camera moving, shaft turning) and the frame
// interval stays slow, the pixel ratio is stepped down so interaction stays fluid on weaker hardware. It is restored to full as soon as the scene
// is idle, so a still image is always drawn at full quality. Only the drawing resolution changes; nothing about the data or the model does.

export const QUALITY = { slowMs: 28, sustain: 45, step: 0.75, floor: 1 };

export class QualityGovernor {
  constructor(maxRatio, opts = {}) {
    this.o = { ...QUALITY, ...opts };
    this.max = Math.max(1, maxRatio || 1);
    this.ratio = this.max;
    this.ema = null; this.slow = 0;
  }

  /** One continuously rendered frame `dtMs` after the previous one. Returns the pixel ratio to use from now on. */
  frame(dtMs) {
    if (!(dtMs > 0) || dtMs > 250) return this.ratio;                  // first frame of a run, or a pause (hidden tab): not a speed measurement
    this.ema = this.ema == null ? dtMs : this.ema * 0.9 + dtMs * 0.1;
    this.slow = this.ema > this.o.slowMs ? this.slow + 1 : 0;
    if (this.slow >= this.o.sustain && this.ratio > this.o.floor) {
      this.ratio = Math.max(this.o.floor, +(this.ratio * this.o.step).toFixed(3));
      this.slow = 0; this.ema = null;                                  // measure again at the new resolution before stepping further
    }
    return this.ratio;
  }

  /** The scene went idle: back to full resolution for the still frame. Returns true when the ratio changed. */
  idle() {
    this.ema = null; this.slow = 0;
    if (this.ratio === this.max) return false;
    this.ratio = this.max;
    return true;
  }
}
