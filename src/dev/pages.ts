// Everything an admin can reach that players can't: the developer zones (the game set up for
// trying things out) and the developer pages (galleries, harnesses, the design). One entry each;
// the Admin menu (src/ui/admin/adminMenu.ts) lists them, and the server sends /dev/ and /design/
// only to an admin's session (server/src/http.rs). A new page is an entry here and its HTML in dev/.

export type DevPageKind = 'zone' | 'page' | 'design';

export interface DevPage {
  id: string;
  kind: DevPageKind;
  /** Title Case, as the menu shows it. */
  title: string;
  /** Where it opens, on this server. */
  url: string | ((at: Pick<Location, 'protocol' | 'host'>) => string);
  /** What it's for: a sentence. */
  about: string;
  /**
   * What it needs beyond the game's own files: `dev-server` saves through the development server's
   * plugins (on beta it only shows), `battlefield` is the server's PvP battlefield (on unless the
   * server was started with --battle off).
   */
  needs?: 'dev-server' | 'battlefield';
}

export const DEV_PAGES: readonly DevPage[] = [
  { id: 'yard', kind: 'zone', title: 'The Yard', url: '/?yard', about: 'The training yard, offline: a dummy to hit, and every weapon and skill to try.' },
  { id: 'yard-goblins', kind: 'zone', title: 'Goblins in the Yard', url: '/?yard&goblins=6', about: "A goblin war-band in the yard's far corner, to fight or to watch working together." },
  {
    id: 'battlefield',
    kind: 'zone',
    title: 'The Battlefield',
    url: (at) => `/?server=${at.protocol === 'https:' ? 'wss' : 'ws'}://${at.host}`,
    about: "PvP on the server's battlefield, among thousands of bots.",
    needs: 'battlefield',
  },
  { id: 'raid', kind: 'zone', title: 'The Raid', url: '/?raid=10000', about: 'Two armies of ten thousand fighters, offline: a stress test for the crowd.' },
  {
    id: 'library',
    kind: 'page',
    title: 'Animation Library',
    url: '/dev/library.html',
    about: 'Every animated thing frame by frame: scrub, onion-skin and pose it, and leave notes on it for Claude.',
    needs: 'dev-server',
  },
  { id: 'animations', kind: 'page', title: 'Hero Animations', url: '/dev/animations.html', about: "The hero's moves one at a time, on a floor sliding at their speed." },
  { id: 'retarget', kind: 'page', title: 'Retargeting Check', url: '/dev/retarget.html', about: 'A library clip on the made hero beside its source, every bone measured against it.' },
  { id: 'creatures', kind: 'page', title: 'Creature Harness', url: '/dev/creatures.html', about: 'Close-up bodies built from their content and posed joint by joint.' },
  { id: 'species', kind: 'page', title: 'Species Harness', url: '/dev/species.html', about: 'One species at a time: its clips, its joints and a crowd of it, with the cost measured.' },
  { id: 'models', kind: 'page', title: 'Model Gallery', url: '/dev/models.html', about: 'Every model side by side, beside a figure 1.9 m tall.' },
  { id: 'buildings', kind: 'page', title: 'Buildings', url: '/dev/buildings.html', about: "The buildings you can walk into, as the game draws them: cut open, or with the rules' walls over them." },
  { id: 'bible', kind: 'design', title: 'Design Bible', url: '/design/', about: 'The design of the whole game, system by system, and where each one stands.' },
  { id: 'ui', kind: 'design', title: 'UI Design System', url: '/design/ui.html', about: "The interface's parts and rules: colours, type, windows, buttons and the writing rule." },
];

/** The address a page opens at, from the page it's opened on. */
export function devPageUrl(p: DevPage, at: Pick<Location, 'protocol' | 'host'> = location): string {
  return typeof p.url === 'string' ? p.url : p.url(at);
}
