/** Duration verification is separate from counts/metrics that quotes may directly establish. */
export function isDurationRequirement(text: string): boolean {
  return /\b\d+(?:\.\d+)?\s*\+?\s*(?:years?|yrs?|months?)\b/i.test(text)
    || /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred|several|multiple|a few|a|an)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?\s+(?:years?|yrs?|months?)\b/i.test(text)
    || /\bhalf[- ](?:a[- ])?(?:years?|months?)\b/i.test(text)
    || /(?:\d+|[零一二三四五六七八九十百两数半几多余]+|若干)\s*(?:[-–至到]\s*(?:\d+|[零一二三四五六七八九十百两]+))?\s*(?:年|个月|月)/u.test(text);
}
