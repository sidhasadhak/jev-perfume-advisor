/**
 * Olfactive families <-> FragDB accords and notes.
 *
 * Jev reasons in families (a small, human-meaningful vocabulary it can pick
 * from). The catalog speaks FragDB accords/notes. This module is the bridge,
 * and is pure data + deterministic scoring - no AI.
 */
import type { Family, Fragrance } from '../types.js';
import { FAMILIES } from '../types.js';

/**
 * Controlled accord vocabulary (Fragrantica/FragDB accord names, lowercase).
 * The seed catalog uses only these; real FragDB data may contain others, which
 * simply do not contribute to family scores.
 */
export const ACCORD_VOCAB = [
  'citrus', 'aromatic', 'fresh spicy', 'warm spicy', 'soft spicy', 'woody', 'amber', 'sweet', 'powdery',
  'floral', 'white floral', 'yellow floral', 'rose', 'tuberose', 'iris', 'violet', 'fruity', 'tropical',
  'cherry', 'green', 'herbal', 'fresh', 'aquatic', 'marine', 'ozonic', 'salty', 'mineral', 'musky', 'soapy',
  'aldehydic', 'vanilla', 'balsamic', 'caramel', 'chocolate', 'coffee', 'honey', 'almond', 'lactonic',
  'coconut', 'cinnamon', 'lavender', 'leather', 'oud', 'smoky', 'tobacco', 'earthy', 'patchouli', 'mossy',
  'animalic', 'metallic', 'rum', 'whiskey', 'nutty', 'anis', 'conifer', 'camphor', 'beeswax', 'cacao',
  'savory', 'terpenic',
] as const;

export interface FamilyDef {
  label: string;
  /** One-line description Jev sees when choosing families. */
  description: string;
  /** accord name -> weight of that accord toward this family. */
  accords: Record<string, number>;
  /** Lowercase note name fragments that signal this family. */
  notes: string[];
  /** Plain-language phrase used by the renderer ("a bright citrus scent"). */
  phrase: string;
  /**
   * Set when `phrase` names a material ("refined leather", "aquatic"). A record can
   * reach a family through a secondary accord or note (civet -> leather, a "fresh"
   * accord -> aquatic), and then the phrase would claim a material it lacks. The
   * phrase is only used for a record with one of these accords or (whole-word)
   * notes; any other record gets `fallback`, which names no material.
   */
  material?: { accords: string[]; notes: string[]; fallback: string };
}

