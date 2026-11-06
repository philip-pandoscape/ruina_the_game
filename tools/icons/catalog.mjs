// Every icon the UI paints, nine to a sheet. Each icon has a name (its file, and what uiIcon() asks
// for), the emoji content names it by (`emoji`), the items it stands for where an item needs its own
// picture (`items`), and what to paint (`paint`). tools/icons/paint.mjs paints a sheet with Gemini;
// tools/icons/bake.mjs cuts the sheets into the game's icons.

/** How every sheet is painted. `{BG}` is the sheet's background colour. */
export const STYLE = `Art style: hand-painted digital fantasy game icons in the tradition of classic MMORPG inventory icons. Confident painterly brushwork, rich but natural colours, soft volumetric shading, a warm golden key light from the upper left and a cool bounce light from the lower right, crisp specular highlights on metal, glass and gems. Every object has a clean dark-brown inked contour of even weight, so it stays readable when shrunk to 32 pixels. Bold, simple, instantly readable silhouettes with slightly chunky proportions, in a pleasing three-quarter view. Each object is centred in its cell and fills about 80 percent of it, never touching the cell's edges or its neighbours. The icons will sit on warm parchment and dark timber in a medieval fantasy interface, so favour warm tones and avoid neon colours.

Background: one perfectly flat, uniform, pure {BG} behind everything, filling every cell: it will be keyed out, so it must be exactly this colour, whatever the reference uses. The cells are not drawn: no tiles, panels or squares of any other colour behind the objects. No gradient, no texture, no vignette, no floor, no cast shadows, no glow or haze spilling onto the background. No grid lines, no borders, no frames, no plates or circles behind the objects. No text, letters, numbers or watermark anywhere, apart from any symbol a cell asks for.`;

export const BACKGROUNDS = { magenta: { css: 'magenta (#FF00FF)', rgb: [255, 0, 255] }, green: { css: 'chroma green (#00FF00)', rgb: [0, 255, 0] } };

/** Painted with the first sheet as the reference for the rest, so they all match. */
export const STYLE_SHEET = 'vitals';

/** Columns and rows of a sheet of n icons. */
export const gridOf = (n) => {
  const cols = Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
};

