import { isAlive, type Actor } from '../actor';
import { DEG, angleDiff, len } from '../math';
import { behaviour, holdsToken, offFacing, type PackDef } from './brain';
import { FOE_ACT, type Foe } from './senses';

// The pack. Before the brains take their turn, every creature whose brain has a `pack` gets told
// what its band has worked out together this frame:
//
// - whether its nerve holds (courage: its health, friends close by, foes close by),
// - where to run if it doesn't (the biggest group of its band, else home),
// - whether it may strike its foe now (a token: only a few at once, more as more fight; one more
//   when the foe leaves an opening - its back turned, recovering from a swing, casting, stunned),
// - and if not, where on the ring around the foe to wait: just outside its weapon's reach, the
//   places bunched up behind it.
//
// So one goblin alone fights you fair and square, and ten of them wear you down from all sides.
// Nothing here changes position; the brains act on it. crates/engine/src/pack.rs does the same.

/** How close the rest of its band has to be for a goblin to count as part of a group to run to. */
const GROUP = 5;

const packOf = (a: Actor): PackDef | undefined => (a.brain ? behaviour(a.brain)?.pack : undefined);

const sameBand = (a: Actor, o: Actor): boolean => o !== a && a.band !== 0 && o.band === a.band;

export function stepPacks(list: readonly Actor[], foes: readonly Foe[]): void {
  const members: Actor[] = [];
  for (const a of list) if (isAlive(a) && !a.gone && packOf(a)) members.push(a);
  if (!members.length) return;

  // Courage first: it decides who is still fighting.
  for (const a of members) {
    const p = packOf(a)!;
    let friends = 0;
    for (const o of members) if (sameBand(a, o) && len(o.x - a.x, o.z - a.z) <= p.friendRadius) friends++;
    let threats = 0;
    for (const f of foes) if (len(f.x - a.x, f.z - a.z) <= p.friendRadius) threats++;
    const courage = a.hp / a.maxHp + p.friendWorth * friends - p.foeWorth * threats;
    a.afraid = a.afraid ? courage < p.calmAt : courage < p.braveAt;
    a.token = false;
    a.opening = false;
  }

  // Where the frightened run: to whichever of the band (not running itself) has the most of the
  // band around it, so a chase leads you into the rest of them. With nobody to run to, home.
  for (const a of members) {
    if (!a.afraid) continue;
    let best: Actor | undefined;
    let bestCount = -1;
    for (const o of members) {
      if (!sameBand(a, o) || o.afraid) continue;
      let n = 0;
      for (const q of members) if (q !== o && q.band === o.band && len(q.x - o.x, q.z - o.z) <= GROUP) n++;
      if (n > bestCount) {
        best = o;
        bestCount = n;
      }
    }
    a.rallyX = best ? best.x : a.homeX;
    a.rallyZ = best ? best.z : a.homeZ;
  }

  // Each foe in turn: who may strike, and where the rest wait.
  for (const f of foes) {
    const fighting = members.filter((a) => a.target === f.id && a.angry > 0 && !a.afraid);
    if (!fighting.length) continue;
    const p = packOf(fighting[0])!;
    const dist = (a: Actor): number => len(a.x - f.x, a.z - f.z);

    // Whoever is already in the middle of a strike keeps its token until it's done.
    let held = 0;
    for (const a of fighting) {
      if (!holdsToken(a)) continue;
      a.token = true;
      held++;
    }
    const waiting = fighting.filter((a) => !a.token).sort((u, v) => dist(u) - dist(v));

    // An opening makes room for one more, and the nearest that has it goes first. One more in all:
    // a foe stunned for a while doesn't let a new one in every frame.
    const exposed = f.act === FOE_ACT.recover || f.act === FOE_ACT.cast || f.act === FOE_ACT.stunned;
    const opener = waiting.find((a) => dist(a) <= p.openingRange && (exposed || offFacing(f.facing, f.x, f.z, a.x, a.z) > p.backArc * DEG));
    let left = p.tokens[Math.min(fighting.length, p.tokens.length) - 1] + (opener ? 1 : 0) - held;
    if (opener && left > 0) {
      opener.token = true;
      opener.opening = true;
      left--;
    }
    for (const a of waiting) {
      if (left <= 0) break;
      if (a.token) continue;
      a.token = true;
      left--;
    }

    // The rest wait on a ring just outside the foe's reach, bunched up behind it, in the order
    // they already stand around it so nobody has to cross over.
    const ringers = waiting.filter((a) => !a.token);
    if (!ringers.length) continue;
    const radius = f.reach + p.ring;
    const back = f.facing + Math.PI;
    const around = (a: Actor): number => angleDiff(back, Math.atan2(a.x - f.x, a.z - f.z));
    ringers.sort((u, v) => around(u) - around(v));
    const n = ringers.length;
    const step = Math.min((Math.PI * 2) / n, p.spread * DEG);
    for (let i = 0; i < n; i++) {
      const angle = back + (i - (n - 1) / 2) * step;
      ringers[i].slotX = f.x + Math.sin(angle) * radius;
      ringers[i].slotZ = f.z + Math.cos(angle) * radius;
    }
  }
}
