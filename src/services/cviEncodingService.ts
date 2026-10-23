import * as path from 'path';
import * as vscode from 'vscode';
import { getConfiguredCviEncoding, isWindows1252CodePoint } from '../utils/pathUtils';
import { CviWorkspaceService } from './cviWorkspaceService';

export type SanitizationMode = 'off' | 'normalizeWhitespace' | 'windows1252Compatible' | 'strictAscii';

export interface CharacterIssue {
  line: number;
  column: number;
  character: string;
  codePoint: number;
  description: string;
}

export interface EncodingAnalysisResult {
  nbspCount: number;
  invisibleCount: number;
  nonCp1252Count: number;
  nonAsciiCount: number;
  hasReplacementChar: boolean;
  mojibakeLikelyCount: number;
  issues: CharacterIssue[];
}

export interface SanitizationResult {
  newText: string;
  changeCount: number;
  summary: string;
}

const INVISIBLE_SPACES = new Set([
  0x00A0, // NO-BREAK SPACE
  0x202F, // NARROW NO-BREAK SPACE
  0x2007, // FIGURE SPACE
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2008, 0x2009, 0x200A, // EN/EM/THIN spaces
  0x3000  // IDEOGRAPHIC SPACE
]);

const ZERO_WIDTH_CHARS = new Set([
  0x200B, // ZERO WIDTH SPACE
  0x200C, // ZERO WIDTH NON-JOINER
  0x200D, // ZERO WIDTH JOINER
  0x2060, // WORD JOINER
  0xFEFF, // ZERO WIDTH NO-BREAK SPACE (BOM inside text)
  0x00AD  // SOFT HYPHEN
]);

const TYPOGRAPHIC_REPLACEMENTS: Record<number, string> = {
  0x2018: "'", 0x2019: "'", 0x201A: "'", 0x201B: "'",
  0x201C: '"', 0x201D: '"', 0x201E: '"', 0x201F: '"', 0x00AB: '"', 0x00BB: '"',
  0x2013: '-', 0x2014: '-', 0x2212: '-'
};

// Common UTF-8 mojibake patterns when opened as Windows-1252 (e.g. Ã¨, Ã , Â , etc.)
const MOJIBAKE_REGEX = /(?:Ã[\x80-\xBF]|Â[\xA0-\xBF])/g;

