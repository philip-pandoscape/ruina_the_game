import type * as THREE from 'three';
import type { WorldStats } from '../net/worldLink';

// How the game runs: frame times, the CPU's share of a frame, how long the graphics card spends
// drawing (where the browser allows it), draw calls and triangles. The HUD's stats line shows them,
// and the test API hands them to the stress tests.

export class Perf {
  private readonly frameTimes: number[] = [];
  private cpu = 0;
  private readonly gl: WebGL2RenderingContext;
  private readonly timer: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private query: WebGLQuery | null = null;
  private gpu = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly particles: () => number,
    /** What the server says of the game you're in (admins only, once a second), when it says anything. */
    private readonly server: () => WorldStats | null,
  ) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    // Unlike fps, the time the graphics card spends drawing isn't capped at 60, so it shows how much
    // headroom is left.
    this.timer = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  /** A frame's length, in milliseconds (the last 240 are kept). */
  frame(ms: number): void {
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 240) this.frameTimes.shift();
  }

  /** The time the page's own work took in a frame, in milliseconds (smoothed). */
  cpuSpent(ms: number): void {
    this.cpu = this.cpu * 0.95 + ms * 0.05;
  }

  /** Starts timing the graphics card's drawing of this frame; false when it can't be timed now. */
  gpuBegin(): boolean {
    const { gl, timer } = this;
    if (!timer) return false;
    if (this.query) {
      if (!gl.getQueryParameter(this.query, gl.QUERY_RESULT_AVAILABLE)) return false;
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(this.query, gl.QUERY_RESULT) / 1e6;
        this.gpu = this.gpu === 0 ? ms : this.gpu * 0.9 + ms * 0.1;
      }
      gl.deleteQuery(this.query);
    }
    this.query = gl.createQuery();
    gl.beginQuery(timer.TIME_ELAPSED_EXT, this.query);
    return true;
  }

  gpuEnd(): void {
    if (this.timer) this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
  }

  private gpuName(): string {
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  }

  /** The numbers as they stand. */
  numbers() {
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const avg = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
    const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
    const info = this.renderer.info.render;
    return {
      avgMs: +avg.toFixed(2),
      p95Ms: +p95.toFixed(2),
      fps: avg > 0 ? Math.round(1000 / avg) : 0,
      cpuMs: +this.cpu.toFixed(2),
      gpuMs: this.timer ? +this.gpu.toFixed(2) : null,
      drawCalls: info.calls,
      triangles: info.triangles,
      particles: this.particles(),
      server: this.server(),
      gpu: this.gpuName(),
    };
  }

  /** The HUD's stats line. An admin sees how the game they're in runs on the server (its tick, players and bots). */
  line(): string {
    const s = this.numbers();
    const base = `${s.fps} fps · ${s.drawCalls} draw calls · ${s.triangles.toLocaleString()} triangles`;
    const gpu = s.gpuMs !== null ? ` · GPU ${s.gpuMs} ms/frame` : '';
    const srv = s.server;
    const server = srv
      ? ` · server: ${srv.players} players + ${srv.bots} bots, ${srv.tickMs.toFixed(1)} ms a tick, ${(srv.bytes / 1024).toFixed(1)} KB an update`
      : '';
    return `${base}${gpu}${server}`;
  }
}
