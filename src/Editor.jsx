import React, { useEffect, useMemo, useRef } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration, ViewPlugin } from '@codemirror/view';
import { EditorState, Compartment, StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { sql, MySQL } from '@codemirror/lang-sql';
import { syntaxHighlighting, syntaxTree, HighlightStyle, bracketMatching, indentOnInput, foldGutter, foldKeymap } from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { statementAt } from './sqlSplit';
import { usePrefs, useSystemDark } from './prefs';
import { resolveTheme, themeVars, FONTS } from './themes';

// Token colours come from CSS variables set by the active theme (themes.js), VS Code-style scopes.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--ed-keyword)', fontWeight: 'var(--ed-keyword-weight)' },
  { tag: t.typeName, color: 'var(--ed-type)', fontStyle: 'var(--ed-type-style)' },
  { tag: t.standard(t.name), color: 'var(--ed-func)' },
  { tag: t.string, color: 'var(--ed-string)' },
  { tag: t.special(t.string), color: 'var(--ed-quoted)' },
  { tag: t.number, color: 'var(--ed-number)' },
  { tag: [t.bool, t.null], color: 'var(--ed-constant)' },
  { tag: [t.lineComment, t.blockComment, t.comment], color: 'var(--ed-comment)', fontStyle: 'var(--ed-comment-style)' },
  { tag: t.special(t.name), color: 'var(--ed-variable)' },
  { tag: t.name, color: 'var(--ed-ident)' },
  { tag: [t.operator], color: 'var(--ed-operator)' },
  { tag: [t.punctuation, t.paren, t.brace, t.squareBracket], color: 'var(--ed-fg)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--ed-font-size)', backgroundColor: 'var(--ed-bg)', color: 'var(--ed-fg)' },
  '.cm-scroller': { fontFamily: 'var(--ed-font)', lineHeight: 'var(--ed-line-height)', fontVariantLigatures: 'var(--ed-ligatures)', fontFeatureSettings: 'var(--ed-features)' },
  '.cm-content': { caretColor: 'var(--ed-cursor)' },
  '.cm-gutters': { backgroundColor: 'var(--ed-bg)', color: 'var(--ed-gutter-fg)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px' },
  '.cm-activeLine': { backgroundColor: 'var(--ed-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ed-gutter-active)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--ed-selection) !important' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ed-cursor)', borderLeftWidth: '2px' },
  '.cm-current-stmt': { backgroundColor: 'var(--ed-stmt)' },
  '.cm-tooltip': { backgroundColor: 'var(--ed-widget)', border: '1px solid var(--ed-border)', color: 'var(--ed-fg)', borderRadius: '6px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--ed-selection)', color: 'var(--ed-fg)' },
  '.cm-completionIcon': { opacity: 0.8 },
  '.cm-panels': { backgroundColor: 'var(--ed-widget)', color: 'var(--ed-fg)' },
  '.cm-panels input, .cm-panels button': { color: 'inherit' },
  '.cm-searchMatch': { backgroundColor: 'var(--ed-search)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--ed-active-line)', outline: '1px solid var(--ed-border)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'transparent', outline: '1px solid var(--ed-gutter-fg)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--ed-widget)', border: '1px solid var(--ed-border)', color: 'var(--ed-gutter-fg)' },
  '&.cm-focused': { outline: 'none' },
});

// VS Code colours a name followed by "(" as a function call (COUNT(…), NOW(), GROUP_CONCAT(…));
// the SQL grammar alone tags most of those as plain names or keywords.
const NOT_FUNCTIONS = new Set(['IN', 'VALUES', 'VALUE', 'EXISTS', 'USING', 'ON', 'AS', 'INTO', 'AND', 'OR', 'NOT', 'THEN', 'ELSE', 'WHEN', 'SELECT', 'FROM', 'WHERE', 'KEY', 'INDEX', 'TABLE', 'JOIN', 'BY', 'OVER', 'ALL', 'ANY', 'SOME', 'RETURNS', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'VIEW']);
const fnMark = Decoration.mark({ class: 'cm-sql-fn' });
const functionCalls = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.build(view);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = this.build(u.view);
    }
    build(view) {
      const b = new RangeSetBuilder();
      const doc = view.state.doc;
      for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
          from,
          to,
          enter: (n) => {
            if (n.name !== 'Identifier' && n.name !== 'Keyword' && n.name !== 'Builtin') return;
            if (doc.sliceString(n.to, n.to + 1) !== '(') return;
            if (NOT_FUNCTIONS.has(doc.sliceString(n.from, n.to).toUpperCase())) return;
            b.add(n.from, n.to, fnMark);
          },
        });
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations }
);

// Bracket pair colourisation (VS Code: editor.bracketPairColorization) — depth cycles through 3 colours,
// unmatched closing brackets are red. Strings/comments are skipped because only real "(" ")" tokens count.
const bpMarks = [0, 1, 2].map((i) => Decoration.mark({ class: 'cm-bp-' + i }));
const bpError = Decoration.mark({ class: 'cm-bp-err' });
const bracketPairs = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.build(view);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = this.build(u.view);
    }
    build(view) {
      const b = new RangeSetBuilder();
      const ranges = view.visibleRanges;
      if (!ranges.length || view.state.doc.length > 500000) return b.finish();
      const end = ranges[ranges.length - 1].to;
      const visible = (pos) => ranges.some((r) => pos >= r.from && pos < r.to);
      let depth = 0;
      // Walk from the top so depth is right for the visible part.
      syntaxTree(view.state).iterate({
        to: end,
        enter: (n) => {
          const open = n.name === '(' || n.name === '[' || n.name === '{';
          const close = n.name === ')' || n.name === ']' || n.name === '}';
          if (!open && !close) return;
          if (open) {
            if (visible(n.from)) b.add(n.from, n.to, bpMarks[depth % 3]);
            depth++;
          } else if (depth === 0) {
            if (visible(n.from)) b.add(n.from, n.to, bpError);
          } else {
            depth--;
            if (visible(n.from)) b.add(n.from, n.to, bpMarks[depth % 3]);
          }
        },
      });
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations }
);

