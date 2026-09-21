/**
 * Stage 2 - Jev screens EVERY perfume.
 *
 * One yes/no question per perfume: "would this be a strong pick for this
 * request?". Questions in one request are evaluated independently against the
 * same state, so each perfume gets its own calibrated probability and they are
 * comparable across the whole catalog. (A single choice question over all
 * perfumes would not work: it concentrates probability on one winner and
 * leaves the rest at ~0, so positions 2..N could not be ranked.)
 *
 * Questions are batched per request and the requests run concurrently.
 */
import { JevError } from '../jev/client.js';
import type { Answer, Decider, NoulAnswer, QuestionSet } from '../jev/types.js';
import { noul } from '../jev/types.js';
import type { Facets, Fragrance } from '../types.js';
import { dayNight, describeFacets, genderPerception, longevityWord, seasonRanking, sillageWord, tierWord } from './describe.js';

export const DEFAULT_BATCH_SIZE = 40;

const CRITERIA = {
  true: 'It clearly suits the occasion, climate, wearer and scent taste described, with nothing that conflicts',
  false: 'It is only an average fit, or it conflicts with something the user asked for',
};

/** A one-line factual profile, built only from catalog data. */
export function compactProfile(fr: Fragrance): string {
  const seasons = seasonRanking(fr).filter(([, s]) => s >= 0.2).slice(0, 2).map(([s]) => (s === 'fall' ? 'autumn' : s));
  const dn = dayNight(fr);
  const notes = [...fr.notes.top.slice(0, 2), ...fr.notes.middle.slice(0, 2), ...fr.notes.base.slice(0, 3)];
  const perf = [sillageWord(fr) ? `${sillageWord(fr)} projection` : '', longevityWord(fr) ?? ''].filter(Boolean).join(', ');
  return [
    `${fr.name} by ${fr.brand}${fr.year ? ` (${fr.year})` : ''}`,
    `marketed for ${fr.gender}, perceived as ${genderPerception(fr)}`,
    `accords: ${fr.accords.slice(0, 5).map((a) => a.name).join(', ')}`,
    notes.length ? `notes: ${notes.join(', ')}` : '',
    seasons.length ? `best in ${seasons.join(' and ')}` : '',
    dn.lean === 'night' ? 'mostly worn in the evening' : dn.lean === 'day' ? 'mostly worn in the day' : 'worn day or night',
    perf,
    tierWord(fr),
  ].filter(Boolean).join('; ');
}

/** Question keys must match [A-Za-z0-9_:-]{1,64}; FragDB pids are numeric, but be safe. */
function keyFor(pid: string, i: number): string {
  const clean = pid.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 50);
  return `p${i}_${clean}`;
}

export interface ScreenInput {
  message: string;
  facets: Facets;
  fragrances: Fragrance[];
  refs: Fragrance[];
  decider: Decider;
  batchSize?: number;
  signal?: AbortSignal;
}

export interface ScreenResult {
  /** pid -> Jev's probability that it is a strong pick. Missing if its batch failed. */
  scores: Map<string, number>;
  screened: number;
  batches: number;
  failedBatches: number;
}

export async function screen(inp: ScreenInput): Promise<ScreenResult> {
  const size = Math.max(1, inp.batchSize ?? DEFAULT_BATCH_SIZE);
  const batches: Fragrance[][] = [];
  for (let i = 0; i < inp.fragrances.length; i += size) batches.push(inp.fragrances.slice(i, i + size));

  const state = {
    context: 'You are screening every perfume in a catalog for a perfume recommendation assistant. Judge each perfume only on how well it fits this user\'s request.',
    user_request: inp.message,
    what_we_know: describeFacets(inp.facets),
    ...(inp.refs.length ? { reference_perfumes_the_user_likes: inp.refs.map((r) => `${r.name} by ${r.brand}`) } : {}),
  };

  const scores = new Map<string, number>();
  let failed = 0;
  let authError: JevError | undefined;
  let offset = 0;
  const jobs = batches.map((batch, b) => {
    const start = offset;
    offset += batch.length;
    const qs: QuestionSet = {};
    const keyToPid = new Map<string, string>();
    batch.forEach((fr, i) => {
      const key = keyFor(fr.pid, start + i);
      keyToPid.set(key, fr.pid);
      qs[key] = noul(`Would this perfume be a strong pick for the request? ${compactProfile(fr)}`, CRITERIA);
    });
    return inp.decider.decide(state, qs, { signal: inp.signal, label: `screen ${b + 1}/${batches.length}` })
      .then(({ answers }) => {
        for (const [key, a] of Object.entries(answers as Record<string, Answer>)) {
          const pid = keyToPid.get(key);
          if (pid && a.type === 'noul') scores.set(pid, (a as NoulAnswer).noul);
        }
      })
      .catch((e: unknown) => {
        if (inp.signal?.aborted) throw e;
        if (e instanceof JevError && e.status === 401) authError = e;
        failed++;
      });
  });
  await Promise.all(jobs);
  // A bad key fails every batch: surface it rather than silently ranking without Jev.
  if (authError && failed === batches.length) throw authError;

  return { scores, screened: inp.fragrances.length, batches: batches.length, failedBatches: failed };
}
