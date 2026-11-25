// Editor colour themes. Token colours follow each VS Code theme's SQL scopes:
//   keyword (keyword.other.sql) · type (storage.type) · func (support.function) · string · quoted (`identifier`)
//   number · constant (TRUE/FALSE/NULL) · comment · variable (@var) · operator · ident (plain names)
const DARK_BRACKETS = ['#FFD700', '#DA70D6', '#179FFF'];
const LIGHT_BRACKETS = ['#0431FA', '#319331', '#7B3814'];

export const THEMES = [
  {
    id: 'dark-plus', name: 'Dark+', group: 'VS Code', dark: true,
    c: { bg: '#1E1E1E', fg: '#D4D4D4', gutterFg: '#858585', gutterActive: '#C6C6C6', activeLine: 'rgba(255,255,255,0.04)', selection: '#264F78', cursor: '#AEAFAD', widget: '#252526', border: '#454545',
      keyword: '#569CD6', type: '#4EC9B0', func: '#DCDCAA', string: '#CE9178', quoted: '#CE9178', number: '#B5CEA8', constant: '#569CD6', comment: '#6A9955', variable: '#9CDCFE', operator: '#D4D4D4', ident: '#D4D4D4' },
    brackets: DARK_BRACKETS,
  },
  {
    id: 'light-plus', name: 'Light+', group: 'VS Code', dark: false,
    c: { bg: '#FFFFFF', fg: '#000000', gutterFg: '#237893', gutterActive: '#0B216F', activeLine: 'rgba(0,0,0,0.035)', selection: '#ADD6FF', cursor: '#000000', widget: '#F3F3F3', border: '#C8C8C8',
      keyword: '#0000FF', type: '#267F99', func: '#795E26', string: '#A31515', quoted: '#A31515', number: '#098658', constant: '#0000FF', comment: '#008000', variable: '#001080', operator: '#000000', ident: '#000000' },
    brackets: LIGHT_BRACKETS,
  },
  {
    id: 'monokai', name: 'Monokai', group: 'Popular', dark: true,
    c: { bg: '#272822', fg: '#F8F8F2', gutterFg: '#90908A', gutterActive: '#C2C2BF', activeLine: '#3E3D32', selection: '#878B9180', cursor: '#F8F8F0', widget: '#1E1F1C', border: '#414339',
      keyword: '#F92672', type: '#66D9EF', typeStyle: 'italic', func: '#A6E22E', string: '#E6DB74', quoted: '#E6DB74', number: '#AE81FF', constant: '#AE81FF', comment: '#88846F', variable: '#FD971F', operator: '#F92672', ident: '#F8F8F2' },
    brackets: DARK_BRACKETS,
  },
  {
    id: 'one-dark', name: 'One Dark Pro', group: 'Popular', dark: true,
    c: { bg: '#282C34', fg: '#ABB2BF', gutterFg: '#495162', gutterActive: '#ABB2BF', activeLine: '#2C313C', selection: '#3E4451', cursor: '#528BFF', widget: '#21252B', border: '#181A1F',
      keyword: '#C678DD', type: '#E5C07B', func: '#61AFEF', string: '#98C379', quoted: '#E06C75', number: '#D19A66', constant: '#D19A66', comment: '#7F848E', commentStyle: 'italic', variable: '#E06C75', operator: '#56B6C2', ident: '#ABB2BF' },
    brackets: DARK_BRACKETS,
  },
  {
    id: 'dracula', name: 'Dracula', group: 'Popular', dark: true,
    c: { bg: '#282A36', fg: '#F8F8F2', gutterFg: '#6272A4', gutterActive: '#F8F8F2', activeLine: '#44475A75', selection: '#44475A', cursor: '#F8F8F2', widget: '#21222C', border: '#191A21',
      keyword: '#FF79C6', type: '#8BE9FD', typeStyle: 'italic', func: '#50FA7B', string: '#F1FA8C', quoted: '#F1FA8C', number: '#BD93F9', constant: '#BD93F9', comment: '#6272A4', variable: '#FFB86C', operator: '#FF79C6', ident: '#F8F8F2' },
    brackets: DARK_BRACKETS,
  },
  {
    id: 'github-dark', name: 'GitHub Dark', group: 'Popular', dark: true,
    c: { bg: '#0D1117', fg: '#E6EDF3', gutterFg: '#6E7681', gutterActive: '#E6EDF3', activeLine: 'rgba(110,118,129,0.10)', selection: '#264F78', cursor: '#E6EDF3', widget: '#161B22', border: '#30363D',
      keyword: '#FF7B72', type: '#FFA657', func: '#D2A8FF', string: '#A5D6FF', quoted: '#A5D6FF', number: '#79C0FF', constant: '#79C0FF', comment: '#8B949E', variable: '#FFA657', operator: '#FF7B72', ident: '#E6EDF3' },
    brackets: DARK_BRACKETS,
  },
  {
    id: 'github-light', name: 'GitHub Light', group: 'Popular', dark: false,
    c: { bg: '#FFFFFF', fg: '#1F2328', gutterFg: '#8C959F', gutterActive: '#1F2328', activeLine: 'rgba(234,238,242,0.6)', selection: 'rgba(9,105,218,0.18)', cursor: '#1F2328', widget: '#F6F8FA', border: '#D0D7DE',
      keyword: '#CF222E', type: '#953800', func: '#8250DF', string: '#0A3069', quoted: '#0A3069', number: '#0550AE', constant: '#0550AE', comment: '#6E7781', variable: '#953800', operator: '#CF222E', ident: '#1F2328' },
    brackets: LIGHT_BRACKETS,
  },
  {
    id: 'solarized-dark', name: 'Solarized Dark', group: 'Popular', dark: true,
    c: { bg: '#002B36', fg: '#839496', gutterFg: '#586E75', gutterActive: '#93A1A1', activeLine: '#073642', selection: '#274642', cursor: '#D30102', widget: '#00212B', border: '#2B2B4A',
      keyword: '#859900', type: '#B58900', func: '#268BD2', string: '#2AA198', quoted: '#2AA198', number: '#D33682', constant: '#B58900', comment: '#586E75', commentStyle: 'italic', variable: '#268BD2', operator: '#859900', ident: '#839496' },
    brackets: DARK_BRACKETS,
  },
  {
    id: 'solarized-light', name: 'Solarized Light', group: 'Popular', dark: false,
    c: { bg: '#FDF6E3', fg: '#657B83', gutterFg: '#93A1A1', gutterActive: '#586E75', activeLine: '#EEE8D5', selection: '#E4DCC4', cursor: '#657B83', widget: '#EEE8D5', border: '#DDD6C1',
      keyword: '#859900', type: '#B58900', func: '#268BD2', string: '#2AA198', quoted: '#2AA198', number: '#D33682', constant: '#B58900', comment: '#93A1A1', commentStyle: 'italic', variable: '#268BD2', operator: '#859900', ident: '#657B83' },
    brackets: LIGHT_BRACKETS,
  },
  {
    id: 'nord', name: 'Nord', group: 'Popular', dark: true,
    c: { bg: '#2E3440', fg: '#D8DEE9', gutterFg: '#4C566A', gutterActive: '#D8DEE9', activeLine: '#3B4252', selection: '#434C5ECC', cursor: '#D8DEE9', widget: '#3B4252', border: '#434C5E',
      keyword: '#81A1C1', type: '#8FBCBB', func: '#88C0D0', string: '#A3BE8C', quoted: '#A3BE8C', number: '#B48EAD', constant: '#81A1C1', comment: '#616E88', commentStyle: 'italic', variable: '#D8DEE9', operator: '#81A1C1', ident: '#D8DEE9' },
    brackets: DARK_BRACKETS,
  },
  {
    id: 'classic', name: 'Classic (Xcode-like)', group: 'QRT', dark: null, // follows light/dark
    light: { bg: '#FFFFFF', fg: '#1D1D1F', gutterFg: '#A1A1A6', gutterActive: '#1D1D1F', activeLine: 'rgba(10,132,255,0.05)', selection: 'rgba(10,132,255,0.22)', cursor: '#0A84FF', widget: '#FFFFFF', border: '#D9D9DE',
      keyword: '#AD3DA4', keywordWeight: '600', type: '#3900A0', func: '#326D74', string: '#C41A16', quoted: '#0B6A7A', number: '#1C00CF', constant: '#1C00CF', comment: '#6E7781', commentStyle: 'italic', variable: '#0B6A7A', operator: '#444444', ident: '#1D1D1F' },
    darkC: { bg: '#1F2023', fg: '#E6E6E9', gutterFg: '#6C6C73', gutterActive: '#E6E6E9', activeLine: 'rgba(255,255,255,0.035)', selection: 'rgba(59,147,255,0.35)', cursor: '#3B93FF', widget: '#26272B', border: '#3A3B40',
      keyword: '#FC5FA3', keywordWeight: '600', type: '#D0A8FF', func: '#A167E6', string: '#FC6A5D', quoted: '#67B7A4', number: '#D0BF69', constant: '#D0BF69', comment: '#7F8C98', commentStyle: 'italic', variable: '#67B7A4', operator: '#C8C8CC', ident: '#E6E6E9' },
  },
];

