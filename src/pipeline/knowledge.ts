/**
 * Replies that answer a question instead of recommending: general perfume
 * knowledge, health and safety, product requirements the catalog cannot check,
 * and perfumes or brands it does not carry.
 *
 * Every sentence here is fixed, vetted text or a fact from a catalog record - Jev
 * only chose WHICH answer applies (understand.ts: topic, safety, requirement).
 * Nothing claims what the catalog does not know: no safety verdicts, no prices, no
 * certifications, no celebrity facts.
 */
import type { Catalog } from '../catalog/catalog.js';
import { normalize } from '../catalog/catalog.js';
import { FAMILY_DEFS } from '../catalog/families.js';
import type { ChatReply, Facets, Family, Fragrance } from '../types.js';
import { performancePredicate, sillageWord, tierPhrase, tierWord, valueWord } from './describe.js';
import { FOLLOW_UPS, cheaperAlternatives, moreLike, tellMeMore } from './followups.js';
import { knownAlternative } from './render.js';
import { features, similarity } from './retrieve.js';
import type { RequirementKind, SafetyKind, Topic } from './understand.js';

type Body = Pick<ChatReply, 'text' | 'recommendations' | 'followUps'>;

const list = (xs: string[], conj = 'and') =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} ${conj} ${xs[xs.length - 1]}`;
const accords = (fr: Fragrance, n = 3) => list(fr.accords.slice(0, n).map((a) => a.name.toLowerCase()));
const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
const reply = (text: string, followUps: string[] = []): Body => ({ text, recommendations: [], followUps });

/** Free-text chips: Jev reads them like anything the user types. */
const ASK = {
  concentration: 'What\'s the difference between EDP and EDT?',
  lastLonger: 'How can I make my perfume last longer?',
  party: 'Suggest a perfume for an evening party',
  longLasting: 'Show me long-lasting perfumes',
  modern: 'Something modern and trendy',
} as const;

// ---------------------------------------------------------------------------
// General knowledge
// ---------------------------------------------------------------------------

/**
 * Short, vetted descriptions of the notes people most often ask about. A note not
 * listed here gets an honest "I don't have a description" and a chip to explore it.
 */
export const NOTE_GLOSSARY: Record<string, string> = {
  oud: 'Oud (agarwood) is a dark, resinous wood: smoky, leathery and a little medicinal or "barnyard" in its rawer forms, smoother and sweeter in modern blends.',
  ambroxan: 'Ambroxan is a modern aroma molecule with a warm, mineral, slightly salty woodiness that sits close to the skin - the backbone of many fresh blockbusters.',
  iris: 'Iris (orris) smells powdery, cool and slightly earthy - often compared to lipstick, violets and suede.',
  orris: 'Orris (iris root) smells powdery, cool and slightly earthy - often compared to lipstick, violets and suede.',
  vetiver: 'Vetiver comes from a grass root: dry, earthy, smoky and a little green, usually read as clean and elegant.',
  aldehydes: 'Aldehydes give a sparkling, soapy, fizzy lift - clean laundry with a champagne-like brightness. The classic example is Chanel N°5.',
  'tonka bean': 'Tonka bean smells warm and sweet: vanilla and almond with a hint of hay or tobacco.',
  tonka: 'Tonka bean smells warm and sweet: vanilla and almond with a hint of hay or tobacco.',
  patchouli: 'Patchouli is earthy, woody and slightly sweet, like damp soil; modern versions are often cleaner, even a little chocolatey.',
  musk: 'Musk in today\'s perfumes is almost always synthetic: soft, clean and skin-like - the warm "fresh laundry" feel under many scents.',
  'white musk': 'White musk is a clean, soft, powdery synthetic musk - the "fresh laundry" note.',
  amber: 'Amber in perfume is not one material but an accord, usually labdanum, vanilla and resins: warm, sweet and glowing.',
  vanilla: 'Vanilla is warm, sweet and creamy - anything from boozy and smoky to sugary and gourmand, depending on the blend.',
  sandalwood: 'Sandalwood is soft, creamy and milky-woody, smooth rather than sharp.',
  bergamot: 'Bergamot is a bright citrus, somewhere between lemon and bitter orange, with a floral, tea-like edge - it is the flavour of Earl Grey.',
  neroli: 'Neroli is distilled from bitter-orange blossoms: fresh, green, citrusy and lightly floral.',
  tuberose: 'Tuberose is a heady, creamy white flower - rich, buttery and a little rubbery, known for big projection.',
  labdanum: 'Labdanum is a sticky resin from the rockrose shrub: warm, leathery, ambery and slightly animalic.',
  incense: 'Incense (frankincense or olibanum) is dry, resinous and smoky, with a lemony, church-like freshness.',
  frankincense: 'Frankincense (olibanum) is dry, resinous and smoky, with a lemony, church-like freshness.',
  leather: 'Leather accords are smoky, dry and a little animalic - from soft suede to tarry, birch-tar leathers.',
  saffron: 'Saffron adds a warm spice that is leathery, slightly metallic and honeyed.',
  rose: 'Rose ranges from fresh and dewy to jammy and honeyed; paired with oud or patchouli it turns dark and dramatic.',
  jasmine: 'Jasmine is a lush white flower - sweet, heady and a little indolic (animalic) in larger doses.',
  lavender: 'Lavender is aromatic and clean - herbal, slightly camphorous and calming; it is the backbone of classic fougères.',
  ambergris: 'Ambergris notes are salty, mineral and warm, with a sweet, skin-like glow; most perfumes today use synthetic versions.',
  benzoin: 'Benzoin is a balsamic resin: sweet, vanilla-like and slightly smoky.',
  'pink pepper': 'Pink pepper is bright, rosy and lightly spicy rather than hot.',
  cardamom: 'Cardamom is a cool, aromatic spice - fresh, slightly eucalyptus-like and warm at once.',
  tobacco: 'Tobacco notes smell like dried tobacco leaf: sweet, hay-like, honeyed and a little smoky.',
  'orange blossom': 'Orange blossom is a sweet, honeyed white flower, sunnier and fuller than neroli.',
  oakmoss: 'Oakmoss is damp, earthy, mossy and slightly salty - the base of classic chypres.',
};

/** The glossary note the text names, preferring notes the lexicon found. */
function glossaryNote(message: string, notes: string[]): { key: string; label: string } | undefined {
  const hay = ` ${normalize(message)} `;
  const keys = Object.keys(NOTE_GLOSSARY).sort((a, b) => b.length - a.length);
  for (const n of notes) {
    const k = normalize(n);
    if (NOTE_GLOSSARY[k]) return { key: k, label: n };
  }
  const k = keys.find((x) => hay.includes(` ${x} `) || hay.includes(` ${x}s `));
  return k ? { key: k, label: k } : undefined;
}

const TIP_LINES = {
  moisturise: 'Apply to moisturised skin - an unscented lotion first gives the scent something to hold on to.',
  pulse: 'Spray warm spots such as the neck, chest and inner elbows, and don\'t rub your wrists together.',
  clothes: 'Spray your clothes or a scarf too - fabric holds scent far longer than skin (test a hidden spot first).',
  storage: 'Keep the bottle somewhere cool and dark so the top notes don\'t fade.',
  stronger: 'If a scent still fades fast on you, an eau de parfum or parfum version, or a scent with woody, amber or musky base notes, usually lasts longer.',
};

export interface KnowledgeInput {
  topic: Topic;
  /** Perfumes the question is about, resolved in the catalog. */
  frs: Fragrance[];
  /** Notes the message names (lexicon). */
  notes: string[];
  message: string;
  catalog: Catalog;
  /** The user named a perfume we do not carry. */
  unknownPerfume?: boolean;
  /** How the user named it, when Jev could point at the words. */
  unknownName?: string;
  /** Concentration words in the message ("edt", "edp"). */
  concentrations?: string[];
}

export function renderKnowledge(k: KnowledgeInput): Body {
  const fr = k.frs[0];
  const about = fr ? `**${fr.name}** by ${fr.brand}` : '';
  const perfumeChips = fr ? [tellMeMore(fr.name, fr.brand), moreLike(fr.name, fr.brand)] : [];
  const notCarried = `I don't have ${k.unknownName ?? 'that perfume'} in my catalog`;
  const needPerfume = (what: string) => (k.unknownPerfume
    ? reply(`${notCarried}, so I can't tell you ${what}. Ask me about any perfume I know, or tell me what you like and I'll suggest some.`, [ASK.party])
    : reply(`Which perfume do you mean? Tell me its name and I'll tell you ${what}, if it's in my catalog.`));
  // "Do you have Kayali Vanilla 28?", "how much is <a perfume we lack>": say we don't have it, first.
  if (!fr && k.unknownPerfume && PER_PERFUME.has(k.topic)) return needPerfume(PER_PERFUME.get(k.topic)!);

  switch (k.topic) {
    case 'concentration': {
      const versions = (k.concentrations ?? []).map((c) => CONCENTRATION_NAME[c] ?? c);
      // Other records of the same line we do carry ("Le Male" beside "Le Male Le Parfum"): name them, never "only one".
      const kin = fr ? k.catalog.versionsOf(fr.pid) : [];
      const lead = !fr || versions.length < 2 ? 'Concentration is how much perfume oil is in the bottle:\n\n'
        : kin.length ? `I carry ${list([fr, ...kin].map((x) => `**${x.name}**`))} by ${fr.brand}, but I can't match them to the ${list(versions)} you asked about, so I can't compare those side by side. In general:\n\n`
        : `I only carry one version of ${about}, so I can't compare its ${list(versions)} side by side. In general:\n\n`;
      return reply(`${lead}${bullets([
        '**Parfum / extrait**: roughly 20-30% - the richest; it usually wears closest to the skin and lasts longest.',
        '**Eau de parfum (EDP)**: roughly 15-20% - the most common strength.',
        '**Eau de toilette (EDT)**: roughly 5-15% - lighter and often brighter.',
        '**Eau de cologne (EDC)**: roughly 2-5% - a fresh splash that fades quickly.',
      ])}\n\nThe exact figures vary by brand, and an EDT and EDP of the same name are often reworked rather than simply weaker or stronger, so they can smell noticeably different. Try both on skin if you can.`,
      [...perfumeChips.slice(0, 1), ASK.longLasting, ASK.lastLonger]);
    }
    case 'longevity_tips':
      return reply(`A few things make a real difference:\n\n${bullets([TIP_LINES.moisturise, TIP_LINES.pulse, TIP_LINES.clothes, TIP_LINES.storage, TIP_LINES.stronger])}`
        + (fr ? `\n\n${about} ${performancePredicate(fr) || 'has no performance rating in my data'}.` : ''),
      [ASK.longLasting, ASK.concentration]);
    case 'application': {
      const lines = [
        'Spray from about 15-20 cm (6-8 in) away onto warm spots: the neck, chest and inner elbows.',
        'Two to four sprays is plenty for most perfumes; one or two for strong ones, or for the office.',
        'Clothes and hair hold scent well - spray fabric lightly and test a hidden spot, since some perfumes can mark it.',
        'In strong sun, spraying clothes rather than skin is the safer bet: a few citrus oils can make skin more sensitive to sunlight.',
      ];
      let extra = '';
      if (fr) {
        const s = sillageWord(fr);
        extra = `\n\n${about} ${performancePredicate(fr) || 'has no performance rating in my data'}`
          + (s === 'strong' || s === 'enormous' ? ', so two or three sprays will carry you a long way.'
            : s === 'intimate' ? ', so be a little more generous and add a spray to your clothes.' : '.');
      }
      return reply(`Where and how much:\n\n${bullets(lines)}${extra}`, [ASK.lastLonger, ASK.concentration]);
    }
    case 'storage_expiry':
      return reply([
        'Keep perfume cool, dark and dry - a drawer or its box, away from sunlight, radiators and the steamy bathroom, with the cap on.',
        'Stored like that, most perfumes last for years, often 3-5 or more. Citrus and fresh top notes fade first; ambers and woods keep longest.',
        'Signs a bottle has turned: a sour, sharp or metallic opening, or a noticeably darker colour.',
      ].join('\n\n'), [ASK.lastLonger, ASK.concentration]);
    case 'nose_fatigue':
      return reply('That\'s nose fatigue (olfactory adaptation): after a few minutes your brain tunes out a smell that\'s always there, so you stop noticing your own perfume - but people around you usually still can.\n\n'
        + bullets([
          'Don\'t keep reapplying to "feel" it - you\'ll end up wearing far too much.',
          'To check it\'s still there, smell your wrist after stepping outside, or ask someone close.',
          'Rotating between two perfumes helps you notice each one again.',
        ]), [ASK.lastLonger, ASK.longLasting]);
    case 'notes_pyramid': {
      const example = fr ?? k.catalog.fragrances.find((x) => normalize(x.name) === 'aventus')
        ?? k.catalog.fragrances.find((x) => x.notes.top.length && x.notes.middle.length && x.notes.base.length);
      const ex = example && example.notes.top.length && example.notes.middle.length && example.notes.base.length
        ? `\n\nFor example, **${example.name}** by ${example.brand} opens with ${list(example.notes.top.slice(0, 3))}, has a heart of ${list(example.notes.middle.slice(0, 3))} and dries down to ${list(example.notes.base.slice(0, 3))}.`
        : '';
      return reply(`Perfumes unfold in three layers over time:\n\n${bullets([
        '**Top notes**: what you smell first, for roughly the first 15-30 minutes - often citrus, herbs or light fruit.',
        '**Heart (middle) notes**: the main character for the next few hours - often florals and spices.',
        '**Base notes**: the drydown that lingers longest - woods, amber, musk, vanilla and resins.',
      ])}${ex}`, example ? [tellMeMore(example.name, example.brand), ASK.lastLonger] : [ASK.lastLonger]);
    }
    case 'note_description': {
      const note = glossaryNote(k.message, k.notes);
      if (note) return reply(NOTE_GLOSSARY[note.key]!, [`Show me perfumes with ${note.label.toLowerCase()}`]);
      if (k.notes[0]) {
        return reply(`I don't have a vetted description of ${k.notes[0].toLowerCase()} yet, but I can show you perfumes that feature it.`,
          [`Show me perfumes with ${k.notes[0].toLowerCase()}`]);
      }
      return reply('Which note are you curious about? I can describe common ones such as oud, iris, vetiver, ambroxan or tonka bean.',
        ['What does oud smell like?', 'What does iris smell like?']);
    }
    case 'layering':
      return renderLayering(k.frs);
    case 'authenticity': {
      const ref = fr && fr.notes.top.length && fr.notes.base.length
        ? `\n\nFor reference, the genuine ${about} should smell ${accords(fr)}, opening with ${list(fr.notes.top.slice(0, 2))} and drying down to ${list(fr.notes.base.slice(0, 2))}.`
        : '';
      return reply(`I can't check a bottle myself, but these catch most fakes:\n\n${bullets([
        'Buy from the brand or an authorised retailer; a price far below retail is the biggest red flag.',
        'The batch code on the bottle should match the one on the box.',
        'Look for crisp printing, tight cellophane, a well-fitting cap and an even, fine spray.',
        'The colour and the scent should match a tester in a shop.',
      ])}${ref}`, perfumeChips);
    }
    case 'dupe':
      return fr ? renderDupe(fr, k.catalog) : needPerfume('what it\'s a dupe of');
    case 'creator_year': {
      if (!fr) return needPerfume('who made it');
      const by = fr.perfumers.length ? `was created by ${list(fr.perfumers)}` : '';
      const when = fr.year ? `launched in ${fr.year}` : '';
      const fact = [by, when].filter(Boolean).join(' and ');
      return reply(fact ? `${about} ${fact}.` : `I don't have the perfumer or launch year on record for ${about}.`, perfumeChips);
    }
    case 'reformulation':
      return reply(`I don't track reformulations or discontinuations${fr ? `, so I can't say whether ${about} has changed` : ''}. Many classics have been adjusted over the years, often to meet newer ingredient-safety standards (IFRA), so older and newer bottles can smell a little different.`
        + (fr ? ` My record describes it as ${accords(fr)}.` : ''), perfumeChips);
    case 'celebrity':
      return reply('I don\'t have reliable information on what particular people wear, so I\'d only be guessing. Tell me what you like about their style - glamorous, sporty, understated? - and I\'ll find scents to match.',
        ['Something glamorous for evenings', 'Something clean and understated']);
    case 'price_where': {
      const value = valueWord(fr ?? ({} as Fragrance));
      const verdict = !fr || !value ? '' : value.startsWith('widely') ? ` and is ${value}` : ` and is generally considered ${value}`;
      const facts = fr ? ` ${about} sits in the ${tierWord(fr)} tier${verdict}.` : '';
      const chips = fr ? [...(fr.priceTier === 'budget' ? [] : [cheaperAlternatives(fr.name, fr.brand)]), moreLike(fr.name, fr.brand)] : [];
      return reply(`I don't have store prices, stock or bottle sizes, so I can't give you a price or say where it's cheapest.${facts} Buying from the brand or an authorised retailer is the safest way to avoid fakes.`, chips);
    }
    case 'new_releases': {
      const recent = [...k.catalog.fragrances].filter((x) => x.year).sort((a, b) => b.year! - a.year! || (b.rating?.votes ?? 0) - (a.rating?.votes ?? 0)).slice(0, 3);
      return reply(`My catalog isn't a live feed of launches, so I can't tell you what's newest right now.${recent.length ? ` The most recent perfumes I know are ${list(recent.map((x) => `${x.name} by ${x.brand}`))}.` : ''}`,
        [ASK.modern, ...(recent[0] ? [tellMeMore(recent[0].name, recent[0].brand)] : [])]);
    }
    case 'skin_type':
      return reply('Skin mostly changes how long a scent lasts rather than what it smells like: dry skin tends to let fragrance fade faster, while oilier skin usually holds it longer. An unscented moisturiser first helps on dry skin. Body chemistry can also make the same perfume wear a little sweeter or sharper from person to person, so try a sample on your own skin before buying a full bottle.',
        [ASK.lastLonger, ASK.longLasting]);
    case 'other_question':
    default:
      return reply('I\'m not able to answer that one reliably. I can recommend perfumes, tell you about the ones in my catalog, compare them, or explain basics like EDP vs EDT and how to make a scent last.',
        [ASK.concentration, ASK.lastLonger, ASK.party]);
  }
}

