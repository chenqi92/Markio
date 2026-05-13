use keyring::Entry;

const SERVICE: &str = "com.welape.mdview";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// 把一个秘密塞进系统 keychain；空字符串视为清除。
pub fn set(account: &str, value: &str) -> Result<(), String> {
    let e = entry(account)?;
    if value.is_empty() {
        // 删除（允许"没设过"情况，吞错）
        let _ = e.delete_credential();
        return Ok(());
    }
    e.set_password(value).map_err(|err| err.to_string())
}

pub fn get(account: &str) -> Result<Option<String>, String> {
    let e = entry(account)?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

pub fn has(account: &str) -> bool {
    matches!(get(account), Ok(Some(_)))
}

pub fn delete(account: &str) -> Result<(), String> {
    let e = entry(account)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}
