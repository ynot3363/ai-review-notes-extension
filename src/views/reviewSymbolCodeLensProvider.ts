import * as vscode from 'vscode';

import { listDocumentSymbols, type ResolvedDocumentSymbol } from '../services/symbolResolver';
import { CREATE_SYMBOL_NOTE_COMMAND } from './reviewSymbolHoverProvider';

export interface SymbolCodeLensTarget {
  readonly uri: vscode.Uri;
  readonly symbol: ResolvedDocumentSymbol;
}

/** Shows a direct Add Note action above every provider-reported symbol. */
export class ReviewSymbolCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.changeEmitter.event;

  public constructor(
    private readonly isDocumentEligible: (document: vscode.TextDocument) => boolean,
    private readonly reportError?: (document: vscode.TextDocument, error: unknown) => void,
  ) {}

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  public async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    if (!this.isDocumentEligible(document)) {
      return [];
    }

    try {
      const symbols = await listDocumentSymbols(document);
      if (token.isCancellationRequested) {
        return [];
      }
      return symbols.map(
        (symbol) =>
          new vscode.CodeLens(symbol.selectionRange, {
            command: CREATE_SYMBOL_NOTE_COMMAND,
            title: '$(comment-add) Add Note',
            tooltip: `Attach a note to ${symbol.descriptor.kind.toLowerCase()} ${symbol.descriptor.name}`,
            arguments: [{ uri: document.uri, symbol } satisfies SymbolCodeLensTarget],
          }),
      );
    } catch (error) {
      this.reportError?.(document, error);
      return [];
    }
  }
}

export function isSymbolCodeLensTarget(value: unknown): value is SymbolCodeLensTarget {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<SymbolCodeLensTarget>;
  return (
    candidate.uri instanceof vscode.Uri &&
    typeof candidate.symbol === 'object' &&
    candidate.symbol !== null &&
    candidate.symbol.range instanceof vscode.Range &&
    candidate.symbol.selectionRange instanceof vscode.Range &&
    typeof candidate.symbol.descriptor?.name === 'string'
  );
}
