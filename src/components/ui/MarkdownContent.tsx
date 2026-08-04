import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import { splitByTerms } from "../../lib/highlight";

/** Only the shape of a rendered node this walk needs; the tree is hast. */
type RenderedNode = { type?: string; tagName?: string; value?: string; children?: unknown };

/**
 * Marks search terms in the rendered tree rather than in the markdown source,
 * so a term is still found when emphasis or a link splits it, and no `<mark>`
 * is ever spliced into syntax the parser has not read yet.
 */
function rehypeHighlightTerms(terms: string[]) {
  return () => (tree: unknown) => markNode(tree as RenderedNode, terms);
}

function markNode(node: RenderedNode, terms: string[]): void {
  if (!Array.isArray(node.children)) return;
  const marked: RenderedNode[] = [];
  for (const child of node.children as RenderedNode[]) {
    // Code is quoted verbatim, and marking inside it would misreport it.
    if (child.type !== "text" || isCode(child)) {
      if (!isCode(child)) markNode(child, terms);
      marked.push(child);
      continue;
    }
    for (const part of splitByTerms(child.value ?? "", terms)) {
      marked.push(part.match
        ? {
          type: "element",
          tagName: "mark",
          properties: { className: ["search-mark"] },
          children: [{ type: "text", value: part.value }],
        } as RenderedNode
        : { type: "text", value: part.value });
    }
  }
  node.children = marked;
}

function isCode(node: RenderedNode): boolean {
  return node.type === "element" && (node.tagName === "code" || node.tagName === "pre");
}

export function MarkdownContent({ content, highlight }: { content: string; highlight?: string[] }) {
  const rehypePlugins = useMemo(
    () => highlight?.length ? [rehypeHighlightTerms(highlight)] : undefined,
    [highlight],
  );
  return <div className="markdown-content">
    <ReactMarkdown remarkPlugins={[remarkBreaks]} rehypePlugins={rehypePlugins}>{content}</ReactMarkdown>
  </div>;
}
