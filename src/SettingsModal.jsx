import React, { useMemo, useState } from 'react';
import Editor from './Editor';
import { THEMES, FONTS, resolveTheme, isFontInstalled } from './themes';
import { usePrefs, setPrefs, useSystemDark, DEFAULT_PREFS } from './prefs';
import { api } from './util';

const SAMPLE = `-- Preview: change settings on the left
SELECT o.id, c.name AS customer, COUNT(*) AS items,
       ROUND(SUM(i.price * i.qty), 2) AS total, @tax_rate
  FROM \`orders\` o
  JOIN customers c ON c.id = o.customer_id
 WHERE o.status IN ('paid', 'shipped')
   AND o.created_at >= NOW() - INTERVAL 7 DAY
   AND (o.note IS NULL OR LENGTH(TRIM(o.note)) > 0)
 GROUP BY o.id
HAVING total > 1000.50;

ALTER TABLE \`beds\` ADD COLUMN \`housekeeping_status\` VARCHAR(20) NOT NULL DEFAULT 'ready';
`;

// One line of tokens for the theme cards: [colourKey, text]
const CARD_LINE = [
  ['keyword', 'SELECT '], ['func', 'COUNT'], ['fg', '(*), '], ['ident', 'name'], ['fg', ' '], ['keyword', 'FROM '], ['quoted', '`beds`'],
];
const CARD_LINE2 = [
  ['keyword', 'WHERE '], ['ident', 'qty'], ['operator', ' > '], ['number', '10'], ['operator', ' AND '], ['ident', 's'], ['operator', ' = '], ['string', "'ok'"],
];
const CARD_LINE3 = [['comment', '-- '], ['comment', 'pending'], ['fg', ' '], ['type', 'VARCHAR'], ['fg', '('], ['number', '20'], ['fg', ')']];

function ThemeCard({ id, name, selected, onPick, systemDark }) {
  const th = resolveTheme(id, systemDark);
  const c = th.c;
  const color = (k) => (k === 'fg' ? c.fg : c[k]);
  const line = (toks) => (
    <div className="tc-line">
      {toks.map(([k, txt], i) => (
        <span key={i} style={{ color: color(k), fontStyle: k === 'comment' ? c.commentStyle || 'normal' : 'normal' }}>
          {txt}
        </span>
      ))}
    </div>
  );
  return (
    <button type="button" className={'theme-card' + (selected ? ' on' : '')} onClick={onPick} title={name}>
      <div className="tc-preview" style={{ background: c.bg, borderColor: c.border }}>
        {line(CARD_LINE)}
        {line(CARD_LINE2)}
        {line(CARD_LINE3)}
      </div>
      <div className="tc-name">{name}</div>
    </button>
  );
}

export default function SettingsModal({ onClose }) {
  const prefs = usePrefs();
  const systemDark = useSystemDark();
  const [preview, setPreview] = useState(SAMPLE);
  const fonts = useMemo(() => FONTS.filter(([name], i) => i === 0 || isFontInstalled(name)), []);
  const missingFonts = FONTS.filter((f) => !fonts.includes(f)).map((f) => f[0]);

  const setAppearance = (v) => {
    setPrefs({ appearance: v });
    api.setAppearance(v).catch(() => {});
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal settings" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-title">
          Settings
          <span className="spacer" />
          <button
            className="danger-link"
            onClick={() => {
              setPrefs({ ...DEFAULT_PREFS });
              api.setAppearance('system').catch(() => {});
            }}
          >
            Reset
          </button>
          <button onClick={onClose}>Done</button>
        </div>
        <div className="settings-body">
          <div className="settings-left">
            <section>
              <h3>Appearance</h3>
              <div className="seg">
                {[
                  ['system', 'System'],
                  ['light', 'Light'],
                  ['dark', 'Dark'],
                ].map(([v, l]) => (
                  <button key={v} className={prefs.appearance === v ? 'on' : ''} onClick={() => setAppearance(v)}>
                    {l}
                  </button>
                ))}
              </div>
            </section>

            <section>
              <h3>Editor Theme</h3>
              <div className="theme-grid">
                <ThemeCard id="auto" name="Auto — Light+ / Dark+" selected={prefs.theme === 'auto'} onPick={() => setPrefs({ theme: 'auto' })} systemDark={systemDark} />
                {THEMES.map((t) => (
                  <ThemeCard key={t.id} id={t.id} name={t.name} selected={prefs.theme === t.id} onPick={() => setPrefs({ theme: t.id })} systemDark={systemDark} />
                ))}
              </div>
            </section>

            <section className="settings-form">
              <h3>Font</h3>
              <div className="srow">
                <label>Family</label>
                <select value={prefs.fontFamily} onChange={(e) => setPrefs({ fontFamily: e.target.value })}>
                  {fonts.map(([name]) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              {missingFonts.length > 0 && <div className="hint">Not installed: {missingFonts.join(', ')}</div>}
              <div className="srow">
                <label>Size</label>
                <div className="stepper">
                  <button onClick={() => setPrefs({ fontSize: Math.max(10, prefs.fontSize - 1) })}>−</button>
                  <span>{prefs.fontSize}px</span>
                  <button onClick={() => setPrefs({ fontSize: Math.min(28, prefs.fontSize + 1) })}>＋</button>
                </div>
              </div>
              <div className="srow">
                <label>Line height</label>
                <select value={prefs.lineHeight} onChange={(e) => setPrefs({ lineHeight: Number(e.target.value) })}>
                  {[1.35, 1.45, 1.55, 1.7, 1.85].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <label className="check">
                <input type="checkbox" checked={prefs.ligatures} onChange={(e) => setPrefs({ ligatures: e.target.checked })} /> Font ligatures
                <span className="hint">(&gt;= != =&gt; with Fira Code / JetBrains Mono / Cascadia)</span>
              </label>
            </section>

            <section className="settings-form">
              <h3>Editor</h3>
              <label className="check">
                <input type="checkbox" checked={prefs.bracketColors} onChange={(e) => setPrefs({ bracketColors: e.target.checked })} /> Bracket pair colorization
              </label>
              <label className="check">
                <input type="checkbox" checked={prefs.highlightStatement} onChange={(e) => setPrefs({ highlightStatement: e.target.checked })} /> Highlight the
                statement ⌘↩ will run
              </label>
              <label className="check">
                <input type="checkbox" checked={prefs.cursorBlink} onChange={(e) => setPrefs({ cursorBlink: e.target.checked })} /> Blinking cursor
              </label>
            </section>
          </div>
          <div className="settings-preview">
            <div className="preview-label">Preview — {resolveTheme(prefs.theme, systemDark).name}</div>
            <div className="preview-editor">
              <Editor value={preview} onChange={setPreview} schema={{}} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