export const FAMILY_DEFS: Record<Family, FamilyDef> = {
  citrus: {
    label: 'Citrus',
    description: 'Bright, zesty citrus: bergamot, lemon, orange, grapefruit, mandarin. Energetic and clean.',
    accords: { citrus: 1 },
    notes: ['bergamot', 'lemon', 'orange', 'grapefruit', 'mandarin', 'lime', 'yuzu', 'citron', 'petitgrain', 'neroli'],
    phrase: 'bright citrus',
  },
  fresh_aquatic: {
    label: 'Fresh & aquatic',
    description: 'Watery, marine, ozonic or salty freshness - sea breeze, cool air, clean skin after a swim.',
    accords: { aquatic: 1, marine: 1, ozonic: 1, fresh: 0.6, salty: 0.8, mineral: 0.6 },
    notes: ['sea notes', 'marine', 'water', 'calone', 'sea salt', 'ambergris', 'ozonic'],
    phrase: 'fresh, airy aquatic',
    material: {
      accords: ['aquatic', 'marine', 'ozonic', 'salty'],
      notes: ['sea notes', 'sea salt', 'sea water', 'sea breeze', 'seaweed', 'algae', 'salt', 'marine', 'aquatic', 'ozonic', 'calone', 'water notes'],
      fallback: 'fresh and airy',
    },
  },
  green: {
    label: 'Green',
    description: 'Crisp green leaves, cut grass, fig leaf, galbanum, tea - outdoorsy and natural.',
    accords: { green: 1, herbal: 0.4 },
    notes: ['galbanum', 'fig leaf', 'violet leaf', 'green tea', 'tea', 'grass', 'mate', 'green notes', 'bamboo', 'fig'],
    phrase: 'crisp green',
    material: {
      accords: ['green'],
      notes: ['green', 'galbanum', 'fig', 'violet leaf', 'lemon leaf', 'tomato leaf', 'blackcurrant leaf', 'tea', 'grass', 'mate', 'bamboo', 'ivy'],
      fallback: 'crisp, herbal',
    },
  },
  aromatic_herbal: {
    label: 'Aromatic & herbal',
    description: 'Lavender, rosemary, sage, mint, basil - the classic barbershop-fresh aromatic signature.',
    accords: { aromatic: 1, lavender: 1, herbal: 0.9, 'fresh spicy': 0.4, camphor: 0.5, conifer: 0.5 },
    notes: ['lavender', 'rosemary', 'sage', 'clary sage', 'mint', 'basil', 'thyme', 'artemisia', 'juniper'],
    phrase: 'aromatic, herbal',
    material: {
      accords: ['aromatic', 'lavender', 'herbal', 'camphor', 'conifer'],
      notes: ['lavender', 'lavandin', 'rosemary', 'sage', 'mint', 'basil', 'thyme', 'artemisia', 'juniper', 'tarragon', 'oregano'],
      fallback: 'crisp, aromatic',
    },
  },
  fruity: {
    label: 'Fruity',
    description: 'Juicy fruits - apple, pear, peach, berries, blackcurrant, pineapple. Playful and bright.',
    accords: { fruity: 1, tropical: 0.8, cherry: 0.9 },
    notes: ['apple', 'pear', 'peach', 'raspberry', 'blackcurrant', 'black currant', 'cassis', 'pineapple', 'lychee', 'strawberry', 'plum', 'cherry', 'apricot', 'mango', 'melon', 'red berries', 'blackberry'],
    phrase: 'juicy fruity',
  },
  floral_rose: {
    label: 'Rose & peony',
    description: 'Rosy florals - rose, peony, geranium. Romantic, feminine, often associated with pink.',
    accords: { rose: 1, floral: 0.35 },
    notes: ['rose', 'damask rose', 'bulgarian rose', 'turkish rose', 'peony', 'geranium', 'rose de mai'],
    phrase: 'romantic rosy-floral',
    material: { accords: ['rose'], notes: ['rose'], fallback: 'romantic floral' },
  },
  floral_white: {
    label: 'White florals',
    description: 'Heady white flowers - jasmine, tuberose, gardenia, orange blossom, ylang-ylang. Lush and sensual.',
    accords: { 'white floral': 1, tuberose: 1, 'yellow floral': 0.8, floral: 0.4 },
    notes: ['jasmine', 'sambac', 'tuberose', 'gardenia', 'orange blossom', 'ylang-ylang', 'ylang ylang', 'frangipani', 'lily', 'magnolia', 'honeysuckle', 'lily-of-the-valley', 'lily of the valley', 'neroli'],
    phrase: 'lush white-floral',
    material: {
      accords: ['white floral', 'tuberose', 'yellow floral'],
      notes: ['jasmine', 'sambac', 'tuberose', 'gardenia', 'orange blossom', 'ylang', 'frangipani', 'lily', 'magnolia', 'honeysuckle', 'neroli', 'tiare'],
      fallback: 'lush floral',
    },
  },
  floral_soft_powdery: {
    label: 'Soft & powdery',
    description: 'Iris, violet, heliotrope, mimosa and powder - soft, cosmetic, gentle and refined.',
    accords: { powdery: 1, iris: 1, violet: 0.9, floral: 0.2 },
    notes: ['iris', 'orris', 'violet', 'heliotrope', 'mimosa', 'powdery notes', 'rice', 'cotton'],
    phrase: 'soft, powdery',
  },
  gourmand_sweet: {
    label: 'Gourmand & sweet',
    description: 'Edible sweetness - vanilla, caramel, praline, chocolate, coffee, honey, tonka. Cosy and delicious.',
    accords: { sweet: 1, vanilla: 0.9, caramel: 1, chocolate: 1, coffee: 1, honey: 0.8, almond: 0.8, lactonic: 0.6, cacao: 1, nutty: 0.7, coconut: 0.6, rum: 0.5 },
    notes: ['vanilla', 'caramel', 'praline', 'tonka', 'tonka bean', 'chocolate', 'cocoa', 'coffee', 'honey', 'almond', 'marshmallow', 'cotton candy', 'sugar', 'toffee', 'hazelnut', 'pistachio'],
    phrase: 'cosy gourmand',
  },
  amber_oriental: {
    label: 'Amber & resinous',
    description: 'Warm amber, resins, balsams, incense and vanilla - rich, enveloping, glowing warmth.',
    accords: { amber: 1, balsamic: 1, vanilla: 0.4, 'warm spicy': 0.3 },
    notes: ['amber', 'benzoin', 'labdanum', 'myrrh', 'opoponax', 'olibanum', 'frankincense', 'incense', 'tolu balsam', 'peru balsam', 'styrax'],
    phrase: 'warm amber',
    material: {
      accords: ['amber', 'balsamic'],
      notes: ['amber', 'benzoin', 'labdanum', 'myrrh', 'opoponax', 'olibanum', 'frankincense', 'incense', 'balsam', 'styrax', 'resin', 'resins', 'cistus'],
      fallback: 'warm, enveloping',
    },
  },
  spicy: {
    label: 'Spicy',
    description: 'Pepper, cardamom, cinnamon, clove, saffron, nutmeg - piquant warmth or sparkling spice.',
    accords: { 'warm spicy': 1, 'fresh spicy': 0.9, 'soft spicy': 0.8, cinnamon: 1, anis: 0.5 },
    notes: ['pepper', 'pink pepper', 'black pepper', 'cardamom', 'cinnamon', 'clove', 'saffron', 'nutmeg', 'ginger', 'cumin', 'star anise', 'coriander'],
    phrase: 'spiced',
  },
  woody: {
    label: 'Woody',
    description: 'Sandalwood, cedar, vetiver, guaiac - grounded, dry or creamy woods. Elegant and versatile.',
    accords: { woody: 1, earthy: 0.5 },
    notes: ['sandalwood', 'cedar', 'cedarwood', 'vetiver', 'guaiac', 'cashmeran', 'cashmere wood', 'iso e super', 'ambroxan', 'birch', 'cypress', 'pine', 'oak'],
    phrase: 'elegant woody',
    material: {
      accords: ['woody'],
      notes: ['sandalwood', 'cedar', 'cedarwood', 'vetiver', 'guaiac', 'cashmeran', 'cashmere wood', 'iso e super', 'birch', 'cypress', 'pine', 'wood', 'woods', 'woody notes', 'oud', 'agarwood', 'rosewood', 'teak'],
      fallback: 'grounded, earthy',
    },
  },
  oud_smoky: {
    label: 'Oud, smoke & tobacco',
    description: 'Oud, smoke, incense, tobacco, birch tar - dark, dramatic, statement-making.',
    accords: { oud: 1, smoky: 1, tobacco: 1, whiskey: 0.4 },
    notes: ['oud', 'agarwood', 'smoke', 'birch tar', 'tobacco', 'tobacco leaf', 'incense', 'cade', 'guaiac wood'],
    phrase: 'dark, smoky',
    material: {
      accords: ['oud', 'smoky', 'tobacco'],
      notes: ['oud', 'agarwood', 'smoke', 'smoky', 'birch tar', 'tobacco', 'incense', 'cade', 'guaiac', 'frankincense', 'olibanum'],
      fallback: 'dark, dramatic',
    },
  },
  leather: {
    label: 'Leather',
    description: 'Leather, suede, animalic richness - sophisticated, bold and a little daring.',
    accords: { leather: 1, animalic: 0.8 },
    notes: ['leather', 'suede', 'castoreum', 'civet'],
    phrase: 'refined leather',
    material: { accords: ['leather'], notes: ['leather', 'suede'], fallback: 'bold, animalic' },
  },
  musky_clean: {
    label: 'Musky & clean',
    description: 'Clean musks, fresh laundry, soap, skin-like softness - discreet, polished, office-safe.',
    accords: { musky: 1, soapy: 0.9, fresh: 0.3 },
    notes: ['musk', 'white musk', 'ambrette', 'clean', 'laundry', 'aldehydes', 'cotton', 'cashmeran', 'iso e super'],
    phrase: 'clean, musky',
    material: { accords: ['musky'], notes: ['musk', 'ambrette'], fallback: 'clean and soft' },
  },
  chypre_mossy: {
    label: 'Chypre & mossy',
    description: 'Oakmoss, patchouli and bergamot - the sophisticated, earthy-elegant chypre structure.',
    accords: { mossy: 1, patchouli: 0.9, earthy: 0.6 },
    notes: ['oakmoss', 'oak moss', 'patchouli', 'labdanum', 'moss', 'treemoss'],
    phrase: 'sophisticated chypre',
  },
  aldehydic_classic: {
    label: 'Aldehydic classic',
    description: 'Sparkling aldehydes over florals and powder - timeless, glamorous, old-Hollywood elegance.',
    accords: { aldehydic: 1, powdery: 0.4, soapy: 0.4 },
    notes: ['aldehydes', 'aldehyde'],
    phrase: 'timeless aldehydic',
    material: { accords: ['aldehydic'], notes: ['aldehyde', 'aldehydes'], fallback: 'timeless, classic' },
  },
};

