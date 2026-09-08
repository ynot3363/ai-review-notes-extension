# Changelog

All notable changes to Coding Notes for AI will be documented in this file.

## Unreleased

- Serialize note transactions across extension processes with exclusive filesystem locks and check for external changes before replacing a store.
- Preserve unsaved comment edits during refresh and reject saves based on externally changed text.
- Bind Clear All Notes to the confirmed note snapshot, preserving later additions and edits.

## 0.6.0

- Added a configurable collapsed/expanded display state for newly submitted notes, defaulting to collapsed.
- Added a confirmed Clear All Notes command that safely preserves notes changed concurrently outside the extension.
- Added an open-notes or all-notes scope picker before generating an AI resolution report.
- Renamed the extension and its public identifiers to Coding Notes for AI.
- Reframed report generation as an AI-resolution handoff and copied the generated task report to the clipboard.
- Fixed View Note navigation so its native comment thread opens instead of only selecting the symbol.
- Added the relevant `CODING_NOTES_FOR_AI.json` path to generated AI resolution reports.
- Added a Caltagirone Dusk marketplace icon plus repository and issue-tracker metadata.
- Kept the built-in category list visible alongside configured and current values, and persisted custom category input for future selection.
- Added Move Note Here so attached notes can be associated with a new line, range, symbol, file, or workspace root.
- Listed every symbol exposed for a file in the target picker, ordered with the closest symbol first.
- Added an Add Note action that appears only while hovering a provider-reported symbol declaration.
- Added `codingNotesForAi.creationUi` as a multi-select setting for any combination of line gutter, symbol CodeLens, and symbol hover, defaulting to gutter plus hover.
- Added persistent View Note CodeLens navigation for saved symbol notes, independent of creation UI settings.

## 0.4.0

- Added a Reopen Note action for resolved native threads, Explorer findings, and orphaned notes.
- Added category selection to native gutter-created drafts, with the selection displayed before submission.

## 0.3.0

- Replaced the assistant-specific Open With commands and settings with a single clipboard workflow.
- Added a Copy AI Prompt icon beside Resolve on open native comment threads and kept it available on resolved threads.

## 0.2.0

- Fixed report, Explorer, clipboard, Open With, Codex, VS Code Chat, and Claude Code command feedback and native-comment targeting.
- Added runtime Codex sidebar discovery and Claude Code's documented prefilled, unsubmitted URI handoff.
- Replaced tailored categories with general-purpose defaults, added ad-hoc custom categories, and added a native Change Category action.
- Removed the legacy inline-comment import command.
- Documented the native VS Code gutter-placement constraint.

## 0.1.0

- Initial standalone extension implementation.
- Native VS Code gutter and range comments for normal workspace text files without changing source files.
- Shared `CODING_NOTES_FOR_AI.json` sidecar storage by default, with optional private local workspace storage.
- Single-line, multi-line selection, and best-effort document-symbol anchors with drift recovery, orphan detection, and manual reattachment.
- Thread editing, deletion, resolution, grouped Explorer navigation, Markdown reports, and safe assistant handoffs.
