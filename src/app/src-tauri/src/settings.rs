 use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingDefinition {
    pub key: String,
    pub type_name: String,
    pub default_value: serde_json::Value,
    pub description: String,
    pub enum_values: Option<Vec<serde_json::Value>>,
    pub scope: Option<String>,
    pub category: Option<String>,
}

pub struct SettingsStore {
    file_path: PathBuf,
}

impl SettingsStore {
    pub fn new() -> Result<Self, String> {
        let data_dir = dirs::data_local_dir()
            .ok_or_else(|| "Could not determine local data directory".to_string())?;
        let config_dir = data_dir.join("corecode");
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create config directory: {e}"))?;

        Ok(Self {
            file_path: config_dir.join("settings.json"),
        })
    }

    pub fn read_all(&self) -> serde_json::Value {
        match std::fs::read_to_string(&self.file_path) {
            Ok(contents) => match serde_json::from_str(&contents) {
                Ok(value) => value,
                Err(e) => {
                    log::error!(
                        "Failed to parse settings file '{}': {e}; falling back to empty settings",
                        self.file_path.display()
                    );
                    serde_json::Value::Object(Default::default())
                }
            },
            Err(_) => serde_json::Value::Object(Default::default()),
        }
    }

    pub fn get(&self, key: &str) -> serde_json::Value {
        let all = self.read_all();
        // Support dotted keys: "editor.fontSize" → settings["editor"]["fontSize"]
        let parts: Vec<&str> = key.split('.').collect();
        let mut current = &all;
        for part in &parts {
            match current.get(part) {
                Some(v) => current = v,
                None => return serde_json::Value::Null,
            }
        }
        current.clone()
    }

    pub fn update(&self, key: &str, value: serde_json::Value) -> Result<(), String> {
        let mut all = match self.read_all() {
            serde_json::Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };

        let parts: Vec<&str> = key.split('.').collect();
        if parts.len() == 1 {
            all.insert(key.to_string(), value);
        } else {
            // Navigate/create nested objects for dotted keys
            let mut current = &mut all;
            for (i, part) in parts.iter().enumerate() {
                if i == parts.len() - 1 {
                    current.insert(part.to_string(), value.clone());
                } else {
                    if !current.contains_key(*part)
                        || !current[*part].is_object()
                    {
                        current.insert(
                            part.to_string(),
                            serde_json::Value::Object(serde_json::Map::new()),
                        );
                    }
                    current = current
                        .get_mut(*part)
                        .unwrap()
                        .as_object_mut()
                        .unwrap();
                }
            }
        }

        let json = serde_json::to_string_pretty(&all)
            .map_err(|e| format!("Failed to serialize settings: {e}"))?;
        self.write_atomic(&json)?;
        Ok(())
    }

    /// Get a config value by dot-separated key path as a string.
    /// Coerces numbers and booleans to their string representation.
    pub fn get_string(&self, key: &str) -> Option<String> {
        let all = self.read_all();
        let parts: Vec<&str> = key.split('.').collect();
        let mut current = all.as_object()?;
        for (i, part) in parts.iter().enumerate() {
            if i == parts.len() - 1 {
                return match current.get(*part)? {
                    serde_json::Value::String(s) => Some(s.clone()),
                    serde_json::Value::Number(n) => Some(n.to_string()),
                    serde_json::Value::Bool(b) => Some(b.to_string()),
                    _ => None,
                };
            }
            current = current.get(*part)?.as_object()?;
        }
        None
    }

    pub fn reset(&self, key: &str) -> Result<(), String> {
        let mut all = match self.read_all() {
            serde_json::Value::Object(map) => map,
            _ => return Ok(()),
        };

        let parts: Vec<&str> = key.split('.').collect();
        if parts.len() == 1 {
            all.remove(key);
        } else {
            // Navigate to parent, remove final key
            let mut current = &mut all;
            for (i, part) in parts.iter().enumerate() {
                if i == parts.len() - 1 {
                    current.remove(*part);
                } else {
                    match current.get_mut(*part) {
                        Some(v) if v.is_object() => {
                            current = v.as_object_mut().unwrap();
                        }
                        _ => return Ok(()),
                    }
                }
            }
        }

        let json = serde_json::to_string_pretty(&all)
            .map_err(|e| format!("Failed to serialize settings: {e}"))?;
        self.write_atomic(&json)?;
        Ok(())
    }

    /// Write `json` to `self.file_path` atomically:
    /// create a sibling `.tmp` file, fsync it (and on Unix its parent directory),
    /// then rename it over the target so callers never see a partial write.
    fn write_atomic(&self, json: &str) -> Result<(), String> {
        use std::io::Write as _;

        let parent = self.file_path.parent()
            .ok_or_else(|| "Cannot determine settings directory".to_string())?;
        let tmp_path = parent.join("settings.json.tmp");

        let mut tmp_file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create temp settings file: {e}"))?;
        tmp_file.write_all(json.as_bytes())
            .map_err(|e| format!("Failed to write temp settings file: {e}"))?;
        tmp_file.sync_all()
            .map_err(|e| format!("Failed to sync temp settings file: {e}"))?;
        drop(tmp_file);

        // Fsync the directory so the rename is durable (only meaningful on Unix).
        #[cfg(unix)]
        {
            let dir = std::fs::File::open(parent)
                .map_err(|e| format!("Failed to open settings directory: {e}"))?;
            dir.sync_all()
                .map_err(|e| format!("Failed to sync settings directory: {e}"))?;
        }

        std::fs::rename(&tmp_path, &self.file_path)
            .map_err(|e| format!("Failed to atomically replace settings file: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store_in(dir: &std::path::Path) -> SettingsStore {
        SettingsStore {
            file_path: dir.join("settings.json"),
        }
    }

    #[test]
    fn get_string_returns_none_for_missing_file() {
        let dir = TempDir::new().unwrap();
        let store = store_in(dir.path());
        assert_eq!(store.get_string("foo"), None);
    }

    #[test]
    fn get_string_returns_string_value() {
        let dir = TempDir::new().unwrap();
        let store = store_in(dir.path());
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"my":{"ext":{"tabSize":"4"}}}"#,
        ).unwrap();
        assert_eq!(store.get_string("my.ext.tabSize"), Some("4".to_string()));
    }

    #[test]
    fn get_string_coerces_number() {
        let dir = TempDir::new().unwrap();
        let store = store_in(dir.path());
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"my":{"ext":{"tabSize":4}}}"#,
        ).unwrap();
        assert_eq!(store.get_string("my.ext.tabSize"), Some("4".to_string()));
    }

    #[test]
    fn get_string_coerces_bool() {
        let dir = TempDir::new().unwrap();
        let store = store_in(dir.path());
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"my":{"ext":{"enabled":true}}}"#,
        ).unwrap();
        assert_eq!(store.get_string("my.ext.enabled"), Some("true".to_string()));
    }

    #[test]
    fn get_string_returns_none_for_object() {
        let dir = TempDir::new().unwrap();
        let store = store_in(dir.path());
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"my":{"ext":{"nested":{}}}}"#,
        ).unwrap();
        assert_eq!(store.get_string("my.ext.nested"), None);
    }
}
