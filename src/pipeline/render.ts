/**
 * Stage 5 - deterministic natural-language rendering.
 *
 * Jev decided WHAT to say (typed decisions); this module decides HOW to say it
 * with template phrase banks. Every perfume fact comes from the catalog record
 * or a Reason built from it - nothing here can invent a note, a year or a
 * rating. Variation is seeded from the message, so output is reproducible.
 */
import { sum } from '../catalog/dist.js';
import { FAMILY_DEFS, dominantFamilies, familyPhrase } from '../catalog/families.js';
import { meanLevel } from '../catalog/dist.js';
import type { ChatReply, Facets, Family, FavouriteColour, Fragrance, Reason, Recommendation, Season } from '../types.js';
import { LONGEVITY, SILLAGE } from '../types.js';
import type { CompareAxis } from './understand.js';
import type { ClarifyTopic, Composition, Lead, Tone } from './compose.js';
import { compareFollowUps, explainFollowUps } from './followups.js';
import { features, similarity } from './retrieve.js';
import {
  dayNight, genderPerception, longevityWord, performancePhrase, seasonRanking, sillageWord, tierWord, valueWord,
} from './describe.js';

// ---------------------------------------------------------------------------
// Seeded variation
// ---------------------------------------------------------------------------

export function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function pick<T>(xs: readonly T[], seed: number, salt = 0): T {
  return xs[((seed + salt * 2654435761) >>> 0) % xs.length]!;
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const list = (xs: string[], conj = 'and') =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} ${conj} ${xs[xs.length - 1]}`;
/** Accord names read as lowercase words; note names and pros keep the catalog's casing ("Turkish Rose", "Italian"). */
const accordList = (xs: string[]) => list(xs.map((x) => x.toLowerCase()));
const seasonWord = (s: string) => (s === 'fall' ? 'autumn' : s);

/**
 * The scent families a favourite colour is commonly associated with, and the
 * mood it evokes. A colour is only tied to a perfume through one of these
 * families, so "a love of black" never lands on a pink rose.
 */
const COLOUR_FAMILIES: Partial<Record<FavouriteColour, { families: Family[]; mood: string }>> = {
  pink: { families: ['floral_rose', 'floral_soft_powdery', 'fruity', 'gourmand_sweet'], mood: 'softness and warmth' },
  red: { families: ['floral_rose', 'fruity', 'spicy', 'amber_oriental'], mood: 'passion and warmth' },
  purple: { families: ['floral_soft_powdery', 'fruity', 'amber_oriental'], mood: 'depth and romance' },
  blue: { families: ['fresh_aquatic', 'citrus', 'aromatic_herbal'], mood: 'cool calm' },
  green: { families: ['green', 'aromatic_herbal', 'chypre_mossy'], mood: 'natural freshness' },
  yellow: { families: ['citrus', 'floral_white'], mood: 'sunny brightness' },
  orange: { families: ['citrus', 'fruity', 'spicy'], mood: 'zest and warmth' },
  white: { families: ['musky_clean', 'floral_white', 'aldehydic_classic'], mood: 'clean simplicity' },
  black: { families: ['oud_smoky', 'leather', 'amber_oriental'], mood: 'drama and depth' },
  gold: { families: ['amber_oriental', 'gourmand_sweet', 'floral_white'], mood: 'glow and richness' },
  silver: { families: ['fresh_aquatic', 'aldehydic_classic', 'musky_clean'], mood: 'cool polish' },
  brown: { families: ['woody', 'gourmand_sweet', 'leather'], mood: 'earthy warmth' },
};

/** Heaviness (features().heaviness) below which a scent may be called fresh in the heat. */
const LIGHT_FOR_HEAT = 0.4;
/** Heaviness from which a scent may be called warm and dense in the cold. */
const WARM_FOR_COLD = 0.35;

// ---------------------------------------------------------------------------
// Openings
// ---------------------------------------------------------------------------

const TONE_PREFIX: Record<Tone, readonly string[]> = {
  warm: ['', 'Happy to help. ', 'Lovely brief. '],
  enthusiastic: ['Great brief! ', 'Ooh, fun one. ', 'Love this. '],
  reassuring: ['No problem at all. ', 'Happy to help you narrow it down. ', 'You\'re in good hands. '],
  crisp: [''],
  apologetic: ['Fair point \u2014 let\'s try a different direction. ', 'Understood \u2014 here\'s a fresh take. '],
};

const OCCASION_OPEN: Record<Facets['occasion'], readonly string[]> = {
  evening_party: [
    'For an evening party you want presence and staying power — something people notice when you walk in and still catch at midnight.',
    'Parties call for scents with a bit of drama: rich enough to hold their own in a crowded room, and built to last the night.',
  ],
  formal_event: [
    'Formal occasions reward polish over volume — refined compositions that feel as tailored as the dress code.',
    'For a formal event I\'d go elegant rather than loud: scents with structure, depth and a sense of occasion.',
  ],
  office: [
    'For professional settings the goal is polished and confident, noticed up close but never a cloud in the meeting room.',
    'A great work scent reads clean and assured at arm\'s length, and stays out of your colleagues\' way.',
  ],
  date_night: [
    'Date night is about intimacy — scents that draw someone closer rather than announcing you from across the room.',
    'For a date you want something warm and inviting that rewards leaning in.',
  ],
  wedding: [
    'Weddings suit romantic, luminous scents that feel celebratory without overpowering a room full of flowers.',
  ],
  casual_daily: [
    'For everyday wear you want an easy, versatile go-to that suits most weather and most moods.',
    'A daily signature should be effortless: pleasant from first spray, never demanding.',
  ],
  outdoor_active: [
    'For active days outdoors, fresh and light is the way — scents that feel like a breath of air, not a blanket.',
  ],
  travel: [
    'For travel it pays to pack something versatile that works across days, evenings and changing weather.',
  ],
  special_signature: [
    'A signature scent should feel distinctly yours — memorable, well made, and quietly recognisable.',
  ],
  any: [''],
};

const CLIMATE_OPEN: Record<Facets['climate'], readonly string[]> = {
  cold: [
    'Cold air mutes fragrance, so for proper winters you want dense, warm compositions — ambers, spices, woods and resins that bloom with body heat.',
    'In freezing weather light scents simply vanish. Richer, warmer blends are the ones that project in cold air and feel cosy under a coat.',
  ],
  hot_humid: [
    'Humid heat amplifies sweetness and can make heavy scents cloying, so these lean fresh, airy and bright.',
    'In muggy heat the best scents are crisp and breathable — citrus, neroli, aquatic and green notes that stay pleasant in the sun.',
  ],
  hot_dry: [
    'Dry heat burns through perfume quickly, so these are bright, clean scents that stay refreshing when the sun is strong.',
  ],
  mild: [
    'Mild weather is the most forgiving — you can wear almost anything, from fresh and bright to softly warm.',
  ],
  any: [''],
};

/**
 * The favourite colour comes from Jev's typed judgement (facets.favouriteColour),
 * never from matching colour words in the message: "she hates pink", "orange
 * blossom" and "Black Orchid" are not a love of a colour.
 */
function personaOpening(f: Facets, liked: Family[]): string {
  const style = f.ageStyle === 'mature_elegant' ? 'a refined, elegant taste'
    : f.ageStyle === 'youthful' ? 'a youthful, playful spirit'
    : f.ageStyle === 'contemporary' ? 'a modern, confident style' : 'the person you described';
  const colour = COLOUR_FAMILIES[f.favouriteColour];
  const hued = colour ? liked.filter((k) => colour.families.includes(k)).slice(0, 2) : [];
  if (colour && hued.length) {
    return `For ${style} and a love of ${f.favouriteColour}, I'd look to ${list(hued.map((k) => FAMILY_DEFS[k].phrase))} scents — `
      + `they share the ${colour.mood} that ${f.favouriteColour} evokes.`;
  }
  const fams = liked.slice(0, 2).map((k) => FAMILY_DEFS[k].phrase);
  const who = colour ? `${style} and a love of ${f.favouriteColour}` : style;
  if (fams.length) return `For ${who}, I'd lean towards ${list(fams)} scents.`;
  return `With ${who} in mind, here's where I'd start.`;
}

