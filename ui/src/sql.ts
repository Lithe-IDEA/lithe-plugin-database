// SQL text handling the page does before it sends anything: splitting a
// script into statements, classifying each, the local risk guard, and the
// formatter. Ported from Lithe's former DatabaseSQLSupport so consoles keep
// their behavior; the backend still enforces read-only connections and
// production protection itself.

export type StatementKind = 'query' | 'mutation' | 'definition' | 'transaction' | 'batch' | 'unknown';

export interface Analysis {
  kind: StatementKind;
  statementCount: number;
  requiresConfirmation: boolean;
  /** A message key of `warnings`, or null. */
  warning: Warning | null;
  statements: string[];
}

export type Warning = 'empty' | 'unqualifiedWrite' | 'destructive' | 'unrecognized';

const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE']);

export function analyze(sql: string): Analysis {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    return { kind: 'unknown', statementCount: 0, requiresConfirmation: false, warning: 'empty', statements };
  }
  const analyses = statements.map(analyzeSingle);
  const warnings = analyses.map(analysis => analysis.warning).filter((warning): warning is Warning => warning !== null);
  return {
    kind: statements.length > 1 ? 'batch' : analyses[0].kind,
    statementCount: statements.length,
    requiresConfirmation: analyses.some(analysis => analysis.requiresConfirmation),
    warning: warnings.find(warning => warning !== 'unrecognized') ?? warnings[0] ?? null,
    statements,
  };
}

function analyzeSingle(statement: string): Analysis {
  const tokens = keywords(statement);
  const first = tokens[0];
  let kind: StatementKind;
  switch (first) {
    case 'SELECT': case 'SHOW': case 'DESCRIBE': case 'DESC': case 'EXPLAIN': case 'PRAGMA': case 'VALUES':
      kind = 'query';
      break;
    case 'WITH':
      kind = tokens.some(token => WRITE_KEYWORDS.has(token)) ? 'mutation' : 'query';
      break;
    case 'INSERT': case 'UPDATE': case 'DELETE': case 'MERGE': case 'REPLACE':
      kind = 'mutation';
      break;
    case 'CREATE': case 'ALTER': case 'DROP': case 'TRUNCATE': case 'VACUUM': case 'ANALYZE': case 'GRANT': case 'REVOKE':
      kind = 'definition';
      break;
    case 'BEGIN': case 'START': case 'COMMIT': case 'ROLLBACK': case 'SAVEPOINT': case 'RELEASE': case 'SET':
      kind = 'transaction';
      break;
    default:
      kind = 'unknown';
  }
  const isUnqualifiedWrite = (tokens.includes('UPDATE') || tokens.includes('DELETE')) && !tokens.includes('WHERE');
  const isDestructive = tokens.includes('DROP') || tokens.includes('TRUNCATE');
  const warning: Warning | null = isUnqualifiedWrite
    ? 'unqualifiedWrite'
    : isDestructive
      ? 'destructive'
      : kind === 'unknown'
        ? 'unrecognized'
        : null;
  return {
    kind,
    statementCount: 1,
    requiresConfirmation: isUnqualifiedWrite || isDestructive,
    warning,
    statements: [statement],
  };
}

/** Only queries go to the engine's `query`; everything else to `execute`. */
export const usesQueryEndpoint = (kind: StatementKind) => kind === 'query';

export function classify(statement: string): StatementKind {
  return analyzeSingle(statement).kind;
}

// Every scanner walks Unicode scalars, as the Swift original did, so a
// combining mark right after a quote never hides the quote.
const scalars = (text: string) => Array.from(text);
const isWordCharacter = (character: string) => /[\p{L}\p{N}_$]/u.test(character);
const isWhitespace = (character: string) => /\s/u.test(character);

function keywords(sql: string): string[] {
  return sanitized(sql)
    .split(/[^\p{L}_]+/u)
    .filter(Boolean)
    .map(token => token.toUpperCase());
}

/** Statements of a script, split on `;` outside quotes and comments. */
export function splitStatements(sql: string): string[] {
  return statementRanges(sql).map(range => range.text);
}

export interface StatementRange {
  text: string;
  /** Offsets in UTF-16 code units, for the editor. */
  from: number;
  to: number;
}