/** For Jev choice questions: key -> description. */
export const FAMILY_CRITERIA: Record<Family, string> = Object.fromEntries(
  FAMILIES.map((f) => [f, FAMILY_DEFS[f].description]),
) as Record<Family, string>;

const wordNorm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const noteFamilyCache = new Map<string, Set<Family>>();

/**
 * Families a single note signals. Fragments match whole words only
 * ("rosemary" is not "rose", "pineapple" is not "pine"), and when a note
 * matches several fragments the longest wins, so "orange blossom" counts as a
 * white floral rather than citrus.
 */
export function noteFamilies(note: string): Set<Family> {
  const key = note.toLowerCase();
  let out = noteFamilyCache.get(key);
  if (out) return out;
  const hay = wordNorm(note);
  const hits: Array<{ family: Family; frag: string }> = [];
  for (const f of FAMILIES) {
    for (const frag of FAMILY_DEFS[f].notes) if (hay.includes(wordNorm(frag))) hits.push({ family: f, frag: frag.toLowerCase() });
  }
  out = new Set(
    hits.filter((h) => !hits.some((o) => o.frag.length > h.frag.length && o.frag.includes(h.frag))).map((h) => h.family),
  );
  noteFamilyCache.set(key, out);
  return out;
}

/**
 * The phrase for `family` that is true of this record: the material phrase
 * ("refined leather") only when the record has one of the family's defining
 * accords or notes, otherwise the material-free fallback ("bold, animalic").
 * Every perfume-level use of a family phrase goes through here.
 */
