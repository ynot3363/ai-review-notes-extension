import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class Position {
    public constructor(
      public readonly line: number,
      public readonly character: number,
    ) {}
  }

  class Range {
    public readonly start: Position;
    public readonly end: Position;

    public constructor(
      startLine: number,
      startCharacter: number,
      endLine: number,
      endCharacter: number,
    ) {
      this.start = new Position(startLine, startCharacter);
      this.end = new Position(endLine, endCharacter);
    }

    public contains(other: Range): boolean {
      return compare(this.start, other.start) <= 0 && compare(this.end, other.end) >= 0;
    }
  }

  const compare = (left: Position, right: Position): number =>
    left.line - right.line || left.character - right.character;

  return { Position, Range, SymbolKind: {}, commands: { executeCommand: vi.fn() } };
});

import * as vscode from 'vscode';

import {
  sortDocumentSymbolsByProximity,
  type ResolvedDocumentSymbol,
} from '../../../src/services/symbolResolver';

describe('document symbol proximity', () => {
  it('keeps all symbols while ordering the smallest enclosing symbol first', () => {
    const symbols = [
      symbol('after', 30, 35),
      symbol('class', 0, 25),
      symbol('method', 8, 15),
      symbol('before', 2, 4),
    ];

    const sorted = sortDocumentSymbolsByProximity(symbols, new vscode.Range(10, 2, 10, 2));

    expect(sorted.map(({ descriptor }) => descriptor.name)).toEqual([
      'method',
      'class',
      'before',
      'after',
    ]);
    expect(sorted).toHaveLength(symbols.length);
  });

  it('orders non-enclosing symbols by distance from the selected range', () => {
    const symbols = [symbol('far-before', 1, 2), symbol('after', 14, 16), symbol('before', 8, 9)];

    const sorted = sortDocumentSymbolsByProximity(symbols, new vscode.Range(11, 0, 12, 0));

    expect(sorted.map(({ descriptor }) => descriptor.name)).toEqual([
      'before',
      'after',
      'far-before',
    ]);
  });
});

function symbol(name: string, startLine: number, endLine: number): ResolvedDocumentSymbol {
  const range = new vscode.Range(startLine, 0, endLine, 0);
  return {
    descriptor: { name, kind: 'Function' },
    range,
    selectionRange: new vscode.Range(startLine, 0, startLine, name.length),
  };
}
