//! AI assistant broker (Phase 17, opt-in).
//!
//! All LLM HTTP lives here (reqwest) so the WebView CSP stays strict and the
//! frontend never makes a network call — the offline autonomy invariant holds for
//! everything except this user-enabled, user-configured outbound (like SSH).
//!
//! Answer tokens stream to the frontend over `ai://out/{id}` and reasoning
//! ("thinking") tokens over `ai://think/{id}` (Phase 40) — two channels because
//! they are two kinds of data, not two stages of one. The stream then ends with
//! `ai://done/{id}`, whose payload is the token tally ([`AiUsage`]) or `null`
//! when the endpoint never reported one, or `ai://error/{id}` on failure. API
//! keys come from the OS keychain (`vterm:ai-key`, keyed by endpoint id) and are
//! never logged.

use crate::error::{AppError, AppResult};
use crate::secrets;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

/// Connect-phase timeout. Separate from the per-read timeout below: a wrong host
/// should fail fast even when the user allows a long generation.
const CONNECT_TIMEOUT_SECS: u64 = 15;

/// Total timeout for a model listing — short, since it is a small GET.
const MODELS_TIMEOUT_SECS: u64 = 30;

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
    /// Extra generation params (temperature, top_p…) merged into the request body.
    #[serde(default)]
    pub params: Option<Value>,
    /// Per-request timeout in seconds (see [`chat_client`] for what it bounds).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

/// Token counts for one reply, reported to the frontend on `ai://done/{id}`.
/// Both halves are optional: an endpoint that never sends `usage` leaves them
/// `None`, and the UI then shows no counter rather than a fabricated zero.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

impl AiUsage {
    fn is_empty(&self) -> bool {
        self.input_tokens.is_none() && self.output_tokens.is_none()
    }
}

/// HTTP client for a streaming chat.
///
/// Deliberately **not** `Client::timeout`: that is a total deadline covering the
/// response body, so a long-but-healthy generation would be cut off mid-reply.
/// `read_timeout` resets after every successful read, which is what "the model
/// went silent" actually means for a token stream.
fn chat_client(timeout_secs: u64) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .read_timeout(Duration::from_secs(timeout_secs))
        .build()
}