function opening(f: Facets, c: Composition, recs: Recommendation[], refs: Fragrance[], seed: number, gift: boolean, voice: VoiceOptions, intro?: string): string {
  const liked = (Object.entries(f.likes) as [Family, number][]).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  // "Since you're drawn to..." only for tastes the user stated - never ones "something warmer" added.
  const stated = liked.filter((k) => !f.refinedLikes.includes(k));
  const prefix = pick(TONE_PREFIX[c.tone], seed);
  let body = '';
  const byLead: Record<Lead, () => string> = {
    // Occasion openers describe the picks too ("fresh and light is the way"): only when the picks are that.
    occasion: () => (occasionFitsPicks(f.occasion, recs) ? pick(OCCASION_OPEN[f.occasion], seed, 1) : ''),
    climate: () => pick(CLIMATE_OPEN[f.climate], seed, 2)
      || (f.season !== 'any'
        ? `For ${seasonWord(f.season)}, here are scents ${voice.measured ? 'the community rates highly for the season' : 'that shine in the season'}.`
        : ''),
    persona: () => personaOpening(f, liked),
    taste: () => {
      const fams = stated.slice(0, 2).map((k) => `${FAMILY_DEFS[k].phrase} scents`);
      const notes = f.likedNotes.slice(0, 2);
      const what = [...fams, ...notes];
      return what.length ? `Since you're drawn to ${list(what)}, these deliver that in different ways.` : '';
    },
    reference: () => refs.length
      ? `If you love ${refs[0]!.name}, these share a lot of its character${recs.length ? ' while each bringing something of its own' : ''}.`
      : '',
    value: () => 'Great scents don\'t have to cost a fortune — these punch well above their price.',
    // After a caveat, the picks are introduced for what they are - never "a few I think you'll love".
    general: () => intro ?? pick(['Here are a few I think you\'ll love.', 'Here\'s where I\'d start.', 'A few strong picks to begin with.'], seed, 3),
  };
  body = byLead[c.lead]() || byLead.general();
  if (c.lead === 'climate' && !climateFitsPicks(f.climate, recs)) body = byLead.general();
  if (c.lead === 'occasion' && !occasionFitsPicks(f.occasion, recs)) body = byLead.general();

  // A second sentence adds context the first did not cover - never a restatement of it.
  let second = '';
  const climateLine = f.climate !== 'any' && climateFitsPicks(f.climate, recs) ? pick(CLIMATE_OPEN[f.climate], seed, 4) : '';
  if (c.lead === 'occasion') second = climateLine;
  else if (c.lead === 'climate' && f.occasion !== 'any' && f.occasion !== 'travel') second = `They also suit ${OCCASION_WORD[f.occasion]}.`;
  else if (c.lead !== 'persona' && c.lead !== 'taste' && f.ageStyle !== 'any' && liked.length) second = personaOpening(f, liked);
  else if (c.lead !== 'climate') second = climateLine;
  if (gift && c.lead !== 'persona') second = `${second} All of them make a thoughtful gift.`.trim();
  return `${prefix}${body}${second ? ` ${second}` : ''}`;
}

