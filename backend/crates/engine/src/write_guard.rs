//! Read-only connections and production protection: one lexical analysis
//! of SQL decides whether a statement writes or needs confirmation.

use crate::*;

pub(crate) fn ensure_write_allowed(
    connection: &Connection,
    sql: &str,
    confirmed: bool,
    allow_write: bool,
) -> Result<(), (String, String)> {
    if connection.read_only && !allow_write {
        return Err((
            "read_only".into(),
            "This connection is configured as read-only".into(),
        ));
    }
    if connection.production_protection && is_dangerous_sql(&connection.kind, sql) && !confirmed {
        return Err((
            "confirmation_required".into(),
            "Production protection requires explicit confirmation".into(),
        ));
    }
    Ok(())
}

pub(crate) fn ensure_mutations_allowed(
    connection: &Connection,
    mutations: &[Mutation],
    confirmed: bool,
    allow_write: bool,
) -> Result<(), (String, String)> {
    if connection.read_only && !allow_write {
        return Err((
            "read_only".into(),
            "This connection is configured as read-only".into(),
        ));
    }
    if connection.production_protection
        && mutations.iter().any(|mutation| mutation.action == "delete")
        && !confirmed
    {
        return Err((
            "confirmation_required".into(),
            "Production protection requires explicit confirmation".into(),
        ));
    }
    Ok(())
}

pub(crate) fn ensure_transaction_allowed(
    connection: &Connection,
    statements: &[Statement],
    confirmed: bool,
    allow_write: bool,
) -> Result<(), (String, String)> {
    if connection.read_only && !allow_write {
        return Err((
            "read_only".into(),
            "This connection is configured as read-only".into(),
        ));
    }
    if connection.production_protection
        && statements
            .iter()
            .any(|statement| is_dangerous_sql(&connection.kind, &statement.sql))
        && !confirmed
    {
        return Err((
            "confirmation_required".into(),
            "Production protection requires explicit confirmation".into(),
        ));
    }
    Ok(())
}

/// Decides whether production protection must ask before running `sql`.
///
/// The script is lexed rather than pattern-matched so that line breaks, comments,
/// string literals and quoted identifiers cannot hide or fake a keyword. A
/// statement is dangerous when it restores a backup, drops or truncates
/// anything, or contains an `UPDATE`/`DELETE` whose own clause has no `WHERE`
/// (a `WHERE` inside a subquery does not bound the outer write). Every
/// statement of a multi-statement script is checked.
pub(crate) fn is_dangerous_sql(kind: &str, sql: &str) -> bool {
    sql_statements(kind, sql)
        .iter()
        .any(|statement| is_dangerous_statement(statement))
}

/// Structural SQL token. Literals, quoted identifiers and comments produce no
/// token, so their contents never read as keywords.
#[derive(Debug, PartialEq)]
pub(crate) enum SqlToken {
    /// Unquoted word, uppercased.
    Word(String),
    Open,
    Close,
}

