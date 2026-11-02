export interface Chunk {
  id: string;
  source: string;
  /** Heading path, e.g. "Alex Rivera > Experience > Backend Engineer". */
  heading: string;
  text: string;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

const FENCE = /^\s*```/;

/** Splits a section body into bullets, paragraphs and fenced code blocks (kept verbatim, newlines included). */
function blocks(lines: string[]): string[] {
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(para.join(" "));
    para = [];
  };
  let fence: string[] | null = null;
  for (const raw of lines) {
    if (fence) {
      fence.push(raw.trimEnd());
      if (FENCE.test(raw)) {
        out.push(fence.join("\n"));
        fence = null;
      }
      continue;
    }
    const line = raw.trim();
    if (FENCE.test(line)) {
      flush();
      fence = [raw.trimEnd()];
    } else if (!line) flush();
    else if (BULLET.test(line)) {
      flush();
      out.push(line.replace(BULLET, "").trim());
    } else para.push(line);
  }
  flush();
  if (fence) out.push(fence.join("\n"));
  return out;
}

/** Heading-aware chunking: one chunk per section, packed up to `maxChars`, never mixing sections. */
export function chunkMarkdown(source: string, markdown: string, maxChars = 400): Chunk[] {
  const chunks: Chunk[] = [];
  const stack: string[] = [];
  let body: string[] = [];

  const emit = () => {
    const heading = stack.filter(Boolean).join(" > ");
    let current: string[] = [];
    const push = () => {
      if (!current.length) return;
      chunks.push({ id: `${source}#${chunks.length}`, source, heading, text: current.join("\n") });
      current = [];
    };
    for (const block of blocks(body)) {
      const size = current.join("\n").length + block.length + 1;
      if (current.length && size > maxChars) push();
      current.push(block);
    }
    push();
    body = [];
  };

  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) inFence = !inFence;
    const h = !inFence ? line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/) : null;
    if (h) {
      emit();
      const level = h[1]!.length;
      stack.length = level - 1;
      stack[level - 1] = h[2]!;
      for (let i = 0; i < stack.length; i++) stack[i] ??= "";
    } else body.push(line);
  }
  emit();
  return chunks;
}