/**
 * Climate openers describe the picks ("these lean fresh and airy"), so only use
 * one when the picks actually are that: heavy gourmands in humid heat get a
 * neutral opener instead.
 */
function climateFitsPicks(climate: Facets['climate'], recs: Recommendation[]): boolean {
  if (!recs.length || climate === 'any') return false;
  const heavy = recs.reduce((s, r) => s + features(r.fragrance).heaviness, 0) / recs.length;
  if (climate === 'cold') return heavy >= 0.35;
  if (climate === 'hot_dry' || climate === 'hot_humid') return heavy < 0.45;
  return true;
}

/**
 * Occasion openers make claims about the picks too - "fresh and light is the way",
 * "presence and staying power", "never a cloud in the meeting room" - so they are
 * used only when the picks bear them out, like climateFitsPicks.
 */
function occasionFitsPicks(occasion: Facets['occasion'], recs: Recommendation[]): boolean {
  if (!recs.length) return false;
  const mean = (x: (r: Recommendation) => number) => recs.reduce((s, r) => s + x(r), 0) / recs.length;
  switch (occasion) {
    case 'outdoor_active': return mean((r) => features(r.fragrance).heaviness) < 0.45 && mean((r) => features(r.fragrance).sillage) < 0.75;
    case 'evening_party': return mean((r) => features(r.fragrance).sillage) >= 0.4;
    case 'office': return mean((r) => features(r.fragrance).sillage) <= 0.7;
    default: return true;
  }
}

const OCCASION_WORD: Record<Facets['occasion'], string> = {
  evening_party: 'evening parties', formal_event: 'formal events', office: 'the office', date_night: 'date nights',
  wedding: 'weddings', casual_daily: 'everyday wear', outdoor_active: 'active days outdoors', travel: 'travel',
  special_signature: 'a signature scent', any: 'most occasions',
};

// ---------------------------------------------------------------------------
// Per-recommendation headline and bullets
// ---------------------------------------------------------------------------

const USE_CASE: Partial<Record<Reason['kind'], (r: Reason, f: Facets) => string>> = {
  // The occasion does not imply evening when the user said daytime (a lunch date, a daytime ceremony).
  occasion: (_r, f) => ({
    evening_party: f.timeOfDay === 'day' ? 'made for a celebration' : 'made for nights out',
    formal_event: 'dressed for a formal occasion', office: 'polished enough for the office',
    date_night: f.timeOfDay === 'day' ? 'made for a date' : 'made for date night',
    wedding: 'romantic enough for a wedding', casual_daily: 'an easy everyday go-to',
    outdoor_active: 'fresh for active days', travel: 'a versatile travel companion', special_signature: 'a true signature scent', any: 'with real character',
  } as const)[f.occasion],
  // Each climate gets its own claim, and only when the scent's weight backs it: mild weather is not heat.
  climate: (r) => {
    const heavy = Number(r.data.heavy);
    switch (r.data.climate) {
      case 'cold': return heavy >= WARM_FOR_COLD ? 'that blooms in cold air' : '';
      case 'hot_dry': case 'hot_humid': return heavy < LIGHT_FOR_HEAT ? 'that stays fresh in the heat' : '';
      case 'mild': return 'easy to wear in mild weather';
      default: return '';
    }
  },
  // "A natural winter scent" only when winter is its top season; otherwise it merely also works then.
  season: (r) => {
    const season = seasonWord(String(r.data.season));
    return Number(r.data.rank) === 1 ? `a natural ${season} scent` : `that also works in ${season}`;
  },
  persona: (r) => ({
    mature_elegant: 'with graceful, grown-up elegance',
    contemporary: 'with modern polish',
    youthful: 'with playful charm',
    any: '',
  } as Record<string, string>)[String(r.data.ageStyle)] ?? '',
  reference: (r) => `in the spirit of ${r.data.name}`,
  // "Good value" is a verdict on price-for-quality, not a claim that it is cheap.
  value: (r) => (r.data.tier === 'budget' ? 'at a very friendly price' : 'and good value for money'),
  time_of_day: (r) => (r.data.when === 'night' ? 'built for evenings' : 'an easy daytime wear'),
};

/**
 * `used` carries the use-case phrases already given to earlier cards, so a list
 * of four evening scents does not end every headline with "built for evenings".
 */
export function headline(rec: Recommendation, f: Facets, used: Set<string> = new Set()): string {
  const fams = dominantFamilies(rec.fragrance, 2);
  const liked = rec.reasons.find((r) => r.kind === 'family' && r.data.liked === 1);
  const shown = liked ? (liked.data.families as Family[]) : fams;
  const phrase = shown.length ? cap(list(shown.map((k) => familyPhrase(rec.fragrance, k)))) : 'Distinctive';
  const options = rec.reasons.filter((x) => USE_CASE[x.kind]).map((x) => USE_CASE[x.kind]!(x, f)).filter(Boolean);
  const use = options.find((u) => !used.has(u)) ?? (used.size ? '' : options[0] ?? '');
  if (use) used.add(use);
  return use ? `${phrase} \u2014 ${use}` : phrase;
}