/// Splits `sql` into top-level statements of structural tokens.
pub(crate) fn sql_statements(kind: &str, sql: &str) -> Vec<Vec<SqlToken>> {
    // MySQL and MariaDB treat backslash as an escape inside quotes by default;
    // the other dialects only escape by doubling the quote character.
    let backslash_escapes = matches!(kind, "mysql" | "mariadb");
    let chars: Vec<char> = sql.chars().collect();
    let mut statements = vec![Vec::new()];
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        let next = chars.get(index + 1).copied();
        let tokens = statements
            .last_mut()
            .expect("statement list is never empty");
        match character {
            '-' if next == Some('-') => {
                while index < chars.len() && chars[index] != '\n' {
                    index += 1;
                }
            }
            '/' if next == Some('*') => {
                // PostgreSQL nests block comments; a nested opener in other
                // dialects is rare enough that over-skipping is acceptable.
                let mut depth = 0;
                while index < chars.len() {
                    if chars[index] == '/' && chars.get(index + 1) == Some(&'*') {
                        depth += 1;
                        index += 2;
                    } else if chars[index] == '*' && chars.get(index + 1) == Some(&'/') {
                        depth -= 1;
                        index += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        index += 1;
                    }
                }
            }
            '\'' => {
                // PostgreSQL E'...' strings accept backslash escapes.
                let escape_string = tokens.last() == Some(&SqlToken::Word("E".into()))
                    && index > 0
                    && chars[index - 1].eq_ignore_ascii_case(&'e');
                if escape_string {
                    tokens.pop();
                }
                index = skip_quoted(&chars, index, '\'', backslash_escapes || escape_string);
            }
            '"' => index = skip_quoted(&chars, index, '"', backslash_escapes),
            '`' => index = skip_quoted(&chars, index, '`', false),
            '[' if kind == "sqlserver" => index = skip_quoted(&chars, index, ']', false),
            '$' => match dollar_quote_tag(&chars, index) {
                Some(tag) => {
                    let start = index + tag.len();
                    index = (start..=chars.len().saturating_sub(tag.len()))
                        .find(|&end| chars[end..end + tag.len()] == tag[..])
                        .map_or(chars.len(), |end| end + tag.len());
                }
                None => index += 1,
            },
            '(' => {
                tokens.push(SqlToken::Open);
                index += 1;
            }
            ')' => {
                tokens.push(SqlToken::Close);
                index += 1;
            }
            ';' => {
                statements.push(Vec::new());
                index += 1;
            }
            _ if character.is_alphanumeric() || character == '_' => {
                let start = index;
                while index < chars.len()
                    && (chars[index].is_alphanumeric() || matches!(chars[index], '_' | '$'))
                {
                    index += 1;
                }
                let word: String = chars[start..index].iter().collect();
                tokens.push(SqlToken::Word(word.to_uppercase()));
            }
            _ => index += 1,
        }
    }
    statements.retain(|tokens| !tokens.is_empty());
    statements
}

/// Returns the index just past the closing `close` of a quoted run that opens
/// at `start`. A doubled closing character is an escaped literal character.
pub(crate) fn skip_quoted(
    chars: &[char],
    start: usize,
    close: char,
    backslash_escapes: bool,
) -> usize {
    let mut index = start + 1;
    while index < chars.len() {
        if backslash_escapes && chars[index] == '\\' {
            index += 2;
        } else if chars[index] == close {
            if chars.get(index + 1) == Some(&close) {
                index += 2;
            } else {
                return index + 1;
            }
        } else {
            index += 1;
        }
    }
    chars.len()
}

/// Returns the `$tag$` opener at `start`, if any. `$1` style placeholders are
/// not dollar quotes because a tag cannot start with a digit.
pub(crate) fn dollar_quote_tag(chars: &[char], start: usize) -> Option<Vec<char>> {
    let mut index = start + 1;
    if chars
        .get(index)
        .is_some_and(|character| character.is_ascii_digit())
    {
        return None;
    }
    while chars
        .get(index)
        .is_some_and(|character| character.is_alphanumeric() || *character == '_')
    {
        index += 1;
    }
    (chars.get(index) == Some(&'$')).then(|| chars[start..=index].to_vec())
}

pub(crate) fn is_dangerous_statement(tokens: &[SqlToken]) -> bool {
    let word = |index: usize| match tokens.get(index) {
        Some(SqlToken::Word(word)) => Some(word.as_str()),
        _ => None,
    };
    if word(0) == Some("RESTORE") {
        return true;
    }
    let mut depths = Vec::with_capacity(tokens.len());
    let mut depth = 0usize;
    for token in tokens {
        if *token == SqlToken::Close {
            depth = depth.saturating_sub(1);
        }
        depths.push(depth);
        if *token == SqlToken::Open {
            depth += 1;
        }
    }
    (0..tokens.len()).any(|index| match word(index) {
        // TRUNCATE(x, d) is MySQL's numeric function, not the statement.
        Some("DROP" | "TRUNCATE") => tokens.get(index + 1) != Some(&SqlToken::Open),
        // Only a verb opens a write: at statement start, as a subquery or CTE
        // body after `(`, or as the main statement after a `WITH ... )` list.
        // This excludes FOR UPDATE, ON DELETE CASCADE, GRANT UPDATE, trigger
        // events and MERGE/upsert actions, which are bounded elsewhere.
        Some("UPDATE" | "DELETE")
            if index == 0 || matches!(tokens[index - 1], SqlToken::Open | SqlToken::Close) =>
        {
            let clause_depth = depths[index];
            !tokens[index + 1..]
                .iter()
                .zip(&depths[index + 1..])
                .take_while(|(_, depth)| **depth >= clause_depth)
                .any(|(token, depth)| {
                    *depth == clause_depth && *token == SqlToken::Word("WHERE".into())
                })
        }
        _ => false,
    })
}