/// Request to list an endpoint's available models (also doubles as a reachability
/// check). Sent by the settings "Check connection" button and the chat's model picker.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelsRequest {
    pub endpoint_id: String,
    pub provider: String,
    pub base_url: String,
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
/// Reasoning ("thinking") tokens, on their own channel (Phase 40).
///
/// A separate channel rather than a tagged payload on `ai://out`: this is a
/// different *kind* of data, not another stage of the same one — the same call
/// `term://phase` makes next to `term://out`. Listeners that only care about the
/// answer keep working unchanged, and nothing has to re-parse every token.
fn think_event(id: &str) -> String {
    format!("ai://think/{id}")
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

/// OpenAI-compatible SSE chunk → incremental *reasoning* text.
///
/// There is no single spec field: DeepSeek emits `reasoning_content`, while
/// OpenRouter and several local servers emit `reasoning`. Both are accepted so a
/// reasoning model doesn't sit silent for half a minute with nothing on screen.
pub fn openai_reasoning_delta(v: &Value) -> Option<String> {
    let delta = v.get("choices")?.get(0)?.get("delta")?;
    delta
        .get("reasoning_content")
        .or_else(|| delta.get("reasoning"))?
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

/// Anthropic SSE event → incremental reasoning text (`thinking_delta`). Distinct
/// from [`anthropic_delta`], which only matches a block carrying `text`.
pub fn anthropic_reasoning_delta(v: &Value) -> Option<String> {
    if v.get("type")?.as_str()? != "content_block_delta" {
        return None;
    }
    let delta = v.get("delta")?;
    if delta.get("type")?.as_str()? != "thinking_delta" {
        return None;
    }
    delta.get("thinking")?.as_str().map(String::from)
}

/// Fold any usage numbers carried by an SSE event into the running total.
///
/// Covers both dialects in one pass: OpenAI-compatible sends a final chunk with
/// `usage.{prompt,completion}_tokens`, Anthropic splits it — `message_start`
/// carries `message.usage.input_tokens`, `message_delta` the output count. Later
/// values win, since Anthropic's output count is cumulative.
pub fn absorb_usage(acc: &mut AiUsage, v: &Value) {
    let direct = v.get("usage");
    let nested = v.get("message").and_then(|m| m.get("usage"));
    for u in [direct, nested].into_iter().flatten() {
        if let Some(n) = u
            .get("prompt_tokens")
            .or_else(|| u.get("input_tokens"))
            .and_then(|x| x.as_u64())
        {
            acc.input_tokens = Some(n);
        }
        if let Some(n) = u
            .get("completion_tokens")
            .or_else(|| u.get("output_tokens"))
            .and_then(|x| x.as_u64())
        {
            acc.output_tokens = Some(n);
        }
    }
}

/// Whether an Anthropic SSE event ends the stream.
pub fn anthropic_done(v: &Value) -> bool {
    v.get("type").and_then(|t| t.as_str()) == Some("message_stop")
}

/// Map a non-success HTTP response to a typed error: 401/403 → `AuthRejected` (so
/// the UI says "check the API key"), otherwise a status-carrying message. The
/// frontend also maps a `send` failure's `ai-unreachable` marker to a friendly hint.
async fn status_error(resp: reqwest::Response) -> AppError {
    let status = resp.status();
    if matches!(status.as_u16(), 401 | 403) {
        return AppError::AuthRejected;
    }
    let text = resp.text().await.unwrap_or_default();
    // Prefer the provider's human message over the raw JSON envelope.
    let msg = provider_error_message(&text).unwrap_or_else(|| text.clone());
    AppError::from(format!("ai endpoint {status}: {}", truncate(&msg, 300)))
}

/// Pull the human-readable message out of a provider error body. Both OpenAI and
/// Anthropic nest it at `error.message` (e.g. "Your credit balance is too low…").
pub fn provider_error_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    let m = v.get("error")?.get("message")?.as_str()?.trim();
    (!m.is_empty()).then(|| m.to_string())
}

/// Merge user-supplied generation params (temperature, top_p, max_tokens…) into
/// the request body, at top level. Protected keys (`model`/`messages`/`stream`/
/// `system`) are never overridden so the request can't be broken.
pub fn merge_params(body: &mut Value, params: &Option<Value>) {
    let Some(Value::Object(extra)) = params.as_ref() else {
        return;
    };
    let Some(map) = body.as_object_mut() else {
        return;
    };
    for (k, v) in extra {
        if matches!(k.as_str(), "model" | "messages" | "stream" | "system") {
            continue;
        }
        map.insert(k.clone(), v.clone());
    }
}

/// Char-safe truncation for error bodies (never split a UTF-8 boundary).
fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

/// OpenAI-compatible request body. `with_usage` adds `stream_options`, which is
/// how a streaming call is asked to report token counts; see [`run_chat`] for why
/// it can be turned back off.
fn openai_body(req: &AiChatRequest, with_usage: bool) -> Value {
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
    if with_usage {
        body["stream_options"] = json!({ "include_usage": true });
    }
    merge_params(&mut body, &req.params);
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
    merge_params(&mut body, &req.params);
    body
}

/// Render an AI agent step (17.8) for the live terminal + recording: a cyan
/// `[AI] $ cmd` header, the combined output (LF → CRLF so it doesn't staircase in
/// the raw PTY view), and a cyan exit/timeout footer.
pub fn agent_mirror(
    command: &str,
    stdout: &str,
    stderr: &str,
    exit_code: i32,
    timed_out: bool,
    timeout_secs: u64,
) -> String {
    let body = format!("{stdout}{stderr}").replace('\n', "\r\n");
    let footer = if timed_out {
        format!("[AI] timed out after {timeout_secs}s")
    } else {
        format!("[AI] exit {exit_code}")
    };
    format!("\r\n\u{1b}[36m[AI] $ {command}\u{1b}[0m\r\n{body}\r\n\u{1b}[36m{footer}\u{1b}[0m\r\n")
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
        _ = notify.notified() => Ok(None),
    };
    cancels().lock().unwrap().remove(&id);

    match outcome {
        Ok(usage) => {
            // The done event carries the tally (or null): usage is terminal data,
            // not a stream, so it rides the event that already means "finished"
            // rather than earning a channel of its own.
            let _ = app.emit(&done_event(&id), usage);
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

/// Model ids from a listing response — OpenAI (`data[].id`, incl. Ollama's
/// `/v1/models`) or Ollama-native (`models[].name`/`.model`). Sorted + deduped.
pub fn parse_models(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
        out.extend(
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from)),
        );
    } else if let Some(arr) = v.get("models").and_then(|d| d.as_array()) {
        out.extend(arr.iter().filter_map(|m| {
            m.get("name")
                .or_else(|| m.get("model"))
                .and_then(|i| i.as_str())
                .map(String::from)
        }));
    }
    out.sort();
    out.dedup();
    out
}

