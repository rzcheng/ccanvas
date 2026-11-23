// Live summary of a Claude Code session transcript for the agent widgets: how
// full the context window is, the session's names, and the last reply. The
// frontend polls it every few seconds for every agent on every tab.
//
// Transcripts are append-only JSONL and grow to hundreds of MB, so reading one
// whole on each poll (and shipping it to the webview to parse) swamped both
// main threads. Instead each file's summary is cached with the byte offset it
// has been read up to, and a poll parses only what was appended since.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What was appended to `path` since `offset`, cut after its last newline (a
/// line still being written waits for the next read), plus the offset to
/// resume from. None when the file is now shorter than `offset`: it was
/// rewritten rather than appended to, so the caller should start over.
pub(crate) fn read_appended(path: &Path, offset: u64) -> io::Result<Option<(Vec<u8>, u64)>> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    if len < offset {
        return Ok(None);
    }
    let mut buf = Vec::with_capacity((len - offset) as usize);
    if len > offset {
        f.seek(SeekFrom::Start(offset))?;
        f.take(len - offset).read_to_end(&mut buf)?;
    }
    let end = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    buf.truncate(end);
    Ok(Some((buf, offset + end as u64)))
}

/// `bytes` as text. Lossy decoding is many times slower than validating, so
/// it's only used when the bytes aren't valid UTF-8.
pub(crate) fn as_text(bytes: &[u8]) -> Cow<'_, str> {
    match std::str::from_utf8(bytes) {
        Ok(s) => Cow::Borrowed(s),
        Err(_) => String::from_utf8_lossy(bytes),
    }
}

#[derive(Clone, Serialize)]
pub struct Context {
    /// tokens in the context at the most recent reply
    used: u64,
    /// model id of that reply
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    /// largest context seen in this session (hints at a 1M window)
    peak: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// bytes read so far; changes whenever new events land
    version: u64,
    context: Option<Context>,
    /// newest `/rename` (a `custom-title` record)
    custom_title: Option<String>,
    /// the name Claude generated for the session (an `ai-title` record)
    ai_title: Option<String>,
    /// text of the latest turn's assistant replies
    last_reply: Option<String>,
    /// when the file was last written (epoch ms); mirrors use it for "running"
    modified: Option<u64>,
    /// a tool call still waiting for its result (a question for the user, a
    /// permission prompt, or a tool that's still running)
    pending: Option<Pending>,
}

/// A tool call the transcript has no result for yet.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    /// tool name, e.g. `AskUserQuestion`, `Bash`
    tool: String,
    /// for AskUserQuestion / ExitPlanMode: what the user is being asked
    question: Option<String>,
    /// for AskUserQuestion: the first question's option labels
    options: Vec<String>,
    /// how many tool calls are open
    count: usize,
}

#[derive(Clone)]
struct OpenTool {
    id: String,
    pending: Pending,
}

/// Open tool calls kept at most; more only happens when results go missing.
const MAX_OPEN: usize = 64;

#[derive(Default)]
struct Tracked {
    offset: u64,
    modified: Option<u64>,
    context: Option<Context>,
    peak: u64,
    custom_title: Option<String>,
    ai_title: Option<String>,
    /// text of each assistant reply since the last user event, oldest first
    reply: Vec<String>,
    /// main-thread tool calls with no result yet, oldest first
    open: Vec<OpenTool>,
}

/// Just the event type, so a line we don't need is skipped without building it.
#[derive(Deserialize)]
struct Head {
    #[serde(rename = "type")]
    kind: Option<String>,
}

/// A top-level string field of a line, trimmed; None when missing or empty.
fn string_field(line: &str, field: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line).ok()?;
    let s = v[field].as_str()?.trim();
    (!s.is_empty()).then(|| s.to_string())
}

impl Tracked {
    fn update(&mut self, path: &Path) -> io::Result<()> {
        let (bytes, next) = match read_appended(path, self.offset)? {
            Some(r) => r,
            // rewritten rather than appended to: start over
            None => {
                *self = Self::default();
                read_appended(path, 0)?.unwrap_or_default()
            }
        };
        for line in as_text(&bytes).lines() {
            self.apply(line);
        }
        self.offset = next;
        self.modified = std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        Ok(())
    }

    fn apply(&mut self, line: &str) {
        if line.contains(r#""type":"custom-title""#) {
            self.custom_title = string_field(line, "customTitle");
        }
        if line.contains(r#""type":"ai-title""#) {
            self.ai_title = string_field(line, "aiTitle");
        }
        if !line.contains(r#""type":"user""#) && !line.contains(r#""type":"assistant""#) {
            return;
        }
        let Ok(head) = serde_json::from_str::<Head>(line) else {
            return;
        };
        match head.kind.as_deref() {
            // a user message or tool result starts a new turn
            Some("user") => {
                self.reply.clear();
                // tool results can be large: only parse them while a call is open
                if !self.open.is_empty() {
                    if let Ok(ev) = serde_json::from_str::<Value>(line) {
                        self.settle(&ev);
                    }
                }
            }
            Some("assistant") => {
                if let Ok(ev) = serde_json::from_str::<Value>(line) {
                    self.add_usage(&ev);
                    self.add_reply(&ev);
                    self.add_tool_calls(&ev);
                }
            }
            _ => {}
        }
    }