/** Topics that are about one particular perfume, and what the reply would have told about it. */
const PER_PERFUME = new Map<Topic, string>([
  ['price_where', 'what it costs or where to buy it'], ['authenticity', 'what the genuine one smells like'],
  ['creator_year', 'who made it'], ['reformulation', 'whether it has changed'], ['dupe', 'what it\'s a dupe of'],
]);

const CONCENTRATION_NAME: Record<string, string> = {
  edp: 'EDP', edt: 'EDT', edc: 'cologne', parfum: 'parfum', elixir: 'Elixir', intense: 'Intense',
};

function renderLayering(frs: Fragrance[]): Body {
  const rules = 'Start with one spray of each - layering adds up fast - and try it on skin before wearing it out.';
  if (frs.length >= 2) {
    const [a, b] = frs as [Fragrance, Fragrance];
    const shared = a.accords.slice(0, 5).map((x) => x.name).filter((n) => b.accords.slice(0, 5).some((y) => y.name === n)).slice(0, 3);
    const heavier = features(a).heaviness >= features(b).heaviness ? a : b;
    const lighter = heavier === a ? b : a;
    const fit = shared.length
      ? `**${a.name}** and **${b.name}** share ${list(shared.map((s) => s.toLowerCase()))} accords, so they should sit together easily.`
      : `**${a.name}** (${accords(a, 2)}) and **${b.name}** (${accords(b, 2)}) have little in common, so test the combination before committing to it.`;
    return reply(`${fit} Spray the heavier one, ${heavier.name}, first and ${lighter.name} over it - or wear one on skin and one on your clothes. ${rules}`,
      [moreLike(a.name, a.brand), moreLike(b.name, b.brand)]);
  }
  if (frs.length === 1) {
    const a = frs[0]!;
    return reply(`**${a.name}** by ${a.brand} is ${accords(a)}. A good rule of thumb is to pair it with something that shares one of those accords, or with a simple scent - a musk, a citrus or a single wood - that won't fight it. Spray the heavier scent first. ${rules}`,
      [moreLike(a.name, a.brand), tellMeMore(a.name, a.brand)]);
  }
  return reply(`Layering works best when the scents share something - a note, an accord or a mood - or when one is simple enough (a musk, a citrus, a single wood) to sit under the other. Spray the heavier scent first. ${rules} Tell me which perfumes you have in mind and I'll check what they share.`,
    [ASK.concentration]);
}

