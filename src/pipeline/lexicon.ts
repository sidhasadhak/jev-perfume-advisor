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

export class NoteLexicon {
  /** normalized note -> display name */
  private readonly notes = new Map<string, string>();

  constructor(catalog: Catalog) {
    for (const fr of catalog.fragrances) {
      for (const n of [...fr.notes.top, ...fr.notes.middle, ...fr.notes.base]) this.add(n);
    }
    for (const f of FAMILIES) for (const n of FAMILY_DEFS[f].notes) this.add(n);
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
      found.push({ note: this.notes.get(k)!, ambiguous: AMBIGUOUS_NOTES.has(k) });
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
