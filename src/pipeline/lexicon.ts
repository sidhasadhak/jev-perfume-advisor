/**
 * Deterministic pre-pass over the user's message. It proposes candidates -
 * perfume names, notes, list positions - and Jev later decides what the user
 * means by them. Jev picks cards from a deck; this module deals the deck.
 */
import type { Catalog } from '../catalog/catalog.js';
import { normalize } from '../catalog/catalog.js';
import { FAMILY_DEFS } from '../catalog/families.js';
import { FAMILIES } from '../types.js';

/** Words that are note names but far more often mean something else in chat. */
const AMBIGUOUS_NOTES = new Set(['musk', 'amber', 'orange', 'rose', 'lime', 'sage', 'mint', 'oud', 'leather', 'smoke', 'water', 'clean', 'rice', 'cotton', 'sugar', 'plum']);
const TOO_GENERIC = new Set(['notes', 'accord', 'wood', 'woods', 'flowers', 'fruits', 'spices', 'green notes', 'sea notes', 'powdery notes', 'clean', 'water']);

/**
 * Note names in other languages (normalized) -> the English note they mean, so "il
 * déteste la vanille" finds Vanilla. Only notes people commonly name in chat.
 */
const NOTE_ALIASES: Record<string, string> = {
  vanille: 'vanilla', vainilla: 'vanilla', vaniglia: 'vanilla', baunilha: 'vanilla',
  jasmin: 'jasmine', gelsomino: 'jasmine', jazmin: 'jasmine', jasmim: 'jasmine',
  rosa: 'rose', rosen: 'rose',
  ambre: 'amber', ambar: 'amber', ambra: 'amber',
  cuir: 'leather', cuero: 'leather', cuoio: 'leather', leder: 'leather', couro: 'leather',
  musc: 'musk', almizcle: 'musk', muschio: 'musk', moschus: 'musk', almiscar: 'musk',
  santal: 'sandalwood', sandalo: 'sandalwood', sandelholz: 'sandalwood',
  'fleur d oranger': 'orange blossom', 'fleur doranger': 'orange blossom', azahar: 'orange blossom', 'zagara': 'orange blossom',
  tubereuse: 'tuberose', nardo: 'tuberose', tuberosa: 'tuberose',
  poivre: 'pepper', pimienta: 'pepper', pepe: 'pepper', pfeffer: 'pepper',
  cannelle: 'cinnamon', canela: 'cinnamon', cannella: 'cinnamon', zimt: 'cinnamon',
  cafe: 'coffee', caffe: 'coffee', kaffee: 'coffee',
  tabac: 'tobacco', tabaco: 'tobacco', tabacco: 'tobacco', tabak: 'tobacco',
  encens: 'incense', incienso: 'incense', incenso: 'incense', weihrauch: 'incense',
  lavande: 'lavender', lavanda: 'lavender', lavendel: 'lavender',
  bergamote: 'bergamot', bergamota: 'bergamot', bergamotto: 'bergamot',
  citron: 'lemon', limon: 'lemon', limone: 'lemon', zitrone: 'lemon', limao: 'lemon',
  pamplemousse: 'grapefruit', pomelo: 'grapefruit', pompelmo: 'grapefruit',
  pomme: 'apple', manzana: 'apple', mela: 'apple', apfel: 'apple', maca: 'apple',
  poire: 'pear', pera: 'pear', birne: 'pear',
  peche: 'peach', melocoton: 'peach', pesca: 'peach', pfirsich: 'peach', pessego: 'peach',
  framboise: 'raspberry', frambuesa: 'raspberry', lampone: 'raspberry', himbeere: 'raspberry',
  figue: 'fig', higo: 'fig', fico: 'fig', feige: 'fig', figo: 'fig',
  violette: 'violet', violeta: 'violet', viola: 'violet', veilchen: 'violet',
  muguet: 'lily of the valley', 'mousse de chene': 'oakmoss',
  miel: 'honey', miele: 'honey', honig: 'honey', mel: 'honey',
  chocolat: 'chocolate', 'cioccolato': 'chocolate', schokolade: 'chocolate',
  'noix de coco': 'coconut', cocco: 'coconut', kokos: 'coconut',
  gingembre: 'ginger', jengibre: 'ginger', zenzero: 'ginger', ingwer: 'ginger', gengibre: 'ginger',
  menthe: 'mint', menta: 'mint', minze: 'mint',
  cedre: 'cedar', cedro: 'cedar', zeder: 'cedar',
  pivoine: 'peony', peonia: 'peony', pfingstrose: 'peony',
  safran: 'saffron', azafran: 'saffron', zafferano: 'saffron', acafrao: 'saffron',
  cardamome: 'cardamom', cardamomo: 'cardamom', kardamom: 'cardamom',
};