function renderDupe(fr: Fragrance, catalog: Catalog): Body {
  const about = `**${fr.name}** by ${fr.brand}`;
  // The seed's links are a curated list of widely cited alternatives; real FragDB links are voters' "reminds me of".
  const curated = catalog.source === 'seed';
  const originals = (fr.remindsOf ?? []).map((l) => catalog.get(l.pid)).filter((o): o is Fragrance => !!o && !!knownAlternative(fr, o));
  const alternatives = catalog.fragrances.filter((o) => o.pid !== fr.pid && knownAlternative(o, fr)).slice(0, MAX_ALTERNATIVES);
  const lines: string[] = [];
  if (originals.length) {
    const o = originals[0]!;
    const shared = fr.accords.slice(0, 5).map((x) => x.name).filter((n) => o.accords.slice(0, 5).some((y) => y.name === n)).slice(0, 3);
    const link = curated ? 'is widely seen as an alternative to' : 'reminds many voters of';
    lines.push(`${about} ${link} **${o.name}** by ${o.brand}${shared.length ? `: both are ${list(shared.map((s) => s.toLowerCase()))}` : ''}. ${fr.name} is ${tierPhrase(fr)}; ${o.name} is ${tierPhrase(o)}.`);
  }
  if (alternatives.length) {
    const head = curated ? 'Well-known alternatives to' : 'Perfumes voters say remind them of';
    lines.push(`${head} ${originals.length ? fr.name : about}: ${list(alternatives.map((x) => `${x.name} by ${x.brand} (${tierWord(x)})`))}.`);
  }
  if (lines.length) {
    const other = originals[0] ?? alternatives[0]!;
    return reply(lines.join('\n\n'), [`Compare ${fr.name} and ${other.name}`, tellMeMore(fr.name, fr.brand)]);
  }
  // No known link: the closest by accords, said as exactly that - not called a dupe.
  const close = catalog.fragrances.filter((o) => o.pid !== fr.pid).map((o) => ({ o, sim: similarity(fr, o) }))
    .filter((x) => x.sim >= 0.6).sort((x, y) => y.sim - x.sim).slice(0, 2);
  return reply(`I don't have ${about} listed as a known dupe of anything, or anything as a dupe of it.`
    + (close.length ? ` The closest perfumes in my catalog by accords are ${list(close.map((x) => `${x.o.name} by ${x.o.brand}`))}.` : ''),
  close.length ? [`Compare ${fr.name} and ${close[0]!.o.name}`, moreLike(fr.name, fr.brand)] : [moreLike(fr.name, fr.brand)]);
}