export class CviEncodingService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly warnedDocuments = new Set<string>();

  constructor(
    private readonly workspaces: CviWorkspaceService,
    private readonly output: vscode.OutputChannel
  ) {
    this.disposables.push(
      vscode.workspace.onWillSaveTextDocument((event) => this.handleWillSave(event)),
      vscode.workspace.onDidOpenTextDocument((document) => void this.handleDidOpen(document)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.warnedDocuments.delete(document.uri.toString());
      })
    );

    // Analyze documents that are already open at activation time
    for (const document of vscode.workspace.textDocuments) {
      void this.handleDidOpen(document);
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.warnedDocuments.clear();
  }

  private isRelevantCviDocument(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== 'file') {
      return false;
    }
    const ext = path.extname(document.fileName).toLowerCase();
    if (['.c', '.h', '.prj', '.cws', '.uir'].includes(ext)) {
      return true;
    }
    return document.languageId === 'c' || document.languageId === 'cpp';
  }

  public analyzeText(text: string): EncodingAnalysisResult {
    let nbspCount = 0;
    let invisibleCount = 0;
    let nonCp1252Count = 0;
    let nonAsciiCount = 0;
    let hasReplacementChar = false;
    const issues: CharacterIssue[] = [];

    const lines = text.split(/\r\n|\r|\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const lineText = lines[lineIndex];
      for (let colIndex = 0; colIndex < lineText.length; colIndex++) {
        const char = lineText[colIndex];
        const code = lineText.charCodeAt(colIndex);

        if (code === 0xFFFD) {
          hasReplacementChar = true;
          if (issues.length < 25) {
            issues.push({
              line: lineIndex + 1,
              column: colIndex + 1,
              character: char,
              codePoint: code,
              description: 'Replacement character (U+FFFD) indicates decoding/corruption error'
            });
          }
        }

        if (code === 0x00A0) {
          nbspCount++;
          if (issues.length < 25) {
            issues.push({
              line: lineIndex + 1,
              column: colIndex + 1,
              character: 'NBSP',
              codePoint: code,
              description: 'Non-breaking space (0xA0 / U+00A0) masquerading as standard space'
            });
          }
        } else if (INVISIBLE_SPACES.has(code) || ZERO_WIDTH_CHARS.has(code)) {
          invisibleCount++;
          if (issues.length < 25) {
            issues.push({
              line: lineIndex + 1,
              column: colIndex + 1,
              character: 'INV',
              codePoint: code,
              description: `Invisible or non-standard whitespace (U+${code.toString(16).toUpperCase().padStart(4, '0')})`
            });
          }
        }

        if (code > 0x7F) {
          nonAsciiCount++;
          if (!isWindows1252CodePoint(code)) {
            nonCp1252Count++;
            if (issues.length < 25) {
              issues.push({
                line: lineIndex + 1,
                column: colIndex + 1,
                character: char,
                codePoint: code,
                description: `Character '${char}' (U+${code.toString(16).toUpperCase().padStart(4, '0')}) is outside Windows-1252 repertoire`
              });
            }
          }
        }
      }
    }

    const mojibakeMatches = text.match(MOJIBAKE_REGEX);
    const mojibakeLikelyCount = mojibakeMatches ? mojibakeMatches.length : 0;

    return {
      nbspCount,
      invisibleCount,
      nonCp1252Count,
      nonAsciiCount,
      hasReplacementChar,
      mojibakeLikelyCount,
      issues
    };
  }

  public sanitizeText(text: string, mode: SanitizationMode): SanitizationResult {
    if (mode === 'off') {
      return { newText: text, changeCount: 0, summary: 'No changes (sanitization disabled)' };
    }

    let changeCount = 0;
    let nbspReplaced = 0;
    let invisibleRemoved = 0;
    let typographicReplaced = 0;
    let nonCp1252Replaced = 0;
    let nonAsciiReplaced = 0;

    const resultChars: string[] = [];

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);

      // 1. Whitespace & invisible characters normalization
      if (INVISIBLE_SPACES.has(code)) {
        resultChars.push(' ');
        changeCount++;
        if (code === 0x00A0) {
          nbspReplaced++;
        } else {
          invisibleRemoved++;
        }
        continue;
      }

      if (ZERO_WIDTH_CHARS.has(code)) {
        changeCount++;
        invisibleRemoved++;
        continue;
      }

      // 2. Typographic punctuation normalization
      if (TYPOGRAPHIC_REPLACEMENTS[code] !== undefined) {
        resultChars.push(TYPOGRAPHIC_REPLACEMENTS[code]);
        changeCount++;
        typographicReplaced++;
        continue;
      }

      // 3. Strict ASCII or Windows-1252 fallback
      if (mode === 'strictAscii') {
        if (code > 0x7F) {
          resultChars.push('?');
          changeCount++;
          nonAsciiReplaced++;
          continue;
        }
      } else if (mode === 'windows1252Compatible') {
        if (code > 0x7F && !isWindows1252CodePoint(code)) {
          resultChars.push('?');
          changeCount++;
          nonCp1252Replaced++;
          continue;
        }
      }

      resultChars.push(text[i]);
    }

    const parts: string[] = [];
    if (nbspReplaced > 0) parts.push(`${nbspReplaced} non-breaking space(s) (0xA0) -> ' '`);
    if (invisibleRemoved > 0) parts.push(`${invisibleRemoved} invisible character(s) removed`);
    if (typographicReplaced > 0) parts.push(`${typographicReplaced} typographic quote(s)/dash(es) normalized`);
    if (nonCp1252Replaced > 0) parts.push(`${nonCp1252Replaced} incompatible character(s) -> '?'`);
    if (nonAsciiReplaced > 0) parts.push(`${nonAsciiReplaced} non-ASCII character(s) -> '?'`);

    const summary = parts.length > 0 ? parts.join(', ') : 'No modifications needed';
    return {
      newText: resultChars.join(''),
      changeCount,
      summary
    };
  }

  private handleWillSave(event: vscode.TextDocumentWillSaveEvent): void {
    const document = event.document;
    if (!this.isRelevantCviDocument(document)) {
      return;
    }

    const mode = vscode.workspace.getConfiguration('labwindowsCvi').get<SanitizationMode>('sanitizeOnSave', 'normalizeWhitespace');
    if (mode === 'off') {
      return;
    }

    const originalText = document.getText();
    const result = this.sanitizeText(originalText, mode);
    if (result.changeCount === 0) {
      return;
    }

    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(originalText.length)
    );

    event.waitUntil(Promise.resolve([vscode.TextEdit.replace(fullRange, result.newText)]));
    this.output.appendLine(`[CVI Encoding] Auto-sanitized on save (${mode}) in ${path.basename(document.fileName)}: ${result.summary}`);
  }

  private async handleDidOpen(document: vscode.TextDocument): Promise<void> {
    if (!this.isRelevantCviDocument(document)) {
      return;
    }

    const encoding = getConfiguredCviEncoding();
    if (encoding !== 'windows1252') {
      return;
    }

    const warnEnabled = vscode.workspace.getConfiguration('labwindowsCvi').get<boolean>('warnOnEncodingIssues', true);
    if (!warnEnabled) {
      return;
    }

    const uriKey = document.uri.toString();
    if (this.warnedDocuments.has(uriKey)) {
      return;
    }

    const text = document.getText();
    const analysis = this.analyzeText(text);

    const hasIssues = analysis.nbspCount > 0 ||
      analysis.invisibleCount > 0 ||
      analysis.nonCp1252Count > 0 ||
      analysis.hasReplacementChar ||
      analysis.mojibakeLikelyCount > 0;

    if (!hasIssues) {
      return;
    }

    this.warnedDocuments.add(uriKey);

    const fileName = path.basename(document.fileName);
    const issueSummaryList: string[] = [];
    if (analysis.nbspCount > 0) issueSummaryList.push(`${analysis.nbspCount} non-breaking space(s) (0xA0)`);
    if (analysis.invisibleCount > 0) issueSummaryList.push(`${analysis.invisibleCount} invisible/zero-width space(s)`);
    if (analysis.nonCp1252Count > 0) issueSummaryList.push(`${analysis.nonCp1252Count} character(s) not in Windows-1252`);
    if (analysis.hasReplacementChar) issueSummaryList.push('replacement character(s) U+FFFD (file corruption/mismatch)');
    if (analysis.mojibakeLikelyCount > 0) issueSummaryList.push(`${analysis.mojibakeLikelyCount} suspected UTF-8 mojibake sequence(s) (e.g. Ã¨)`);

    this.output.appendLine(`[CVI Encoding] WARNING: Potential character/encoding issues in ${document.fileName} (opened with Windows-1252):`);
    issueSummaryList.forEach((msg) => this.output.appendLine(`  - ${msg}`));
    if (analysis.issues.length > 0) {
      this.output.appendLine('  Detailed occurrences (first few):');
      analysis.issues.slice(0, 10).forEach((issue) => {
        this.output.appendLine(`    Line ${issue.line}, Col ${issue.column}: ${issue.description}`);
      });
    }
    this.output.appendLine(`  Hint: Save the file to auto-sanitize (if sanitizeOnSave is enabled) or run "LabWindows/CVI: Sanitize Invisible / Incompatible Characters in Current File".`);

    const summaryText = issueSummaryList.join(', ');
    const choice = await vscode.window.showWarningMessage(
      `LabWindows/CVI: Issues found in ${fileName}: ${summaryText}.`,
      'Sanitize Now',
      'View Output',
      'Ignore'
    );

    if (choice === 'Sanitize Now') {
      await this.sanitizeActiveDocument(document);
    } else if (choice === 'View Output') {
      this.output.show(true);
    }
  }

  public async sanitizeActiveDocument(targetDocument?: vscode.TextDocument): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const document = targetDocument ?? editor?.document;

    if (!document) {
      vscode.window.showInformationMessage('No active document to sanitize.');
      return;
    }

    if (!this.isRelevantCviDocument(document)) {
      vscode.window.showWarningMessage('Current document is not a LabWindows/CVI source or project file.');
      return;
    }

    const configuredMode = vscode.workspace.getConfiguration('labwindowsCvi').get<SanitizationMode>('sanitizeOnSave', 'normalizeWhitespace');
    const mode = configuredMode === 'off' ? 'normalizeWhitespace' : configuredMode;

    const originalText = document.getText();
    const result = this.sanitizeText(originalText, mode);

    if (result.changeCount === 0) {
      vscode.window.showInformationMessage(`No characters needed sanitization in ${path.basename(document.fileName)}.`);
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(originalText.length)
    );
    edit.replace(document.uri, fullRange, result.newText);
    const success = await vscode.workspace.applyEdit(edit);

    if (success) {
      this.output.appendLine(`[CVI Encoding] Sanitized ${path.basename(document.fileName)} (${mode}): ${result.summary}`);
      vscode.window.showInformationMessage(`Sanitized ${result.changeCount} character(s) in ${path.basename(document.fileName)}: ${result.summary}`);
    } else {
      vscode.window.showErrorMessage(`Failed to apply sanitization edits to ${path.basename(document.fileName)}.`);
    }
  }
}