export interface VoiceOptions {
  /**
   * True only when vote data is real community data (FragDB csv/api). The seed
   * catalog's votes are estimates, so exact percentages and vote counts would
   * overstate what we know - phrase those qualitatively instead. Defaults to the
   * safe choice.
   */
  measured?: boolean;
}

export function bullets(rec: Recommendation, f: Facets, max = 3, { measured = false }: VoiceOptions = {}): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  const fr = rec.fragrance;
  const add = (kind: string, text: string | undefined) => {
    if (!text || used.has(kind) || out.length >= max) return;
    used.add(kind);
    out.push(text);
  };
  const perf = () => {
    const p = performancePhrase(fr);
    return p && `Performance: ${p}`;
  };

  for (const r of rec.reasons) {
    const d = r.data;
    switch (r.kind) {
      case 'season': {
        const season = seasonWord(String(d.season));
        if (measured) {
          add('season', Number(d.rank) === 1
            ? `Community voters rank ${season} first for it (${d.share}% of season votes)`
            : `${d.share}% of season votes go to ${season}`);
        } else {
          add('season', Number(d.rank) === 1 ? `Best suited to ${season}` : `Also works well in ${season}`);
        }
        break;
      }
      case 'climate': {
        // Mild weather has no weather-specific claim worth a bullet; the headline covers it.
        const heavy = Number(d.heavy);
        add('climate', d.climate === 'cold' ? (heavy >= WARM_FOR_COLD ? 'Dense and warm enough to project in cold air' : undefined)
          : d.climate === 'hot_humid' ? (heavy < LIGHT_FOR_HEAT ? 'Light enough not to turn cloying in humid heat' : undefined)
          : d.climate === 'hot_dry' ? (heavy < LIGHT_FOR_HEAT ? 'Stays bright and clean in dry heat' : undefined) : undefined);
        break;
      }
      case 'time_of_day':
        if (measured) {
          add('time', d.when === 'night' ? `${d.share}% of wearers reach for it in the evening` : `A daytime favourite — ${d.share}% of wear is during the day`);
        } else {
          const strong = Number(d.share) >= 70;
          add('time', d.when === 'night'
            ? (strong ? 'Mostly worn in the evening' : 'Leans towards evening wear')
            : (strong ? 'A daytime favourite' : 'Leans towards daytime wear'));
        }
        break;
      case 'occasion':
        add('occasion', ({
          evening_party: 'Has the presence a party calls for', formal_event: 'Elegant enough for a formal dress code',
          office: 'Office-appropriate: noticed up close, never overwhelming',
          date_night: `Intimate and alluring — a strong ${f.timeOfDay === 'day' ? 'date' : 'date-night'} pick`,
          wedding: 'Romantic and wedding-appropriate', casual_daily: 'An easy, versatile everyday wear',
          outdoor_active: 'Fresh enough for active days', travel: 'Versatile enough to be your only bottle on a trip',
          special_signature: 'Distinctive enough to become a signature', any: undefined,
        } as const)[f.occasion]);
        break;
      case 'projection':
      case 'longevity':
        add('perf', perf());
        break;
      case 'family': {
        const accords = d.accords as string[];
        // Family labels name example materials ("Rose & peony"), and some phrases do too ("refined
        // leather"), so each family is named by the phrase that is true of THIS record.
        const style = list((d.families as Family[]).map((k) => familyPhrase(fr, k)));
        add('family', d.liked === 1
          ? `Delivers the ${style} style you're after${accords.length ? ` (${accordList(accords)})` : ''}`
          : accords.length ? `Main accords: ${accordList(accords)}` : undefined);
        break;
      }
      case 'note': {
        const notes = list(d.notes as string[]);
        add('note', d.wanted === 1 ? `Features ${notes}, as you asked` : `Key notes: ${notes}`);
        break;
      }
      case 'persona': {
        const colour = COLOUR_FAMILIES[f.favouriteColour];
        // The colour's most characteristic family among this perfume's own (pink: rose before gourmand).
        const fam = colour?.families.find((k) => (d.families as Family[]).includes(k));
        add('persona', fam
          ? `Its ${familyPhrase(fr, fam)} character suits a love of ${f.favouriteColour}`
          : d.ageStyle === 'mature_elegant' ? 'A refined, grown-up style with classic elegance'
          : d.ageStyle === 'youthful' ? 'Playful and easy to love'
          : d.ageStyle === 'contemporary' ? 'Modern and polished' : undefined);
        break;
      }
      case 'gender': {
        // "Officially unisex, with a unisex character" says nothing; with no votes there is no community view.
        const seen = genderPerception(fr);
        const voted = sum(fr.genderVotes) > 0;
        add('gender', seen === 'unisex' ? (measured && voted ? 'Officially unisex, and community votes agree' : 'Officially unisex')
          : measured && voted ? `Officially unisex — community votes see it as ${seen}`
          : `Officially unisex, with a ${seen} character`);
        break;
      }
      case 'value':
        add('value', d.tier === 'budget'
          ? `Budget-friendly, and ${measured ? 'the community rates it' : 'generally considered'} ${d.value}`
          : `${measured ? 'Community rates it' : 'Generally considered'} ${d.value}`);
        break;
      case 'popularity':
        add('popularity', measured
          ? `Rated ${d.rating}/5 by ${Number(d.votes).toLocaleString('en-US')} people`
          : Number(d.rating) >= 4.2 ? 'Very highly regarded' : Number(d.rating) >= 4.0 ? 'Highly regarded' : 'Well liked');
        break;
      case 'reference': {
        const shared = d.shared as string[];
        add('reference', shared.length ? `Shares ${accordList(shared)} with ${d.name}` : `A similar mood to ${d.name}`);
        break;
      }
    }
  }
  if (out.length < 2) add('perf', perf());
  if (out.length < 2 && fr.accords.length) add('family', `Main accords: ${accordList(fr.accords.slice(0, 3).map((a) => a.name))}`);
  return out;
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

