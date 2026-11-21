//! MIDI keyboards and controllers. The core listens to every plugged-in device the user
//! hasn't switched off (WinMM/CoreMIDI/ALSA via midir) and forwards notes, knobs, pitch
//! bend and transport buttons to the UI as "midi" events; the UI plays them through the
//! studio engine. The UI calls `midi_sync` every couple of seconds, so devices plugged in
//! or out while the app runs are picked up on their own.

use crate::commands::{CmdResult, err};
use midir::{Ignore, MidiInput, MidiInputConnection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct MidiState {
    conns: Mutex<HashMap<String, MidiInputConnection<()>>>,
    /// Devices that failed to open (busy in another program…), with the reason, so the
    /// UI can say why and the sync loop doesn't retry every tick.
    failed: Mutex<HashMap<String, String>>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TransportAction {
    Play,
    Stop,
    Record,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MidiMsg {
    /// velocity 1..127
    On { note: u8, velocity: u8 },
    Off { note: u8 },
    /// Control change (1 = modulation wheel, 64 = sustain pedal, others: knobs/faders).
    Cc { controller: u8, value: u8 },
    /// Pitch wheel, -1..1 (0 = centre).
    Bend { value: f32 },
    /// Play/stop/record buttons (MIDI Machine Control or Start/Continue/Stop).
    Transport { action: TransportAction },
}

/// A message plus the device it came from (knob assignments are per device).
#[derive(Debug, Clone, Serialize)]
struct MidiEvent {
    device: String,
    #[serde(flatten)]
    msg: MidiMsg,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MidiDevice {
    name: String,
    /// Listening to it right now.
    connected: bool,
    /// Why it couldn't be opened, if it couldn't.
    error: Option<String>,
}

/// Decode a raw MIDI message (any channel). Other messages are ignored.
pub fn parse(msg: &[u8]) -> Option<MidiMsg> {
    let (&status, rest) = msg.split_first()?;
    match status {
        // Realtime transport (sequencer-style Start/Continue/Stop buttons).
        0xFA | 0xFB => return Some(MidiMsg::Transport { action: TransportAction::Play }),
        0xFC => return Some(MidiMsg::Transport { action: TransportAction::Stop }),
        // MIDI Machine Control: F0 7F <device> 06 <command> F7.
        0xF0 => {
            return match rest {
                [0x7F, _, 0x06, cmd, ..] => match cmd {
                    0x02 | 0x03 => Some(MidiMsg::Transport { action: TransportAction::Play }),
                    0x01 | 0x09 => Some(MidiMsg::Transport { action: TransportAction::Stop }),
                    0x06 => Some(MidiMsg::Transport { action: TransportAction::Record }),
                    _ => None,
                },
                _ => None,
            };
        }
        _ => {}
    }
    match (status & 0xF0, rest) {
        (0x90, [note, vel, ..]) if *vel > 0 => Some(MidiMsg::On { note: *note, velocity: *vel }),
        // Note-on with velocity 0 is a note-off ("running status" keyboards send these).
        (0x90, [note, 0, ..]) | (0x80, [note, ..]) => Some(MidiMsg::Off { note: *note }),
        (0xB0, [controller, value, ..]) => Some(MidiMsg::Cc { controller: *controller, value: *value }),
        (0xE0, [lsb, msb, ..]) => {
            let raw = ((*msb as i32 & 0x7F) << 7 | (*lsb as i32 & 0x7F)) - 8192;
            // -8192..8191 → -1..1 (the top is one step short of 1; round it up).
            let v = if raw >= 0 { raw as f32 / 8191.0 } else { raw as f32 / 8192.0 };
            Some(MidiMsg::Bend { value: v })
        }
        _ => None,
    }
}

fn input() -> CmdResult<MidiInput> {
    let mut mi = MidiInput::new("Sampler Lab").map_err(|e| err(format!("MIDI no disponible: {e}")))?;
    // Let SysEx through (MMC transport buttons); clock and active sensing are noise.
    mi.ignore(Ignore::TimeAndActiveSense);
    Ok(mi)
}

/// What `midi_sync` must do, given what's plugged in, what's open and what's switched off.
/// Pure so it can be tested without hardware.
fn plan(present: &[String], open: &HashSet<String>, failed: &HashSet<String>, off: &HashSet<String>) -> (Vec<String>, Vec<String>) {
    let close = open.iter().filter(|n| !present.contains(n) || off.contains(*n)).cloned().collect();
    let connect = present
        .iter()
        .filter(|n| !open.contains(*n) && !off.contains(*n) && !failed.contains(*n))
        .cloned()
        .collect();
    (close, connect)
}

/// Listen to every plugged-in device except the ones in `off`, stop listening to the ones
/// unplugged or switched off, and return the list. Cheap: safe to call every few seconds.
/// `retry` = try again the devices that failed to open before.
#[tauri::command]
pub fn midi_sync(app: AppHandle, state: State<'_, MidiState>, off: Vec<String>, retry: Option<bool>) -> CmdResult<Vec<MidiDevice>> {
    let off: HashSet<String> = off.into_iter().collect();
    let mi = input()?;
    let ports = mi.ports();
    let present: Vec<String> = ports.iter().filter_map(|p| mi.port_name(p).ok()).collect();

    let mut conns = state.conns.lock().unwrap();
    let mut failed = state.failed.lock().unwrap();
    if retry.unwrap_or(false) {
        failed.clear();
    }
    // Forget failures of devices that are gone, so plugging one back retries it.
    failed.retain(|n, _| present.contains(n) && !off.contains(n));

    let open: HashSet<String> = conns.keys().cloned().collect();
    let failed_names: HashSet<String> = failed.keys().cloned().collect();
    let (close, connect) = plan(&present, &open, &failed_names, &off);
    for name in close {
        if let Some(c) = conns.remove(&name) {
            c.close();
        }
    }
    for name in connect {
        // A MidiInput is consumed by connect(): make one per device.
        let result = input().and_then(|mi| {
            let port = mi
                .ports()
                .into_iter()
                .find(|p| mi.port_name(p).ok().as_deref() == Some(name.as_str()))
                .ok_or_else(|| err(format!("\"{name}\" se desconectó")))?;
            let app = app.clone();
            let device = name.clone();
            mi.connect(
                &port,
                "sampler-lab-in",
                move |_stamp, msg, _| {
                    if let Some(msg) = parse(msg) {
                        let _ = app.emit("midi", MidiEvent { device: device.clone(), msg });
                    }
                },
                (),
            )
            .map_err(|e| err(format!("No se pudo abrir \"{name}\" (¿lo está usando otro programa?): {e}")))
        });
        match result {
            Ok(conn) => {
                conns.insert(name, conn);
            }
            Err(e) => {
                failed.insert(name, e.0);
            }
        }
    }
    Ok(present
        .into_iter()
        .map(|name| MidiDevice {
            connected: conns.contains_key(&name),
            error: failed.get(&name).cloned(),
            name,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_notes_on_any_channel_and_ignores_the_rest() {
        assert_eq!(parse(&[0x90, 60, 100]), Some(MidiMsg::On { note: 60, velocity: 100 }));
        assert_eq!(parse(&[0x93, 64, 1]), Some(MidiMsg::On { note: 64, velocity: 1 }));
        assert_eq!(parse(&[0x80, 60, 40]), Some(MidiMsg::Off { note: 60 }));
        assert_eq!(parse(&[0x90, 60, 0]), Some(MidiMsg::Off { note: 60 }));
        assert_eq!(parse(&[0xB0, 64, 127]), Some(MidiMsg::Cc { controller: 64, value: 127 }));
        assert_eq!(parse(&[0xF8]), None); // clock
        assert_eq!(parse(&[]), None);
        assert_eq!(parse(&[0x90, 60]), None);
    }

    #[test]
    fn parses_pitch_bend_to_minus_one_one() {
        assert_eq!(parse(&[0xE0, 0, 64]), Some(MidiMsg::Bend { value: 0.0 }));
        assert_eq!(parse(&[0xE1, 0x7F, 0x7F]), Some(MidiMsg::Bend { value: 1.0 }));
        assert_eq!(parse(&[0xE0, 0, 0]), Some(MidiMsg::Bend { value: -1.0 }));
    }

    #[test]
    fn parses_transport_buttons() {
        let t = |action| Some(MidiMsg::Transport { action });
        assert_eq!(parse(&[0xFA]), t(TransportAction::Play));
        assert_eq!(parse(&[0xFB]), t(TransportAction::Play));
        assert_eq!(parse(&[0xFC]), t(TransportAction::Stop));
        assert_eq!(parse(&[0xF0, 0x7F, 0x7F, 0x06, 0x02, 0xF7]), t(TransportAction::Play));
        assert_eq!(parse(&[0xF0, 0x7F, 0x00, 0x06, 0x01, 0xF7]), t(TransportAction::Stop));
        assert_eq!(parse(&[0xF0, 0x7F, 0x7F, 0x06, 0x06, 0xF7]), t(TransportAction::Record));
        assert_eq!(parse(&[0xF0, 0x7F, 0x7F, 0x06, 0x44, 0xF7]), None); // locate: not used
        assert_eq!(parse(&[0xF0, 0x41, 0x10, 0x42, 0xF7]), None); // vendor sysex
    }

    #[test]
    fn events_serialize_for_the_ui() {
        let j = serde_json::to_string(&MidiEvent { device: "Teclado".into(), msg: MidiMsg::On { note: 60, velocity: 90 } }).unwrap();
        assert_eq!(j, r#"{"device":"Teclado","kind":"on","note":60,"velocity":90}"#);
        let j = serde_json::to_string(&MidiEvent { device: "X".into(), msg: MidiMsg::Transport { action: TransportAction::Record } }).unwrap();
        assert_eq!(j, r#"{"device":"X","kind":"transport","action":"record"}"#);
    }

    #[test]
    fn sync_plan_opens_new_devices_and_closes_gone_or_switched_off_ones() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<HashSet<_>>();
        let present = vec!["A".to_string(), "B".to_string(), "C".to_string(), "D".to_string()];
        let (mut close, mut connect) = plan(&present, &s(&["A", "Gone", "B"]), &s(&["D"]), &s(&["B"]));
        close.sort();
        connect.sort();
        assert_eq!(close, vec!["B", "Gone"]);
        assert_eq!(connect, vec!["C"]); // A already open, B off, D failed before
    }
}