export const SHEETS = [
  {
    id: 'vitals',
    bg: 'magenta',
    icons: [
      { name: 'heart', paint: 'a plump glossy crimson heart, like a polished ruby, with a bright highlight on its upper left' },
      { name: 'mana', paint: 'a single plump teardrop of glowing sapphire-blue liquid with a white highlight' },
      { name: 'stamina', paint: 'a golden-yellow leather boot with a small white feathered wing at its heel' },
      { name: 'labor', emoji: ['⚡'], paint: 'a jagged lightning bolt of glowing gold with an orange-hot core' },
      { name: 'seal', paint: 'a round crimson wax seal stamped with a small golden sunburst, with two short blue silk ribbon tails hanging beneath it' },
      { name: 'coin-gold', paint: 'a single thick gold coin in three-quarter view, embossed with a crown, with a milled rim and a bright shine' },
      { name: 'coin-silver', paint: 'the same coin struck in bright silver' },
      { name: 'coin-copper', paint: 'the same coin struck in warm reddish copper' },
      { name: 'star', paint: 'a faceted five-pointed golden star with a small white sparkle' },
    ],
  },
  {
    id: 'menu',
    bg: 'magenta',
    icons: [
      { name: 'bag', paint: 'a brown leather drawstring pouch, plump and tied shut with a cord' },
      { name: 'helm', emoji: ['🪖'], paint: "a polished steel knight's helmet with a visor slit and brass trim, turned three-quarters to the left" },
      { name: 'scroll', emoji: ['📜'], paint: 'a partly unrolled parchment scroll covered in lines of brown ink handwriting' },
      { name: 'map', paint: 'a folded parchment map showing a small island coast, a dotted red trail and a red X' },
      { name: 'wheel', paint: 'a wooden cart wheel with eight spokes, an iron tyre and an iron hub, seen straight on' },
      { name: 'gear', paint: 'a single brass cogwheel with eight teeth and a round hole in its centre, seen straight on' },
      { name: 'quest-new', paint: 'a chunky exclamation mark sculpted from polished gold (the symbol is the whole icon)' },
      { name: 'quest-done', paint: 'a chunky question mark sculpted from polished gold (the symbol is the whole icon)' },
      { name: 'talk', paint: 'a speech bubble of cream parchment with three small dark dots in it' },
    ],
  },
  {
    id: 'signs',
    bg: 'magenta',
    icons: [
      { name: 'lock', paint: 'a small closed iron padlock' },
      { name: 'craft', paint: "a blacksmith's hammer resting on a small iron anvil" },
      { name: 'check', emoji: ['✔️'], paint: 'a bold check mark painted in glossy emerald green (the symbol is the whole icon)' },
      { name: 'cottage', emoji: ['🏡', '🏠'], paint: 'a small timber-framed cottage with a red tiled roof and a chimney' },
      { name: 'wave', emoji: ['🌊'], paint: 'a curling blue sea wave with white foam' },
      { name: 'rain', emoji: ['🌧️'], paint: 'a grey rain cloud with blue raindrops falling from it' },
      { name: 'sunrise', emoji: ['🌅'], paint: 'a golden sun half risen over a green hill, with short rays' },
      { name: 'sun', emoji: ['☀️'], paint: 'a bright golden sun with short wavy rays' },
      { name: 'moon', emoji: ['🌙'], paint: 'a pale silver crescent moon with a sharp, blade-like inner edge' },
    ],
  },
  {
    id: 'places',
    bg: 'magenta',
    icons: [
      { name: 'sun-cloud', emoji: ['🌤️'], paint: 'a golden sun peeking out from behind a fluffy white cloud' },
      { name: 'dunes', emoji: ['🏜️'], paint: 'two rippled golden sand dunes with a small green cactus' },
      { name: 'snowflake', emoji: ['❄️'], paint: 'a crystalline ice-blue snowflake' },
      { name: 'scales', emoji: ['⚖️'], paint: "a pair of brass merchant's balance scales" },
      { name: 'pickaxe', emoji: ['⛏️'], paint: 'an iron pickaxe with a wooden handle' },
      { name: 'beach', emoji: ['🏖️'], paint: 'a spiral seashell and an orange starfish on a small patch of golden sand' },
      { name: 'lantern', emoji: ['🏮'], paint: 'an iron lantern glowing with warm amber candlelight' },
      { name: 'slime', emoji: ['🟢'], paint: 'a glossy translucent green jelly slime with two dark dot eyes' },
      { name: 'anchor', emoji: ['⚓'], paint: "an iron ship's anchor with a coil of rope" },
    ],
  },
  {
    id: 'produce',
    bg: 'magenta',
    icons: [
      { name: 'sunroot', emoji: ['🥔'], paint: 'three golden sunroot tubers, like smooth golden potatoes with a faint sunny glow' },
      { name: 'barley', emoji: ['🌾'], paint: 'a sheaf of golden bearded barley tied with twine' },
      { name: 'flax', emoji: ['💠'], paint: 'a bundle of pale green-gold flax stalks tied with string, topped with small sky-blue flowers' },
      { name: 'emberberry', emoji: ['🍒'], paint: 'a cluster of glossy ember-red berries with a faint orange glow inside, on a sprig with two leaves' },
      { name: 'apple', emoji: ['🍎'], paint: 'a shiny red apple with a short stem and one leaf' },
      { name: 'egg', emoji: ['🥚'], paint: "two brown hen's eggs on a little nest of straw" },
      { name: 'milk', emoji: ['🥛'], paint: 'a small earthenware jug brimming with fresh white milk' },
      { name: 'wool', emoji: ['🧶'], paint: 'a fluffy ball of cream wool yarn with a loose strand' },
      { name: 'herbs', emoji: ['🌿'], paint: 'a bunch of fresh green wild herbs tied with twine' },
    ],
  },
  {
    id: 'materials',
    bg: 'magenta',
    icons: [
      { name: 'lumber', emoji: ['🪵'], paint: 'a small stack of rough-sawn timber planks and a log, tied with rope' },
      { name: 'stone', emoji: ['🪨'], paint: 'a small pile of pale grey quarry stones' },
      { name: 'iron-ore', emoji: ['⛓️'], paint: 'a chunk of dark iron ore streaked with rust and glinting metal flecks' },
      { name: 'thunder-log', items: ['thunderLog'], paint: 'a split log blackened by lightning, with glowing blue electric cracks along it' },
      { name: 'tonic', emoji: ['🧪'], paint: 'a corked round glass flask of glowing amber tonic' },
      { name: 'scarecrow', emoji: ['🧑‍🌾'], paint: 'a scarecrow on a wooden post with a straw hat, a patched shirt and straw poking out' },
      { name: 'blueprint', items: ['blueprint.cottage'], paint: 'a rolled-up deep blue blueprint with white plan lines of a cottage, tied with a red ribbon' },
      { name: 'ship-design', emoji: ['📐'], paint: "a parchment sheet with an ink drawing of a sailing ship's hull, with a brass set square lying across it" },
      { name: 'sprout', emoji: ['🌱'], paint: 'a small green seedling sprouting from a clump of dark soil' },
    ],
  },
  {
    id: 'seeds',
    bg: 'magenta',
    icons: [
      { name: 'seed-sunroot', items: ['seed.sunroot'], paint: 'a small burlap seed sack tied with twine, with a golden sunroot tuber leaning against it' },
      { name: 'seed-barley', items: ['seed.barley'], paint: 'the same small burlap seed sack, with ears of golden barley tucked into its tie' },
      { name: 'seed-flax', items: ['seed.flax'], paint: 'the same small burlap seed sack, with a sprig of sky-blue flax flowers tucked into its tie' },
      { name: 'seed-emberberry', items: ['seed.emberberry'], paint: 'the same small burlap seed sack, with a sprig of ember-red berries tucked into its tie' },
      { name: 'apple-sapling', items: ['sapling.apple'], paint: 'a young apple sapling with a few leaves and one small red apple, its roots wrapped in a burlap ball' },
      { name: 'pine-sapling', items: ['sapling.pine'], paint: 'a young pine sapling, its roots wrapped in a burlap ball' },
      { name: 'pine', emoji: ['🌲'], paint: 'a tall dark-green pine tree' },
      { name: 'oak', emoji: ['🌳'], paint: 'a broad leafy oak tree with strong roots spreading at its base' },
      { name: 'chick', emoji: ['🐣'], paint: 'a fluffy yellow chick hatching from a cracked egg' },
    ],
  },
  {
    id: 'animals',
    bg: 'magenta',
    icons: [
      { name: 'cow', emoji: ['🐄'], paint: 'a black-and-white dairy cow standing in three-quarter view' },
      { name: 'calf', emoji: ['🐮'], paint: 'the head of a young brown-and-white calf with a little bell on a strap' },
      { name: 'sheep', emoji: ['🐑'], paint: 'a fluffy white sheep with a dark face, standing' },
      { name: 'lamb', items: ['animal.lamb'], paint: 'a small fluffy white lamb, lying down' },
      { name: 'hen', emoji: ['🐔'], paint: 'a plump red-brown hen' },
      { name: 'horse', emoji: ['🐎'], paint: 'the head and neck of a chestnut horse with a leather bridle' },
      { name: 'donkey', emoji: ['🫏'], paint: 'the head of a grey donkey with long ears and a rope halter' },
      { name: 'fish', emoji: ['🐟'], paint: 'a silver-blue fish curving as if leaping' },
      { name: 'wolf', emoji: ['🐺'], paint: 'the head of a grey wolf, snarling' },
    ],
  },
  {
    id: 'vehicles',
    bg: 'magenta',
    icons: [
      { name: 'farm-cart', emoji: ['🚜'], paint: 'a wooden farm cart painted green with cream trim and red spoked wheels, a small red pennant at the back, side view facing left' },
      { name: 'roadster', emoji: ['🏎️'], paint: 'a low open-top two-seat steam roadster with no windscreen, painted red, with brass headlamps and red spoked wheels, side view facing left' },
      { name: 'hauler', emoji: ['🚚'], paint: 'a heavy steam truck painted dark green with cream trim, a black boiler and a smokestack puffing white steam, red spoked wheels and a cargo bed, side view facing left' },
      { name: 'rowboat', emoji: ['🚣'], paint: 'a small white rowboat with blue stripes and a pair of wooden oars' },
      { name: 'sloop', emoji: ['⛵'], paint: 'a single-masted sloop with a yellow and teal hull and a cream sail with a red top band' },
      { name: 'cog', emoji: ['🚢'], paint: 'a broad-beamed medieval merchant cog with a brown wooden hull, a raised stern castle and a square red-and-cream striped sail' },
      { name: 'wayfarer', emoji: ['🪁'], paint: 'a hang glider, a flying contraption and not a bird: one broad triangular wing of patched cream canvas stretched over a light wooden frame, with a wooden control bar hanging beneath it, seen from slightly below and in front' },
      { name: 'swiftwing', items: ['glider.swiftwing'], paint: "a sleek racing hang glider, a flying contraption and not a bird: one narrow swept-back wing of canvas striped brown and white like a hawk's feathers, on a dark wooden frame with a control bar beneath it, seen from slightly below and in front" },
      { name: 'eagle', emoji: ['🦅'], paint: 'a golden eagle with its wings spread, in flight' },
    ],
  },
  {
    id: 'packs',
    bg: 'magenta',
    icons: [
      { name: 'crate', emoji: ['📦'], paint: 'a wooden crate with iron corner brackets' },
      { name: 'fittings', emoji: ['🔩'], paint: 'a small pile of iron bolts, nails and a hinge bracket' },
      { name: 'cask', emoji: ['🛢️'], paint: 'a wooden cider cask lying on its side, with iron hoops and a brass tap' },
      { name: 'preserves', emoji: ['🫙'], paint: 'a glass jar of red berry preserves with a cloth cover tied with string' },
      { name: 'stone-block', emoji: ['🧱'], paint: 'a neatly cut rectangular block of pale stone' },
      { name: 'sailcloth', emoji: ['🧵'], paint: 'a folded bolt of cream canvas sailcloth tied with rope' },
      { name: 'basket', emoji: ['🧺'], paint: 'a woven wicker hamper with a lid and a handle' },
      { name: 'castle', emoji: ['🏰'], paint: 'a round stone castle tower with battlements and a red banner' },
      { name: 'burst', emoji: ['💥'], paint: 'a bright orange and yellow starburst explosion with flying wooden splinters' },
    ],
  },
  {
    id: 'weapons',
    bg: 'magenta',
    icons: [
      { name: 'sword', emoji: ['🗡️'], paint: 'a steel arming sword with a leather-wrapped grip and a brass crossguard, pointing up and to the right' },
      { name: 'mallet', emoji: ['🔨'], paint: 'a heavy wooden war mallet with an iron-banded head, pointing up and to the right' },
      { name: 'staff', emoji: ['🪄'], paint: "a gnarled wooden mage's staff topped with a glowing blue orb, leaning up and to the right" },
      { name: 'bow', emoji: ['🏹'], paint: 'a wooden longbow with an arrow nocked on its string' },
      { name: 'shield', emoji: ['🛡️'], paint: 'a round wooden shield with an iron rim and a central iron boss' },
      { name: 'swords', emoji: ['⚔️'], paint: 'two crossed steel swords' },
      { name: 'tunic', emoji: ['👕'], paint: 'a simple linen tunic with a laced collar' },
      { name: 'gloves', emoji: ['🧤'], paint: 'a pair of brown leather gloves' },
      { name: 'trousers', emoji: ['👖'], paint: 'a pair of brown wool trousers' },
    ],
  },
  {
    id: 'blades',
    bg: 'magenta',
    icons: [
      { name: 'boots', emoji: ['🥾'], paint: 'a pair of sturdy brown leather boots' },
      { name: 'backstep', emoji: ['↩️'], paint: 'a leather boot stepping backwards, with a curved white arrow sweeping back behind it' },
      { name: 'slide', emoji: ['🏂'], paint: 'a leather boot sliding forward low over the ground, kicking up a spray of dust' },
      { name: 'dodge-roll', emoji: ['🤼'], paint: 'a hooded adventurer tucked into a forward roll, with a white swirl of motion around them' },
      { name: 'riposte', emoji: ['🤺'], paint: 'two crossed fencing rapiers with a bright spark where their blades meet' },
      { name: 'whirlwind', emoji: ['🌀'], paint: 'a swirling vortex of white wind with a steel sword blade spinning in it' },
      { name: 'wide-arc', emoji: ['🌪️'], paint: 'a sword sweeping through a wide silver crescent of motion' },
      { name: 'bladestorm', emoji: ['🌟'], paint: 'a ring of silver sword blades whirling around a bright golden spark' },
      { name: 'whirling-steel', emoji: ['🎖️'], paint: 'a single steel sword spinning end over end, with circular motion streaks' },
    ],
  },
  {
    id: 'archery',
    bg: 'magenta',
    icons: [
      { name: 'quick-draw', emoji: ['⏱️'], paint: 'a brass pocket stopwatch with an arrow laid across it' },
      { name: 'target', emoji: ['🎯'], paint: 'a round straw archery target with red and white rings and an arrow in the bullseye' },
      { name: 'rapid-fire', emoji: ['💨'], paint: 'three arrows flying side by side with white speed streaks behind them' },
      { name: 'fletcher', emoji: ['🪶'], paint: 'a white feather beside an arrow with white fletching' },
      { name: 'deadeye', emoji: ['👁️'], paint: 'a piercing golden eye with a sharp black pupil' },
      { name: 'light-feet', emoji: ['🐾'], paint: 'a trail of light paw prints with a small white feather' },
      { name: 'iron-wrists', emoji: ['💪'], paint: 'a steel-banded leather bracer' },
      { name: 'rally', emoji: ['📯'], paint: 'a brass war horn with a red cord' },
      { name: 'healing', emoji: ['💚'], paint: 'a glowing green heart inside a ring of soft green light' },
    ],
  },
  {
    id: 'fire',
    bg: 'green',
    icons: [
      { name: 'meteor', emoji: ['☄️'], paint: 'a flaming meteor streaking down towards the lower left with a fiery tail' },
      { name: 'kindling', emoji: ['🔥'], paint: 'a lively orange campfire flame' },
      { name: 'wildfire', emoji: ['🎇'], paint: 'a burst of fiery sparks spreading outward' },
      { name: 'ember-heart', emoji: ['🌋'], paint: 'a small volcano erupting glowing orange lava' },
      { name: 'ash', emoji: ['🌫️'], paint: 'a billowing cloud of grey ash with glowing orange embers' },
      { name: 'pyreborn', emoji: ['🐉'], paint: 'the horned head of a small red dragon in profile, breathing a short burst of fire; the whole head and the flame sit well inside the cell' },
      { name: 'glass-cannon', emoji: ['🔮'], paint: 'a violet crystal ball glowing with arcane light, on a small bronze stand' },
      { name: 'focused-mind', emoji: ['🧠'], paint: 'a pale blue glowing brain wreathed in faint arcane sparks' },
      { name: 'menders-grace', emoji: ['🕊️'], paint: 'a white dove with its wings spread' },
    ],
  },
  {
    id: 'extra',
    bg: 'magenta',
    icons: [
      { name: 'mending', emoji: ['✨'], paint: 'a cluster of golden and pale green four-pointed sparkles' },
      { name: 'warm-hands', emoji: ['🤲'], paint: 'two cupped hands holding a small warm golden light' },
      { name: 'lifebinder', emoji: ['🧿'], paint: 'a round blue glass ward amulet with a white and dark blue eye, on a leather cord' },
      { name: 'sanctuary', emoji: ['🔷'], paint: 'a glowing blue diamond-shaped crystal ward' },
      { name: 'quest-active', paint: 'a chunky question mark carved from dull grey pewter (the symbol is the whole icon)' },
      { name: 'coins', paint: 'a small stack of gold coins with one more gold coin leaning against it' },
      { name: 'book', paint: 'a thick leather-bound spellbook with brass corners and a red ribbon bookmark' },
      { name: 'compass', paint: "a brass traveller's compass, open, with a red needle" },
      { name: 'flag', paint: 'a small red pennant flag on a short wooden pole planted in a tuft of grass' },
    ],
  },
  {
    // Parties, and Goblin's Dread (.plans/dungeons/goblin-dread).
    id: 'dungeons',
    bg: 'magenta',
    icons: [
      { name: 'party', emoji: ['👥'], paint: 'three adventurers shown as head-and-shoulders busts standing close together and overlapping a little: a knight in a steel helm in front, a hooded ranger in green to the left and a mage in a blue pointed hat to the right' },
      { name: 'crown', emoji: ['👑'], paint: 'a small golden crown with five points, each tipped with a tiny ruby' },
      { name: 'portal', paint: 'a rough stone archway with a swirling teal-and-dark-blue magic portal filling its opening, a few sparks drifting from it' },
      { name: 'gong', paint: 'a dented copper cooking pot hung by a rope from a short wooden frame, used as a gong, with a wooden mallet leaning against it' },
      { name: 'lens', paint: 'a great lighthouse lens: a tall rounded lantern of stacked faceted glass rings in a brass frame, glowing warm gold inside' },
      { name: 'totem', paint: 'a short carved wooden goblin totem post with a grinning painted face, two curved horns and a small round shield hung on it' },
      { name: 'waterfall', paint: 'a white waterfall pouring off a grey rock ledge into a small turquoise pool, with a little spray' },
      { name: 'goblin', paint: "a goblin's face head-on: green skin, long pointed ears, a big hooked nose, yellow eyes and a toothy grin, wearing a dented iron pot as a helmet" },
    ],
  },
];