const CLARIFY_Q: Record<ClarifyTopic, readonly string[]> = {
  gender: ['Is this for you, or someone else — and do you prefer a feminine, masculine or unisex style?'],
  budget: ['Roughly what budget do you have in mind? I can go budget-friendly or all-out luxury.'],
  occasion: ['Where will you mostly wear it — work, evenings out, or every day?'],
  climate: ['What will the weather be like where you\'ll wear it?'],
  taste: ['Are there any notes you love or can\'t stand — vanilla, rose, oud, citrus?'],
  strength: ['Do you like your scent subtle and close to the skin, or bold enough to get noticed?'],
  none: [''],
};

const TIPS: Array<[(f: Facets) => boolean, string]> = [
  [(f) => f.climate === 'cold', 'Tip: in freezing weather, spray pulse points and the base of your neck under your scarf — body heat helps richer scents bloom.'],
  [(f) => f.climate === 'hot_humid', 'Tip: in humid heat go light — one or two sprays — and carry a travel atomiser, since fresh scents fade faster.'],
  [(f) => f.climate === 'hot_dry', 'Tip: moisturised skin holds fragrance longer in dry heat — apply an unscented lotion first.'],
  [(f) => f.occasion === 'office', 'Tip: in shared spaces, one or two sprays is plenty — if you can smell yourself constantly, colleagues can too.'],
  [(f) => f.occasion === 'date_night', 'Tip: apply a little less than usual — the best date scent is one they discover up close.'],
  [(f) => f.occasion === 'evening_party', 'Tip: spray on clothes as well as skin — fabric holds scent longer through a long night.'],
];

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

export function toCards(recs: Recommendation[], f: Facets, voice: VoiceOptions = {}): ChatReply['recommendations'] {
  const used = new Set<string>();
  return recs.map((r) => ({
    pid: r.fragrance.pid,
    name: r.fragrance.name,
    brand: r.fragrance.brand,
    year: r.fragrance.year,
    photo: r.fragrance.photo,
    url: r.fragrance.url,
    accords: r.fragrance.accords.slice(0, 5).map((a) => a.name),
    headline: headline(r, f, used),
    bullets: bullets(r, f, 3, voice),
    match: Math.round(r.final * 100),
  }));
}

/** What the reply actually contains, as opposed to what Jev suggested - the trace panel labels against this. */
export interface AppliedShape {
  lead: Lead;
  clarify: ClarifyTopic | null;
  tip: boolean;
}

/** Below this, every pick is a weak match: the reply says so instead of presenting them as the answer. */
export const WEAK_MATCH = 0.25;

export function renderRecommendations(args: {
  message: string; facets: Facets; recs: Recommendation[]; composition: Composition; refs: Fragrance[]; gift: boolean;
  measured?: boolean;
  /**
   * Honest caveats that go before the picks - a requirement we cannot check, a brand or
   * perfume we do not carry, a budget we could not fully meet. With any, the reply drops
   * its upbeat tone prefix: "No problem at all" must never sit on top of an unmet request.
   */
  preface?: string[];
  /** Replaces the generic opener after a caveat ("Here are the closest matches I found..."). */
  intro?: string;
}): Pick<ChatReply, 'text' | 'recommendations' | 'followUps'> & { applied: AppliedShape } {
  const { facets: f, recs } = args;
  const preface = (args.preface ?? []).filter(Boolean);
  const weak = recs.length > 0 && recs.every((r) => r.final < WEAK_MATCH);
  const cautious = preface.length > 0 || weak;
  // A caveat changes what the opening may say: no cheerful prefix, and no reference lead for a reference we set aside.
  const c: Composition = cautious ? { ...args.composition, tone: 'crisp' } : args.composition;
  const voice: VoiceOptions = { measured: args.measured ?? false };
  const seed = seedFrom(args.message);
  if (recs.length === 0) return { ...renderNoMatch(f), applied: { lead: c.lead, clarify: null, tip: false } };

  const cards = toCards(recs, f, voice);
  const intro = args.intro ?? (cautious ? 'Here are the closest matches I found.' : undefined);
  const hedge = weak ? ' None of them is a strong match for what you asked, so treat them as a starting point rather than an answer.' : '';
  const lines = [...(preface.length ? [preface.join(' '), ''] : []), `${opening(f, c, recs, args.refs, seed, args.gift, voice, intro)}${hedge}`, ''];
  cards.forEach((card, i) => {
    lines.push(`**${i + 1}. ${card.name}** by ${card.brand} — ${card.headline.charAt(0).toLowerCase()}${card.headline.slice(1)}.`);
  });
  const closing: string[] = [];
  let tipShown = false;
  if (c.clarify) closing.push(pick(CLARIFY_Q[c.clarify], seed, 5));
  else if (c.tip) {
    const tip = TIPS.find(([when]) => when(f));
    tipShown = !!tip;
    if (tip) closing.push(tip[1]);
  }
  if (closing.length) lines.push('', ...closing);
  return {
    text: lines.join('\n'), recommendations: cards, followUps: c.followUps,
    applied: { lead: c.lead, clarify: c.clarify, tip: tipShown },
  };
}

