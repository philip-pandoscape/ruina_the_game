// The pages an admin can reach that players can't (the content library, the design), and the
// players' own bible beside them. One entry each; the Admin menu (src/ui/admin/adminMenu.ts) lists
// them after the developer zones (those are content: content/instances/, `developer`), and the server
// sends /dev/ and /design/ only to an admin's session (crates/server/src/http.rs). A new page is an
// entry here and its HTML in dev/.

export type DevPageKind = 'page' | 'design';

export interface DevPage {
  id: string;
  kind: DevPageKind;
  /** Title Case, as the menu shows it. */
  title: string;
  /** Where it opens, on this server. */
  url: string;
  /** What it's for: a sentence. */
  about: string;
  /** What it needs beyond the game's own files: `dev-server` saves through the development server's plugins (on beta it only shows). */
  needs?: 'dev-server';
}

export const DEV_PAGES: readonly DevPage[] = [
  {
    id: 'library',
    kind: 'page',
    title: 'Content Library',
    url: '/dev/library.html',
    about:
      "The content library, everything the game draws in one place: every animated thing frame by frame with the game's timing (scrub, onion-skin and pose it, lay it out as a contact sheet, and leave notes on it for Claude), library clips on the hero beside their source, close-up rigs posed joint by joint, every model side by side, the buildings cut open over their walls, crowds of each species with their cost measured, and every window of the interface in made-up states.",
    needs: 'dev-server',
  },
  { id: 'bible', kind: 'design', title: 'Design Bible', url: '/design/', about: 'The design of the whole game, system by system, and where each one stands.' },
  {
    id: 'players-bible',
    kind: 'design',
    title: 'Ruina Bible',
    url: '/bible/',
    about: 'The game as players read it: every system, how it works exactly, and everything in the world. Open to everyone.',
  },
  {
    id: 'ui',
    kind: 'design',
    title: 'UI Design System',
    url: '/design/ui.html',
    about: "The interface's parts and rules: colours, type, windows, buttons and the writing rule.",
  },
];
