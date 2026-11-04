// Pictures for bug reports. The 3D view is a WebGL canvas that is only readable right after it
// has been drawn, so everything here is called from the render loop (BugReporter.afterRender).
// The HUD is HTML on top of the canvas; screenshots draw it in too, through an SVG foreignObject.

function toBlob(c: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      c.toBlob(resolve, type, quality);
    } catch {
      resolve(null); // a tainted canvas
    }
  });
}

// Reading pixels back from the GPU and encoding a JPEG costs ~15 ms; on the main thread that is a
// dropped frame four times a second. So the main thread only takes a GPU-side snapshot, already
// scaled down (well under a millisecond), and a worker does the readback and the encoding.
const WORKER_SOURCE = `
const canvases = new Map();
onmessage = async (e) => {
  const { id, bitmap, quality } = e.data;
  try {
    const key = bitmap.width + 'x' + bitmap.height;
    let c = canvases.get(key);
    if (!c) canvases.set(key, (c = new OffscreenCanvas(bitmap.width, bitmap.height)));
    c.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0);
    bitmap.close();
    postMessage({ id, blob: await c.convertToBlob({ type: 'image/jpeg', quality }) });
  } catch (err) {
    postMessage({ id, error: String(err) });
  }
};`;

/** Small JPEGs of the 3D view, a few times a second. */
export class FrameGrabber {
  private worker: Worker | null = null;
  private waiting = new Map<number, (b: Blob | null) => void>();
  private nextId = 1;
  private c: HTMLCanvasElement | null = null;

  constructor() {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return;
    try {
      this.worker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })));
      this.worker.onmessage = (e: MessageEvent<{ id: number; blob?: Blob }>) => {
        this.waiting.get(e.data.id)?.(e.data.blob ?? null);
        this.waiting.delete(e.data.id);
      };
      this.worker.onerror = () => this.dropWorker();
    } catch {
      this.worker = null;
    }
  }

  private dropWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
  }

  grab(src: HTMLCanvasElement, maxWidth: number, quality = 0.7): Promise<Blob | null> {
    if (src.width < 2 || src.height < 2) return Promise.resolve(null);
    const scale = Math.min(1, maxWidth / src.width);
    const w = Math.round(src.width * scale);
    const h = Math.round(src.height * scale);
    const worker = this.worker;
    if (!worker) return this.grabHere(src, w, h, quality);
    // Behind (a slow machine, a busy tab): skip a frame rather than queue them up.
    if (this.waiting.size > 3) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      // The snapshot is taken now, while the canvas still holds this frame.
      createImageBitmap(src, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' }).then(
        (bitmap) => worker.postMessage({ id, bitmap, quality }, [bitmap]),
        () => {
          this.waiting.delete(id);
          resolve(null);
        },
      );
    });
  }

  /** Without a worker: the same, on this thread. */
  private grabHere(src: HTMLCanvasElement, w: number, h: number, quality: number): Promise<Blob | null> {
    this.c ??= document.createElement('canvas');
    const g = this.c.getContext('2d', { alpha: false });
    if (!g) return Promise.resolve(null);
    if (this.c.width !== w || this.c.height !== h) {
      this.c.width = w;
      this.c.height = h;
    }
    g.drawImage(src, 0, 0, w, h);
    // toBlob copies the pixels now and encodes them later, so the canvas can be reused at once.
    return toBlob(this.c, 'image/jpeg', quality);
  }
}

/** The text on screen outside the 3D view (HUD, panels, prompts, toasts), as the player reads it. */
export function hudText(skip: Element[]): string {
  const out: string[] = [];
  for (const e of Array.from(document.body.children)) {
    if (skip.includes(e) || e.tagName === 'SCRIPT' || e.tagName === 'CANVAS' || e.tagName === 'STYLE') continue;
    const t = (e as HTMLElement).innerText?.trim();
    // One line per element: the HUD's layout puts every icon and number on a line of its own.
    if (t) out.push(`[${e.id || e.className || e.tagName.toLowerCase()}] ${t.replace(/\s*\n\s*/g, ' · ')}`);
  }
  return out.join('\n').slice(0, 30_000);
}

/** The page's HTML overlay as an SVG image, ready to be drawn over the 3D view. */
function overlaySvg(w: number, h: number, skip: Element[]): string {
  const css = Array.from(document.querySelectorAll('style'))
    .map((s) => s.textContent ?? '')
    .join('\n')
    .replaceAll(']]>', ']] >');
  const body = document.body.cloneNode(true) as HTMLElement;
  // Canvases in the HUD (the map) can't be serialized; carry their pixels across as images.
  const liveCanvases = Array.from(document.body.querySelectorAll('canvas'));
  const copies = Array.from(body.querySelectorAll('canvas'));
  liveCanvases.forEach((live, i) => {
    const copy = copies[i];
    if (!copy) return;
    if (live.id === 'game' || skip.some((s) => s.contains(live))) return void copy.remove();
    try {
      const img = document.createElement('img');
      img.src = live.toDataURL();
      img.setAttribute('style', live.getAttribute('style') ?? '');
      img.className = live.className;
      img.width = live.clientWidth || live.width;
      img.height = live.clientHeight || live.height;
      copy.replaceWith(img);
    } catch {
      copy.remove();
    }
  });
  for (const e of Array.from(body.querySelectorAll('script'))) e.remove();
  for (const s of skip) if (s.id) body.querySelector(`#${CSS.escape(s.id)}`)?.remove();
  const html = new XMLSerializer().serializeToString(body);
  // The page's own background would paint over the 3D view.
  const reset = 'html, body { background: transparent !important; margin: 0; }';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
    `<html xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px"><head><style><![CDATA[${css}\n${reset}]]></style></head>${html}</html>` +
    `</foreignObject></svg>`
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not draw the HUD'));
    img.src = src;
  });
}

export interface Screenshot {
  blob: Blob;
  /** Whether the HTML HUD made it into the picture (if not, it is the 3D view alone). */
  hud: boolean;
}

/**
 * The whole screen: the 3D view with the HUD on top, at CSS-pixel size. Must be called right after
 * the canvas was drawn (the 3D part is copied synchronously; the HUD is added afterwards).
 */
export async function screenshot(src: HTMLCanvasElement, skip: Element[]): Promise<Screenshot | null> {
  const w = Math.max(2, Math.round(innerWidth));
  const h = Math.max(2, Math.round(innerHeight));
  const base = document.createElement('canvas');
  base.width = w;
  base.height = h;
  const bg = base.getContext('2d', { alpha: false });
  if (!bg) return null;
  bg.drawImage(src, 0, 0, w, h);
  let svg = '';
  try {
    svg = overlaySvg(w, h, skip);
  } catch {
    /* fall back to the 3D view alone */
  }
  if (svg) {
    try {
      const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      const full = document.createElement('canvas');
      full.width = w;
      full.height = h;
      const fg = full.getContext('2d', { alpha: false })!;
      fg.drawImage(base, 0, 0);
      fg.drawImage(img, 0, 0, w, h);
      const blob = await toBlob(full, 'image/jpeg', 0.88);
      if (blob) return { blob, hud: true };
    } catch {
      /* fall back to the 3D view alone */
    }
  }
  const blob = await toBlob(base, 'image/jpeg', 0.88);
  return blob ? { blob, hud: false } : null;
}
