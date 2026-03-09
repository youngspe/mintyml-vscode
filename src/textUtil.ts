import * as vscode from 'vscode';

interface ByteOffsetSearchState {
  byteOffset: number;
  charOffset: number;
  position: vscode.Position;
}

export function advancePositionByByteOffset(
  text: string,
  advanceBy: number,
  state: Partial<ByteOffsetSearchState> = {},
  startingChar = 0,
): ByteOffsetSearchState | undefined {
  let { position: { line = 0, character: character = 0 } = {}, charOffset = 0, byteOffset = 0 } = state;
  if (advanceBy <= 0) return { charOffset, byteOffset, position: state.position ?? ORIGIN };
  const endByteOffset = byteOffset + advanceBy;

  if (charOffset - startingChar >= text.length) return undefined;

  while (charOffset - startingChar < text.length) {
    let i = charOffset++;

    const codePoint = text.codePointAt(i - startingChar)!;
    const utf8Bytes =
      codePoint <= 0x7f ? 1
      : codePoint <= 0x7ff ? 2
      : codePoint <= 0xffff ? 3
      : 4;

    if (byteOffset + utf8Bytes > endByteOffset) {
      break;
    }

    byteOffset += utf8Bytes;

    if (codePoint > 0xffff) {
      // Surrogate pair: skip extra index
      i++;
      charOffset++;
    }

    if (text[i - startingChar] === '\n') {
      line++;
      character = 0;
    } else {
      character++;
    }
  }

  return { byteOffset, charOffset, position: new vscode.Position(line, character) };
}

export function byteOffsetToPosition(text: string, byteOffset: number): vscode.Position {
  return advancePositionByByteOffset(text, byteOffset)?.position ?? new vscode.Position(0, 0);
}

const ORIGIN = new vscode.Position(0, 0);

const INDEX_CHUNK_LOG_LENGTH = 8;

export class StringByteOffsetIndex {
  #doc: vscode.TextDocument;
  #rightmost: ByteOffsetSearchState = { byteOffset: 0, charOffset: 0, position: ORIGIN };
  #index: ByteOffsetSearchState[] = [this.#rightmost];
  #version;

  constructor(doc: vscode.TextDocument) {
    this.#doc = doc;
    this.#version = doc.version;
  }

  getPositionAtByteOffset(offset: number): vscode.Position {
    if (this.#doc.version > this.#version) {
      this.#rightmost = { byteOffset: 0, charOffset: 0, position: ORIGIN };
      this.#index.length = 0;
      this.#version = this.#doc.version;
    }

    const preIndex = offset >> INDEX_CHUNK_LOG_LENGTH;
    const pre = this.#index[preIndex];

    if (!pre) {
      const startingChar = this.#rightmost.charOffset;
      const text = this.#doc.getText(
        new vscode.Range(this.#rightmost.position, new vscode.Position(this.#doc.lineCount, 0)),
      );

      while (offset > this.#index.length << INDEX_CHUNK_LOG_LENGTH) {
        const result = advancePositionByByteOffset(
          text,
          (this.#index.length << INDEX_CHUNK_LOG_LENGTH) - this.#rightmost.byteOffset,
          this.#rightmost,
          startingChar,
        );

        if (!result) return this.#rightmost.position;
        this.#index.push((this.#rightmost = result));
      }

      return (
        advancePositionByByteOffset(
          text,
          offset - this.#rightmost.byteOffset,
          this.#rightmost,
          startingChar,
        )?.position ?? this.#rightmost.position
      );
    }

    const post = this.#index[preIndex + 1];

    const text = this.#doc.getText(
      new vscode.Range(pre.position, post?.position ?? new vscode.Position(this.#doc.lineCount, 0)),
    );
    const startingChar = pre.charOffset;
    return (
      advancePositionByByteOffset(text, offset - pre.byteOffset, pre, startingChar)?.position
      ?? this.#rightmost.position
    );
  }
}