export class NoteLexicon {
  /** normalized note -> display name */
  private readonly notes = new Map<string, string>();

  constructor(catalog: Catalog) {
    for (const fr of catalog.fragrances) {
      for (const n of [...fr.notes.top, ...fr.notes.middle, ...fr.notes.base]) this.add(n);
    }
    for (const f of FAMILIES) for (const n of FAMILY_DEFS[f].notes) this.add(n);
    // Aliases resolve to a note the catalog knows, under its English display name.
    for (const [alias, note] of Object.entries(NOTE_ALIASES)) {
      const display = this.notes.get(normalize(note));
      if (display && !this.notes.has(alias)) this.notes.set(alias, display);
    }
  }

  private add(display: string): void {
    const k = normalize(display);
    if (k.length < 3 || TOO_GENERIC.has(k) || this.notes.has(k)) return;
    this.notes.set(k, display.replace(/\b\w/g, (c) => c.toUpperCase()));
  }

  /**
   * Notes mentioned in the text, longest match first, without overlaps
   * ("pink pepper" wins over "pepper"). Ambiguous words are still returned -
   * Jev decides whether "orange" is a note or a colour.
   */
  find(text: string, limit = 6): Array<{ note: string; ambiguous: boolean }> {
    let hay = ` ${normalize(text)} `;
    const found: Array<{ note: string; ambiguous: boolean }> = [];
    const keys = [...this.notes.keys()].sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const variants = [k, `${k}s`];
      const v = variants.find((x) => hay.includes(` ${x} `));
      if (!v) continue;
      const note = this.notes.get(k)!;
      // Two spellings of one note ("vanille", "vanilla") are one mention.
      if (!found.some((x) => x.note === note)) found.push({ note, ambiguous: AMBIGUOUS_NOTES.has(k) || AMBIGUOUS_NOTES.has(normalize(note)) });
      hay = hay.replace(` ${v} `, ' # ');
      if (found.length >= limit) break;
    }
    return found;
  }
}

const ITEM = '(?:one|option|pick|perfume|fragrance|scent|suggestion)';
const PHRASE_END = '(?=\\s*(?:$|[?.!,;:]))';
const ORDINAL_WORDS: Array<[string, number]> = [
  ['first|1st|number one|no\\.? ?1|top one|top pick', 0],
  ['second|2nd|number two|no\\.? ?2', 1],
  ['third|3rd|number three|no\\.? ?3', 2],
  ['fourth|4th|number four|no\\.? ?4', 3],
  ['fifth|5th|number five|no\\.? ?5', 4],
  // Past anything we show: recognised so "the sixth one" is answered as out of range instead of
  // silently about #1. Only in list-reference forms - "my 10th anniversary" is not a position.
  // "the sixth" at the end of a phrase ("tell me about the sixth", "and the 6th?") counts too.
  [`sixth ${ITEM}|6th ${ITEM}|number six|the (?:sixth|6th)${PHRASE_END}`, 5],
  [`seventh ${ITEM}|7th ${ITEM}|number seven|the (?:seventh|7th)${PHRASE_END}`, 6],
  [`eighth ${ITEM}|8th ${ITEM}|number eight|the (?:eighth|8th)${PHRASE_END}`, 7],
  [`ninth ${ITEM}|9th ${ITEM}|number nine|the (?:ninth|9th)${PHRASE_END}`, 8],
  [`tenth ${ITEM}|10th ${ITEM}|number ten|the (?:tenth|10th)${PHRASE_END}`, 9],
];
// "#2" needs its own boundary: \b cannot sit before "#", which is not a word character.
const ORDINALS: Array<[RegExp, number]> = ORDINAL_WORDS.map(([words, i]) => [new RegExp(`\\b(?:${words})\\b|#${i + 1}\\b`), i]);
/** "the first two", "top 3": a run of positions from the top of the list. */
// Not when a counted noun follows: "the top 3 notes in the second one" is about notes, not positions 1-3.
const LEADING_RUN = /\b(?:first|top)\s+(two|2|three|3|four|4)\b(?!\s+(?:notes?|accords?|ingredients?|days?|hours?|sprays?|weeks?|months?|years?|minutes?|times?|things?|seasons?|reasons?|brands?)\b)/;
const RUN_LENGTH: Record<string, number> = { two: 2, 2: 2, three: 3, 3: 3, four: 4, 4: 4 };