/** Most alternatives listed for one perfume. */
const MAX_ALTERNATIVES = 3;

// ---------------------------------------------------------------------------
// Health and safety - never a product list, never reassurance
// ---------------------------------------------------------------------------

export function renderSafety(kind: SafetyKind, fr?: Fragrance): Body {
  const lighter = FOLLOW_UPS.lighter_scents.text;
  const named = fr ? `, including ${fr.name},` : ',';
  switch (kind) {
    case 'pregnancy':
      return reply(`I can't advise on perfume during pregnancy or breastfeeding: I don't have ingredient or safety data for any perfume${named} so I can't say which are safe. Please ask your doctor, midwife or pharmacist - they can go through a product's ingredient list with you.\n\nIf you'd like, I can suggest light, subtle scents - just not as a safety recommendation.`, [lighter]);
    case 'child':
      return reply('I can\'t recommend perfume for a baby or young child, and I don\'t have ingredient-safety data. Young children\'s skin is more sensitive than adults\', so please ask your paediatrician or pharmacist before putting any fragrance on them.\n\nIf you\'re shopping for yourself, or for someone older, I\'m happy to help.', ['Suggest a perfume for me instead']);
    case 'pet':
      return reply('Please don\'t use human perfume on a pet: the alcohol and fragrance oils can irritate their skin, eyes and nose, and their sense of smell is far stronger than ours. A bath, a pet-safe grooming spray or a word with your vet is the way to go.\n\nI\'m happy to help find a scent for you, though.', ['Suggest a perfume for me instead']);
    case 'medical':
    default:
      return reply(`I can't give medical advice, and I don't have ingredient or allergen data for any perfume${named} so I can't say what's safe for you. If you have allergies, asthma, migraines or sensitive skin, a doctor, pharmacist or allergist is the right person to ask, and patch-testing a sample on your inner arm for a day or two before wearing it is a sensible precaution.\n\nIf you'd like, I can suggest light, subtle scents - just not as a safety recommendation.`, [lighter]);
  }
}

