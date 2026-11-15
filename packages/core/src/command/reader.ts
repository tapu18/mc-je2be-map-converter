// コマンド文字列を先頭から読む小道具（Brigadier の StringReader に相当）。
// ゲーム内でも動かすため、Node / DOM の API は使わない。

export class CommandSyntaxError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = "CommandSyntaxError";
    this.position = position;
  }
}

const isUnquotedChar = (c: string): boolean =>
  (c >= "0" && c <= "9") || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_" || c === "-" || c === "." || c === "+";

export class StringReader {
  readonly input: string;
  cursor: number;

  constructor(input: string, cursor = 0) {
    this.input = input;
    this.cursor = cursor;
  }

  canRead(n = 1): boolean {
    return this.cursor + n <= this.input.length;
  }
  peek(offset = 0): string {
    return this.input.charAt(this.cursor + offset);
  }
  read(): string {
    return this.input.charAt(this.cursor++);
  }
  skip(n = 1): void {
    this.cursor += n;
  }
  remaining(): string {
    return this.input.slice(this.cursor);
  }
  startsWith(s: string): boolean {
    return this.input.startsWith(s, this.cursor);
  }

  error(message: string, position = this.cursor): CommandSyntaxError {
    return new CommandSyntaxError(message, position);
  }

  skipWhitespace(): void {
    while (this.canRead() && /\s/.test(this.peek())) this.cursor++;
  }

  expect(c: string): void {
    if (this.peek() !== c) throw this.error(`'${c}' が必要`);
    this.cursor++;
  }

  /** 空白（または文字列の終わり）までを読む */
  readUntilSpace(): string {
    const start = this.cursor;
    while (this.canRead() && this.peek() !== " ") this.cursor++;
    return this.input.slice(start, this.cursor);
  }

  readWhile(pred: (c: string) => boolean): string {
    const start = this.cursor;
    while (this.canRead() && pred(this.peek())) this.cursor++;
    return this.input.slice(start, this.cursor);
  }

  readUnquotedString(): string {
    return this.readWhile(isUnquotedChar);
  }

  /** 引用符で囲んだ文字列（' と " の両方）。エスケープは \\ と引用符だけ（Brigadier と同じ） */
  readQuotedString(): string {
    const quote = this.peek();
    if (quote !== '"' && quote !== "'") throw this.error("引用符が必要");
    this.cursor++;
    let out = "";
    let escaped = false;
    while (this.canRead()) {
      const c = this.read();
      if (escaped) {
        if (c !== quote && c !== "\\") throw this.error(`不正なエスケープ '\\${c}'`, this.cursor - 1);
        out += c;
        escaped = false;
      } else if (c === "\\") escaped = true;
      else if (c === quote) return out;
      else out += c;
    }
    throw this.error("引用符が閉じていない");
  }

  readString(): string {
    const c = this.peek();
    if (c === '"' || c === "'") return this.readQuotedString();
    return this.readUnquotedString();
  }

  private readNumberText(): string {
    return this.readWhile((c) => (c >= "0" && c <= "9") || c === "." || c === "-");
  }

  readInt(): number {
    const start = this.cursor;
    const s = this.readNumberText();
    if (!/^-?\d+$/.test(s)) {
      this.cursor = start;
      throw this.error(s ? `整数ではない '${s}'` : "整数が必要", start);
    }
    const n = Number(s);
    if (n > 2147483647 || n < -2147483648) throw this.error(`整数の範囲外 '${s}'`, start);
    return n;
  }

  readLong(): bigint {
    const start = this.cursor;
    const s = this.readNumberText();
    if (!/^-?\d+$/.test(s)) {
      this.cursor = start;
      throw this.error("整数が必要", start);
    }
    return BigInt(s);
  }

  readDouble(): number {
    const start = this.cursor;
    const s = this.readNumberText();
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) {
      this.cursor = start;
      throw this.error(s ? `数値ではない '${s}'` : "数値が必要", start);
    }
    return Number(s);
  }

  readBoolean(): boolean {
    const start = this.cursor;
    const s = this.readString();
    if (s === "true") return true;
    if (s === "false") return false;
    this.cursor = start;
    throw this.error(`true か false が必要（'${s}'）`, start);
  }
}
