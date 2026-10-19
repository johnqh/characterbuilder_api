/**
 * The distribution endpoint's logic: demographics -> per-trait probability maps.
 *
 * Hybrid design: `buildDistributions` is the deterministic STATIC base
 * (ancestry/age/health/sex weighting from characterbuilder_types). When a fine
 * sub-population is named (e.g. "Korean"), the static tables only know the broad
 * ancestry, so we ask the `character-distribution` LLM endpoint for per-trait
 * ODDS overrides and fold them in. The LLM call is best-effort: any failure
 * falls back to the static base.
 */
import {
  buildDistributions,
  type Demographics,
  type DistributionResponse,
} from '@sudobility/characterbuilder_types';
import { log } from '../lib/log';
import { refineDistributionsRemote } from './shapeshyft';

/** Build (and, for a named sub-population, LLM-refine) the trait distribution. */
export async function getDistributions(
  demo: Demographics
): Promise<DistributionResponse> {
  // Only pay for the LLM when the static tables can't express it (sub-population).
  const overrides = demo.subPopulation
    ? await refineDistributionsRemote(demo).catch((err) => {
        log('warn', '[distribution] LLM refine failed; using static base', {
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      })
    : undefined;
  const distributions = buildDistributions(demo, overrides);
  return { demographics: demo, distributions };
}
