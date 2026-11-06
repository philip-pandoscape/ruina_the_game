// The UI gallery's entries: every window of the game's interface, in the states worth seeing. Each
// is drawn by /dev/ui.html#/<window>/<state> (src/dev/ui/main.ts) on a real offline island, its
// state made up from the content (src/dev/ui/states.ts), and the content library frames it as
// #/ui/<window>/<state> (src/dev/library/galleries/ui.ts). Plain data, so the library lists them
// without bringing in the interface itself: a new window or state is an entry here and how it is
// made up in states.ts (tests/unit/uiGallery.test.ts holds the two together).

export interface UiEntry {
  /** The window, as the address names it. */
  window: string;
  /** Its state, as the address names it. */
  state: string;
  /** The window's name (Title Case): the library lists its states under it. */
  title: string;
  /** The state's (Title Case). */
  label: string;
  /** What it shows, in a sentence. */
  about: string;
}

export const UI_ENTRIES: readonly UiEntry[] = [
  { window: 'bag', state: 'start', title: 'Bag', label: 'As You Start', about: 'Your bag on a new island.' },
  { window: 'bag', state: 'full', title: 'Bag', label: 'One of Everything', about: 'A stack of the first item of each kind, and money to spare.' },
  { window: 'character', state: 'start', title: 'Character', label: 'As You Start', about: 'You, your gear and your numbers on a new island.' },
  { window: 'quests', state: 'start', title: 'Quest Log', label: 'As You Start', about: 'The quest a new island starts you on, under way.' },
  { window: 'quests', state: 'between', title: 'Quest Log', label: 'Between Quests', about: 'The opening quest handed in, and nothing taken since.' },
  {
    window: 'quests',
    state: 'under-way',
    title: 'Quest Log',
    label: 'A Quest Under Way',
    about: 'The first quest offered once the opening one is done, taken.',
  },
  { window: 'map', state: 'island', title: 'Map', label: 'The Island', about: 'The whole island, with its places and roads.' },
  { window: 'rides', state: 'none', title: 'Rides', label: 'Nothing to Ride', about: 'Before you own a ride.' },
  { window: 'rides', state: 'every-ride', title: 'Rides', label: 'Every Ride', about: 'The deed to every vehicle, and every mount, in the bag.' },
  { window: 'settings', state: 'default', title: 'Settings', label: 'As They Start', about: 'Every setting at its default.' },
  { window: 'developer', state: 'tools', title: 'Developer Tools', label: 'Tools', about: 'Gifts, time and the island, for admins.' },
  { window: 'admin', state: 'menu', title: 'Admin', label: 'Menu', about: 'The developer zones and pages, for admins.' },
  {
    window: 'talk',
    state: 'quest-giver',
    title: 'Talking',
    label: 'Someone With a Quest',
    about: 'The first townsperson with a quest for you once the opening one is done.',
  },
  { window: 'talk', state: 'merchant', title: 'Talking', label: 'A Merchant', about: 'The first townsperson who keeps a shop.' },
  { window: 'talk', state: 'crafter', title: 'Talking', label: 'A Crafter', about: 'The first townsperson who makes things for you.' },
  { window: 'shop', state: 'buy', title: 'Shop', label: 'Buying', about: "The first merchant's wares, with your bag beside them." },
  { window: 'shop', state: 'sell', title: 'Shop', label: 'Selling', about: 'What the first merchant buys, a stack of each in your bag.' },
  { window: 'shop', state: 'buyback', title: 'Shop', label: 'Buying Back', about: 'Something just sold to the first merchant, to buy back.' },
  {
    window: 'crafting',
    state: 'materials',
    title: 'Workbench',
    label: 'With the Materials',
    about: 'The first workbench, with what its first recipe takes in your bag.',
  },
  { window: 'crafting', state: 'short', title: 'Workbench', label: 'Short of Materials', about: 'The first workbench with nothing to make anything with.' },
  {
    window: 'storage',
    state: 'chest',
    title: 'Storage Chest',
    label: 'In Your House',
    about: 'The chest of a finished house of the first blueprint, a few things stored.',
  },
  { window: 'skills', state: 'book', title: 'Skills', label: 'The Skill Book', about: 'What you know, its levels and your hotbar (T).' },
  { window: 'skills', state: 'tree', title: 'Skills', label: 'The Skill Tree', about: 'What you can learn (N).' },
  { window: 'challenge', state: 'choosing', title: 'Challenge', label: 'Choosing', about: 'Challenging another player: the game and the stake.' },
  { window: 'challenge', state: 'waiting', title: 'Challenge', label: 'Waiting for an Answer', about: 'A challenge sent, with the time left to answer.' },
  {
    window: 'challenged',
    state: 'asked',
    title: 'A Challenge',
    label: 'Asked to Play',
    about: 'Another player challenges you to the first game, for a stake.',
  },
  {
    window: 'table',
    state: 'your-turn',
    title: 'At the Table',
    label: 'Your Turn',
    about: 'The first game dealt by its rules and played a few turns on, your turn.',
  },
  { window: 'table', state: 'their-turn', title: 'At the Table', label: 'Their Turn', about: 'The same game, the other player to move.' },
  { window: 'table', state: 'over', title: 'At the Table', label: 'Over', about: 'The first game played to its end by its rules.' },
  { window: 'party', state: 'frame', title: 'Party', label: 'The Party Frame', about: 'In a party of three: the others under your portrait.' },
  { window: 'party', state: 'window', title: 'Party', label: 'The Party Window', about: 'The Party window (O), you leading a party of three.' },
  { window: 'party', state: 'invited', title: 'Party', label: 'Invited', about: "Another player's invitation to their party." },
];

/** The entry `<window>/<state>` names, if there is one. */
export const uiEntry = (key: string): UiEntry | undefined => UI_ENTRIES.find((e) => `${e.window}/${e.state}` === key);