export function renderNoMatch(f: Facets): Pick<ChatReply, 'text' | 'recommendations' | 'followUps'> {
  const loosen: string[] = [];
  if (f.budget !== 'any') loosen.push('a wider budget');
  if (f.gender !== 'any') loosen.push('unisex options');
  if (Object.keys(f.avoids).length || f.avoidedNotes.length) loosen.push('fewer exclusions');
  return {
    text: `I couldn't find anything that fits all of that well. ${loosen.length ? `Would you be open to ${list(loosen, 'or')}?` : 'Could you tell me a bit more about what you\'re looking for?'}`,
    recommendations: [],
    followUps: ['Start over with a new request', 'Show me popular crowd-pleasers'],
  };
}

/** The (up to two) seasons it is voted for, e.g. "best in winter and autumn"; '' with no season votes. */
function bestSeasons(fr: Fragrance): string {
  const seasons = seasonRanking(fr).filter(([, s]) => s > 0).slice(0, 2).map(([s]) => seasonWord(s));
  return seasons.length ? `best in ${list(seasons)}` : '';
}

/** Day or night from time-of-day votes; '' when nobody voted (a 50/50 default is not "day or night"). */
function dayNightWord(fr: Fragrance, words: Record<'day' | 'night' | 'both', string>): string {
  return sum(fr.timeOfDay) > 0 ? words[dayNight(fr).lean] : '';
}

export function renderExplain(fr: Fragrance, whyBullets: string[] | undefined, { measured = false }: VoiceOptions = {}): Pick<ChatReply, 'text' | 'recommendations' | 'followUps'> {
  const lines: string[] = [`**${fr.name}** by ${fr.brand}${fr.description ? ` — ${fr.description}` : ''}`, ''];
  // Records without accords or votes (common in real FragDB data) skip the line rather than print an empty one.
  if (fr.accords.length) lines.push(`**Scent:** ${accordList(fr.accords.slice(0, 5).map((a) => a.name))}.`);
  const tiers = [
    fr.notes.top.length ? `top — ${list(fr.notes.top)}` : '',
    fr.notes.middle.length ? `heart — ${list(fr.notes.middle)}` : '',
    fr.notes.base.length ? `base — ${list(fr.notes.base)}` : '',
  ].filter(Boolean);
  if (tiers.length) lines.push(`**Notes:** ${tiers.join('; ')}.`);
  const when = [
    bestSeasons(fr),
    dayNightWord(fr, { night: 'mostly worn in the evening', day: 'mostly worn during the day', both: 'works day or night' }),
  ].filter(Boolean);
  if (when.length) lines.push(`**When to wear:** ${when.join('; ')}.`);
  const perf = performancePhrase(fr);
  if (perf) lines.push(`**Performance:** ${perf}.`);
  const value = valueWord(fr);
  lines.push(`**Style:** ${genderPerception(fr)}, ${tierWord(fr)}${value ? ` — ${value}` : ''}.`);
  if (fr.pros.length) lines.push(`**${measured ? 'People love' : 'Strengths'}:** ${fr.pros.slice(0, 3).join('; ')}.`);
  if (fr.cons.length) lines.push(`**Watch out for:** ${fr.cons.slice(0, 2).join('; ')}.`);
  if (whyBullets?.length) lines.push('', `**Why I suggested it:** ${whyBullets.map((b) => b.charAt(0).toLowerCase() + b.slice(1)).join('; ')}.`);
  return {
    text: lines.join('\n'),
    recommendations: [],
    followUps: explainFollowUps(fr),
  };
}

/** Options for a comparison beyond Jev's overall verdict. */
export interface CompareOptions {
  /** What the user compares on; everything but `any` is answered from catalog data. */
  axis?: CompareAxis;
  /** The season a `season` comparison is about. */
  season?: Season | null;
  /** Jev's probabilities per pid for `any`, used to rank three or more. */
  ranking?: Record<string, number>;
  /** A perfume the user named is not in the catalog: say it was left out. */
  missing?: string | true;
  measured?: boolean;
}

const TIER_ORDER: Record<Fragrance['priceTier'], number> = { budget: 0, mid: 1, luxury: 2, niche: 3 };
/** Mean vote levels (0-1) closer than this are reported as level: the data cannot tell them apart. */
const PERFORMANCE_TIE = 0.03;

/**
 * `needs` is describeNeeds() of the request ("an evening party in cold
 * weather"), or '' when nothing specific was asked.
 */
