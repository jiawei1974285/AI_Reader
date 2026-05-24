//! Secret storage — wraps the OS keystore so API keys never land in SQLite.
//!
//! 按 CLAUDE.md 原则 14（关键路径要有兜底）+ 原则 16（自适应）：
//! 之前 `app_config[ai_settings]` 把 api_key 明文存 SQLite，备份 / 同步盘 /
//! 多用户场景全暴露。改走 OS keystore：
//!
//! - Windows → Credential Manager
//! - macOS   → Keychain
//! - Linux   → secret-service (KWallet / gnome-keyring)
//!
//! DB 里只留 base_url / chat_model / temperature / fast_mode，备份 db 文件
//! 不再泄密。
//!
//! Service 名固定 `"aireader"`，account 名 = secret 类别（目前只有 `ai_api_key`）。

use keyring::Entry;
use tracing::warn;

const SERVICE: &str = "aireader";
pub const ACCOUNT_AI_API_KEY: &str = "ai_api_key";

/// 写入或更新一个 secret。空字符串 → 删除。
pub fn set(account: &str, value: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, account).map_err(|e| format!("keystore 不可用: {e}"))?;
    if value.is_empty() {
        // 显式清除：用户在设置面板清空了 api_key
        match entry.delete_credential() {
            Ok(_) => Ok(()),
            // NoEntry 是预期路径（删一个本就不存在的）
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => {
                warn!(error = %e, "keystore delete failed");
                Err(format!("清除 keystore 条目失败: {e}"))
            }
        }
    } else {
        entry
            .set_password(value)
            .map_err(|e| format!("写 keystore 失败: {e}"))
    }
}

/// 读 secret。条目不存在返回 `Ok(None)`，区别于真正的 IO 错误。
pub fn get(account: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, account).map_err(|e| format!("keystore 不可用: {e}"))?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => {
            warn!(error = %e, account = account, "keystore read failed");
            Err(format!("读 keystore 失败: {e}"))
        }
    }
}
