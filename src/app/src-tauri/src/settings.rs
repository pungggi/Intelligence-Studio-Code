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
            Ok(contents) => serde_json::from_str(&contents)
                .unwrap_or_else(|_| serde_json::Value::Object(Default::default())),
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
        std::fs::write(&self.file_path, json)
            .map_err(|e| format!("Failed to write settings: {e}"))?;
        Ok(())
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
        std::fs::write(&self.file_path, json)
            .map_err(|e| format!("Failed to write settings: {e}"))?;
        Ok(())
    }
}
