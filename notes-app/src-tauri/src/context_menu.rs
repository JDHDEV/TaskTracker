//! Native context-menu augmentation (Plan 16, approach C).
//!
//! WebView2 draws the context menu itself — every default item (Undo/Redo,
//! Cut/Copy/Paste, Select all, spell-check suggestions, emoji…) stays exactly
//! as the OS renders it — and this module APPENDS the app's items to that menu
//! from Rust via `ICoreWebView2_11::add_ContextMenuRequested`. The app never
//! draws a menu of its own.
//!
//! Which items appear depends on which kind of field has focus. The frontend
//! publishes that (`commands::set_context_menu_surface`) into the ONE copy of
//! the flag, `AppState::menu_surface`, and the hook reads it back through the
//! `AppHandle` at right-click time — the command and the callback can never
//! diverge (D4). Static labels — never user text (§4 MUST 1): the selection
//! text is read solely to decide whether the send-to items appear and is
//! dropped on the spot (MUST 2). This is the crate's only Windows-only / COM
//! code; every COM call fails soft (the plain native menu shows) and nothing
//! here can panic inside `setup()` (MUST 4). `webview2-com` / `windows-core`
//! must stay pinned to the versions `wry` resolves (Cargo.toml, D9).

/// Which kind of field has keyboard focus, as published by the frontend from
/// the app-rendered `data-menu-surface` attribute.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MenuSurface {
    /// Anything without a `data-menu-surface` (titles, search, key fields,
    /// list rows, chrome) — no custom items.
    #[default]
    None,
    /// An item or prompt body textarea — "Insert timestamp".
    Body,
    /// The scratch pad — "Insert timestamp", plus the three send-to items when
    /// the target carries a non-whitespace selection.
    Scratch,
}

impl MenuSurface {
    /// Exact-match allowlist: `none` | `body` | `scratch`. Anything else —
    /// including case or whitespace variants — is `None` (the option), so a
    /// caller never stores an unrecognised value (§4 MUST 3).
    pub fn parse(s: &str) -> Option<MenuSurface> {
        match s {
            "none" => Some(MenuSurface::None),
            "body" => Some(MenuSurface::Body),
            "scratch" => Some(MenuSurface::Scratch),
            _ => None,
        }
    }
}

/// The Tauri event carrying the chosen item's static action id.
pub const ACTION_EVENT: &str = "context-menu-action";