/// List an endpoint's available models (and verify it's reachable). Uses the
/// OpenAI-compatible `/models` endpoint (Ollama/vLLM/LM Studio/OpenAI) or
/// Anthropic's `/v1/models`. Returns installed models — the picker's choices.
#[tauri::command]
pub async fn ai_models(req: AiModelsRequest) -> AppResult<Vec<String>> {
    let key = secrets::get_ai_key(&req.endpoint_id);
    // A model listing is a short, non-streaming request, so a *total* timeout is
    // the right bound here (unlike the chat stream) — an unreachable host must not
    // leave "Check connection" spinning forever.
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(MODELS_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("ai client error: {e}"))?;
    let is_anthropic = req.provider == "anthropic";
    let base = req.base_url.trim_end_matches('/');

    let mut rb = if is_anthropic {
        let mut b = client
            .get(format!("{base}/v1/models"))
            .header("anthropic-version", "2023-06-01");
        if let Some(k) = &key {
            b = b.header("x-api-key", k.as_str());
        }
        b
    } else {
        let mut b = client.get(format!("{base}/models"));
        if let Some(k) = &key {
            b = b.header("authorization", format!("Bearer {}", k.as_str()));
        }
        b
    };
    rb = rb.header("content-type", "application/json");

    let resp = rb
        .send()
        .await
        .map_err(|e| AppError::from(format!("ai-unreachable: {e}")))?;
    if !resp.status().is_success() {
        return Err(status_error(resp).await);
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("ai parse error: {e}"))?;
    Ok(parse_models(&v))
}

/// Fire one chat request. Split out of [`run_chat`] so the same call can be
/// retried with a different body without duplicating the auth/URL wiring.
async fn send_chat(
    client: &reqwest::Client,
    req: &AiChatRequest,
    body: &Value,
) -> AppResult<reqwest::Response> {
    let key = secrets::get_ai_key(&req.endpoint_id);
    let base = req.base_url.trim_end_matches('/');

    let mut rb = if req.provider == "anthropic" {
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
    rb = rb.json(body);

    rb.send()
        .await
        .map_err(|e| AppError::from(format!("ai-unreachable: {e}")))
}

async fn run_chat(app: &AppHandle, req: &AiChatRequest) -> AppResult<Option<AiUsage>> {
    let is_anthropic = req.provider == "anthropic";
    let timeout = req.timeout_secs.unwrap_or(120);
    let client = chat_client(timeout).map_err(|e| format!("ai client error: {e}"))?;

    let resp = if is_anthropic {
        send_chat(&client, req, &anthropic_body(req)).await?
    } else {
        // `stream_options` is how an OpenAI-compatible endpoint is asked for token
        // counts, but older/partial implementations reject the unknown field. The
        // status is checked before any body is read, so retrying without it costs
        // one round-trip and can't duplicate streamed tokens.
        let first = send_chat(&client, req, &openai_body(req, true)).await?;
        if first.status() == reqwest::StatusCode::BAD_REQUEST {
            send_chat(&client, req, &openai_body(req, false)).await?
        } else {
            first
        }
    };
    if !resp.status().is_success() {
        return Err(status_error(resp).await);
    }

    let mut usage = AiUsage::default();
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
                return Ok(finish_usage(usage));
            }
            let v: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            absorb_usage(&mut usage, &v);
            if is_anthropic {
                if anthropic_done(&v) {
                    return Ok(finish_usage(usage));
                }
                if let Some(t) = anthropic_reasoning_delta(&v) {
                    let _ = app.emit(&think_event(&req.stream_id), t);
                } else if let Some(t) = anthropic_delta(&v) {
                    let _ = app.emit(&out_event(&req.stream_id), t);
                }
            } else if let Some(t) = openai_reasoning_delta(&v) {
                let _ = app.emit(&think_event(&req.stream_id), t);
            } else if let Some(t) = openai_delta(&v) {
                let _ = app.emit(&out_event(&req.stream_id), t);
            }
        }
    }
    Ok(finish_usage(usage))
}

