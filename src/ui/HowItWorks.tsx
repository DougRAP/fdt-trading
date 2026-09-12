/**
 * "How it works" section (T6, D10, D11). Renders src/content/how-it-works.md unchanged at runtime.
 * Transformations happen only in memory: display-math delimiters normalized for remark-math,
 * two passages wrapped in <details>, worked-example labels styled. No images, charts or chat.
 */
import { useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import raw from "../content/how-it-works.md?raw";

export const LIVE_EXAMPLE_UNAVAILABLE = "Live example unavailable: synthetic snapshot has no timestamp or dated contract";
export const ILLUSTRATIVE_LABEL = "Illustrative — synthetic inputs.";

/** The markdown uses \[ … \] display math; remark-math expects $$ fences. Content is not edited on disk. */
export function normalizeMath(md: string): string {
  return md.replace(/^\\\[\s*$/gm, "$$$$").replace(/^\\\]\s*$/gm, "$$$$");
}

export interface Segment {
  kind: "md" | "details";
  summary?: string;
  text: string;
}

const DERIVATION_START = "The mathematical decomposition is:";
const FUTURE_START = "## What we still need to learn";

/** Split into visible markdown and two collapsible passages (derivation, future research). */
export function splitSections(md: string): Segment[] {
  const out: Segment[] = [];
  const dStart = md.indexOf(DERIVATION_START);
  const fStart = md.indexOf(FUTURE_START);
  let cursor = 0;
  if (dStart >= 0) {
    const open = md.indexOf("$$", dStart);
    const close = open >= 0 ? md.indexOf("$$", open + 2) : -1;
    if (close >= 0) {
      const dEnd = close + 2;
      out.push({ kind: "md", text: md.slice(cursor, dStart) });
      out.push({ kind: "details", summary: "Derivation: how u changes with Q and A", text: md.slice(dStart, dEnd) });
      cursor = dEnd;
    }
  }
  if (fStart >= cursor) {
    out.push({ kind: "md", text: md.slice(cursor, fStart) });
    out.push({ kind: "details", summary: "What we still need to learn (future research questions)", text: md.slice(fStart) });
  } else {
    out.push({ kind: "md", text: md.slice(cursor) });
  }
  return out.filter((s) => s.text.trim().length > 0);
}

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

const components: Components = {
  // Page already has an h1 ("Campaign"); shift the document one level down.
  h1: ({ children }) => <h2 id="how-title">{children}</h2>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h4>{children}</h4>,
  table: ({ children }) => (
    <div className="cp-scroll">
      <table>{children}</table>
    </div>
  ),
  strong: ({ children }) => {
    const t = textOf(children);
    if (t.startsWith("Illustrative — synthetic inputs")) return <strong className="cp-illustrative">{children}</strong>;
    return <strong>{children}</strong>;
  },
};

function Md({ text }: { text: string }) {
  return (
    <div className="cp-how-md">
      <ReactMarkdown remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]} rehypePlugins={[rehypeKatex]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

const SEGMENTS = splitSections(normalizeMath(raw));

export function HowItWorks({ selectedRoot, defaultExample = false }: { selectedRoot: string | null; defaultExample?: boolean }) {
  const [example, setExample] = useState(defaultExample);
  return (
    <section id="how-it-works" className="cp-how" aria-labelledby="how-title">
      <div className="cp-how-inner">
        <div className="cp-row">
          <span className="cp-small">Explanation · model v0.1 · research hypothesis, unvalidated · worked examples are synthetic</span>
          <button type="button" aria-pressed={example} onClick={() => setExample((v) => !v)}>
            Use selected market{selectedRoot ? ` (${selectedRoot})` : ""}
          </button>
        </div>
        {example && (
          <p className="cp-flag" role="status">
            {LIVE_EXAMPLE_UNAVAILABLE}. The worked examples below stay synthetic; the ticket, model settings and ledgers are unchanged.
          </p>
        )}
        {SEGMENTS.map((s, i) =>
          s.kind === "details" ? (
            <details key={i}>
              <summary>{s.summary}</summary>
              <Md text={s.text} />
            </details>
          ) : (
            <Md key={i} text={s.text} />
          ),
        )}
      </div>
    </section>
  );
}