// ---------------------------------------------------------------------------
// Requirements the catalog cannot check
// ---------------------------------------------------------------------------

/**
 * The honest line for a requirement we have no data on. `fr`: a question about one perfume.
 * `seed`: the catalog is our own seed list, so we can say what it holds; a FragDB export may
 * list attars or body mists, so there we only say we have no data.
 */
export function requirementLine(kind: RequirementKind, fr?: Fragrance, seed = true): string {
  const it = fr ? `**${fr.name}**` : 'any perfume';
  switch (kind) {
    case 'alcohol_free':
      return `I don't have data on alcohol content${seed ? ', and everything in my catalog is an alcohol-based spray (colognes, eaux de toilette, eaux de parfum and parfums)' : ''}, so I can't point you to ${fr ? `an alcohol-free version of ${it}` : 'an alcohol-free or halal-certified perfume'}. For that, look for attars or perfume oils labelled alcohol-free, and check with the seller.`;
    case 'format':
      return seed
        ? 'I only carry perfumes - sprays such as colognes, eaux de toilette, eaux de parfum and parfums - not body mists, roll-ons, solid perfumes or other formats.'
        : 'I don\'t have product-format data, so I can\'t pick out body mists, roll-ons or solid perfumes.';
    case 'vegan_cruelty_free':
      return `I don't have vegan or cruelty-free certification data for ${it}, so please check the brand's own policy, or a certification such as Leaping Bunny, before buying.`;
    case 'natural':
      return `I don't have ingredient data${fr ? ` for ${it}` : ''}, and nearly every modern perfume uses synthetic materials, so I can't recommend an all-natural one. Brands that sell natural or botanical perfumes usually list their full ingredients.`;
    case 'sensitivity':
      return `I can't give medical advice, and I don't have allergen or ingredient data for ${it}, so I can't promise anything won't trigger a reaction. Patch-test a sample on your inner arm for a day or two first, and stop if it bothers you.`;
    case 'hypoallergenic':
    default:
      return `I don't have allergen data for ${it}, so I can't promise anything is hypoallergenic. Patch-test a sample on your inner arm for a day or two first, and check the ingredient list for anything you react to.`;
  }
}