/** Statements with their position in `sql`; empty and comment-only parts are dropped. */
export function statementRanges(sql: string): StatementRange[] {
  const characters = scalars(sql);
  const ranges: StatementRange[] = [];
  let current = '';
  let start = 0;
  let offset = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;

  const flush = (end: number) => {
    if (sanitized(current).trim()) ranges.push({ text: current, from: start, to: end });
  };

  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    const next = characters[index + 1];
    const width = character.length;
    if (lineComment) {
      current += character;
      if (character === '\n') lineComment = false;
    } else if (blockComment) {
      current += character;
      if (character === '*' && next === '/') {
        current += next;
        blockComment = false;
        index++;
        offset += width;
      }
    } else if (quote !== null) {
      current += character;
      if (character === '\\' && next !== undefined) {
        current += next;
        index++;
        offset += width + next.length;
        continue;
      }
      if (character === quote) {
        if (next === quote) {
          current += next;
          index++;
          offset += width;
        } else {
          quote = null;
        }
      }
    } else if (character === '-' && next === '-') {
      lineComment = true;
      current += character + next;
      index++;
      offset += width;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      current += character + next;
      index++;
      offset += width;
    } else if (character === "'" || character === '"' || character === '`') {
      quote = character;
      current += character;
    } else if (character === ';') {
      flush(offset);
      current = '';
      start = offset + width;
    } else {
      current += character;
    }
    offset += width;
  }
  flush(offset);
  return ranges.map(range => trimRange(range));
}

/** Drops the whitespace around a statement, keeping its comments. */
function trimRange(range: StatementRange): StatementRange {
  const leading = range.text.length - range.text.trimStart().length;
  const text = range.text.trim();
  return { text, from: range.from + leading, to: range.from + leading + text.length };
}

/** The statement text with literals and comments blanked out. */
function sanitized(sql: string): string {
  const characters = scalars(sql);
  let output = '';
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    const next = characters[index + 1];
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        output += ' ';
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index++;
        output += ' ';
      }
      continue;
    }
    if (quote !== null) {
      if (character === '\\' && next !== undefined) {
        output += '  ';
        index++;
        continue;
      }
      if (character === quote) {
        if (next === quote) index++;
        else quote = null;
      }
      output += ' ';
      continue;
    }
    if (character === '-' && next === '-') {
      lineComment = true;
      index++;
      output += ' ';
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index++;
      output += ' ';
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      output += ' ';
      continue;
    }
    output += character;
  }
  return output;
}

const CLAUSES = new Set(['WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'RETURNING', 'SET', 'VALUES', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS']);
const JOIN_MODIFIERS = new Set(['LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS']);
const SELECT_INDENT = '    ';

/** Trims spaces and tabs, not newlines, from both ends. */
const trimSpaces = (text: string) => text.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, '');

/**
 * Lays out top-level clauses on their own lines and the SELECT list on an
 * indented line, preserving word case, literals, and comments. Scripts with
 * backslashes or dollar quoting are returned unchanged: their escaping
 * depends on the dialect and session.
 */