// Subtle highlight of the statement the cursor is in (what ⌘↩ will run).
const stmtMark = Decoration.line({ class: 'cm-current-stmt' });
const currentStatement = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.build(view);
    }
    update(u) {
      if (u.docChanged || u.selectionSet || u.focusChanged) this.decorations = this.build(u.view);
    }
    build(view) {
      const doc = view.state.doc;
      if (doc.length > 200000 || !view.hasFocus) return Decoration.none;
      const sel = view.state.selection.main;
      if (!sel.empty) return Decoration.none;
      const s = statementAt(doc.toString(), sel.head);
      if (!s) return Decoration.none;
      const ranges = [];
      const startLine = doc.lineAt(s.from).number;
      const endLine = doc.lineAt(Math.min(s.to, doc.length)).number;
      if (startLine === endLine && doc.lines === 1) return Decoration.none;
      for (let l = startLine; l <= endLine; l++) ranges.push(stmtMark.range(doc.line(l).from));
      return Decoration.set(ranges);
    }
  },
  { decorations: (v) => v.decorations }
);

// Flash errors: a highlighted range set from outside.
const setErrorRange = StateEffect.define();
const errorField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrorRange)) {
        deco = e.value ? Decoration.set([Decoration.mark({ class: 'cm-error-range' }).range(e.value.from, e.value.to)]) : Decoration.none;
      }
    }
    if (tr.docChanged) return Decoration.none;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export default function Editor({ value, onChange, schema, defaultTable, onRun, onRunAll, editorRef }) {
  const host = useRef(null);
  const viewRef = useRef(null);
  const sqlConf = useRef(new Compartment());
  const optConf = useRef(new Compartment());
  const prefs = usePrefs();
  const systemDark = useSystemDark();
  const optional = (p) => [
    p.bracketColors ? bracketPairs : [],
    p.highlightStatement ? currentStatement : [],
    drawSelection({ cursorBlinkRate: p.cursorBlink ? 1200 : 0 }),
  ];
  const handlers = useRef({});
  handlers.current = { onChange, onRun, onRunAll };

  useEffect(() => {
    const runKeys = keymap.of([
      {
        key: 'Mod-Enter',
        preventDefault: true,
        run: (view) => {
          handlers.current.onRun && handlers.current.onRun(selectedOrCurrent(view));
          return true;
        },
      },
      {
        key: 'Shift-Mod-Enter',
        preventDefault: true,
        run: (view) => {
          handlers.current.onRunAll && handlers.current.onRunAll(view.state.doc.toString());
          return true;
        },
      },
      { key: 'Mod-/', run: toggleComment },
    ]);
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value || '',
        extensions: [
          runKeys,
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          syntaxHighlighting(highlight),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true, maxRenderedOptions: 80 }),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
          sqlConf.current.of(sql({ dialect: MySQL, upperCaseKeywords: true, schema: schema || {}, defaultTable })),
          optConf.current.of(optional(prefs)),
          functionCalls,
          errorField,
          theme,
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange && handlers.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (editorRef) {
      editorRef.current = {
        view,
        focus: () => view.focus(),
        getValue: () => view.state.doc.toString(),
        current: () => selectedOrCurrent(view),
        insert: (text) => {
          const sel = view.state.selection.main;
          view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length } });
          view.focus();
        },
        replaceAll: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
        markError: (range) => view.dispatch({ effects: setErrorRange.of(range) }),
        select: (from, to) => {
          const len = view.state.doc.length;
          view.dispatch({ selection: { anchor: Math.min(from, len), head: Math.min(to, len) }, scrollIntoView: true });
          view.focus();
        },
      };
    }
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggleable extras follow the preferences live.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: optConf.current.reconfigure(optional(prefs)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.bracketColors, prefs.highlightStatement, prefs.cursorBlink]);

  // Theme + font as CSS variables on the host element.
  const style = useMemo(() => {
    const th = resolveTheme(prefs.theme, systemDark);
    const font = (FONTS.find((f) => f[0] === prefs.fontFamily) || FONTS[0])[1];
    return {
      ...themeVars(th),
      '--ed-font': font,
      '--ed-font-size': prefs.fontSize + 'px',
      '--ed-line-height': String(prefs.lineHeight),
      '--ed-ligatures': prefs.ligatures ? 'contextual' : 'none',
      '--ed-features': prefs.ligatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0',
      colorScheme: th.dark ? 'dark' : 'light',
    };
  }, [prefs, systemDark]);

  // Keep schema-aware autocompletion in sync with the selected database.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: sqlConf.current.reconfigure(sql({ dialect: MySQL, upperCaseKeywords: true, schema: schema || {}, defaultTable })) });
  }, [schema, defaultTable]);

  // External value replacement (e.g. opening a file / switching tabs) without clobbering typing.
  useEffect(() => {
    const view = viewRef.current;
    if (view && value !== undefined && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className="editor-host" ref={host} style={style} />;
}

function selectedOrCurrent(view) {
  const sel = view.state.selection.main;
  const doc = view.state.doc.toString();
  if (!sel.empty) return { text: doc.slice(sel.from, sel.to), from: sel.from, to: sel.to, selection: true };
  const s = statementAt(doc, sel.head);
  return s ? { ...s, selection: false } : null;
}
