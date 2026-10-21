import hljs from 'highlight.js/lib/common';

export interface Seg {
  text: string;
  cls: string;
}

const EXT_LANG: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  go: 'go',
  rs: 'rust',
  py: 'python',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  m: 'objectivec',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  vue: 'xml',
  svg: 'xml',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  ini: 'ini',
  toml: 'ini',
  properties: 'ini',
  gradle: 'kotlin',
  graphql: 'graphql',
  mk: 'makefile',
};

export function languageFor(path: string): string | null {
  const name = path.split('/').pop() ?? '';
  if (/^(Makefile|GNUmakefile)$/.test(name)) return 'makefile';
  if (/^Dockerfile/.test(name)) return 'bash';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return EXT_LANG[ext] ?? null;
}

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };

/** Converts highlight.js HTML output into per-line lists of classed segments. */
function htmlToLines(html: string): Seg[][] {
  const lines: Seg[][] = [[]];
  const stack: string[] = [];
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) stack.push(m[1].split(' ').map((c) => c.replace(/^hljs-/, 'hl-')).join(' '));
    else if (m[0] === '</span>') stack.pop();
    else {
      const text = m[2].replace(/&(lt|gt|amp|quot|#x27|#39);/g, (e) => ENTITIES[e]);
      const cls = stack.join(' ');
      const parts = text.split('\n');
      parts.forEach((p, i) => {
        if (i > 0) lines.push([]);
        if (p) lines[lines.length - 1].push({ text: p, cls });
      });
    }
  }
  return lines;
}

const MAX_HIGHLIGHT = 400_000;

export function highlightLines(text: string, path: string): Seg[][] | null {
  const lang = languageFor(path);
  if (!lang || text.length > MAX_HIGHLIGHT || !hljs.getLanguage(lang)) return null;
  try {
    return htmlToLines(hljs.highlight(text, { language: lang, ignoreIllegals: true }).value);
  } catch {
    return null;
  }
}

/** Splits segments at range boundaries and adds `mark` to the parts inside the ranges. */
export function markRanges(segs: Seg[], ranges: [number, number][] | undefined, mark: string): Seg[] {
  if (!ranges || !ranges.length) return segs;
  const out: Seg[] = [];
  let pos = 0;
  for (const s of segs) {
    let start = 0;
    const end = s.text.length;
    while (start < end) {
      const abs = pos + start;
      const inside = ranges.find(([a, b]) => abs >= a && abs < b);
      let stop = end;
      if (inside) stop = Math.min(end, inside[1] - pos);
      else {
        const nextR = ranges.filter(([a]) => a > abs).sort((x, y) => x[0] - y[0])[0];
        if (nextR) stop = Math.min(end, nextR[0] - pos);
      }
      out.push({ text: s.text.slice(start, stop), cls: inside ? `${s.cls} ${mark}`.trim() : s.cls });
      start = stop;
    }
    pos += end;
  }
  return out;
}