/** Requirements where showing ordinary sprays anyway would answer the wrong question. */
export function requirementBlocksPicks(kind: RequirementKind): boolean {
  return kind === 'alcohol_free';
}

/**
 * How picks shown despite an unmet requirement are introduced, in place of a generic opener.
 * `light`: the picks really are light (the caller checks their projection) - only then say so.
 */
export function requirementBridge(kind: RequirementKind, light = true): string {
  switch (kind) {
    case 'format': return 'If a perfume works for you, these are close to the rest of your request.';
    case 'hypoallergenic':
    case 'sensitivity': return light ? 'These are lighter, softer options - not a guarantee.' : 'These fit the rest of your request - not a guarantee of anything.';
    default: return 'If that\'s not a must, these fit the rest of your request.';
  }
}

/** A requirement answered without picks: a question about one perfume, or alcohol-free. */
export function renderRequirement(kind: RequirementKind, fr: Fragrance | undefined, hasTaste: boolean, seed = true): Body {
  // Only alcohol-free withholds picks; the offer to show sprays anyway is about that alone.
  const offerSprays = !fr && hasTaste && kind === 'alcohol_free';
  const chips = fr ? [tellMeMore(fr.name, fr.brand), moreLike(fr.name, fr.brand)] : offerSprays ? [FOLLOW_UPS.sprays_anyway.text] : [];
  const offer = offerSprays ? '\n\nIf a spray is fine for other occasions, I can show you ones in the style you described.' : '';
  return reply(`${requirementLine(kind, fr, seed)}${offer}`, chips);
}