export function formatSQL(sql: string): string {
  if (sql.includes('\\') || /\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.test(sql)) return sql;
  const source = scalars(sql.trim());
  let output = '';
  let word = '';
  let needsSpace = false;
  let depth = 0;
  let previousWord = '';
  let followsLineComment = false;

  const appendWord = () => {
    if (!word) return;
    const keyword = word.toUpperCase();
    const qualified = output.endsWith('.');
    const joinModifier = JOIN_MODIFIERS.has(previousWord);
    if (depth === 0 && !qualified && keyword === 'FROM' && !followsLineComment && output.endsWith('\n')) {
      output = output.trim();
      needsSpace = true;
    }
    if (depth === 0 && !qualified && CLAUSES.has(keyword) && output && !(joinModifier && (keyword === 'JOIN' || keyword === 'OUTER'))) {
      output = trimSpaces(output);
      if (!output.endsWith('\n')) output += '\n';
    } else if (needsSpace && output && !output.endsWith('\n')) {
      output += ' ';
    }
    output += word;
    previousWord = keyword;
    followsLineComment = false;
    word = '';
    needsSpace = true;
    if (depth === 0 && !qualified && keyword === 'SELECT') {
      output += `\n${SELECT_INDENT}`;
      needsSpace = false;
    }
  };

  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (isWordCharacter(character)) {
      word += character;
      index++;
      continue;
    }
    appendWord();
    if (isWhitespace(character)) {
      if (character === '\n' && output && !output.endsWith('\n') && !output.endsWith(`\n${SELECT_INDENT}`)) output += '\n';
      needsSpace = output !== '' && !output.endsWith('\n') && !output.endsWith(' ');
      index++;
      continue;
    }
    if (character === '#' || (character === '-' && source[index + 1] === '-')) {
      if (needsSpace && output && !output.endsWith('\n')) output += ' ';
      output += character === '#' ? '#' : '--';
      index += character === '#' ? 1 : 2;
      while (index < source.length) {
        output += source[index];
        if (source[index] === '\n') {
          index++;
          break;
        }
        index++;
      }
      needsSpace = false;
      followsLineComment = true;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      if (needsSpace && output && !output.endsWith('\n')) output += ' ';
      output += '/*';
      index += 2;
      let commentDepth = 1;
      while (index < source.length) {
        const commentCharacter = source[index];
        output += commentCharacter;
        if (commentCharacter === '*' && source[index + 1] === '/') {
          output += '/';
          index += 2;
          commentDepth--;
          if (commentDepth === 0) break;
          continue;
        }
        if (commentCharacter === '/' && source[index + 1] === '*') {
          output += '*';
          index += 2;
          commentDepth++;
          continue;
        }
        index++;
      }
      needsSpace = true;
      continue;
    }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      // Literal prefixes (E'...', X'...') and qualified quoted names stay attached.
      if (index > 0 && isWhitespace(source[index - 1]) && needsSpace && output && !output.endsWith('\n')) output += ' ';
      const quote = character === '[' ? ']' : character;
      output += character;
      index++;
      while (index < source.length) {
        const quoted = source[index];
        output += quoted;
        index++;
        if (quoted === '\\' && index < source.length) {
          output += source[index];
          index++;
          continue;
        }
        if (quoted === quote) {
          if (source[index] === quote) {
            output += source[index];
            index++;
          } else {
            break;
          }
        }
      }
      needsSpace = true;
      continue;
    }
    if (character === ';') {
      output = trimSpaces(output);
      output += ';\n';
      previousWord = '';
      needsSpace = false;
    } else if (character === ',') {
      output = trimSpaces(output);
      output += ', ';
      needsSpace = false;
    } else if (character === '(') {
      output = trimSpaces(output);
      output += '(';
      depth++;
      needsSpace = false;
    } else if (character === ')') {
      output = trimSpaces(output);
      output += ')';
      depth = Math.max(0, depth - 1);
      needsSpace = true;
    } else {
      // Decimals, qualified names, casts, and compound operators stay intact.
      if (index > 0 && isWhitespace(source[index - 1]) && output && !output.endsWith('\n') && !output.endsWith(' ')) output += ' ';
      output += character;
      needsSpace = false;
    }
    index++;
  }
  appendWord();
  return output.trim();
}

/** Columns whose lowercased name contains a pattern show `******`; null stays null. */
export function maskRows<T extends Record<string, unknown>>(rows: T[], enabled: boolean, patterns: string[]): T[] {
  if (!enabled) return rows;
  const normalized = patterns.map(pattern => pattern.trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return rows;
  return rows.map(row => {
    const masked: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      const name = column.toLowerCase();
      masked[column] = normalized.some(pattern => name.includes(pattern)) && value !== null ? '******' : value;
    }
    return masked as T;
  });
}

export const MASK = '******';

/** Quotes an identifier for the dialect, doubling the closing quote. */
export function quoteIdentifier(kind: string, name: string): string {
  switch (kind) {
    case 'mysql':
    case 'mariadb':
      return `\`${name.replaceAll('`', '``')}\``;
    case 'sqlserver':
      return `[${name.replaceAll(']', ']]')}]`;
    default:
      return `"${name.replaceAll('"', '""')}"`;
  }
}

export const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'ALTER',
  'DROP', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET', 'HAVING',
];