#[cfg(windows)]
mod win {
    use super::{MenuSurface, ACTION_EVENT};
    use crate::commands::AppState;
    use tauri::{AppHandle, Emitter, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{take_pwstr, ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler};
    use windows_core::{w, Interface, BOOL, PCWSTR, PWSTR};

    /// One custom item: a static label and the static id emitted when chosen.
    /// Never interpolate selection text, titles, or ids from user data here.
    struct MenuItemSpec {
        label: PCWSTR,
        id: &'static str,
    }

    const INSERT_TIMESTAMP: MenuItemSpec = MenuItemSpec {
        label: w!("Insert timestamp"),
        id: "insert-timestamp",
    };

    /// Scratch-only, selection-gated (the labels SelectionMenu.tsx carried).
    const SEND_ITEMS: [MenuItemSpec; 3] = [
        MenuItemSpec { label: w!("New note from selection"), id: "send-note" },
        MenuItemSpec { label: w!("New task from selection"), id: "send-task" },
        MenuItemSpec { label: w!("New prompt from selection"), id: "send-prompt" },
    ];

    /// Hook the main window's WebView2 `ContextMenuRequested` event. Returns
    /// `Ok(())` without hooking when there is no main window yet; the closure
    /// itself skips installation on any COM failure (an old runtime without
    /// `ICoreWebView2_11`, a failed cast) so the app runs with the plain
    /// native menu. Never panics.
    pub fn install(app: &AppHandle) -> tauri::Result<()> {
        let Some(window) = app.get_webview_window("main") else {
            return Ok(());
        };
        let handle = app.clone();
        window.with_webview(move |webview| {
            // SAFETY: `with_webview` runs this on the thread that owns the
            // WebView2 controller; everything below is a COM method call on
            // interfaces reached from it, and every failure is skipped.
            unsafe { hook(&handle, &webview.controller()) }
        })
    }

    unsafe fn hook(handle: &AppHandle, controller: &ICoreWebView2Controller) {
        let Ok(core) = controller.CoreWebView2() else { return };
        // ICoreWebView2_11 (runtime ≥ 1.0.1185.39) adds ContextMenuRequested;
        // an older runtime fails the cast and keeps the default menu.
        let Ok(core11) = core.cast::<ICoreWebView2_11>() else { return };
        let handle = handle.clone();
        let handler = ContextMenuRequestedEventHandler::create(Box::new(move |sender, args| {
            if let (Some(sender), Some(args)) = (sender, args) {
                // Any failure means "no app items this time"; the default menu
                // still shows (items are created before any is inserted).
                let _ = append_items(&handle, &sender, &args);
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core11.add_ContextMenuRequested(&handler, &mut token);
    }

    /// The published surface, copied out with the lock released before any
    /// COM call. A poisoned lock still yields the stored value (never a panic).
    fn current_surface(handle: &AppHandle) -> MenuSurface {
        let Some(state) = handle.try_state::<AppState>() else {
            return MenuSurface::None;
        };
        let surface = match state.menu_surface.lock() {
            Ok(guard) => *guard,
            Err(poisoned) => *poisoned.into_inner(),
        };
        surface
    }

    /// Append the app's items to the menu WebView2 is about to show (D5):
    /// "Insert timestamp" on an editable target when a body surface has focus;
    /// on the scratch pad with a non-whitespace selection, also the three
    /// send-to items. Items are created fresh per right-click and owned by
    /// WebView2 (no caching).
    unsafe fn append_items(
        handle: &AppHandle,
        sender: &ICoreWebView2,
        args: &ICoreWebView2ContextMenuRequestedEventArgs,
    ) -> windows_core::Result<()> {
        let surface = current_surface(handle);
        if surface == MenuSurface::None {
            return Ok(());
        }
        let target = args.ContextMenuTarget()?;
        let mut editable = BOOL::default();
        target.IsEditable(&mut editable)?;
        if !editable.as_bool() {
            return Ok(());
        }

        let env = sender
            .cast::<ICoreWebView2_2>()?
            .Environment()?
            .cast::<ICoreWebView2Environment9>()?;
        // Create every item first, then insert: a creation failure part-way
        // leaves the menu exactly as WebView2 built it (no orphan separator).
        let mut created = vec![env.CreateContextMenuItem(
            w!(""),
            None,
            COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
        )?];
        created.push(create_command(handle, &env, &INSERT_TIMESTAMP)?);
        if surface == MenuSurface::Scratch && has_text_selection(&target)? {
            for spec in &SEND_ITEMS {
                created.push(create_command(handle, &env, spec)?);
            }
        }

        // Appended after the defaults, behind the separator (D5).
        let items = args.MenuItems()?;
        let mut index = 0u32;
        items.Count(&mut index)?;
        for item in &created {
            items.InsertValueAtIndex(index, item)?;
            index += 1;
        }
        Ok(())
    }

    /// Whether the target has a non-whitespace selection. The text is read only
    /// for this check and dropped here — never emitted, logged, or stored
    /// (§4 MUST 2).
    unsafe fn has_text_selection(target: &ICoreWebView2ContextMenuTarget) -> windows_core::Result<bool> {
        let mut has = BOOL::default();
        target.HasSelection(&mut has)?;
        if !has.as_bool() {
            return Ok(false);
        }
        let mut text = PWSTR::null();
        target.SelectionText(&mut text)?;
        let text = take_pwstr(text); // frees the CoTaskMem buffer on drop
        Ok(!text.trim().is_empty())
    }

    /// Create one command item with its `CustomItemSelected` wired to emit the
    /// static action id. The caller inserts it.
    unsafe fn create_command(
        handle: &AppHandle,
        env: &ICoreWebView2Environment9,
        spec: &MenuItemSpec,
    ) -> windows_core::Result<ICoreWebView2ContextMenuItem> {
        let item =
            env.CreateContextMenuItem(spec.label, None, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND)?;
        let handle = handle.clone();
        let id = spec.id;
        let mut token = 0i64;
        item.add_CustomItemSelected(
            &CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
                // The static id is the entire payload (§4 MUST 1).
                let _ = handle.emit(ACTION_EVENT, id);
                Ok(())
            })),
            &mut token,
        )?;
        Ok(item)
    }
}

#[cfg(windows)]
pub use win::install;

/// Non-Windows twin: there is no WebView2 here, so nothing to hook.
#[cfg(not(windows))]
pub fn install(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_none() {
        assert_eq!(MenuSurface::parse("none"), Some(MenuSurface::None));
    }

    #[test]
    fn parse_accepts_body() {
        assert_eq!(MenuSurface::parse("body"), Some(MenuSurface::Body));
    }

    #[test]
    fn parse_accepts_scratch() {
        assert_eq!(MenuSurface::parse("scratch"), Some(MenuSurface::Scratch));
    }

    #[test]
    fn parse_rejects_empty_string() {
        assert_eq!(MenuSurface::parse(""), None);
    }

    #[test]
    fn parse_rejects_wrong_case() {
        assert_eq!(MenuSurface::parse("Body"), None);
    }

    #[test]
    fn parse_rejects_unknown_value() {
        assert_eq!(MenuSurface::parse("title"), None);
    }

    #[test]
    fn parse_rejects_trailing_space() {
        assert_eq!(MenuSurface::parse("scratch "), None);
    }

    #[test]
    fn parse_rejects_leading_space() {
        assert_eq!(MenuSurface::parse(" body"), None);
    }

    #[test]
    fn parse_rejects_trailing_newline() {
        assert_eq!(MenuSurface::parse("none\n"), None);
    }

    #[test]
    fn default_is_none() {
        assert_eq!(MenuSurface::default(), MenuSurface::None);
    }

    #[test]
    fn menu_surface_is_copy_and_partial_eq() {
        let a = MenuSurface::Body;
        let b = a;
        assert_eq!(a, b);
    }
}
