//! LSP base-protocol framing: `Content-Length` headers followed by a UTF-8
//! JSON body. Lithe talks to every plugin backend this way, so the SDK owns
//! the framing and plugin code never writes to the protocol stream itself.

use serde_json::Value;
use std::fmt;
use std::io::{self, BufRead, Read, Write};

/// Largest header block accepted from the host.
const MAX_HEADER_BYTES: usize = 8192;
/// Largest body accepted from the host. Larger frames end the session.
pub(crate) const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// One frame read from the host.
#[derive(Debug, PartialEq)]
pub(crate) enum Frame {
    Message(Value),
    /// A body that is not JSON; the framing position is intact.
    Malformed,
}

/// A framing error the session cannot recover from.
#[derive(Debug)]
pub(crate) struct FramingError(pub String);

impl fmt::Display for FramingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl From<io::Error> for FramingError {
    fn from(error: io::Error) -> Self {
        Self(format!("The input failed: {error}"))
    }
}

/// Reads the next frame, or `None` when the input ended between frames.
pub(crate) fn read_frame(reader: &mut impl BufRead) -> Result<Option<Frame>, FramingError> {
    let mut header = Vec::new();
    let mut length = None;
    loop {
        let mut line = Vec::new();
        let remaining = (MAX_HEADER_BYTES + 1).saturating_sub(header.len()) as u64;
        reader
            .by_ref()
            .take(remaining)
            .read_until(b'\n', &mut line)?;
        if line.is_empty() {
            if header.is_empty() {
                return Ok(None);
            }
            return Err(FramingError(
                "The input ended inside a message header.".into(),
            ));
        }
        header.extend_from_slice(&line);
        // The same bound whether the header arrived whole or in pieces.
        if header.len() > MAX_HEADER_BYTES {
            return Err(FramingError("The message header is too long.".into()));
        }
        if !line.ends_with(b"\n") {
            return Err(FramingError(
                "The input ended inside a message header.".into(),
            ));
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\r', '\n']);
        if text.is_empty() {
            break;
        }
        if length.is_none() {
            length = content_length(text)?;
        }
    }
    let length = length
        .ok_or_else(|| FramingError("A message has no valid Content-Length header.".into()))?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(Some(match serde_json::from_slice(&body) {
        Ok(message) => Frame::Message(message),
        Err(_) => Frame::Malformed,
    }))
}

/// The length of a `Content-Length` line, `None` for any other header.
fn content_length(line: &str) -> Result<Option<usize>, FramingError> {
    let Some((name, value)) = line.split_once(':') else {
        return Ok(None);
    };
    if !name.trim().eq_ignore_ascii_case("content-length") {
        return Ok(None);
    }
    let value = value.trim();
    let invalid = || FramingError("A message has no valid Content-Length header.".into());
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    let length: usize = value.parse().map_err(|_| invalid())?;
    if length > MAX_FRAME_BYTES {
        return Err(FramingError(format!(
            "A message of {length} bytes exceeds the {MAX_FRAME_BYTES}-byte limit."
        )));
    }
    Ok(Some(length))
}

/// Writes one JSON-RPC message as a complete frame and flushes it.
pub(crate) fn write_frame(writer: &mut dyn Write, message: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(message)?;
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend_from_slice(&body);
    writer.write_all(&frame)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::BufReader;

    fn frames(input: &[u8]) -> Vec<Result<Option<Frame>, String>> {
        let mut reader = BufReader::with_capacity(3, input);
        let mut frames = Vec::new();
        loop {
            let frame = read_frame(&mut reader).map_err(|error| error.0);
            let done = !matches!(frame, Ok(Some(_)));
            frames.push(frame);
            if done {
                return frames;
            }
        }
    }

    #[test]
    fn decodes_consecutive_frames_and_reports_malformed_bodies_in_place() {
        let mut input = Vec::new();
        write_frame(&mut input, &json!({"id": 1})).unwrap();
        input.extend_from_slice(b"content-length: 3\r\nContent-Type: x\r\n\r\nnot");
        write_frame(&mut input, &json!({"id": "é"})).unwrap();
        assert_eq!(
            frames(&input),
            [
                Ok(Some(Frame::Message(json!({"id": 1})))),
                Ok(Some(Frame::Malformed)),
                Ok(Some(Frame::Message(json!({"id": "é"})))),
                Ok(None),
            ]
        );
    }

    #[test]
    fn refuses_frames_it_cannot_delimit() {
        let oversized = format!("Content-Length: {}\r\n\r\n", MAX_FRAME_BYTES + 1);
        let long_header = format!("X: {}\r\n\r\n", "a".repeat(MAX_HEADER_BYTES));
        for (input, expected) in [
            ("Content-Type: x\r\n\r\n{}", "no valid Content-Length"),
            ("Content-Length: -1\r\n\r\n", "no valid Content-Length"),
            (oversized.as_str(), "exceeds"),
            (long_header.as_str(), "too long"),
            ("Content-Length: 2\r\n", "inside a message header"),
            ("Content-Length: 4\r\n\r\n{}", "input failed"),
        ] {
            let last = frames(input.as_bytes()).pop().unwrap();
            let error = last.expect_err(input);
            assert!(error.contains(expected), "{input:?}: {error}");
        }
    }
}
