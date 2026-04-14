import { describe, it, expect } from "vitest";
import { StreamingMarkdownFilter } from "./markdown-filter.js";

/** Feed entire string at once (one-shot). */
function oneShot(input: string): string {
  const f = new StreamingMarkdownFilter();
  return f.feed(input) + f.flush();
}

/** Feed one character at a time (worst-case streaming). */
function charByChar(input: string): string {
  const f = new StreamingMarkdownFilter();
  let out = "";
  for (const ch of input) out += f.feed(ch);
  out += f.flush();
  return out;
}

/** Feed in random-sized chunks (fuzz-style streaming). */
function randomChunks(input: string, seed = 42): string {
  const f = new StreamingMarkdownFilter();
  let out = "";
  let pos = 0;
  let s = seed;
  while (pos < input.length) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const size = (s % 5) + 1;
    out += f.feed(input.slice(pos, pos + size));
    pos += size;
  }
  out += f.flush();
  return out;
}

/**
 * Assert that one-shot, char-by-char, and random-chunk streaming all
 * produce the same expected output.
 */
function expectFilter(input: string, expected: string) {
  expect(oneShot(input)).toBe(expected);
  expect(charByChar(input)).toBe(expected);
  expect(randomChunks(input)).toBe(expected);
}

// ---------------------------------------------------------------------------
// Tests migrated from markdownToPlainText (now using StreamingMarkdownFilter)
// ---------------------------------------------------------------------------

describe("markdown filtering (migrated from markdownToPlainText)", () => {
  it("strips code blocks but keeps content", () => {
    const input = "before\n```js\nconst x = 1;\n```\nafter";
    const result = oneShot(input);
    expect(result).toContain("const x = 1;");
    expect(result).not.toContain("```");
  });

  it("removes image markdown", () => {
    expect(oneShot("![alt](url)")).toBe("");
  });

  it("strips bold/italic markers", () => {
    const result = oneShot("**bold** and *italic*");
    expect(result).toContain("bold");
    expect(result).toContain("italic");
    expect(result).not.toContain("*italic*");
  });

  it("strips table with surrounding text", () => {
    const input = "结果如下：\n| A | B |\n|---|---|\n| 1 | 2 |\n完毕。";
    const result = oneShot(input);
    expect(result).toContain("结果如下：");
    expect(result).toContain("完毕。");
    expect(result).not.toContain("|");
    expect(result).not.toContain("---");
    expect(result).toContain("A");
    expect(result).toContain("2");
  });
});

// ---------------------------------------------------------------------------
// StreamingMarkdownFilter
// ---------------------------------------------------------------------------