export function renderCompare(
  frs: Fragrance[], winnerPid: string | null, confidence: number, needs: string, opts: CompareOptions = {},
): Pick<ChatReply, 'text' | 'recommendations' | 'followUps'> {
  const axis = opts.axis === 'season' && !opts.season ? 'any' : opts.axis ?? 'any';
  const byAxis = axis === 'any' ? null : compareOn(axis, frs, opts);
  let winner = frs.find((f) => f.pid === winnerPid) ?? null;
  const lines: string[] = [];
  if (byAxis) {
    lines.push(...byAxis.lines);
    winner = byAxis.top;
  } else if (winner && confidence >= 0.55) {
    lines.push(needs ? `For ${needs}, I'd lean towards **${winner.name}**.` : `Overall, I'd lean towards **${winner.name}**.`);
    // Three or more: Jev's probabilities give the rest of the order too.
    const ranked = opts.ranking && frs.length >= 3
      ? [...frs].sort((a, b) => (opts.ranking![b.pid] ?? 0) - (opts.ranking![a.pid] ?? 0)).filter((f) => f.pid !== winner!.pid)
      : [];
    if (ranked.length) lines.push(`After it: ${list(ranked.map((f) => f.name))}, in that order.`);
  } else {
    winner = null;
    lines.push('Honestly, they\'re close for what you\'ve described \u2014 it comes down to taste. Here\'s how they differ:');
  }
  if (opts.missing) {
    lines.push(typeof opts.missing === 'string'
      ? `I don't have ${opts.missing} in my catalog, so I've left it out.`
      : 'One of the perfumes you named isn\'t in my catalog, so I\'ve left it out.');
  }
  lines.push('');
  for (const fr of frs) {
    const when = [bestSeasons(fr), dayNightWord(fr, { night: 'an evening scent', day: 'a daytime scent', both: 'day or night' })]
      .filter(Boolean).join(', ');
    const parts = [accordList(fr.accords.slice(0, 3).map((a) => a.name)), when, performancePhrase(fr) ?? '', tierWord(fr)].filter(Boolean);
    lines.push(`**${fr.name}** by ${fr.brand}: ${parts.join('; ')}.`);
  }
  return {
    text: lines.join('\n'),
    recommendations: [],
    followUps: compareFollowUps(winner, frs),
  };
}

/**
 * A comparison on one attribute, answered from the catalog record - never Jev's
 * taste verdict: "which lasts longest" has an answer in the vote data. `top` is
 * the perfume the answer favours, or null when it is a tie or there is no data.
 */