    /// Context fill from a reply's token usage. Subagent (sidechain) turns have
    /// their own context and are skipped.
    fn add_usage(&mut self, ev: &Value) {
        let msg = &ev["message"];
        let u = &msg["usage"];
        if u.is_null() || ev["isSidechain"].as_bool() == Some(true) {
            return;
        }
        let model = msg["model"].as_str();
        if model == Some("<synthetic>") {
            return;
        }
        let used = [
            "input_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
            "output_tokens",
        ]
        .iter()
        .map(|k| u[k].as_u64().unwrap_or(0))
        .sum::<u64>();
        if used == 0 {
            return;
        }
        self.peak = self.peak.max(used);
        self.context = Some(Context {
            used,
            model: model.map(str::to_string),
            peak: 0,
        });
    }

    fn add_reply(&mut self, ev: &Value) {
        let content = &ev["message"]["content"];
        let text = match content {
            Value::String(s) => s.clone(),
            Value::Array(blocks) => blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str().filter(|t| !t.is_empty()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => return,
        };
        let text = text.trim();
        if !text.is_empty() {
            self.reply.push(text.to_string());
        }
    }

    /// Remember each main-thread tool call until its result arrives.
    fn add_tool_calls(&mut self, ev: &Value) {
        if ev["isSidechain"].as_bool() == Some(true) {
            return;
        }
        let Some(blocks) = ev["message"]["content"].as_array() else {
            return;
        };
        for b in blocks.iter().filter(|b| b["type"] == "tool_use") {
            let (Some(id), Some(tool)) = (b["id"].as_str(), b["name"].as_str()) else {
                continue;
            };
            let (question, options) = ask_of(tool, &b["input"]);
            self.open.push(OpenTool {
                id: id.to_string(),
                pending: Pending {
                    tool: tool.to_string(),
                    question,
                    options,
                    count: 0,
                },
            });
        }
        if self.open.len() > MAX_OPEN {
            self.open.drain(..self.open.len() - MAX_OPEN);
        }
    }

    /// Close the tool calls a user event answers. A real prompt (no tool
    /// results) means anything still open was interrupted.
    fn settle(&mut self, ev: &Value) {
        if ev["isSidechain"].as_bool() == Some(true) {
            return;
        }
        let results: Vec<&str> = ev["message"]["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b["type"] == "tool_result")
                    .filter_map(|b| b["tool_use_id"].as_str())
                    .collect()
            })
            .unwrap_or_default();
        if results.is_empty() {
            if ev["isMeta"].as_bool() != Some(true) {
                self.open.clear();
            }
        } else {
            self.open.retain(|t| !results.contains(&t.id.as_str()));
        }
    }

    fn summary(&self) -> Summary {
        let reply = self.reply.join("\n\n");
        Summary {
            version: self.offset,
            context: self.context.clone().map(|c| Context {
                peak: self.peak,
                ..c
            }),
            custom_title: self.custom_title.clone(),
            ai_title: self.ai_title.clone(),
            last_reply: (!reply.is_empty()).then_some(reply),
            modified: self.modified,
            // a question for the user matters more than a tool that's running
            pending: self
                .open
                .iter()
                .rev()
                .find(|t| t.pending.question.is_some())
                .or(self.open.last())
                .map(|t| Pending {
                    count: self.open.len(),
                    ..t.pending.clone()
                }),
        }
    }
}

