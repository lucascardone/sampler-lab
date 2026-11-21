pub mod audio;
mod capture;
mod catalog;
mod commands;
mod engine;
mod jam;
mod jam_net;
mod library;
mod midi;
mod online;
mod packs;
mod remote;
pub mod project;
pub mod recorder;
mod studio;

use tauri::WindowEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch just brings the running app (in the tray) forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| capture::show_main_window(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::AppState::default())
        .manage(engine::EngineState::default())
        .manage(capture::CaptureState::default())
        .manage(library::LibraryState::default())
        .manage(studio::SongState::default())
        .manage(catalog::CatalogState::default())
        .manage(online::OnlineState::default())
        .manage(midi::MidiState::default())
        .manage(remote::RemoteState::default())
        .manage(jam::JamState::default())
        .setup(|app| {
            capture::setup_tray(app.handle())?;
            Ok(())
        })
        // Closing the window keeps the app in the tray (so recording keeps working).
        // "Salir" in the tray menu quits for real.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_audio,
            commands::add_audio,
            commands::last_session,
            commands::restore_session,
            commands::create_sample,
            commands::rename_sample,
            commands::delete_sample,
            commands::add_effect,
            commands::set_effect_enabled,
            commands::remove_effect,
            commands::move_effect,
            commands::undo,
            commands::redo,
            commands::render_sample,
            commands::snap_to_zero,
            commands::export_sample,
            commands::export_all,
            commands::prepare_separation,
            commands::import_stems,
            commands::keep_stem,
            engine::engine_status,
            engine::engine_hardware,
            engine::engine_setup,
            engine::engine_start,
            capture::recording_status,
            capture::start_recording,
            capture::stop_recording,
            capture::list_recordings,
            capture::set_recordings_dir,
            capture::open_recordings_dir,
            capture::rename_recording,
            capture::delete_recording,
            capture::recording_usage,
            library::library_list,
            library::library_sample_audio,
            library::library_analyze,
            library::library_rename_sample,
            library::library_delete_sample,
            packs::packs_list,
            packs::pack_import_folder,
            packs::pack_delete,
            packs::pack_rename,
            catalog::catalog_fetch,
            catalog::pack_install,
            catalog::pack_cancel,
            online::sound_search,
            online::sound_add,
            studio::song_load,
            studio::song_save,
            studio::song_recovery_note,
            studio::fx_presets_load,
            studio::fx_presets_save,
            studio::export_song,
            studio::save_file,
            midi::midi_sync,
            remote::remote_start,
            remote::remote_stop,
            remote::remote_status,
            jam::jam_default_name,
            jam::jam_host_start,
            jam::jam_host_stop,
            jam::jam_host_internet,
            jam::jam_host_status,
            jam::jam_host_send,
            jam::jam_scan,
            jam::jam_join,
            jam::jam_guest_send,
            jam::jam_guest_call,
            jam::jam_guest_fetch,
            jam::jam_guest_upload,
            jam::jam_leave,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                remote::shutdown(app);
                jam::shutdown(app);
                capture::shutdown(app);
                engine::shutdown(app);
            }
        });
}
