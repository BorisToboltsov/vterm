//! AI assistant broker (Phase 17, opt-in).
//!
//! All LLM HTTP lives here (reqwest) so the WebView CSP stays strict and the
//! frontend never makes a network call — the offline autonomy invariant holds for
//! everything except this user-enabled, user-configured outbound (like SSH).
//!
//! Tokens stream to the frontend over `ai://out/{id}`, then `ai://done/{id}` on
//! success or `ai://error/{id}` on failure. API keys come from the OS keychain
//! (`vterm:ai-key`, keyed by endpoint id) and are never logged.

use crate::error::AppResult;
use crate::secrets;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

/// Registry of in-flight streams → a cancel signal, so the frontend's Stop button
/// can abort a running request (dropping the reqwest stream, not just muting it).
fn cancels() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    static M: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    /// Correlates the `ai://…/{id}` event channel with the frontend request.
    pub stream_id: String,
    /// Keychain lookup key for this endpoint's API key.
    pub endpoint_id: String,
    pub provider: String, // "openai" (OpenAI-compatible) | "anthropic"
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub system: Option<String>,
    pub messages: Vec<AiMessage>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

fn out_event(id: &str) -> String {
    format!("ai://out/{id}")
}
fn done_event(id: &str) -> String {
    format!("ai://done/{id}")
}
fn error_event(id: &str) -> String {
    format!("ai://error/{id}")
}

// ── Pure helpers (unit-tested without network) ──────────────────────────────────

/// OpenAI-compatible SSE chunk → incremental text (`choices[0].delta.content`).
pub fn openai_delta(v: &Value) -> Option<String> {
    v.get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()
        .map(String::from)
}

/// Anthropic SSE event → incremental text (`content_block_delta` → `delta.text`).
pub fn anthropic_delta(v: &Value) -> Option<String> {
    if v.get("type")?.as_str()? != "content_block_delta" {
        return None;
    }
    v.get("delta")?.get("text")?.as_str().map(String::from)
}

/// Whether an Anthropic SSE event ends the stream.
pub fn anthropic_done(v: &Value) -> bool {
    v.get("type").and_then(|t| t.as_str()) == Some("message_stop")
}

/// Char-safe truncation for error bodies (never split a UTF-8 boundary).
fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

fn openai_body(req: &AiChatRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(sys) = req.system.as_deref().filter(|s| !s.is_empty()) {
        messages.push(json!({ "role": "system", "content": sys }));
    }
    for m in &req.messages {
        messages.push(json!({ "role": m.role, "content": m.content }));
    }
    let mut body = json!({ "model": req.model, "messages": messages, "stream": true });
    if let Some(mt) = req.max_tokens {
        body["max_tokens"] = json!(mt);
    }
    body
}

fn anthropic_body(req: &AiChatRequest) -> Value {
    let messages: Vec<Value> = req
        .messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    // Anthropic's /v1/messages requires max_tokens.
    let mut body = json!({
        "model": req.model,
        "messages": messages,
        "max_tokens": req.max_tokens.unwrap_or(4096),
        "stream": true,
    });
    if let Some(sys) = req.system.as_deref().filter(|s| !s.is_empty()) {
        body["system"] = json!(sys);
    }
    body
}

// ── Streaming command ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn ai_chat(app: AppHandle, req: AiChatRequest) -> AppResult<()> {
    let id = req.stream_id.clone();
    let notify = Arc::new(Notify::new());
    cancels().lock().unwrap().insert(id.clone(), notify.clone());

    // Race the stream against a cancel signal; cancelling drops `run_chat`, which
    // aborts the underlying HTTP request, and is reported as a graceful stop.
    let outcome = tokio::select! {
        r = run_chat(&app, &req) => r,
        _ = notify.notified() => Ok(()),
    };
    cancels().lock().unwrap().remove(&id);

    match outcome {
        Ok(()) => {
            let _ = app.emit(&done_event(&id), ());
            Ok(())
        }
        Err(e) => {
            let _ = app.emit(&error_event(&id), e.to_string());
            Err(e)
        }
    }
}

/// Stop an in-flight `ai_chat` stream (the chat's Stop button). No-op if the
/// stream already finished or never existed.
#[tauri::command]
pub fn cancel_ai_chat(stream_id: String) {
    if let Some(n) = cancels().lock().unwrap().get(&stream_id) {
        n.notify_one();
    }
}

