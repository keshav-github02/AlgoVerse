/**
 * Playback.
 *
 * Owns a position in the event log and nothing else. There is no timer in
 * here: the host calls `tick(deltaMs)` from its own animation loop, which
 * keeps playback deterministic and testable, and keeps algorithm time separate
 * from wall-clock time.
 */

import { Timeline, type Mark, type SceneState } from './timeline.ts';

/** Fine steps per second at speed 1. */
export const BASE_RATE = 12;

export class Playback {
  readonly #timeline: Timeline;
  readonly #listeners = new Set<() => void>();
  #step = 0;
  #playing = false;
  #speed = 1;
  /** Fractional step carried between ticks, so slow speeds still advance. */
  #carry = 0;

  constructor(timeline: Timeline) {
    this.#timeline = timeline;
  }

  get length(): number {
    return this.#timeline.length;
  }

  get step(): number {
    return this.#step;
  }

  get playing(): boolean {
    return this.#playing;
  }

  get speed(): number {
    return this.#speed;
  }

  get marks(): readonly Mark[] {
    return this.#timeline.marks;
  }

  get atEnd(): boolean {
    return this.#step >= this.length;
  }

  /** The state to draw right now. */
  scene(): SceneState {
    return this.#timeline.stateAt(this.#step);
  }

  /** The operation the playhead is inside, if any. */
  currentMark(): Mark | undefined {
    return this.marks.find((m) => this.#step <= m.index);
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #commit(step: number): boolean {
    const next = Math.max(0, Math.min(Math.trunc(step), this.length));
    if (next === this.#step) return false;
    this.#step = next;
    for (const fn of this.#listeners) fn();
    return true;
  }

  seek(step: number): boolean {
    this.#carry = 0;
    return this.#commit(step);
  }

  next(): boolean {
    return this.seek(this.#step + 1);
  }

  prev(): boolean {
    return this.seek(this.#step - 1);
  }

  first(): boolean {
    return this.seek(0);
  }

  last(): boolean {
    return this.seek(this.length);
  }

  /** Coarse stepping: jump to the end of the next operation. */
  nextMark(): boolean {
    const m = this.marks.find((x) => x.index > this.#step);
    return this.seek(m?.index ?? this.length);
  }

  prevMark(): boolean {
    const earlier = this.marks.filter((x) => x.index < this.#step);
    return this.seek(earlier[earlier.length - 1]?.index ?? 0);
  }

  play(): void {
    if (this.atEnd) this.seek(0);
    this.#playing = true;
    this.#carry = 0;
    for (const fn of this.#listeners) fn();
  }

  pause(): void {
    if (!this.#playing) return;
    this.#playing = false;
    for (const fn of this.#listeners) fn();
  }

  toggle(): void {
    if (this.#playing) this.pause();
    else this.play();
  }

  setSpeed(speed: number): void {
    const next = Math.max(0.1, Math.min(speed, 16));
    if (next === this.#speed) return;
    this.#speed = next;
    for (const fn of this.#listeners) fn();
  }

  /**
   * Advance by wall-clock time. Returns true when the visible step changed.
   * Pausing at the end is deliberate: playback stops, it does not loop.
   */
  tick(deltaMs: number): boolean {
    if (!this.#playing || deltaMs <= 0) return false;
    this.#carry += (deltaMs / 1000) * BASE_RATE * this.#speed;
    const whole = Math.floor(this.#carry);
    if (whole < 1) return false;
    this.#carry -= whole;
    const moved = this.#commit(this.#step + whole);
    if (this.atEnd) this.pause();
    return moved;
  }
}
