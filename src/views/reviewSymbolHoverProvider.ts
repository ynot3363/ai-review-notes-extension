import * as vscode from 'vscode';

import type { NoteSymbolDescriptor } from '../core/noteStore';
import { listDocumentSymbols, sortDocumentSymbolsByProximity } from '../services/symbolResolver';

export const CREATE_SYMBOL_NOTE_COMMAND = 'codingNotesForAi.createSymbolNote';

export interface SymbolHoverTarget {
  readonly uri: string;
  readonly descriptor: NoteSymbolDescriptor;
}

/** Adds a compact Add Note action when a provider-reported symbol name is hovered. */
export class ReviewSymbolHoverProvider implements vscode.HoverProvider {
  public constructor(
    private readonly isDocumentEligible: (document: vscode.TextDocument) => boolean,
    private readonly reportError?: (document: vscode.TextDocument, error: unknown) => void,
  ) {}

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    if (!this.isDocumentEligible(document)) {
      return undefined;
    }

    try {
      const positionRange = new vscode.Range(position, position);
      const symbols = sortDocumentSymbolsByProximity(
        (await listDocumentSymbols(document)).filter(({ selectionRange }) =>
          selectionRange.contains(positionRange),
        ),
        positionRange,
      );
      if (token.isCancellationRequested || symbols.length === 0) {
        return undefined;
      }

      const symbol = symbols[0]!;
      const target: SymbolHoverTarget = {
        uri: document.uri.toString(),
        descriptor: symbol.descriptor,
      };
      const commandArguments = encodeURIComponent(JSON.stringify([target]));
      const content = new vscode.MarkdownString(
        `[Add Note](command:${CREATE_SYMBOL_NOTE_COMMAND}?${commandArguments} "Attach a note to ${escapeTitle(symbol.descriptor.name)}")`,
      );
      content.isTrusted = { enabledCommands: [CREATE_SYMBOL_NOTE_COMMAND] };
      return new vscode.Hover(content, symbol.selectionRange);
    } catch (error) {
      this.reportError?.(document, error);
      return undefined;
    }
  }
}

export function isSymbolHoverTarget(value: unknown): value is SymbolHoverTarget {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<SymbolHoverTarget>;
  return (
    typeof candidate.uri === 'string' &&
    candidate.uri.length > 0 &&
    typeof candidate.descriptor === 'object' &&
    candidate.descriptor !== null &&
    typeof candidate.descriptor.name === 'string' &&
    typeof candidate.descriptor.kind === 'string'
  );
}

function escapeTitle(value: string): string {
  return value.replace(/[\\"]/gu, '\\$&');
}