// 'auto' = Light+ / Dark+ following the app appearance (like VS Code's "auto detect color scheme").
export function resolveTheme(id, systemDark) {
  if (id === 'auto' || !id) id = systemDark ? 'dark-plus' : 'light-plus';
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  if (t.dark === null) {
    return { ...t, dark: systemDark, c: systemDark ? t.darkC : t.light, brackets: systemDark ? DARK_BRACKETS : LIGHT_BRACKETS };
  }
  return t;
}

// CSS custom properties consumed by the editor (see Editor.jsx).
export function themeVars(t) {
  const c = t.c;
  return {
    '--ed-bg': c.bg,
    '--ed-fg': c.fg,
    '--ed-gutter-fg': c.gutterFg,
    '--ed-gutter-active': c.gutterActive,
    '--ed-active-line': c.activeLine,
    '--ed-selection': c.selection,
    '--ed-cursor': c.cursor,
    '--ed-widget': c.widget,
    '--ed-border': c.border,
    '--ed-stmt': t.dark ? 'rgba(130,170,255,0.055)' : 'rgba(10,132,255,0.045)',
    '--ed-search': t.dark ? 'rgba(234,92,0,0.33)' : 'rgba(234,92,0,0.25)',
    '--ed-keyword': c.keyword,
    '--ed-keyword-weight': c.keywordWeight || 'normal',
    '--ed-type': c.type,
    '--ed-type-style': c.typeStyle || 'normal',
    '--ed-func': c.func,
    '--ed-string': c.string,
    '--ed-quoted': c.quoted,
    '--ed-number': c.number,
    '--ed-constant': c.constant,
    '--ed-comment': c.comment,
    '--ed-comment-style': c.commentStyle || 'normal',
    '--ed-variable': c.variable,
    '--ed-operator': c.operator,
    '--ed-ident': c.ident,
    '--ed-bp0': t.brackets[0],
    '--ed-bp1': t.brackets[1],
    '--ed-bp2': t.brackets[2],
  };
}

export const FONTS = [
  ['SF Mono', 'ui-monospace, "SF Mono", Menlo, monospace'], // ui-monospace = SF Mono in Chromium on macOS
  ['Menlo', 'Menlo, monospace'],
  ['Monaco', 'Monaco, monospace'],
  ['JetBrains Mono', '"JetBrains Mono", Menlo, monospace'],
  ['Fira Code', '"Fira Code", Menlo, monospace'],
  ['Cascadia Code', '"Cascadia Code", Menlo, monospace'],
  ['Source Code Pro', '"Source Code Pro", Menlo, monospace'],
  ['IBM Plex Mono', '"IBM Plex Mono", Menlo, monospace'],
  ['Hack', 'Hack, Menlo, monospace'],
  ['Courier New', '"Courier New", monospace'],
];

// A font is installed if text measures differently from the generic fallbacks.
export function isFontInstalled(name) {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    const sample = 'mmmmmmmmmmlli1|WW0Oo{}<>=>';
    return ['monospace', 'serif'].some((base) => {
      ctx.font = `20px ${base}`;
      const w0 = ctx.measureText(sample).width;
      ctx.font = `20px "${name}", ${base}`;
      return ctx.measureText(sample).width !== w0;
    });
  } catch {
    return true;
  }
}