/** List positions referenced in the text ("the second one", "#3", "the first two"), 0-based, in order of mention. */
export function ordinalRefs(text: string): number[] {
  const t = text.toLowerCase();
  const hits: Array<[number, number]> = [];
  for (const [re, idx] of ORDINALS) {
    const m = re.exec(t);
    if (m) hits.push([m.index, idx]);
  }
  const run = LEADING_RUN.exec(t);
  if (run) for (let i = 0; i < RUN_LENGTH[run[1]!]!; i++) hits.push([run.index, i]);
  if (/\b(last one|the last|final one)\b/.test(t)) hits.push([t.search(/\b(last one|the last|final one)\b/), -1]);
  // "the first two" hits "first" (#1) and the run (#1, #2) at the same spot: keep each position once.
  return [...new Set(hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, i]) => i))];
}

/**
 * Cheap gate for the favourite-colour question: only ask Jev when a colour word
 * is present at all. Jev then decides whether it is a colour the wearer loves
 * ("loves pink") or something else ("orange blossom", "hates pink").
 */
export function mentionsColour(text: string): boolean {
  return /\b(colou?rs?|pink|red|purple|lilac|violet|blue|navy|turquoise|teal|green|yellow|orange|white|black|gold|golden|silver|brown|crimson|scarlet|burgundy)\b/i.test(text);
}

/** Cheap gate: only ask Jev "avoid X?" questions when the message could express aversion at all. */
export function hasNegationCue(text: string): boolean {
  return /\b(no|not|don'?t|dont|avoid|hate|hates|dislike|dislikes|without|less|too|never|nothing|allergic|can'?t stand|cannot stand|isn'?t|aren'?t|instead|except|rather than|but not)\b/i.test(text);
}

/**
 * Negation and dislike words in other common languages (accents stripped). An
 * English-only gate silently dropped "il déteste la vanille".
 */
const FOREIGN_NEGATION = /\b(pas|sans|deteste|detestent|n ?aime|jamais|eviter|trop|moins|sin|odia|odio|nada|evitar|demasiado|nunca|nicht|kein|keine|ohne|hasse|hasst|non|senza|troppo|mai|nao|sem|odeia|odeio|niet|zonder|geen|haat|nie|bez|inte|utan|ikke|uden|uten|ej|nem|ne)\b/;

/**
 * Whether to ask Jev the "avoid X?" questions: an English negation cue, a foreign
 * one, or any message not written in plain ASCII (another script or language),
 * where a word list cannot be trusted to spot a dislike.
 */
