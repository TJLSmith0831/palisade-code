//! Session-local ACP telemetry. Never inferred from transcript length.
use serde::{Serialize, Deserialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextStatus {
    pub used: Option<u64>,
    pub size: Option<u64>,
    pub updated_at: Option<String>,
    pub compaction: Option<String>,
    pub error: Option<String>,
    pub pending: bool,
    #[serde(skip)]
    pub manual: bool,
    pub compactions: BTreeMap<String, Value>,
}

impl ContextStatus {
    pub fn apply(&mut self, update: Value) {
        match update["sessionUpdate"].as_str() {
            Some("usage_update") => {
                if let (Some(used), Some(size)) = (update["used"].as_u64(), update["size"].as_u64()) {
                    if size > 0 && used <= size {
                        self.used = Some(used);
                        self.size = Some(size);
                        self.updated_at = Some(chrono::Utc::now().to_rfc3339());
                    }
                }
            }
            Some("compaction_update") => {
                let Some(id) = update["compactionId"].as_str() else { return };
                let record = self.compactions.entry(id.to_string()).or_insert_with(|| serde_json::json!({}));
                for key in ["status", "summary", "error", "_meta"] {
                    if let Some(value) = update.get(key) { record[key] = value.clone(); }
                }
                self.compaction = record["status"].as_str().map(str::to_string);
                self.error = record["error"].as_str().map(str::to_string);
                self.pending = self.compactions.values().any(|item| item["status"] == "in_progress");
            }
            Some("compaction_summary_chunk") => {
                let Some(id) = update["compactionId"].as_str() else { return };
                if let Some(record) = self.compactions.get_mut(id) {
                    if record["status"] == "in_progress" {
                        if !record["summary"].is_array() { record["summary"] = serde_json::json!([]); }
                        if let Some(content) = update.get("content") { record["summary"].as_array_mut().unwrap().push(content.clone()); }
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn usage_is_reported_not_estimated_and_invalid_updates_do_not_replace_it() {
        let mut state = ContextStatus::default();
        state.apply(json!({"sessionUpdate":"usage_update","used":50,"size":100}));
        assert_eq!(state.used, Some(50));
        assert!(state.updated_at.is_some());
        state.apply(json!({"sessionUpdate":"usage_update","used":90,"size":0}));
        assert_eq!(state.size, Some(100));
    }
    #[test]
    fn compaction_chunks_patch_one_entity_and_null_clears_summary() {
        let mut state = ContextStatus::default();
        state.apply(json!({"sessionUpdate":"compaction_update","compactionId":"a","status":"in_progress"}));
        state.apply(json!({"sessionUpdate":"compaction_summary_chunk","compactionId":"a","content":{"type":"text","text":"kept"}}));
        state.apply(json!({"sessionUpdate":"compaction_update","compactionId":"a","status":"completed"}));
        assert_eq!(state.compactions["a"]["summary"][0]["text"], "kept");
        assert!(!state.pending);
        state.apply(json!({"sessionUpdate":"compaction_update","compactionId":"a","status":"completed","summary":null}));
        assert!(state.compactions["a"]["summary"].is_null());
        assert_eq!(state.compactions.len(), 1);
    }
}