describe("StreamingMarkdownFilter", () => {

  // ---- Plain text -----------------------------------------------------------

  describe("plain text passthrough", () => {
    it("passes plain text unchanged", () => {
      expectFilter("hello world", "hello world");
    });

    it("passes empty string", () => {
      expectFilter("", "");
    });

    it("preserves newlines in plain text", () => {
      expectFilter("line1\nline2\nline3", "line1\nline2\nline3");
    });

    it("preserves Chinese text", () => {
      expectFilter("你好世界", "你好世界");
    });

    it("preserves mixed CJK and ASCII", () => {
      expectFilter("Hello 你好 World 世界", "Hello 你好 World 世界");
    });
  });

  // ---- Code fences ----------------------------------------------------------

  describe("code fences", () => {
    it("strips fence markers but keeps content (one-shot)", () => {
      expect(oneShot("```\ncode\n```\n")).toBe("code\n");
    });

    it("strips fence with language tag (one-shot)", () => {
      expect(oneShot("```typescript\nconst x = 1;\n```\n")).toBe("const x = 1;\n");
    });

    it("preserves text before and after fence (one-shot)", () => {
      expect(oneShot("before\n```\ncode\n```\nafter")).toBe("before\ncode\nafter");
    });

    it("preserves markdown inside a code fence verbatim (one-shot)", () => {
      expect(oneShot("```\n**bold** *italic* ~~strike~~\n```\n"))
        .toBe("**bold** *italic* ~~strike~~\n");
    });

    it("handles multiple fenced blocks (one-shot)", () => {
      expect(oneShot("```\nblock1\n```\ntext\n```\nblock2\n```\n"))
        .toBe("block1\ntext\nblock2\n");
    });

    it("code fence at end of input (one-shot)", () => {
      expect(oneShot("```\ncode\n```")).toBe("code\n");
    });

    it("streaming: newline after ``` becomes content when split", () => {
      const f = new StreamingMarkdownFilter();
      const out = f.feed("```") + f.feed("\ncode\n```\n") + f.flush();
      expect(out).toBe("\ncode\n");
    });

    it("streaming: ``` and newline in same chunk works correctly", () => {
      const f = new StreamingMarkdownFilter();
      const out = f.feed("```\n") + f.feed("code\n") + f.feed("```\n") + f.flush();
      expect(out).toBe("code\n");
    });

    it("code fence with language tag in single chunk", () => {
      const f = new StreamingMarkdownFilter();
      const out = f.feed("```typescript\n") + f.feed("const x = 1;\n") + f.feed("```\n") + f.flush();
      expect(out).toBe("const x = 1;\n");
    });
  });

  // ---- Inline code ----------------------------------------------------------

  describe("inline code", () => {
    it("strips backticks, keeps content", () => {
      expectFilter("use `fmt.Println` here", "use fmt.Println here");
    });

    it("handles inline code at start of body", () => {
      expectFilter("text\n`code`", "text\ncode");
    });

    it("unclosed backtick before newline restores the backtick", () => {
      expectFilter("hello `world\nnext", "hello `world\nnext");
    });

    it("inline code with special chars", () => {
      expectFilter("run `rm -rf /` carefully", "run rm -rf / carefully");
    });
  });

  // ---- Images ---------------------------------------------------------------

  describe("images", () => {
    it("strips complete image markdown", () => {
      expectFilter("![alt](http://example.com/img.png)", "");
    });

    it("strips image with surrounding text", () => {
      expectFilter("before ![alt](url) after", "before  after");
    });

    it("preserves incomplete image syntax (no closing paren)", () => {
      const f = new StreamingMarkdownFilter();
      const result = f.feed("![alt](url") + f.flush();
      expect(result).toBe("![alt](url");
    });

    it("preserves ![ when ] is not followed by (", () => {
      expectFilter("![not an image] text", "![not an image] text");
    });

    it("strips multiple images", () => {
      expectFilter("![a](u1)![b](u2)", "");
    });
  });

  // ---- Strikethrough --------------------------------------------------------

  describe("strikethrough", () => {
    it("strips ~~ markers, keeps content", () => {
      expectFilter("~~deleted~~", "deleted");
    });

    it("strips strikethrough with surrounding text", () => {
      expectFilter("keep ~~this~~ too", "keep this too");
    });

    it("unclosed ~~ at EOF restores markers", () => {
      const f = new StreamingMarkdownFilter();
      const result = f.feed("~~unclosed") + f.flush();
      expect(result).toBe("~~unclosed");
    });
  });

  // ---- Bold (** preserved) --------------------------------------------------

  describe("bold (** preserved)", () => {
    it("preserves ** bold markers", () => {
      expectFilter("**bold**", "**bold**");
    });

    it("preserves bold in context", () => {
      expectFilter("this is **very** important", "this is **very** important");
    });

    it("preserves multiple bold segments", () => {
      expectFilter("**a** and **b**", "**a** and **b**");
    });
  });

  // ---- Italic (* stripped) --------------------------------------------------

  describe("italic (* stripped)", () => {
    it("strips single * markers", () => {
      expectFilter("*italic*", "italic");
    });

    it("strips italic with surrounding text", () => {
      expectFilter("this is *emphasized* text", "this is emphasized text");
    });

    it("unclosed italic before newline restores *", () => {
      expectFilter("*unclosed\nnext", "*unclosed\nnext");
    });

    it("* followed by space is not italic", () => {
      expectFilter("3 * 4 = 12", "3 * 4 = 12");
    });

    it("* at end of line is not italic", () => {
      expectFilter("3 *\nnext", "3 *\nnext");
    });
  });

  // ---- Bold-italic (*** stripped) -------------------------------------------

  describe("bold-italic (*** stripped)", () => {
    it("strips *** markers", () => {
      expectFilter("***bold italic***", "bold italic");
    });

    it("strips bold-italic with surrounding text", () => {
      expectFilter("this is ***very strong*** text", "this is very strong text");
    });

    it("unclosed *** at EOF restores markers", () => {
      const f = new StreamingMarkdownFilter();
      const result = f.feed("***unclosed") + f.flush();
      expect(result).toBe("***unclosed");
    });
  });

  // ---- Blockquotes ----------------------------------------------------------

  describe("blockquotes", () => {
    it("strips > prefix with space", () => {
      expectFilter("> quoted text", "quoted text");
    });

    it("strips > prefix without space", () => {
      expectFilter(">quoted", "quoted");
    });

    it("strips multiline blockquote", () => {
      expectFilter("> line1\n> line2", "line1\nline2");
    });

    it("strips blockquote with inline formatting", () => {
      expectFilter("> **bold** in quote", "**bold** in quote");
    });
  });

  // ---- Headings -------------------------------------------------------------

  describe("headings", () => {
    it("preserves H1 marker", () => {
      expectFilter("# Title", "# Title");
    });

    it("preserves H2 marker", () => {
      expectFilter("## Subtitle", "## Subtitle");
    });

    it("preserves H3 marker", () => {
      expectFilter("### Section", "### Section");
    });

    it("preserves H4 marker", () => {
      expectFilter("#### Subsection", "#### Subsection");
    });

    it("strips H5 marker", () => {
      expectFilter("##### Small Heading", "Small Heading");
    });

    it("strips H6 marker", () => {
      expectFilter("###### Tiny Heading", "Tiny Heading");
    });

    it("heading followed by body text", () => {
      expectFilter("## Title\nbody text", "## Title\nbody text");
    });

    it("H5 followed by body text", () => {
      expectFilter("##### Title\nbody text", "Title\nbody text");
    });
  });

  // ---- Horizontal rules -----------------------------------------------------

  describe("horizontal rules", () => {
    it("strips --- rule", () => {
      expectFilter("before\n---\nafter", "before\nafter");
    });

    it("strips *** rule", () => {
      expectFilter("before\n***\nafter", "before\nafter");
    });

    it("strips ___ rule", () => {
      expectFilter("before\n___\nafter", "before\nafter");
    });

    it("strips - - - rule (with spaces)", () => {
      expectFilter("before\n- - -\nafter", "before\nafter");
    });

    it("strips rule at end of input", () => {
      expectFilter("text\n---", "text\n");
    });

    it("does not strip -- (only two dashes)", () => {
      expectFilter("text\n--\nnext", "text\n--\nnext");
    });
  });

  // ---- Tables ---------------------------------------------------------------

  describe("tables", () => {
    it("strips | delimiters and converts cells to tab-separated text", () => {
      const input = "| Header1 | Header2 |\n|---------|---------||\n| Cell1 | Cell2 |";
      const result = oneShot(input);
      expect(result).not.toContain("|");
      expect(result).toContain("Header1");
      expect(result).toContain("Header2");
      expect(result).toContain("Cell1");
      expect(result).toContain("Cell2");
    });

    it("removes separator row entirely", () => {
      const input = "| A | B |\n|---|---|\n| 1 | 2 |";
      const result = oneShot(input);
      expect(result).not.toContain("---");
      expect(result).not.toContain("|");
      expect(result).toContain("A");
      expect(result).toContain("B");
      expect(result).toContain("1");
      expect(result).toContain("2");
    });

    it("produces tab-separated cell values", () => {
      expect(oneShot("| A | B |\n")).toBe("A\tB\n");
    });

    it("removes separator with colons (alignment markers)", () => {
      expect(oneShot("|:---|---:|\n")).toBe("");
    });

    it("table with surrounding text", () => {
      const input = "结果如下：\n| A | B |\n|---|---|\n| 1 | 2 |\n完毕。";
      const result = oneShot(input);
      expect(result).toContain("结果如下：");
      expect(result).toContain("完毕。");
      expect(result).not.toContain("|");
      expect(result).not.toContain("---");
      expect(result).toContain("A");
      expect(result).toContain("2");
    });

    it("table with emoji content", () => {
      const table = [
        "| 微信表情 | Emoji |",
        "|----------|-------|",
        "| [微笑] | 😊 |",
        "| [撇嘴] | 😣 |",
      ].join("\n");
      const result = oneShot(table);
      expect(result).not.toContain("|");
      expect(result).not.toContain("---");
      expect(result).toContain("微信表情");
      expect(result).toContain("😊");
      expect(result).toContain("[微笑]");
    });

    it("table at EOF without trailing newline", () => {
      const result = oneShot("| A | B |");
      expect(result).toBe("A\tB");
    });

    it("streaming: table row split across chunks", () => {
      const f = new StreamingMarkdownFilter();
      const out = f.feed("| A |") + f.feed(" B |\n") + f.flush();
      expect(out).toBe("A\tB\n");
    });

    it("streaming: separator row split across chunks", () => {
      const f = new StreamingMarkdownFilter();
      const out = f.feed("|---") + f.feed("|---|\n") + f.flush();
      expect(out).toBe("");
    });

    it("| at SOL in non-table context (single |)", () => {
      expect(oneShot("| just text\n")).toBe("just text\n");
    });
  });

  // ---- Lists ----------------------------------------------------------------

  describe("lists", () => {
    it("preserves non-indented - list item", () => {
      expectFilter("- item 1\n- item 2", "- item 1\n- item 2");
    });

    it("preserves non-indented * list item", () => {
      expectFilter("* item 1\n* item 2", "* item 1\n* item 2");
    });

    it("preserves indented - list item (one-shot)", () => {
      expect(oneShot("  - nested item")).toBe("  - nested item");
    });

    it("preserves deeply indented list item (one-shot)", () => {
      expect(oneShot("      - deep item")).toBe("      - deep item");
    });

    it("preserves indented * list item (one-shot)", () => {
      expect(oneShot("  * nested")).toBe("  * nested");
    });

    it("preserves mixed nesting (one-shot)", () => {
      expect(oneShot("- top\n  - nested\n- top2")).toBe("- top\n  - nested\n- top2");
    });

    it("streaming: indented list with chunked input", () => {
      const f = new StreamingMarkdownFilter();
      const out = f.feed("  - nested item") + f.flush();
      expect(out).toBe("  - nested item");

      const f2 = new StreamingMarkdownFilter();
      const out2 = f2.feed("  ") + f2.feed("- nested") + f2.flush();
      expect(out2).toBe("  - nested");
    });
  });

  // ---- Combined patterns ----------------------------------------------------

  describe("combined patterns", () => {
    it("heading + bold + inline code", () => {
      expectFilter(
        "## **Title**\nUse `code` here.",
        "## **Title**\nUse code here.",
      );
    });

    it("blockquote + italic + strikethrough", () => {
      expectFilter(
        "> *italic* and ~~strike~~",
        "italic and strike",
      );
    });

    it("code fence + inline code + image (one-shot)", () => {
      expect(oneShot("```\nfenced\n```\n`inline` ![img](url)"))
        .toBe("fenced\ninline ");
    });

    it("mixed bold and bold-italic", () => {
      expectFilter(
        "**bold** then ***bold-italic*** then **bold2**",
        "**bold** then bold-italic then **bold2**",
      );
    });

    it("complex document", () => {
      const input = [
        "## Summary",
        "",
        "> This is a quote.",
        "",
        "Here is **important** and *emphasized* text.",
        "",
        "```python",
        "print('hello')",
        "```",
        "",
        "- item 1",
        "  - nested",
        "- item 2",
        "",
        "---",
        "",
        "End.",
      ].join("\n");

      const result = oneShot(input);
      expect(result).toContain("## Summary");
      expect(result).toContain("**important**");
      expect(result).toContain("emphasized");
      expect(result).not.toContain("*emphasized*");
      expect(result).toContain("print('hello')");
      expect(result).not.toContain("```");
      expect(result).toContain("- item 1");
      expect(result).toContain("- nested");
      expect(result).not.toContain("---");
      expect(result).toContain("End.");
    });
  });

  // ---- Hold-back / buffering ------------------------------------------------

  describe("hold-back logic", () => {
    it("holds trailing * until resolved as italic", () => {
      const f = new StreamingMarkdownFilter();
      const r1 = f.feed("hello *");
      expect(r1).toBe("hello ");
      const r2 = f.feed("world* end");
      expect(r2).toBe("world end");
      expect(f.flush()).toBe("");
    });

    it("holds trailing * then resolves as non-italic (space follows)", () => {
      const f = new StreamingMarkdownFilter();
      const r1 = f.feed("3 *");
      expect(r1).toBe("3 ");
      const r2 = f.feed(" 4");
      expect(r2).toBe("* 4");
      expect(f.flush()).toBe("");
    });

    it("holds trailing ** until resolved", () => {
      const f = new StreamingMarkdownFilter();
      const r1 = f.feed("text **");
      expect(r1).toBe("text ");
      const r2 = f.feed("bold** end");
      expect(r2).toBe("**bold** end");
      expect(f.flush()).toBe("");
    });

    it("holds trailing ** then resolves as *** (bold-italic)", () => {
      const f = new StreamingMarkdownFilter();
      const r1 = f.feed("a **");
      expect(r1).toBe("a ");
      const r2 = f.feed("*bi*** end");
      expect(r2).toBe("bi end");
      expect(f.flush()).toBe("");
    });

    it("holds trailing ~ until resolved", () => {
      const f = new StreamingMarkdownFilter();
      const r1 = f.feed("text ~");
      expect(r1).toBe("text ");
      const r2 = f.feed("~strike~~ end");
      expect(r2).toBe("strike end");
      expect(f.flush()).toBe("");
    });

    it("holds trailing ! until resolved", () => {
      const f = new StreamingMarkdownFilter();
      const r1 = f.feed("see !");
      expect(r1).toBe("see ");
      const r2 = f.feed("[alt](url) end");
      expect(r2).toBe(" end");
      expect(f.flush()).toBe("");
    });

    it("trailing ! not followed by [ passes through", () => {
      const f = new StreamingMarkdownFilter();
      const r1 = f.feed("wow!");
      expect(r1).toBe("wow");
      const r2 = f.feed(" great");
      expect(r2).toBe("! great");
      expect(f.flush()).toBe("");
    });
  });

  // ---- EOF handling ---------------------------------------------------------

  describe("EOF / flush behavior", () => {
    it("flush emits held-back chars", () => {
      const f = new StreamingMarkdownFilter();
      f.feed("trailing *");
      expect(f.flush()).toBe("*");
    });

    it("flush emits unclosed inline code", () => {
      const f = new StreamingMarkdownFilter();
      const r = f.feed("unclosed `code") + f.flush();
      expect(r).toBe("unclosed `code");
    });

    it("flush emits unclosed strikethrough", () => {
      const f = new StreamingMarkdownFilter();
      const r = f.feed("~~unclosed") + f.flush();
      expect(r).toBe("~~unclosed");
    });

    it("flush emits unclosed bold-italic", () => {
      const f = new StreamingMarkdownFilter();
      const r = f.feed("***unclosed") + f.flush();
      expect(r).toBe("***unclosed");
    });

    it("flush emits unclosed italic", () => {
      const f = new StreamingMarkdownFilter();
      const r = f.feed("*unclosed") + f.flush();
      expect(r).toBe("*unclosed");
    });

    it("flush emits unclosed image", () => {
      const f = new StreamingMarkdownFilter();
      const r = f.feed("![alt text") + f.flush();
      expect(r).toBe("![alt text");
    });

    it("double flush is idempotent", () => {
      const f = new StreamingMarkdownFilter();
      const feedOut = f.feed("hello **bold**");
      const r1 = f.flush();
      const r2 = f.flush();
      expect(feedOut + r1 + r2).toBe("hello **bold**");
      expect(r2).toBe("");
    });
  });

  // ---- Streaming consistency ------------------------------------------------

  describe("streaming consistency (one-shot vs char-by-char)", () => {
    const cases: [string, string][] = [
      ["plain text", "plain text"],
      ["**bold** text", "**bold** text"],
      ["*italic* text", "italic text"],
      ["***bi*** text", "bi text"],
      ["~~strike~~ text", "strike text"],
      ["`code` text", "code text"],
      ["![img](url)", ""],
      ["> blockquote", "blockquote"],
      ["##### H5 heading", "H5 heading"],
      ["## H2 heading", "## H2 heading"],
      ["before\n---\nafter", "before\nafter"],
      [
        "Here **bold** and *italic* `code` ~~strike~~ ***bi*** end",
        "Here **bold** and italic code strike bi end",
      ],
    ];

    for (const [input, expected] of cases) {
      it(`consistent for: ${JSON.stringify(input).slice(0, 50)}`, () => {
        expectFilter(input, expected);
      });
    }

    it("code fence: one-shot vs line-chunked streaming", () => {
      const input = "```\nfenced\n```\nafter";
      expect(oneShot(input)).toBe("fenced\nafter");
      const f = new StreamingMarkdownFilter();
      const out = f.feed("```\n") + f.feed("fenced\n") + f.feed("```\n") + f.feed("after") + f.flush();
      expect(out).toBe("fenced\nafter");
    });

    it("indented list: one-shot vs whole-line streaming", () => {
      const input = "  - nested";
      expect(oneShot(input)).toBe("  - nested");
      const f = new StreamingMarkdownFilter();
      const out = f.feed("  - nested") + f.flush();
      expect(out).toBe("  - nested");
    });
  });

  // ---- Edge cases -----------------------------------------------------------

  describe("edge cases", () => {
    it("adjacent bold and italic: **b***i*", () => {
      const result = oneShot("**b***i*");
      expect(result).toContain("**b**");
      expect(charByChar("**b***i*")).toBe(oneShot("**b***i*"));
    });

    it("single * at start of line followed by space (list marker)", () => {
      expectFilter("* item\n* item2", "* item\n* item2");
    });

    it("single - at start of line followed by space (list marker)", () => {
      expectFilter("- item\n- item2", "- item\n- item2");
    });

    it("only whitespace", () => {
      expectFilter("   \n  \n", "   \n  \n");
    });

    it("only newlines", () => {
      expectFilter("\n\n\n", "\n\n\n");
    });

    it("nested blockquote (>>)", () => {
      expectFilter(">> deeply nested", "> deeply nested");
    });

    it("multiple images on same line", () => {
      expectFilter(
        "see ![a](u1) and ![b](u2) end",
        "see  and  end",
      );
    });

    it("bold inside code fence is not processed (one-shot)", () => {
      expect(oneShot("```\n**not bold**\n```\n")).toBe("**not bold**\n");
    });

    it("handles very long input", () => {
      const longText = "word ".repeat(1000);
      expectFilter(longText, longText);
    });

    it("alternating italic and bold", () => {
      expectFilter(
        "*a* **b** *c* **d**",
        "a **b** c **d**",
      );
    });

    it("horizontal rule vs list item at SOL", () => {
      expectFilter("- - -\n", "");
      expectFilter("- item", "- item");
    });
  });
});
