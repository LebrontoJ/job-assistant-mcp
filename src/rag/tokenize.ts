const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on",
  "or", "the", "to", "with", "we", "you", "our", "your", "will", "have", "has", "this", "that",
  "experience", "strong", "knowledge", "ability", "working", "work", "using", "use",
]);

// Only plain words are stemmed; tokens like "node.js" or "ci/cd" must stay intact.
const stem = (t: string) =>
  /^[a-z]+$/.test(t) && t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t;

/**
 * Lowercased word tokens (keeping c++, ci/cd, node.js intact) plus character bigrams for
 * Han text, so Chinese profiles work without a segmenter.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/\p{Script=Han}+|[a-z0-9][a-z0-9+#./]*/gu)) {
    const tok = m[0];
    if (/\p{Script=Han}/u.test(tok)) {
      if (tok.length === 1) out.push(tok);
      for (let i = 0; i + 1 < tok.length; i++) out.push(tok.slice(i, i + 2));
      continue;
    }
    const t = tok.replace(/[./]+$/, "");
    if (!t) continue;
    if (!STOP.has(t)) out.push(stem(t));
    // "Python/FastAPI" must be findable by either half; "ci/cd" stays findable as a whole too.
    if (t.includes("/")) {
      for (const part of t.split("/")) if (part && !STOP.has(part)) out.push(stem(part));
    }
  }
  return out;
}