/// The question a tool call puts to the user, if it's one that waits on them.
fn ask_of(tool: &str, input: &Value) -> (Option<String>, Vec<String>) {
    match tool {
        "AskUserQuestion" => {
            let qs = input["questions"].as_array();
            let first = qs.and_then(|q| q.first());
            let Some(text) = first.and_then(|q| q["question"].as_str()) else {
                return (Some("Claude has a question".into()), vec![]);
            };
            let more = qs.map_or(0, |q| q.len().saturating_sub(1));
            let text = if more > 0 {
                format!("{text} (+{more} more)")
            } else {
                text.to_string()
            };
            let options = first
                .and_then(|q| q["options"].as_array())
                .map(|o| {
                    o.iter()
                        .filter_map(|o| o["label"].as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            (Some(text), options)
        }
        "ExitPlanMode" => (Some("Approve the plan?".into()), vec![]),
        _ => (None, vec![]),
    }
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Arc<Mutex<Tracked>>>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<Tracked>>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Summary of the transcript at `path` (None if it can't be read). The first
/// call for a file reads it whole; later ones read only what was appended.
#[tauri::command]
pub async fn transcript_summary(path: String) -> Option<Summary> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let tracked = cache()
            .lock()
            .unwrap()
            .entry(path.clone())
            .or_default()
            .clone();
        let mut t = tracked.lock().unwrap();
        t.update(&path).ok()?;
        Some(t.summary())
    })
    .await
    .ok()
    .flatten()
}

/// A slice of a transcript for the transcript widget, which parses it into turns.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    /// complete lines read (a line still being written waits for the next call)
    text: String,
    /// offset to pass next time
    next: u64,
    /// the file was rewritten rather than appended to: drop what you had
    reset: bool,
    /// earlier lines were skipped to honour `tail`
    truncated: bool,
}

fn read_chunk(path: &Path, offset: u64, tail: Option<u64>) -> io::Result<Chunk> {
    let len = std::fs::metadata(path)?.len();
    let reset = len < offset;
    let mut start = if reset { 0 } else { offset };
    let mut truncated = false;
    // a first read of a huge file starts near the end, on a line boundary
    if start == 0 {
        if let Some(t) = tail.filter(|&t| len > t) {
            let mut f = File::open(path)?;
            let from = len - t;
            f.seek(SeekFrom::Start(from))?;
            let mut probe = Vec::new();
            f.take(t).read_to_end(&mut probe)?;
            let skip = probe
                .iter()
                .position(|&b| b == b'\n')
                .map_or(probe.len(), |i| i + 1);
            start = from + skip as u64;
            truncated = true;
        }
    }
    let (bytes, next) = read_appended(path, start)?.unwrap_or((Vec::new(), start));
    Ok(Chunk {
        text: as_text(&bytes).into_owned(),
        next,
        reset,
        truncated,
    })
}

/// What was appended to the transcript at `path` since `offset` (None if it
/// can't be read). With `tail`, a first read (offset 0) of a file larger than
/// `tail` bytes returns only roughly its last `tail` bytes.
#[tauri::command]
pub async fn transcript_chunk(path: String, offset: u64, tail: Option<u64>) -> Option<Chunk> {
    tauri::async_runtime::spawn_blocking(move || read_chunk(Path::new(&path), offset, tail).ok())
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ccanvas-tx-{name}-{}.jsonl", std::process::id()))
    }

    #[test]
    fn chunk_reads_appended_lines_and_resets() {
        let p = scratch("chunk");
        std::fs::write(&p, "a\nb\npart").unwrap();
        let c = read_chunk(&p, 0, None).unwrap();
        assert_eq!(
            (c.text.as_str(), c.next, c.reset, c.truncated),
            ("a\nb\n", 4, false, false)
        );
        std::fs::write(&p, "a\nb\npartial\nc\n").unwrap();
        let c = read_chunk(&p, 4, None).unwrap();
        assert_eq!(c.text, "partial\nc\n");
        std::fs::write(&p, "x\n").unwrap();
        let c = read_chunk(&p, 14, None).unwrap();
        assert!(c.reset);
        assert_eq!(c.text, "x\n");
        let _ = std::fs::remove_file(&p);
    }

    fn track(lines: &[&str]) -> Summary {
        let mut t = Tracked::default();
        for l in lines {
            t.apply(l);
        }
        t.summary()
    }

    const ASK: &str = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"AskUserQuestion","input":{"questions":[{"question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}}]}}"#;
    const BASH: &str = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"ls"}}]}}"#;

    #[test]
    fn pending_prefers_a_question_and_clears_on_results() {
        let s = track(&[BASH, ASK]);
        let p = s.pending.unwrap();
        assert_eq!((p.tool.as_str(), p.count), ("AskUserQuestion", 2));
        assert_eq!(p.question.as_deref(), Some("Which?"));
        assert_eq!(p.options, ["A", "B"]);

        let answered = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"A"}]}}"#;
        let p = track(&[BASH, ASK, answered]).pending.unwrap();
        assert_eq!((p.tool.as_str(), p.count), ("Bash", 1));

        let done = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"ok"}]}}"#;
        assert!(track(&[BASH, ASK, answered, done]).pending.is_none());
    }

    #[test]
    fn pending_ignores_sidechains_and_clears_on_a_new_prompt() {
        let side = r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"tool_use","id":"s1","name":"Read","input":{}}]}}"#;
        assert!(track(&[side]).pending.is_none());
        let meta = r#"{"type":"user","isMeta":true,"message":{"content":"caveat"}}"#;
        assert!(track(&[BASH, meta]).pending.is_some());
        let prompt = r#"{"type":"user","message":{"content":"never mind"}}"#;
        assert!(track(&[BASH, ASK, prompt]).pending.is_none());
    }

    #[test]
    fn chunk_tail_starts_on_a_line_boundary() {
        let p = scratch("tail");
        std::fs::write(&p, "first line\nsecond\nthird\n").unwrap();
        // the last 10 bytes start mid "second"; skip to "third"
        let c = read_chunk(&p, 0, Some(10)).unwrap();
        assert!(c.truncated);
        assert_eq!(c.text, "third\n");
        // small files are read whole
        let c = read_chunk(&p, 0, Some(1000)).unwrap();
        assert!(!c.truncated);
        assert_eq!(c.text, "first line\nsecond\nthird\n");
        let _ = std::fs::remove_file(&p);
    }
}
