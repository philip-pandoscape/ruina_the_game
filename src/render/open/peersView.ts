import * as THREE from 'three';
import { MOVE } from '../../content/tuning';
import type { IslandView } from '../../engine/island';
import type { PlayerState } from '../../engine/rules';
import { Hero } from '../character';
import { SpeciesCrowd } from '../creatures/crowd';
import { HERO_TEAM_COLOURS } from '../creatures/heroBody';
import { getSpecies } from '../creatures/registry';
import type { SpeciesDef } from '../creatures/species';
import type { HouseView } from '../village/village';
import { LifeView, sitIn, type Seated } from './life';
import type { ModelKit } from './models';

// Everyone else in your channel of Emberholm, drawn: a body for each player as they move, with their
// name over their head, and their island (houses, farms, ships, vehicles, packs and glider) by a
// life view of its own. What they are doing comes from whoever keeps them (online, the world
// server's updates: src/net/worldPeers.ts), brought to the moment drawn before each frame.
//
// Up close each is a hero (src/render/character.ts: the made body, its feet planted, its hands on
// its weapon); far off, past where the wire stops sending everything about them, a crowd body (the
// hero's own poses baked, one instanced draw for all of them: src/render/creatures/crowd.ts),
// crossfading from one to the other so nobody pops.

/** Someone else here, as much of them as drawing them needs. */
export interface ShownPeer {
  readonly id: number;
  readonly name: string;
  /** Playing here now and heard from: there's someone to draw (else only what they built). */
  readonly drawn: boolean;
  /** Their state at the moment drawn. */
  readonly shown: PlayerState;
  /** What of their island everyone sees. */
  readonly life: IslandView;
  /** How far they are from you (m). */
  readonly away: number;
}

/** Whoever keeps everyone else, brought to this frame. */
export interface PeerSource {
  all(): Iterable<ShownPeer>;
}

interface Body {
  hero: Hero;
  view: LifeView;
  label: THREE.Sprite;
  /** The side their colours show (0 until a developer zone puts them on another). */
  team: number;
  /** 0 drawn as a hero up close, 1 as a crowd body; between, fading from one to the other. */
  crowd: number;
  /** Drawn in the crowd this frame. */
  inCrowd: boolean;
  /** Which it's going toward: the crowd body (far off) or the hero. */
  far: boolean;
  /** The hero has been faded once (its materials fade from then on). */
  faded: boolean;
  /** How far into the crowd body's clip (seconds). */
  clipTime: number;
}

/**
 * Past `from` metres from you someone is drawn as a crowd body, and within `within` as a hero again:
 * the wire for crowds sends everything about them within 40 m (crates/wire interest NEAR), and a
 * margin either way keeps anyone at the edge from flickering between the two. The switch takes
 * `seconds`, the one fading out as the other fades in.
 */
export const CROWD_AT = { from: 42, within: 38, seconds: 0.35 };

/** Toward `to` by at most `step`. */
const toward = (v: number, to: number, step: number): number => (v < to ? Math.min(to, v + step) : Math.max(to, v - step));

/** Riding along in someone else's vehicle. */
const along = (p: ShownPeer): boolean => p.shown.mode === 'ride' && !!p.shown.host;

/**
 * Names over other players, by their distance from you in metres: whole within `fullWithin`, fading
 * out to nothing by `goneBy`, where the townsfolk's names go too (an MMO's range: the people around
 * you are named, a crowd far off isn't a cloud of names). From you rather than the camera, so the
 * crew beside you stay named when the camera pulls back behind a boat. Past `shrinkFrom` they also
 * shrink a little, to `farScale` of their size by `goneBy`, so a far name looks far.
 */
const NAME_PLATE = { fullWithin: 30, goneBy: 45, shrinkFrom: 10, farScale: 0.8 };
/** A name plate's height as a sprite's scale, which without size attenuation is a size on screen. */
const PLATE_HEIGHT = 0.04;

export class PeersView {
  private bodies = new Map<number, Body>();
  /** Everyone drawn far off, one instance each (made when first needed, bigger when outgrown). */
  private crowd: SpeciesCrowd | null = null;
  private species: SpeciesDef | null = null;
  private clips = new Map<string, number>();
  /** How many crowd bodies were drawn last frame. */
  private crowded = 0;
  /** Called when the ground under someone's new farm or house needs its grass cleared. */
  onGroundChanged: (() => void) | null = null;
  /** What draws your own vehicles, for anyone riding along in one of them. */
  mineView: LifeView | null = null;
  /** Where someone sits at a mini-game's table, if they're at one (src/render/open/gameTables.ts). */
  stoolFor: ((id: number) => Seated | null) | null = null;
  /** Where everyone's houses are drawn (the island's Village), by owner. */
  houseSink: ((owner: string, houses: HouseView[]) => void) | null = null;

