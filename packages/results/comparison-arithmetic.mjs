// Internal trusted-policy arithmetic over prevalidated quality objects. No eligibility, authentication,
// identity or privacy claim, no IO and no mutation; the fixed Captain policy in comparison.mjs is the only caller.
const ALLOWED_MODES=new Set(['AUTOMATED_ONLY','REVIEWED']);
const roundedDifference=(candidate,baseline)=>Number((candidate-baseline).toFixed(4));

/**
 * Fixed-precision descriptive quality deltas between two prevalidated quality objects.
 * For any disposition outside AUTOMATED_ONLY and REVIEWED this returns a fresh all-null result,
 * never converting an unknown delta to zero. For the two allowed modes automated is the
 * four-decimal-rounded candidate-minus-baseline difference; REVIEWED additionally yields humanUI
 * and quality with the same subtraction and precision. Throws when an allowed mode lacks its
 * input; no policy, identity, eligibility or authentication check happens here.
 */
export function projectQualityDeltas({mode,baseline,candidate}){
  const result={automated:null,humanUI:null,quality:null};
  if(!ALLOWED_MODES.has(mode))return result;
  if(baseline==null||candidate==null)throw new TypeError('Missing quality input for an allowed comparison mode');
  result.automated=roundedDifference(candidate.automated,baseline.automated);
  if(mode==='REVIEWED'){
    result.humanUI=roundedDifference(candidate.humanUI,baseline.humanUI);
    result.quality=roundedDifference(candidate.quality,baseline.quality);
  }
  return result;
}
