/**
 * Streaming markdown filter — character-level state machine that strips
 * unsupported markdown syntax on-the-fly.
 *
 * Outputs as much filtered text as possible on each `feed()` call, only
 * holding back the minimum characters needed for pattern disambiguation
 * (e.g. a trailing `*` that might become `***`).
 *
 * States:
 * - **sol** (start-of-line): checks for line-start patterns (```, >, #####, indent)
 * - **body**: scans for inline patterns (`, ![, ~~, ***) and outputs safe chars
 * - **fence**: inside a fenced code block, passes through until closing ```
 * - **inline**: accumulating content inside an inline marker pair
 */
export class StreamingMarkdownFilter {
  private buf = "";
  private fence = false;
  private sol = true;
  private inl: { type: "code" | "image" | "strike" | "bold3" | "italic" | "ubold3" | "uitalic" | "table"; acc: string } | null = null;

  feed(delta: string): string {
    this.buf += delta;
    return this.pump(false);
  }

  flush(): string {
    return this.pump(true);
  }

  private pump(eof: boolean): string {
    let out = "";
    while (this.buf) {
      const sLen = this.buf.length;
      const sSol = this.sol;
      const sFence = this.fence;
      const sInl = this.inl;

      if (this.fence) out += this.pumpFence(eof);
      else if (this.inl) out += this.pumpInline(eof);
      else if (this.sol) out += this.pumpSOL(eof);
      else out += this.pumpBody(eof);

      if (this.buf.length === sLen && this.sol === sSol &&
          this.fence === sFence && this.inl === sInl) break;
    }

    if (eof && this.inl) {
      if (this.inl.type === "table") {
        out += StreamingMarkdownFilter.extractTableRow(this.inl.acc);
      } else {
        const markers: Record<string, string> = { code: "`", image: "![", strike: "~~", bold3: "***", italic: "*", ubold3: "___", uitalic: "_" };
        out += (markers[this.inl.type] ?? "") + this.inl.acc;
      }
      this.inl = null;
    }
    return out;
  }

  /** Inside a code fence: pass content through, watch for closing ``` at SOL. */
  private pumpFence(eof: boolean): string {
    if (this.sol) {
      if (this.buf.length < 3 && !eof) return "";
      if (this.buf.startsWith("```")) {
        this.fence = false;
        const nl = this.buf.indexOf("\n", 3);
        this.buf = nl !== -1 ? this.buf.slice(nl + 1) : "";
        this.sol = true;
        return "";
      }
      this.sol = false;
    }
    const nl = this.buf.indexOf("\n");
    if (nl !== -1) {
      const chunk = this.buf.slice(0, nl + 1);
      this.buf = this.buf.slice(nl + 1);
      this.sol = true;
      return chunk;
    }
    const chunk = this.buf;
    this.buf = "";
    return chunk;
  }

  /** At start of line: detect and consume line-start patterns, then transition to body. */
  private pumpSOL(eof: boolean): string {
    const b = this.buf;

    if (b[0] === "\n") {
      this.buf = b.slice(1);
      return "\n";
    }

    if (b[0] === "`") {
      if (b.length < 3 && !eof) return "";
      if (b.startsWith("```")) {
        this.fence = true;
        const nl = b.indexOf("\n", 3);
        this.buf = nl !== -1 ? b.slice(nl + 1) : "";
        this.sol = true;
        return "";
      }
      this.sol = false;
      return "";
    }

    if (b[0] === ">") {
      if (b.length < 2 && !eof) return "";
      this.buf = b.length >= 2 && b[1] === " " ? b.slice(2) : b.slice(1);
      this.sol = false;
      return "";
    }

    if (b[0] === "#") {
      let n = 0;
      while (n < b.length && b[n] === "#") n++;
      if (n === b.length && !eof) return "";
      if (n >= 5 && n <= 6 && n < b.length && b[n] === " ") {
        this.buf = b.slice(n + 1);
        this.sol = false;
        return "";
      }
      this.sol = false;
      return "";
    }

    if (b[0] === "|") {
      this.buf = b.slice(1);
      this.inl = { type: "table", acc: "" };
      this.sol = false;
      return "";
    }

    if (b[0] === " " || b[0] === "\t") {
      if (b.search(/[^ \t]/) === -1 && !eof) return "";
      this.sol = false;
      return "";
    }

    if (b[0] === "-" || b[0] === "*" || b[0] === "_") {
      const ch = b[0];
      let j = 0;
      while (j < b.length && (b[j] === ch || b[j] === " ")) j++;
      if (j === b.length && !eof) return "";
      if (j === b.length || b[j] === "\n") {
        let count = 0;
        for (let k = 0; k < j; k++) if (b[k] === ch) count++;
        if (count >= 3) {
          this.buf = j < b.length ? b.slice(j + 1) : "";
          this.sol = true;
          return "";
        }
      }
      this.sol = false;
      return "";
    }

    this.sol = false;
    return "";
  }