async fn run_chat(app: &AppHandle, req: &AiChatRequest) -> AppResult<()> {
    let key = secrets::get_ai_key(&req.endpoint_id);
    let client = reqwest::Client::new();
    let is_anthropic = req.provider == "anthropic";
    let base = req.base_url.trim_end_matches('/');

    let mut rb = if is_anthropic {
        let mut b = client
            .post(format!("{base}/v1/messages"))
            .header("content-type", "application/json")
            .header("anthropic-version", "2023-06-01");
        if let Some(k) = &key {
            b = b.header("x-api-key", k.as_str());
        }
        b
    } else {
        let mut b = client
            .post(format!("{base}/chat/completions"))
            .header("content-type", "application/json");
        if let Some(k) = &key {
            b = b.header("authorization", format!("Bearer {}", k.as_str()));
        }
        b
    };

    let body = if is_anthropic {
        anthropic_body(req)
    } else {
        openai_body(req)
    };
    rb = rb.json(&body);

    let resp = rb
        .send()
        .await
        .map_err(|e| format!("ai request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("ai endpoint {status}: {}", truncate(&text, 300)).into());
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("ai stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            let data = match line.strip_prefix("data:") {
                Some(d) => d.trim(),
                None => continue, // skip blank/`event:` lines
            };
            if !is_anthropic && data == "[DONE]" {
                return Ok(());
            }
            let v: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if is_anthropic {
                if anthropic_done(&v) {
                    return Ok(());
                }
                if let Some(t) = anthropic_delta(&v) {
                    let _ = app.emit(&out_event(&req.stream_id), t);
                }
            } else if let Some(t) = openai_delta(&v) {
                let _ = app.emit(&out_event(&req.stream_id), t);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> AiChatRequest {
        AiChatRequest {
            stream_id: "s1".into(),
            endpoint_id: "e1".into(),
            provider: "openai".into(),
            base_url: "http://h/v1".into(),
            model: "qwen".into(),
            system: Some("you are a sysadmin".into()),
            messages: vec![AiMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            max_tokens: None,
        }
    }

    #[test]
    fn openai_delta_extracts_content() {
        let v = json!({ "choices": [{ "delta": { "content": "ab" } }] });
        assert_eq!(openai_delta(&v).as_deref(), Some("ab"));
        // A role-only opening delta has no content.
        let role = json!({ "choices": [{ "delta": { "role": "assistant" } }] });
        assert_eq!(openai_delta(&role), None);
    }

    #[test]
    fn anthropic_delta_and_done() {
        let d = json!({ "type": "content_block_delta", "delta": { "type": "text_delta", "text": "x" } });
        assert_eq!(anthropic_delta(&d).as_deref(), Some("x"));
        let other = json!({ "type": "message_start" });
        assert_eq!(anthropic_delta(&other), None);
        assert!(anthropic_done(&json!({ "type": "message_stop" })));
        assert!(!anthropic_done(&d));
    }

    #[test]
    fn openai_body_prepends_system_and_streams() {
        let b = openai_body(&req());
        assert_eq!(b["stream"], json!(true));
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][1]["content"], "hi");
        assert!(b.get("max_tokens").is_none());
    }

    #[test]
    fn anthropic_body_defaults_max_tokens_and_lifts_system() {
        let mut r = req();
        r.provider = "anthropic".into();
        let b = anthropic_body(&r);
        assert_eq!(b["max_tokens"], json!(4096));
        assert_eq!(b["system"], "you are a sysadmin");
        assert_eq!(b["messages"][0]["role"], "user"); // system not inlined into messages
    }

    #[test]
    fn truncate_is_char_safe() {
        assert_eq!(truncate("héllo", 100), "héllo");
        assert_eq!(truncate("héllo", 2), "hé…");
    }

    #[test]
    fn cancel_unknown_stream_is_noop() {
        cancel_ai_chat("does-not-exist".into()); // must not panic
    }

    #[tokio::test]
    async fn cancel_signals_a_registered_stream() {
        let n = Arc::new(Notify::new());
        cancels()
            .lock()
            .unwrap()
            .insert("t-cancel".into(), n.clone());
        cancel_ai_chat("t-cancel".into());
        // notify_one leaves a permit, so notified() resolves without hanging.
        n.notified().await;
        cancels().lock().unwrap().remove("t-cancel");
    }
}
