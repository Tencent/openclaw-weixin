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
  it("preserves code blocks with markers", () => {
    const input = "before\n```js\nconst x = 1;\n```\nafter";
    expect(oneShot(input)).toBe(input);
  });

  it("removes image markdown", () => {
    expect(oneShot("![alt](url)")).toBe("");
  });

  it("preserves bold and non-CJK italic markers", () => {
    const result = oneShot("**bold** and *italic*");
    expect(result).toBe("**bold** and *italic*");
  });

  it("preserves table with surrounding text", () => {
    const input = "结果如下：\n| A | B |\n|---|---|\n| 1 | 2 |\n完毕。";
    expect(oneShot(input)).toBe(input);
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

  // ---- Code fences (passed through) ----------------------------------------

  describe("code fences (passed through)", () => {
    it("preserves fence markers and content (one-shot)", () => {
      expect(oneShot("```\ncode\n```\n")).toBe("```\ncode\n```\n");
    });

    it("preserves fence with language tag (one-shot)", () => {
      expect(oneShot("```typescript\nconst x = 1;\n```\n")).toBe("```typescript\nconst x = 1;\n```\n");
    });

    it("preserves text before and after fence (one-shot)", () => {
      expect(oneShot("before\n```\ncode\n```\nafter")).toBe("before\n```\ncode\n```\nafter");
    });

    it("preserves markdown inside a code fence verbatim (one-shot)", () => {
      expect(oneShot("```\n**bold** *italic* ~~strike~~\n```\n"))
        .toBe("```\n**bold** *italic* ~~strike~~\n```\n");
    });

    it("handles multiple fenced blocks (one-shot)", () => {
      expect(oneShot("```\nblock1\n```\ntext\n```\nblock2\n```\n"))
        .toBe("```\nblock1\n```\ntext\n```\nblock2\n```\n");
    });

    it("code fence at end of input (one-shot)", () => {
      expect(oneShot("```\ncode\n```")).toBe("```\ncode\n```");
    });

    it("streaming: newline after ``` becomes content when split", () => {
      const f = new StreamingMarkdownFilter();
      const out = f.feed("```") + f.feed("\ncode\n```\n") + f.flush();
      expect(out).toBe("```\ncode\n```\n");
    });

    it("streaming: ``` and newline in same chunk works correctly", () => {
      const f = new StreamingMarkdownFilter();
      const out = f.feed("```\n") + f.feed("code\n") + f.feed("```\n") + f.flush();
      expect(out).toBe("```\ncode\n```\n");
    });

    it("code fence with language tag in single chunk", () => {
      const f = new StreamingMarkdownFilter();
      const out = f.feed("```typescript\n") + f.feed("const x = 1;\n") + f.feed("```\n") + f.flush();
      expect(out).toBe("```typescript\nconst x = 1;\n```\n");
    });
  });

  // ---- Inline code (passed through) ----------------------------------------

  describe("inline code (passed through)", () => {
    it("preserves backticks and content", () => {
      expectFilter("use `fmt.Println` here", "use `fmt.Println` here");
    });

    it("preserves inline code at start of body", () => {
      expectFilter("text\n`code`", "text\n`code`");
    });

    it("preserves unclosed backtick before newline", () => {
      expectFilter("hello `world\nnext", "hello `world\nnext");
    });

    it("preserves inline code with special chars", () => {
      expectFilter("run `rm -rf /` carefully", "run `rm -rf /` carefully");
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

  describe("strikethrough (passed through)", () => {
    it("preserves ~~ markers and content", () => {
      expectFilter("~~deleted~~", "~~deleted~~");
    });

    it("preserves strikethrough with surrounding text", () => {
      expectFilter("keep ~~this~~ too", "keep ~~this~~ too");
    });

    it("preserves unclosed ~~ at EOF", () => {
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

  // ---- Italic (* — CJK-aware) ----------------------------------------------

  describe("italic (* — CJK-aware)", () => {
    it("preserves * markers for non-CJK content", () => {
      expectFilter("*italic*", "*italic*");
    });

    it("preserves italic with surrounding non-CJK text", () => {
      expectFilter("this is *emphasized* text", "this is *emphasized* text");
    });

    it("strips * markers for CJK content", () => {
      expectFilter("*中文斜体*", "中文斜体");
    });

    it("strips * markers for mixed CJK content", () => {
      expectFilter("*hello 你好*", "hello 你好");
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

  // ---- Bold-italic (*** — CJK-aware) ---------------------------------------

  describe("bold-italic (*** — CJK-aware)", () => {
    it("preserves *** markers for non-CJK content", () => {
      expectFilter("***bold italic***", "***bold italic***");
    });

    it("preserves bold-italic with surrounding non-CJK text", () => {
      expectFilter("this is ***very strong*** text", "this is ***very strong*** text");
    });

    it("strips *** markers for CJK content", () => {
      expectFilter("***粗斜体文字***", "粗斜体文字");
    });

    it("unclosed *** at EOF restores markers", () => {
      const f = new StreamingMarkdownFilter();
      const result = f.feed("***unclosed") + f.flush();
      expect(result).toBe("***unclosed");
    });
  });

  // ---- CJK-aware italic/bold-italic (comprehensive) ------------------------

  describe("CJK-aware italic/bold-italic", () => {
    it("preserves _italic_ for non-CJK content", () => {
      expectFilter("_italic_", "_italic_");
    });

    it("strips _italic_ for CJK content", () => {
      expectFilter("_中文_", "中文");
    });

    it("preserves ___bold-italic___ for non-CJK content", () => {
      expectFilter("___bold italic___", "___bold italic___");
    });

    it("strips ___bold-italic___ for CJK content", () => {
      expectFilter("___粗斜体___", "粗斜体");
    });

    it("handles Japanese text as CJK", () => {
      expectFilter("*こんにちは*", "こんにちは");
    });

    it("handles Korean text as CJK", () => {
      expectFilter("*안녕하세요*", "안녕하세요");
    });

    it("preserves italic around numbers and punctuation", () => {
      expectFilter("*123!*", "*123!*");
    });

    it("strips italic around CJK with numbers", () => {
      expectFilter("*第1章*", "第1章");
    });

    it("preserves non-CJK italic in CJK context", () => {
      expectFilter("中文 *English* 中文", "中文 *English* 中文");
    });

    it("strips CJK italic in English context", () => {
      expectFilter("English *中文* English", "English 中文 English");
    });
  });

  // ---- Blockquotes ----------------------------------------------------------

  describe("blockquotes (passed through)", () => {
    it("preserves > prefix with space", () => {
      expectFilter("> quoted text", "> quoted text");
    });

    it("preserves > prefix without space", () => {
      expectFilter(">quoted", ">quoted");
    });

    it("preserves multiline blockquote", () => {
      expectFilter("> line1\n> line2", "> line1\n> line2");
    });

    it("preserves blockquote with inline formatting", () => {
      expectFilter("> **bold** in quote", "> **bold** in quote");
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

  // ---- Horizontal rules (passed through) ------------------------------------

  describe("horizontal rules (passed through)", () => {
    it("preserves --- rule", () => {
      expectFilter("before\n---\nafter", "before\n---\nafter");
    });

    it("preserves *** rule", () => {
      expectFilter("before\n***\nafter", "before\n***\nafter");
    });

    it("preserves ___ rule", () => {
      expectFilter("before\n___\nafter", "before\n___\nafter");
    });

    it("preserves - - - rule (with spaces)", () => {
      expectFilter("before\n- - -\nafter", "before\n- - -\nafter");
    });

    it("preserves rule at end of input", () => {
      expectFilter("text\n---", "text\n---");
    });

    it("does not strip -- (only two dashes)", () => {
      expectFilter("text\n--\nnext", "text\n--\nnext");
    });
  });

  // ---- Tables (passed through) ----------------------------------------------

  describe("tables (passed through)", () => {
    it("preserves | delimiters and table structure", () => {
      const input = "| Header1 | Header2 |\n|---------|---------||\n| Cell1 | Cell2 |";
      expect(oneShot(input)).toBe(input);
    });

    it("preserves separator row", () => {
      const input = "| A | B |\n|---|---|\n| 1 | 2 |";
      expect(oneShot(input)).toBe(input);
    });

    it("preserves table row as-is", () => {
      expect(oneShot("| A | B |\n")).toBe("| A | B |\n");
    });

    it("preserves separator with colons (alignment markers)", () => {
      expect(oneShot("|:---|---:|\n")).toBe("|:---|---:|\n");
    });

    it("preserves table with surrounding text", () => {
      const input = "结果如下：\n| A | B |\n|---|---|\n| 1 | 2 |\n完毕。";
      expect(oneShot(input)).toBe(input);
    });

    it("preserves table with emoji content", () => {
      const input = [
        "| 微信表情 | Emoji |",
        "|----------|-------|",
        "| [微笑] | 😊 |",
        "| [撇嘴] | 😣 |",
      ].join("\n");
      expect(oneShot(input)).toBe(input);
    });

    it("preserves table at EOF without trailing newline", () => {
      expect(oneShot("| A | B |")).toBe("| A | B |");
    });

    it("streaming: table row split across chunks", () => {
      const f = new StreamingMarkdownFilter();
      const out = f.feed("| A |") + f.feed(" B |\n") + f.flush();
      expect(out).toBe("| A | B |\n");
    });

    it("streaming: separator row split across chunks", () => {
      const f = new StreamingMarkdownFilter();
      const out = f.feed("|---") + f.feed("|---|\n") + f.flush();
      expect(out).toBe("|---|---|\n");
    });

    it("| at SOL passes through", () => {
      expect(oneShot("| just text\n")).toBe("| just text\n");
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
        "## **Title**\nUse `code` here.",
      );
    });

    it("blockquote + italic + strikethrough", () => {
      expectFilter(
        "> *italic* and ~~strike~~",
        "> *italic* and ~~strike~~",
      );
    });

    it("code fence + inline code + image (one-shot)", () => {
      expect(oneShot("```\nfenced\n```\n`inline` ![img](url)"))
        .toBe("```\nfenced\n```\n`inline` ");
    });

    it("mixed bold and bold-italic (non-CJK)", () => {
      expectFilter(
        "**bold** then ***bold-italic*** then **bold2**",
        "**bold** then ***bold-italic*** then **bold2**",
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
      expect(result).toContain("*emphasized*");
      expect(result).toContain("print('hello')");
      expect(result).toContain("```");
      expect(result).toContain("- item 1");
      expect(result).toContain("- nested");
      expect(result).toContain("---");
      expect(result).toContain("End.");
      expect(result).toContain("> This is a quote.");
    });
  });

  // ---- Hold-back / buffering ------------------------------------------------

  describe("hold-back logic", () => {
    it("holds trailing * until resolved as italic (non-CJK)", () => {
      const f = new StreamingMarkdownFilter();
      const r1 = f.feed("hello *");
      expect(r1).toBe("hello ");
      const r2 = f.feed("world* end");
      expect(r2).toBe("*world* end");
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

    it("holds trailing ** then resolves as *** (bold-italic, non-CJK)", () => {
      const f = new StreamingMarkdownFilter();
      const r1 = f.feed("a **");
      expect(r1).toBe("a ");
      const r2 = f.feed("*bi*** end");
      expect(r2).toBe("***bi*** end");
      expect(f.flush()).toBe("");
    });

    it("~ is not held back (passed through)", () => {
      const f = new StreamingMarkdownFilter();
      const r1 = f.feed("text ~");
      expect(r1).toBe("text ~");
      const r2 = f.feed("~strike~~ end");
      expect(r2).toBe("~strike~~ end");
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

    it("flush emits unclosed inline code as-is", () => {
      const f = new StreamingMarkdownFilter();
      const r = f.feed("unclosed `code") + f.flush();
      expect(r).toBe("unclosed `code");
    });

    it("flush emits ~~ as-is (passed through)", () => {
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
      ["*italic* text", "*italic* text"],
      ["*中文* text", "中文 text"],
      ["***bi*** text", "***bi*** text"],
      ["***中文*** text", "中文 text"],
      ["~~strike~~ text", "~~strike~~ text"],
      ["`code` text", "`code` text"],
      ["![img](url)", ""],
      ["> blockquote", "> blockquote"],
      ["##### H5 heading", "H5 heading"],
      ["## H2 heading", "## H2 heading"],
      ["before\n---\nafter", "before\n---\nafter"],
      [
        "Here **bold** and *italic* `code` ~~strike~~ ***bi*** end",
        "Here **bold** and *italic* `code` ~~strike~~ ***bi*** end",
      ],
    ];

    for (const [input, expected] of cases) {
      it(`consistent for: ${JSON.stringify(input).slice(0, 50)}`, () => {
        expectFilter(input, expected);
      });
    }

    it("code fence: one-shot vs line-chunked streaming", () => {
      const input = "```\nfenced\n```\nafter";
      expect(oneShot(input)).toBe("```\nfenced\n```\nafter");
      const f = new StreamingMarkdownFilter();
      const out = f.feed("```\n") + f.feed("fenced\n") + f.feed("```\n") + f.feed("after") + f.flush();
      expect(out).toBe("```\nfenced\n```\nafter");
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
      expectFilter(">> deeply nested", ">> deeply nested");
    });

    it("multiple images on same line", () => {
      expectFilter(
        "see ![a](u1) and ![b](u2) end",
        "see  and  end",
      );
    });

    it("bold inside code fence is not processed (one-shot)", () => {
      expect(oneShot("```\n**not bold**\n```\n")).toBe("```\n**not bold**\n```\n");
    });

    it("handles very long input", () => {
      const longText = "word ".repeat(1000);
      expectFilter(longText, longText);
    });

    it("alternating italic and bold (non-CJK)", () => {
      expectFilter(
        "*a* **b** *c* **d**",
        "*a* **b** *c* **d**",
      );
    });

    it("horizontal rule vs list item at SOL", () => {
      expectFilter("- - -\n", "- - -\n");
      expectFilter("- item", "- item");
    });
  });
});