  /** Scan line body for inline pattern triggers; output safe chars eagerly. */
  private pumpBody(eof: boolean): string {
    let out = "";
    let i = 0;
    while (i < this.buf.length) {
      const c = this.buf[i];
      if (c === "\n") {
        out += this.buf.slice(0, i + 1);
        this.buf = this.buf.slice(i + 1);
        this.sol = true;
        return out;
      }
      if (c === "`") {
        out += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        this.inl = { type: "code", acc: "" };
        return out;
      }
      if (c === "!" && i + 1 < this.buf.length && this.buf[i + 1] === "[") {
        out += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        this.inl = { type: "image", acc: "" };
        return out;
      }
      if (c === "~" && i + 1 < this.buf.length && this.buf[i + 1] === "~") {
        out += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        this.inl = { type: "strike", acc: "" };
        return out;
      }
      if (c === "*") {
        if (i + 2 < this.buf.length && this.buf[i + 1] === "*" && this.buf[i + 2] === "*") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 3);
          this.inl = { type: "bold3", acc: "" };
          return out;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] === "*") {
          i += 2;
          continue;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] !== " " && this.buf[i + 1] !== "\n") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.inl = { type: "italic", acc: "" };
          return out;
        }
        i++;
        continue;
      }
      if (c === "_") {
        if (i + 2 < this.buf.length && this.buf[i + 1] === "_" && this.buf[i + 2] === "_") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 3);
          this.inl = { type: "ubold3", acc: "" };
          return out;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] === "_") {
          i += 2;
          continue;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] !== " " && this.buf[i + 1] !== "\n") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.inl = { type: "uitalic", acc: "" };
          return out;
        }
        i++;
        continue;
      }
      i++;
    }

    let hold = 0;
    if (!eof) {
      if (this.buf.endsWith("**")) hold = 2;
      else if (this.buf.endsWith("__")) hold = 2;
      else if (this.buf.endsWith("*")) hold = 1;
      else if (this.buf.endsWith("_")) hold = 1;
      else if (this.buf.endsWith("~")) hold = 1;
      else if (this.buf.endsWith("!")) hold = 1;
    }
    out += this.buf.slice(0, this.buf.length - hold);
    this.buf = hold > 0 ? this.buf.slice(-hold) : "";
    return out;
  }

  /** Accumulate inline content until closing marker is found. */
  private pumpInline(_eof: boolean): string {
    if (!this.inl) return "";
    this.inl.acc += this.buf;
    this.buf = "";

    switch (this.inl.type) {
      case "code": {
        const idx = this.inl.acc.indexOf("`");
        if (idx !== -1) {
          const content = this.inl.acc.slice(0, idx);
          this.buf = this.inl.acc.slice(idx + 1);
          this.inl = null;
          return content;
        }
        const nl = this.inl.acc.indexOf("\n");
        if (nl !== -1) {
          const r = "`" + this.inl.acc.slice(0, nl + 1);
          this.buf = this.inl.acc.slice(nl + 1);
          this.inl = null;
          this.sol = true;
          return r;
        }
        return "";
      }
      case "strike": {
        const idx = this.inl.acc.indexOf("~~");
        if (idx !== -1) {
          const content = this.inl.acc.slice(0, idx);
          this.buf = this.inl.acc.slice(idx + 2);
          this.inl = null;
          return content;
        }
        return "";
      }
      case "bold3": {
        const idx = this.inl.acc.indexOf("***");
        if (idx !== -1) {
          const content = this.inl.acc.slice(0, idx);
          this.buf = this.inl.acc.slice(idx + 3);
          this.inl = null;
          return content;
        }
        return "";
      }
      case "ubold3": {
        const idx = this.inl.acc.indexOf("___");
        if (idx !== -1) {
          const content = this.inl.acc.slice(0, idx);
          this.buf = this.inl.acc.slice(idx + 3);
          this.inl = null;
          return content;
        }
        return "";
      }
      case "italic": {
        for (let j = 0; j < this.inl.acc.length; j++) {
          if (this.inl.acc[j] === "\n") {
            const r = "*" + this.inl.acc.slice(0, j + 1);
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            this.sol = true;
            return r;
          }
          if (this.inl.acc[j] === "*") {
            if (j + 1 < this.inl.acc.length && this.inl.acc[j + 1] === "*") {
              j++;
              continue;
            }
            const content = this.inl.acc.slice(0, j);
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            return content;
          }
        }
        return "";
      }
      case "uitalic": {
        for (let j = 0; j < this.inl.acc.length; j++) {
          if (this.inl.acc[j] === "\n") {
            const r = "_" + this.inl.acc.slice(0, j + 1);
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            this.sol = true;
            return r;
          }
          if (this.inl.acc[j] === "_") {
            if (j + 1 < this.inl.acc.length && this.inl.acc[j + 1] === "_") {
              j++;
              continue;
            }
            const content = this.inl.acc.slice(0, j);
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            return content;
          }
        }
        return "";
      }
      case "image": {
        const cb = this.inl.acc.indexOf("]");
        if (cb === -1) return "";
        if (cb + 1 >= this.inl.acc.length) return "";
        if (this.inl.acc[cb + 1] !== "(") {
          const r = "![" + this.inl.acc.slice(0, cb + 1);
          this.buf = this.inl.acc.slice(cb + 1);
          this.inl = null;
          return r;
        }
        const cp = this.inl.acc.indexOf(")", cb + 2);
        if (cp !== -1) {
          this.buf = this.inl.acc.slice(cp + 1);
          this.inl = null;
          return "";
        }
        return "";
      }
      case "table": {
        const nl = this.inl.acc.indexOf("\n");
        if (nl !== -1) {
          const line = this.inl.acc.slice(0, nl);
          this.buf = this.inl.acc.slice(nl + 1);
          this.inl = null;
          this.sol = true;
          const row = StreamingMarkdownFilter.extractTableRow(line);
          return row ? row + "\n" : "";
        }
        return "";
      }
    }
    return "";
  }

  /** Extract cell contents from a table row, or return "" for separator rows. */
  private static extractTableRow(line: string): string {
    if (/^[\s|:\-]+$/.test(line) && line.includes("-")) return "";
    const parts = line.split("|").map(c => c.trim());
    const cells = parts.slice(
      parts[0] === "" ? 1 : 0,
      parts[parts.length - 1] === "" ? parts.length - 1 : parts.length,
    );
    return cells.join("\t");
  }
}