// ---------------------------------------------------------------------------
// Things we do not carry, and requests we should not guess at
// ---------------------------------------------------------------------------

export function brandNotCarriedLine(brand: string | undefined): string {
  return `I don't carry ${brand ?? 'that brand'} yet, so I can't rank its perfumes.`;
}

export function perfumeNotCarriedLine(name: string | undefined): string {
  return `I don't have ${name ?? 'that perfume'} in my catalog, so I can't match it exactly.`;
}

/** "I love Angel Nova": we only have Angel, which must not stand in for it. */
export function variantLine(variant: string, base: Fragrance): string {
  return `I don't have ${variant} - only ${base.name} by ${base.brand}, which is a different scent - so these go by your description, not by ${base.name}.`;
}

/** Openers for picks shown after a caveat, instead of "Here are a few I think you'll love". */
export const CAUTIOUS_INTRO = {
  notCarried: 'Here are the closest matches I found for what you described.',
  variant: 'These are my closest picks for what you described.',
} as const;

export function renderVariant(variant: string, base: Fragrance): Body {
  return reply(`I don't have ${variant} in my catalog - only ${base.name} by ${base.brand}, which is a different perfume, so I won't describe one as the other. Want to hear about ${base.name} instead?`,
    [tellMeMore(base.name, base.brand), moreLike(base.name, base.brand)]);
}