  /** `me`: your own id, for anyone riding along with you. */
  constructor(
    private scene: THREE.Scene,
    private models: ModelKit,
    private source: PeerSource,
    private me: number,
  ) {}

  /** How much of someone's name plate shows (0 hidden, 1 whole), for tests. */
  plate(id: number): number {
    const b = this.bodies.get(id);
    return b?.label.visible && b.hero.root.visible ? +(b.label.material as THREE.SpriteMaterial).opacity.toFixed(3) : 0;
  }

  /** How far the farm ground drawn for anyone here stands over the terrain within `pad` metres of (x, z) (LifeView.raisedAt). */
  raisedAt(x: number, z: number, pad: number): number {
    let top = 0;
    for (const b of this.bodies.values()) top = Math.max(top, b.view.raisedAt(x, z, pad));
    return top;
  }

  /** Where you sit riding along in someone's vehicle this frame (theirs is placed by frame(), so call that first). */
  seatFor(you: PlayerState): Seated | null {
    if (you.mode !== 'ride' || !you.host) return null;
    return this.bodies.get(you.host)?.view.seatOf(you.vehicle, you.seat) ?? null;
  }

  private body(p: ShownPeer): Body {
    let b = this.bodies.get(p.id);
    if (b) return b;
    const hero = new Hero();
    hero.root.visible = false;
    this.scene.add(hero.root);
    const view = new LifeView(this.scene, p.life, this.models, hero, { others: true });
    view.onGroundChanged = () => this.onGroundChanged?.();
    view.houseSink = (houses) => this.houseSink?.(`peer:${p.id}`, houses);
    const label = nameTag(p.name);
    label.position.set(0, 2.45, 0);
    hero.root.add(label);
    b = { hero, view, label, team: 0, crowd: 0, inCrowd: false, far: false, faded: false, clipTime: 0 };
    this.bodies.set(p.id, b);
    return b;
  }

  /** How someone is drawn right now (tests): as a hero, a crowd body, both (fading) or not at all, and how far toward the crowd body. */
  look(id: number): { body: 'hero' | 'crowd' | 'both' | 'none'; crowd: number } {
    const b = this.bodies.get(id);
    if (!b) return { body: 'none', crowd: 0 };
    const hero = b.hero.root.visible;
    return { body: hero && b.inCrowd ? 'both' : hero ? 'hero' : b.inCrowd ? 'crowd' : 'none', crowd: +b.crowd.toFixed(3) };
  }

  /** How many crowd bodies were drawn last frame (tests). */
  get crowdBodies(): number {
    return this.crowded;
  }

  /** Draws everyone as they are this frame. */
  frame(dt: number, frame: number, cameraPos: THREE.Vector3): void {
    // Whoever drives (or walks) first, then whoever rides along with them: a vehicle has to be
    // where it is this frame before anyone sits down in it.
    const order = [...this.source.all()].sort((a, b) => Number(along(a)) - Number(along(b)));
    let n = 0;
    for (const p of order) {
      const b = this.body(p);
      // Riding, or at a mini-game's table, always up close: a crowd body has no seat to sit in.
      const seated = p.shown.mode === 'ride' || !!this.stoolFor?.(p.id);
      if (seated || p.away < CROWD_AT.within) b.far = false;
      else if (p.away > CROWD_AT.from) b.far = true;
      b.crowd = seated ? 0 : toward(b.crowd, b.far ? 1 : 0, dt / CROWD_AT.seconds);
      if (p.drawn && b.crowd < 1) {
        this.pose(p, b, dt, frame);
        if (b.crowd > 0 || b.faded) {
          b.faded = true;
          b.hero.setFade(1 - b.crowd);
        }
      } else b.hero.root.visible = false;
      b.inCrowd = p.drawn && b.crowd > 0;
      if (b.inCrowd) this.crowdBody(n++, p, b, dt);
      b.view.update(p.shown, dt, cameraPos);
      plateFor(b.label, p.away);
    }
    this.crowded = n;
    if (this.crowd) {
      this.crowd.setCount(n);
      this.crowd.flush();
    }
  }