/// An all-empty tally means the endpoint never reported usage — report `None` so
/// the UI omits the counter instead of showing zeroes it didn't measure.
fn finish_usage(u: AiUsage) -> Option<AiUsage> {
    (!u.is_empty()).then_some(u)
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
            params: None,
            timeout_secs: None,
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
        let b = openai_body(&req(), false);
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
    fn parse_models_openai_and_ollama_shapes() {
        // OpenAI-compatible (incl. Ollama /v1/models): data[].id
        let openai = json!({ "data": [{ "id": "qwen2.5" }, { "id": "llama3" }] });
        assert_eq!(parse_models(&openai), vec!["llama3", "qwen2.5"]); // sorted
                                                                      // Ollama-native /api/tags: models[].name.
        let ollama = json!({ "models": [{ "name": "mistral" }, { "model": "phi3" }] });
        assert_eq!(parse_models(&ollama), vec!["mistral", "phi3"]);
        // Unknown/empty shapes → empty.
        assert!(parse_models(&json!({})).is_empty());
        // Dedup.
        let dupes = json!({ "data": [{ "id": "a" }, { "id": "a" }] });
        assert_eq!(parse_models(&dupes), vec!["a"]);
    }

    #[test]
    fn provider_error_message_unwraps_error_body() {
        let anthropic = r#"{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."},"request_id":"req_1"}"#;
        assert_eq!(
            provider_error_message(anthropic).as_deref(),
            Some("Your credit balance is too low to access the Anthropic API.")
        );
        let openai = r#"{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}"#;
        assert_eq!(
            provider_error_message(openai).as_deref(),
            Some("You exceeded your current quota")
        );
        // Non-JSON / unexpected shapes → None (caller keeps the raw body).
        assert_eq!(provider_error_message("<html>502</html>"), None);
        assert_eq!(provider_error_message("{}"), None);
    }

    #[test]
    fn merge_params_adds_generation_params_and_protects_core_fields() {
        let mut r = req();
        r.params =
            Some(json!({ "temperature": 0.2, "top_p": 0.9, "model": "HACKED", "messages": [] }));
        let b = openai_body(&r, false);
        assert_eq!(b["temperature"], json!(0.2));
        assert_eq!(b["top_p"], json!(0.9));
        assert_eq!(b["model"], "qwen"); // protected — not overridden
        assert_eq!(b["messages"][1]["content"], "hi"); // protected
        assert_eq!(b["stream"], json!(true));
    }

    #[test]
    fn merge_params_overrides_max_tokens_for_anthropic() {
        let mut r = req();
        r.provider = "anthropic".into();
        r.params = Some(json!({ "max_tokens": 100 }));
        let b = anthropic_body(&r);
        assert_eq!(b["max_tokens"], json!(100)); // user value wins over the 4096 default
    }

    #[test]
    fn agent_mirror_formats_header_output_and_footer() {
        let m = agent_mirror("ls -la", "a\nb\n", "", 0, false, 60);
        assert!(m.contains("[AI] $ ls -la"));
        assert!(m.contains("a\r\nb\r\n")); // LF → CRLF, no staircase
        assert!(m.contains("[AI] exit 0"));
        // Timeout footer when it timed out.
        let t = agent_mirror("sleep 99", "", "", -1, true, 30);
        assert!(t.contains("[AI] timed out after 30s"));
    }

    #[test]
    fn openai_reasoning_delta_accepts_both_field_names() {
        // DeepSeek's spelling…
        let ds = json!({ "choices": [{ "delta": { "reasoning_content": "hmm" } }] });
        assert_eq!(openai_reasoning_delta(&ds).as_deref(), Some("hmm"));
        // …and the one OpenRouter/local servers use.
        let or = json!({ "choices": [{ "delta": { "reasoning": "so" } }] });
        assert_eq!(openai_reasoning_delta(&or).as_deref(), Some("so"));
        // A plain answer chunk is not reasoning (and vice versa), so the two
        // channels never receive the same token.
        let plain = json!({ "choices": [{ "delta": { "content": "answer" } }] });
        assert_eq!(openai_reasoning_delta(&plain), None);
        assert_eq!(openai_delta(&ds), None);
    }

    #[test]
    fn anthropic_reasoning_delta_matches_only_thinking_blocks() {
        let think = json!({
            "type": "content_block_delta",
            "delta": { "type": "thinking_delta", "thinking": "step" }
        });
        assert_eq!(anthropic_reasoning_delta(&think).as_deref(), Some("step"));
        // A text delta stays on the answer channel only.
        let text = json!({
            "type": "content_block_delta",
            "delta": { "type": "text_delta", "text": "x" }
        });
        assert_eq!(anthropic_reasoning_delta(&text), None);
        assert_eq!(anthropic_delta(&think), None);
    }

    #[test]
    fn absorb_usage_reads_both_dialects_and_prefers_later_values() {
        // OpenAI-compatible: one final chunk carries both halves.
        let mut u = AiUsage::default();
        absorb_usage(
            &mut u,
            &json!({ "usage": { "prompt_tokens": 10, "completion_tokens": 4 } }),
        );
        assert_eq!(u.input_tokens, Some(10));
        assert_eq!(u.output_tokens, Some(4));

        // Anthropic: input arrives nested in message_start, output in message_delta,
        // and the output count is cumulative — the last value must win.
        let mut a = AiUsage::default();
        absorb_usage(
            &mut a,
            &json!({ "type": "message_start", "message": { "usage": { "input_tokens": 7 } } }),
        );
        absorb_usage(
            &mut a,
            &json!({ "type": "message_delta", "usage": { "output_tokens": 2 } }),
        );
        absorb_usage(
            &mut a,
            &json!({ "type": "message_delta", "usage": { "output_tokens": 9 } }),
        );
        assert_eq!(a.input_tokens, Some(7));
        assert_eq!(a.output_tokens, Some(9));

        // Ordinary token chunks carry no usage and must not disturb the tally.
        let before = a;
        absorb_usage(
            &mut a,
            &json!({ "choices": [{ "delta": { "content": "x" } }] }),
        );
        assert_eq!(a, before);
    }

    #[test]
    fn finish_usage_reports_nothing_when_the_endpoint_stayed_silent() {
        // No counter beats a made-up zero.
        assert_eq!(finish_usage(AiUsage::default()), None);
        let partial = AiUsage {
            input_tokens: Some(3),
            output_tokens: None,
        };
        assert_eq!(finish_usage(partial), Some(partial));
    }

    #[test]
    fn openai_body_requests_usage_only_when_asked() {
        let with = openai_body(&req(), true);
        assert_eq!(with["stream_options"], json!({ "include_usage": true }));
        // The retry body (after a 400) must not carry the field at all.
        let without = openai_body(&req(), false);
        assert!(without.get("stream_options").is_none());
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