export function familyPhrase(fr: Fragrance, family: Family): string {
  const { phrase, material } = FAMILY_DEFS[family];
  if (!material) return phrase;
  const accords = new Set(fr.accords.map((a) => a.name.toLowerCase()));
  if (material.accords.some((a) => accords.has(a))) return phrase;
  const notes = [...fr.notes.top, ...fr.notes.middle, ...fr.notes.base].map(wordNorm);
  return material.notes.some((m) => notes.some((n) => n.includes(wordNorm(m)))) ? phrase : material.fallback;
}

/**
 * How strongly a fragrance expresses a family, 0..1.
 * 70% from accord strengths (FragDB's own voting), 30% from note presence.
 */
export function familyAffinity(fr: Fragrance, family: Family): number {
  const def = FAMILY_DEFS[family];
  let acc = 0;
  for (const a of fr.accords) {
    const w = def.accords[a.name.toLowerCase()];
    if (w) acc = Math.max(acc, (a.strength / 100) * w);
  }
  const hits = [...fr.notes.top, ...fr.notes.middle, ...fr.notes.base].filter((n) => noteFamilies(n).has(family)).length;
  const noteScore = Math.min(1, hits / 2);
  return Math.min(1, 0.7 * acc + 0.3 * noteScore);
}

export function familyProfile(fr: Fragrance): Record<Family, number> {
  return Object.fromEntries(FAMILIES.map((f) => [f, familyAffinity(fr, f)])) as Record<Family, number>;
}

/** The fragrance's dominant families, strongest first. */
export function dominantFamilies(fr: Fragrance, n = 3, min = 0.25): Family[] {
  return (Object.entries(familyProfile(fr)) as [Family, number][])
    .filter(([, v]) => v >= min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([f]) => f);
}
