//! 自定义 CSS 主题：列出 / 导入 / 读取 / 删除 / 打开主题目录。
//! 所有实际逻辑在 `crate::custom_themes` 模块；本文件只是 tauri command 包装。

use crate::custom_themes;

#[tauri::command]
pub fn theme_list() -> Result<Vec<custom_themes::CustomTheme>, String> {
    custom_themes::list()
}

#[tauri::command]
pub fn theme_import(source_path: String) -> Result<custom_themes::CustomTheme, String> {
    custom_themes::import(&source_path)
}

#[tauri::command]
pub fn theme_read(id: String) -> Result<String, String> {
    custom_themes::read(&id)
}

#[tauri::command]
pub fn theme_delete(id: String) -> Result<(), String> {
    custom_themes::delete(&id)
}

#[tauri::command]
pub fn theme_dir_path() -> Result<String, String> {
    custom_themes::dir_path()
}
