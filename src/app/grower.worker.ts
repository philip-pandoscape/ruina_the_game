import { startEngine, useContent } from '../engine/load';
import { answer, type GrowerRequest } from './grower';

// The page's region grower (grower.ts), run as a Web Worker: an engine of its own (the same
// WebAssembly as the page's, given the same content before it reads anything), growing a region at a
// time as the page asks and handing each over, its arrays moved.

const self_ = self as unknown as { onmessage: ((e: MessageEvent<GrowerRequest>) => void) | null; postMessage(m: unknown, move: ArrayBuffer[]): void };
let started: Promise<void> | null = null;
/** Requests answered in turn: the engine is asked one thing at a time. */
let queue: Promise<void> = Promise.resolve();

self_.onmessage = (e) => {
  const req = e.data;
  queue = queue.then(async () => {
    if (req.t === 'start') {
      started ??= startEngine().then(() => {
        if (req.content) useContent(req.content);
      });
    }
    await started;
    const { reply, move } = answer(req);
    self_.postMessage(reply, move);
  });
};