export function mayExpressDislike(text: string): boolean {
  if (hasNegationCue(text)) return true;
  // Any letter outside plain ASCII in the ORIGINAL text (an accent, another script) means a language the
  // word list may not cover - ask. Folding first would turn "lubię" into ASCII and skip it.
  if (/[^\x00-\x7F]/.test(text)) return true;
  const folded = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['’]/g, ' ');
  return FOREIGN_NEGATION.test(folded);
}

/** Concentration words in the text ("EDT vs EDP"), one key each, in the order written: edp, edt, edc, parfum, elixir, intense. */
export function concentrationTerms(text: string): string[] {
  const t = ` ${normalize(text)} `;
  const patterns: Array<[string, RegExp]> = [
    ['edp', / (?:edp|eau de parfum)s? /],
    ['edt', / (?:edt|eau de toilette)s? /],
    ['edc', / (?:edc|eau de cologne) /],
    // "parfum" on its own or as extrait, but not inside "eau de parfum".
    ['parfum', / (?:extrait|pure parfum|le parfum|(?<!eau de )parfum) /],
    ['elixir', / elixir /],
    ['intense', / intense /],
  ];
  return patterns.flatMap(([key, re]) => {
    const m = re.exec(t);
    return m ? [{ key, at: m.index }] : [];
  }).sort((a, b) => a.at - b.at).map((x) => x.key);
}

/**
 * Words that can neither start nor end a product or brand name in a question
 * ("what's the best Kayali perfume?" -> not "best Kayali", not "Kayali perfume").
 */
const SPAN_EDGE_STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'about', 'is', 'are', 'was',
  'be', 'do', 'does', 'did', 'have', 'has', 'you', 'your', 'i', 'im', 'me', 'my', 'mine', 'we', 'our', 'it', 'its', 'this', 'that',
  'these', 'those', 'what', 'whats', 'which', 'who', 'whos', 'how', 'where', 'when', 'why', 'can', 'could', 'would', 'should',
  'will', 'please', 'any', 'some', 'something', 'anything', 'one', 'ones', 'best', 'good', 'great', 'nice', 'newest', 'latest',
  'perfume', 'perfumes', 'fragrance', 'fragrances', 'scent', 'scents', 'spray', 'recommend', 'suggest', 'like', 'love',
  'loves', 'want', 'need', 'looking', 'find', 'tell', 'show', 'give', 'get', 'buy', 'similar', 'else', 'other', 'dupe', 'clone',
  'cheaper', 'cheap', 'version', 'smell', 'smells', 'wear', 'wearing', 'really', 'very', 'so', 'too', 'also', 'just', 'more',
  'most', 'than', 'then', 'there', 'their', 'them', 'they', 'he', 'she', 'him', 'her', 'his', 'if', 'not', 'no', 'yes', 'vs',
  'versus', 'better', 'worth', 'lasts', 'last', 'longer', 'much', 'many', 'yet', 'carry', 'stock', 'sell', 'available', 'gift',
  'hi', 'hello', 'hey', 'thanks', 'alternative', 'alternatives', 'brand', 'brands', 'house', 'mist', 'body',
]);

/**
 * Word runs (1-4 words, original spelling) that could name a product or brand the
 * catalog does not have - the deck for Jev to point at, so a reply can say "I don't
 * carry Kayali" in the user's own words. Jev never spells a name itself.
 */
export function candidateSpans(text: string, max = 80): string[] {
  const words: Array<{ start: number; end: number; key: string; cap: boolean }> = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’&.-]*/gu;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let w = m[0].replace(/[.'’-]+$/, '');
    if (/['’]s$/i.test(w)) w = w.slice(0, -2);
    const sentenceStart = words.length === 0 || /[.!?:;"(]\s*$/.test(text.slice(0, m.index));
    words.push({ start: m.index, end: m.index + w.length, key: normalize(w).replace(/ /g, ''), cap: !sentenceStart && /^\p{Lu}/u.test(w) });
  }
  // A capitalised word mid-sentence can end a name even if it is a common word ("Stronger With You").
  const canEnd = (w: (typeof words)[number]) => !SPAN_EDGE_STOP.has(w.key) || (w.cap && w.key !== 'i');
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (SPAN_EDGE_STOP.has(words[i]!.key)) continue;
    for (let n = 1; n <= 6 && i + n <= words.length; n++) {
      const last = words[i + n - 1]!;
      if (!canEnd(last) || (n === 1 && /^\d+$/.test(last.key))) continue;
      const span = text.slice(words[i]!.start, last.end).replace(/\s+/g, ' ');
      // A list is not a name: "Sauvage, Aventus and Kayali Vanilla 28" offers each name, not the run.
      if (/[,;:!?]/.test(span) || /\s(?:and|or|vs|versus)\s/i.test(span)) continue;
      if (span.length <= 60 && !out.includes(span)) out.push(span);
    }
  }
  return out.slice(0, max);
}
