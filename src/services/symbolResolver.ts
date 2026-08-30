import * as vscode from 'vscode';

import type { NoteRange, NoteSymbolDescriptor } from '../core/noteStore';

export interface ResolvedDocumentSymbol {
  readonly descriptor: NoteSymbolDescriptor;
  readonly range: vscode.Range;
  readonly selectionRange: vscode.Range;
}

export type SymbolReconciliation =
  | { readonly state: 'matched'; readonly symbol: ResolvedDocumentSymbol }
  | { readonly state: 'missing' }
  | { readonly state: 'ambiguous'; readonly candidateCount: number };

/** Find the smallest language-provider symbol containing a cursor or selection. */
export async function findEnclosingDocumentSymbol(
  document: vscode.TextDocument,
  target: vscode.Range,
): Promise<ResolvedDocumentSymbol | undefined> {
  const symbols = await listDocumentSymbols(document);
  return symbols
    .filter(({ range }) => range.contains(target))
    .sort((left, right) => rangeWeight(left.range) - rangeWeight(right.range))[0];
}

/** Return every provider symbol with the nearest, most specific symbol first. */
export function sortDocumentSymbolsByProximity(
  symbols: readonly ResolvedDocumentSymbol[],
  target: vscode.Range,
): ResolvedDocumentSymbol[] {
  return [...symbols].sort((left, right) => {
    const leftContains = left.range.contains(target);
    const rightContains = right.range.contains(target);
    if (leftContains !== rightContains) {
      return leftContains ? -1 : 1;
    }

    const distanceDifference =
      rangeDistance(left.range, target) - rangeDistance(right.range, target);
    if (distanceDifference !== 0) {
      return distanceDifference;
    }

    const weightDifference = rangeWeight(left.range) - rangeWeight(right.range);
    if (weightDifference !== 0) {
      return weightDifference;
    }

    return (
      left.selectionRange.start.line - right.selectionRange.start.line ||
      left.selectionRange.start.character - right.selectionRange.start.character ||
      left.descriptor.name.localeCompare(right.descriptor.name)
    );
  });
}

/** Resolve a persisted, best-effort descriptor without guessing between duplicates. */
export async function reconcileDocumentSymbol(
  document: vscode.TextDocument,
  descriptor: NoteSymbolDescriptor,
): Promise<SymbolReconciliation> {
  const candidates = (await listDocumentSymbols(document)).filter(
    ({ descriptor: candidate }) =>
      candidate.name === descriptor.name &&
      candidate.kind === descriptor.kind &&
      (descriptor.containerName === undefined ||
        candidate.containerName === descriptor.containerName),
  );

  if (candidates.length === 0) {
    return { state: 'missing' };
  }
  if (candidates.length === 1) {
    return { state: 'matched', symbol: candidates[0]! };
  }

  if (descriptor.range) {
    const exact = candidates.filter(({ selectionRange }) =>
      noteRangesEqual(toNoteRange(selectionRange), descriptor.range!),
    );
    if (exact.length === 1) {
      return { state: 'matched', symbol: exact[0]! };
    }
  }

  return { state: 'ambiguous', candidateCount: candidates.length };
}

export async function listDocumentSymbols(
  document: vscode.TextDocument,
): Promise<ResolvedDocumentSymbol[]> {
  const provided = await vscode.commands.executeCommand<
    readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
  >('vscode.executeDocumentSymbolProvider', document.uri);
  if (!provided) {
    return [];
  }

  const output: ResolvedDocumentSymbol[] = [];
  for (const symbol of provided) {
    if (isHierarchicalSymbol(symbol)) {
      flattenDocumentSymbol(symbol, [], output);
    } else if (
      isSymbolInformation(symbol) &&
      symbol.location.uri.toString() === document.uri.toString()
    ) {
      const containerName = symbol.containerName.trim() || undefined;
      const selectionRange = symbol.location.range;
      output.push({
        descriptor: {
          name: symbol.name,
          kind: symbolKindName(symbol.kind),
          ...(containerName ? { containerName } : {}),
          range: toNoteRange(selectionRange),
        },
        range: symbol.location.range,
        selectionRange,
      });
    }
  }
  return output;
}

function flattenDocumentSymbol(
  symbol: vscode.DocumentSymbol,
  containers: readonly string[],
  output: ResolvedDocumentSymbol[],
): void {
  const containerName = containers.length > 0 ? containers.join(' › ') : undefined;
  output.push({
    descriptor: {
      name: symbol.name,
      kind: symbolKindName(symbol.kind),
      ...(containerName ? { containerName } : {}),
      range: toNoteRange(symbol.selectionRange),
    },
    range: symbol.range,
    selectionRange: symbol.selectionRange,
  });

  const nextContainers = [...containers, symbol.name];
  for (const child of symbol.children) {
    flattenDocumentSymbol(child, nextContainers, output);
  }
}

function isHierarchicalSymbol(
  value: vscode.DocumentSymbol | vscode.SymbolInformation,
): value is vscode.DocumentSymbol {
  return 'children' in value && 'selectionRange' in value;
}

function isSymbolInformation(
  value: vscode.DocumentSymbol | vscode.SymbolInformation,
): value is vscode.SymbolInformation {
  return 'location' in value;
}

function symbolKindName(kind: vscode.SymbolKind): string {
  return vscode.SymbolKind[kind] ?? String(kind);
}

function toNoteRange(range: vscode.Range): NoteRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function noteRangesEqual(left: NoteRange, right: NoteRange): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

function rangeWeight(range: vscode.Range): number {
  return (
    (range.end.line - range.start.line) * 1_000_000 +
    Math.max(0, range.end.character - range.start.character)
  );
}

function rangeDistance(candidate: vscode.Range, target: vscode.Range): number {
  if (comparePositions(candidate.end, target.start) < 0) {
    return positionDistance(candidate.end, target.start);
  }
  if (comparePositions(target.end, candidate.start) < 0) {
    return positionDistance(target.end, candidate.start);
  }
  return 0;
}

function positionDistance(left: vscode.Position, right: vscode.Position): number {
  return Math.abs(left.line - right.line) * 1_000_000 + Math.abs(left.character - right.character);
}

function comparePositions(left: vscode.Position, right: vscode.Position): number {
  return left.line - right.line || left.character - right.character;
}
