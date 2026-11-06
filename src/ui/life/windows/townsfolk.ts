// What the townsfolk look like until their portraits are taken, what they say when you talk to them,
// and the workbenches they stand at.

/** Each townsperson's face as an emoji, until their portrait is taken. */
const FACES: Record<string, string> = {
  hollis: '🧓',
  mara: '👩‍🌾',
  tamsin: '🧑‍🔧',
  bertram: '🧔',
  sela: '👩‍🦰',
  ilsa: '🧑‍✈️',
  quill: '🧐',
  ysolde: '🧝',
  dunmore: '🧑‍💼',
  pell: '🎩',
  hob: '🪓',
  brenna: '⛏️',
};

/** What each says when you talk to them. */
export const GREETINGS: Record<string, string> = {
  hollis: 'Lanternwick prospers when its people do. Plant, pack, haul - and keep your boots dry.',
  mara: "Seeds for sowing, coin for your crops. Sunroot's quick, emberberry's dear - and slow on this isle.",
  tamsin: "The bench is yours whenever you've the goods. Remember: a pack sold where it's made is worth nothing.",
  bertram: 'A cart for the patient, a roadster for the bold, a hauler for the ambitious. Bring timber and iron.',
  sela: 'A donkey will carry your pack and complain the whole way. A horse will outrun the wind and carry nothing.',
  ilsa: "Rowboats for the bay, a sloop for the open sea. Sail with the wind at your back and you'll fly.",
  quill: 'Land is granted by blueprint, and kept by paying your tax. Hearthside Rise has plots for claim.',
  ysolde: "Jump, jump again, then once more to open your wings. The warm air at the cliff's foot will lift you.",
  dunmore: 'Westwatch buys what the east grows. Prices fall as I fill my storeroom - they recover with time.',
  pell: "Gullrock's a long row from anywhere. That's why I pay in seals as well as silver.",
  hob: 'Fell the deadfall for timber, bundle ten at my sawhorse, and haul it wherever you build.',
  brenna: 'Stone and iron, raw or ready. Ten stone makes a block at the cutting table. Mind your back.',
};
/** Workbenches an NPC stands at (talking to them opens it). */
export const BENCH_OF: Record<string, string> = { tamsin: 'lanternwickBench', hob: 'sawhorse', brenna: 'stonecutter' };

/** Whoever looks out of a window's medallion: their portrait (`url`), else their face. */
export function faceHtml(id: string, url: string | null): string {
  return url ? `<img src="${url}" alt="">` : `<span class="emoji">${FACES[id] ?? '🙂'}</span>`;
}