  /** Someone far off as crowd body `i`: where they are, what they're doing, their side, how much shows. */
  private crowdBody(i: number, p: ShownPeer, b: Body, dt: number): void {
    const crowd = this.crowdFor(i + 1);
    const sh = p.shown;
    crowd.place(i, sh.pos.x, sh.pos.y, sh.pos.z, sh.facing);
    const clip = (name: string) => this.clips.get(name) ?? 0;
    // The crowd's clips are the hero's poses baked (src/render/creatures/heroBody.ts HERO_CLIPS), 30
    // to a second, a swing's and a cast's a frame of theirs to a frame of the clip's.
    let at = clip('idle');
    let seconds = 0;
    if (sh.downFrame >= 0) at = clip('down');
    else if (sh.mode === 'attack' && sh.attackFrame >= 0 && this.clips.has(`attack${sh.attackIndex + 1}`)) {
      at = clip(`attack${sh.attackIndex + 1}`);
      seconds = sh.attackFrame / 30;
    } else if (sh.mode === 'cast') {
      at = clip('cast');
      seconds = Math.min(Math.max(0, sh.castFrame), 47) / 30;
    } else if (!sh.grounded && sh.mode !== 'swim' && sh.mode !== 'glide') at = clip('air');
    else {
      // Walking, running or sprinting by the pace, the clip played as fast as they cover the ground.
      const speed = Math.hypot(sh.vel.x, sh.vel.z);
      const gait =
        speed < 0.3
          ? null
          : speed < MOVE.runSpeed * 0.7
            ? { name: 'walk', pace: 0.43 }
            : sh.sprinting
              ? { name: 'sprint', pace: 1.4 }
              : { name: 'run', pace: 1 };
      at = clip(gait?.name ?? 'idle');
      b.clipTime += dt * (gait ? speed / (gait.pace * MOVE.runSpeed) : 1);
      seconds = b.clipTime;
    }
    crowd.animate(i, at, seconds, sh.team === 1 ? 1 : 0);
    if (crowd.fade) crowd.fade[i] = b.crowd;
  }

  /** The crowd, with room for at least `n`. */
  private crowdFor(n: number): SpeciesCrowd {
    if (this.crowd && this.crowd.capacity >= n) return this.crowd;
    this.species ??= getSpecies('hero');
    this.species.clips.forEach((c, i) => {
      this.clips.set(c.name, i);
    });
    const old = this.crowd;
    const crowd = new SpeciesCrowd(this.species, Math.max(64, (old?.capacity ?? 0) * 2, n), {
      fade: true,
      palette: { teamA: HERO_TEAM_COLOURS[0].tunic, teamB: HERO_TEAM_COLOURS[1].tunic },
    });
    if (old) {
      // What the old one was given this frame carries over.
      crowd.root.set(old.root);
      crowd.pose.set(old.pose);
      if (old.fade && crowd.fade) crowd.fade.set(old.fade);
      this.scene.remove(old.group);
      old.dispose();
    }
    this.scene.add(crowd.group);
    this.crowd = crowd;
    return crowd;
  }

  private pose(p: ShownPeer, b: Body, dt: number, frame: number): void {
    const sh = p.shown;
    // Sides are a developer zone's: there, everyone wears their side's colours.
    if (sh.team !== b.team) {
      b.team = sh.team;
      b.hero.setTeam(sh.team);
    }
    // Driving, their vehicle goes under them; riding along, they sit in whoever's it is; at a
    // mini-game's table, on its stool.
    const host = sh.host === this.me ? this.mineView : this.bodies.get(sh.host)?.view;
    const stool = this.stoolFor?.(p.id) ?? null;
    sitIn(b.hero, stool ?? (sh.mode === 'ride' && sh.host ? (host?.seatOf(sh.vehicle, sh.seat) ?? null) : b.view.placeRide(sh, 1, null, dt)));
    b.hero.root.visible = true;
    b.hero.update(stool ? { ...sh, mode: 'ride' } : sh, 1, frame);
  }
}

/** A name over someone's head, on a canvas as wide as the name, so a long one isn't cut off. */
function nameTag(name: string): THREE.Sprite {
  const font = 'bold 30px system-ui, -apple-system, "Segoe UI", sans-serif';
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  g.font = font;
  // Room either side for the outline.
  c.width = Math.max(64, Math.ceil(g.measureText(name).width) + 24);
  c.height = 64;
  // Sizing the canvas resets how it draws.
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(20, 30, 40, 0.85)';
  g.strokeText(name, c.width / 2, 32);
  g.fillStyle = '#ffffff';
  g.fillText(name, c.width / 2, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // The same size on screen at any distance, crisp and easy to read, until it is far enough away
  // to shrink a little and fade (plateFor).
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true, sizeAttenuation: false }));
  sprite.userData.aspect = c.width / c.height;
  sprite.scale.set(PLATE_HEIGHT * sprite.userData.aspect, PLATE_HEIGHT, 1);
  sprite.renderOrder = 5;
  return sprite;
}

/** Fades and sizes a name plate for how far its player is from you, in metres (NAME_PLATE). */
function plateFor(label: THREE.Sprite, distance: number): void {
  const { fullWithin, goneBy, shrinkFrom, farScale } = NAME_PLATE;
  const t = Math.min(1, Math.max(0, (distance - fullWithin) / (goneBy - fullWithin)));
  const shown = 1 - t * t * (3 - 2 * t);
  label.visible = shown > 0.01;
  (label.material as THREE.SpriteMaterial).opacity = shown;
  const k = 1 - (1 - farScale) * Math.min(1, Math.max(0, (distance - shrinkFrom) / (goneBy - shrinkFrom)));
  label.scale.set(PLATE_HEIGHT * label.userData.aspect * k, PLATE_HEIGHT * k, 1);
}
