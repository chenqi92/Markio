#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::CStr;
    use std::os::raw::c_char;

    extern "C" {
        fn markio_storefront_country_code() -> *mut c_char;
        fn markio_free_c_string(ptr: *mut c_char);
    }

    pub fn country_code() -> Option<String> {
        unsafe {
            let ptr = markio_storefront_country_code();
            if ptr.is_null() {
                return None;
            }
            let value = CStr::from_ptr(ptr).to_string_lossy().trim().to_string();
            markio_free_c_string(ptr);
            if value.is_empty() {
                None
            } else {
                Some(value.to_uppercase())
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn country_code() -> Option<String> {
        None
    }
}

pub fn country_code() -> Option<String> {
    platform::country_code()
}