export function renderTwoWearers(phrases: string[]): Body {
  return reply('You\'re shopping for two people - I\'ll find better matches taking them one at a time. Who should I start with?',
    phrases.map((p) => `Start with ${p}`));
}

/** "Fresh and light" and "beast-mode gourmand" in one brief: say so, with an example from the facets when there is one. */
export function conflictLine(f: Facets): string {
  const FRESH: Family[] = ['citrus', 'fresh_aquatic', 'green', 'musky_clean', 'aromatic_herbal'];
  const HEAVY: Family[] = ['gourmand_sweet', 'amber_oriental', 'oud_smoky', 'leather', 'spicy'];
  const fresh = FRESH.find((k) => k in f.likes);
  const heavy = HEAVY.find((k) => k in f.likes);
  const example = fresh && heavy ? ` - ${FAMILY_DEFS[fresh].phrase} versus ${FAMILY_DEFS[heavy].phrase}`
    : f.projection >= 3 && (f.occasion === 'outdoor_active' || f.occasion === 'office') ? ` - a very strong scent versus ${f.occasion === 'office' ? 'the office' : 'active days'}`
    : '';
  return `Heads-up: some of what you asked for pulls in opposite directions${example}, so I've aimed for a balance. Tell me which matters more and I'll lean that way.`;
}

export const ENGLISH_ONLY = 'I can only reply in English for now.';