function compareOn(axis: Exclude<CompareAxis, 'any'>, frs: Fragrance[], opts: CompareOptions): { lines: string[]; top: Fragrance | null } {
  const source = opts.measured ? 'By community votes' : 'Going by my catalog\'s performance data';
  const two = frs.length === 2;
  const names = (xs: Fragrance[]) => list(xs.map((f) => `**${f.name}**`));
  switch (axis) {
    case 'longevity':
    case 'projection': {
      const dist = (f: Fragrance) => (axis === 'longevity' ? meanLevel(f.longevity, LONGEVITY) : meanLevel(f.sillage, SILLAGE));
      const word = (f: Fragrance) => (axis === 'longevity' ? longevityWord(f) : sillageWord(f) && `${sillageWord(f)} projection`);
      const rated = frs.filter((f) => Number.isFinite(dist(f)) && word(f));
      if (rated.length < 2) return { lines: [`I don't have enough ${axis} data on these to compare them.`], top: null };
      const order = [...rated].sort((a, b) => dist(b) - dist(a));
      const top = order[0]!;
      // Close scores are a tie, whatever their order: the vote data cannot split them.
      const tied = order.filter((f) => dist(top) - dist(f) < PERFORMANCE_TIE);
      const sameWord = new Set(order.map(word)).size === 1;
      const topic = axis === 'longevity' ? 'longevity' : 'projection';
      const lines: string[] = [];
      if (tied.length > 1) {
        lines.push(`${source}, ${names(tied)} are about level on ${topic} (${tied.length === 2 ? 'both' : 'all'} ${word(top)})${tied.length === order.length ? '.' : `, ahead of ${list(order.filter((f) => !tied.includes(f)).map((f) => f.name))}.`}`);
      } else {
        const verb = axis === 'longevity' ? (two ? 'lasts longer' : 'lasts longest') : (two ? 'projects more' : 'projects the most');
        lines.push(`${source}, **${top.name}** ${verb}${sameWord ? ` - though ${two ? 'both are' : 'all of them are'} ${word(top)}` : ` (${word(top)})`}.`);
      }
      if (!two && tied.length < order.length) {
        const label = axis === 'longevity' ? 'longest- to shortest-lasting' : 'strongest to softest';
        lines.push(`From ${label}: ${order.map((f) => (sameWord ? f.name : `${f.name} (${word(f)})`)).join(', ')}.`);
      }
      return { lines, top: tied.length > 1 ? null : top };
    }
    case 'price': {
      const order = [...frs].sort((a, b) => TIER_ORDER[a.priceTier] - TIER_ORDER[b.priceTier]);
      const cheapest = order.filter((f) => f.priceTier === order[0]!.priceTier);
      const note = 'I go by price tier, not store prices, which vary by size and retailer.';
      if (cheapest.length === frs.length) {
        return { lines: [`${two ? 'Both are' : 'They\'re all'} ${tierWord(order[0]!)}, and I don't have store prices, so I can't say which costs less.`], top: null };
      }
      const lead = cheapest.length === 1
        ? `**${cheapest[0]!.name}** is the ${two ? 'cheaper one' : 'most affordable'} \u2014 it's ${tierWord(cheapest[0]!)}${two ? `, while ${order[1]!.name} is ${tierWord(order[1]!)}` : ''}.`
        : `${names(cheapest)} are the most affordable (${tierWord(cheapest[0]!)}).`;
      const rest = two ? [] : [`By price tier, from cheapest: ${order.map((f) => `${f.name} (${tierWord(f)})`).join(', ')}.`];
      return { lines: [lead, ...rest, note], top: cheapest.length === 1 ? cheapest[0]! : null };
    }
    case 'season': {
      const season = opts.season!;
      const word = seasonWord(season);
      const voted = frs.filter((f) => sum(f.season) > 0);
      if (voted.length < 2) return { lines: [`I don't have enough season data on these to rank them for ${word}.`], top: null };
      const order = [...voted].sort((a, b) => features(b).season[season] - features(a).season[season]);
      const top = order[0]!;
      // The best of poor fits is not "the best fit": say none of them is really a winter scent.
      const suits = seasonRanking(top).slice(0, 2).some(([x, share]) => x === season && share > 0);
      const lines = [suits
        ? `For ${word}, **${top.name}** is the best fit (${bestSeasons(top) || 'versatile'}).`
        : `${two ? 'Neither' : 'None of these'} is really a ${word} scent; **${top.name}** comes closest (${bestSeasons(top) || 'versatile'}).`];
      if (!two) lines.push(`My order for ${word}: ${order.map((f) => f.name).join(', ')}.`);
      const last = order[order.length - 1]!;
      const lastTop = seasonRanking(last)[0]?.[0];
      if (lastTop && lastTop !== season && last !== top) lines.push(`${last.name} is really more of ${lastTop === 'fall' ? 'an autumn' : `a ${seasonWord(lastTop)}`} scent.`);
      return { lines, top };
    }
    case 'daytime':
    case 'evening': {
      const voted = frs.filter((f) => sum(f.timeOfDay) > 0);
      if (voted.length < 2) return { lines: ['I don\'t have enough day-or-night data on these to compare them.'], top: null };
      const night = (f: Fragrance) => dayNight(f).night;
      const order = [...voted].sort((a, b) => (axis === 'evening' ? night(b) - night(a) : night(a) - night(b)));
      const top = order[0]!;
      const lean = (f: Fragrance) => dayNightWord(f, { night: 'mostly worn in the evening', day: 'mostly worn in the day', both: 'works day or night' });
      const lines = [`For ${axis === 'evening' ? 'evenings' : 'daytime'}, **${top.name}** is the best fit (${lean(top)}).`];
      if (!two) lines.push(`From most to least ${axis === 'evening' ? 'evening' : 'daytime'}-leaning: ${order.map((f) => f.name).join(', ')}.`);
      return { lines, top };
    }
    case 'similarity': {
      const [a, b] = frs as [Fragrance, Fragrance];
      if (!two) {
        const others = frs.slice(1).map((f) => ({ f, sim: similarity(a, f) })).sort((x, y) => y.sim - x.sim);
        return { lines: [`Closest to **${a.name}** in style: ${others.map((o) => `${o.f.name} (${likeness(o.sim)})`).join(', ')}.`], top: others[0]!.f };
      }
      const link = knownAlternative(a, b) ?? knownAlternative(b, a);
      const shared = a.accords.slice(0, 5).map((x) => x.name).filter((n) => b.accords.slice(0, 5).some((y) => y.name === n)).slice(0, 3);
      const both = shared.length ? `both are ${accordList(shared)}` : '';
      const sim = similarity(a, b);
      const lines: string[] = [];
      if (link) {
        lines.push(`Yes \u2014 **${link.alt.name}** is widely seen as an alternative to **${link.original.name}**${both ? `: ${both}` : ''}.`);
      } else if (sim >= 0.75) {
        lines.push(`They're very close in style${both ? `: ${both}` : ''}.`);
      } else if (sim >= 0.55) {
        lines.push(`They're fairly similar${both ? ` \u2014 ${both}` : ''} \u2014 but not interchangeable.`);
      } else {
        lines.push(`Not really: ${a.name} is ${accordList(a.accords.slice(0, 2).map((x) => x.name))}, while ${b.name} is ${accordList(b.accords.slice(0, 2).map((x) => x.name))}.`);
      }
      if (!link) lines.push('I judged that from their accords \u2014 they aren\'t a known dupe pair in my catalog.');
      if (a.priceTier !== b.priceTier) lines.push(`${a.name} is ${tierWord(a)}; ${b.name} is ${tierWord(b)}.`);
      return { lines, top: null };
    }
  }
}

function likeness(sim: number): string {
  return sim >= 0.75 ? 'very close' : sim >= 0.55 ? 'fairly similar' : 'quite different';
}

/**
 * `alt` is a well-known alternative to `original` when its reminds_of link has a
 * clear majority of votes (in the seed catalog, the curated links).
 */
export function knownAlternative(alt: Fragrance, original: Fragrance): { alt: Fragrance; original: Fragrance } | undefined {
  const link = alt.remindsOf?.find((l) => l.pid === original.pid);
  return link && link.yes >= 3 * Math.max(1, link.no) ? { alt, original } : undefined;
}

export const CANNED = {
  greeting: {
    text: 'Hi! I\'m your scent sommelier. Tell me where you\'ll wear it, who it\'s for, the weather, or scents you already love — and I\'ll find your match.',
    followUps: [
      'Suggest a perfume for an evening party',
      'Something for Nordic winters',
      'A perfume for a 65-year-old lady who loves the colour pink',
    ],
  },
  thanks: {
    text: 'My pleasure — enjoy the sniffing! Come back any time you need a scent for a new occasion.',
    followUps: ['Suggest something for summer', 'Find me a signature scent'],
  },
  out_of_scope: {
    text: 'I\'m a perfume specialist, so I can\'t help with that one — but ask me about fragrances for any occasion, climate or person and I\'m all yours.',
    followUps: ['Best perfume for a working professional', 'What should I wear for a summer in Turkey?'],
  },
} as const;
