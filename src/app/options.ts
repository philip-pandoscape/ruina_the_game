// Every option the game's page reads from its address, in one place: what each does, and whether
// it's for players or for developers and the tests (players never need any). Read once, at start.
// The developer pages (dev/) read options of their own, documented in their modules; so do the
// hero's made body and weapons (src/render/detail/madeHero.ts, madeWeapons.ts, moves.ts: trying a
// body, a weapon or a set of moves without shipping it), which the animation work owns.

/** An option, as the list below documents it. */
interface OptionDoc {
  name: string;
  what: string;
  developer: boolean;
  /** Read by another module, not readOptions: the look reads its own (the developer pages share it). */
  readBy?: string;
}

/** Every option of the game's page (`?name` or `&name=value`). */
export const OPTION_DOCS: readonly OptionDoc[] = [
  {
    name: 'test',
    what: 'Starts paused and offline, so automated tests step the game frame by frame: the yard, unless world is given too, or test=<instance> in a copy of that instance (test=yard, test=goblinCamp).',
    developer: true,
  },
  { name: 'offline', what: 'Plays offline in real time: the open world, or offline=<instance> in a copy of that instance.', developer: true },
  { name: 'world', what: 'With test: the open world, offline and paused, instead of the yard.', developer: true },
  { name: 'load', what: 'With world and test: the island kept in this browser (bug-report replays).', developer: true },
  { name: 'yard', what: 'The training yard, offline.', developer: true },
  {
    name: 'fixture=world',
    what: "Offline, a fixture world of the tests' in place of the shipped one (tests/fixtures/world/<name>.json: world, three regions; far, a region 102 km out), on a development server.",
    developer: true,
  },
  { name: 'goblins=6', what: "With yard: a war-band of that many goblins in the yard's far corner (up to 24).", developer: true },
  { name: 'lag=150', what: "Delays this page's connection by that many milliseconds each way, to feel a far server.", developer: true },
  { name: 'softlock=0', what: 'No automatic pick of a target to face (Tab still picks one).', developer: true },
  { name: 'as=name', what: 'On a development server: signs straight in as that name and plays its last character.', developer: true },
  { name: 'fresh', what: 'Starts your island over.', developer: true },
  {
    name: 'quality=low|medium|high',
    what: 'How much of the look to draw, instead of what the graphics chip picks.',
    developer: false,
    readBy: 'src/render/look.ts',
  },
  { name: 'lookdebug=ao', what: 'Shows the ambient occlusion alone.', developer: true, readBy: 'src/render/look.ts' },
  { name: 'bugs=0', what: 'No bug reporter (\\ records a bug report; with test it is off unless bugs is given).', developer: true },
  { name: 'bugspeech=0', what: 'Bug reports without live transcription.', developer: true },
  { name: 'buglang=en-GB', what: "The bug reporter's transcription language (else the browser's).", developer: true },
];

export interface Options {
  /** Paused for automated tests, stepped frame by frame. */
  test: boolean;
  /** The training yard (also what test opens, unless world or an instance is given). */
  yard: boolean;
  /** Offline in real time (`?offline`). */
  offline: boolean;
  /** Offline, the instance to start in a copy of (`?test=<id>`, `?offline=<id>`); null in the world. */
  space: string | null;
  /** Emberholm, the open world. */
  openWorld: boolean;
  /** A war-band in the yard (`?goblins=`: that many goblins). */
  band?: { kind: string; count: number };
  /** Milliseconds added each way to this page's connection. */
  lag: number;
  softLock: boolean;
  /** A development server's sign-in by name. */
  as: string | null;
  fresh: boolean;
  /** The island kept in this browser (offline, tests). */
  load: boolean;
  /** A fixture world of the tests' to play in place of the shipped one (`?fixture=`), offline. */
  fixture: string | null;
  /** Whether the bug reporter is on. */
  bugs: boolean;
  bugSpeech: boolean;
  bugLang: string | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The options in `search` (the page's own address by default). */
/** `?goblins=`'s war-band: that many of the goblins' kind, or none. */
const bandOf = (count: number): Options['band'] => (count > 0 ? { kind: 'goblin', count } : undefined);

export function readOptions(search: string = typeof location === 'undefined' ? '' : location.search): Options {
  const q = new URLSearchParams(search);
  const test = q.has('test');
  const space = q.get('test') || q.get('offline') || null;
  const yard = q.has('yard') || (test && !q.has('world') && !space);
  return {
    test,
    yard,
    offline: q.has('offline'),
    space,
    openWorld: !yard,
    band: bandOf(yard ? clamp(Math.floor(Number(q.get('goblins')) || 0), 0, 24) : 0),
    lag: clamp(Number(q.get('lag')) || 0, 0, 2000),
    softLock: q.get('softlock') !== '0',
    as: q.get('as'),
    fresh: q.has('fresh'),
    load: q.has('load'),
    fixture: q.get('fixture'),
    bugs: test ? q.has('bugs') : q.get('bugs') !== '0',
    bugSpeech: q.get('bugspeech') !== '0',
    bugLang: q.get('buglang'),
  };
}
