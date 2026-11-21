import { describe, expect, it } from "vitest";
import { applyKnob, bind, findBinding, normalizeBindings, parseTargetKey, targetKey, unbind, type MidiBinding } from "./midiMap";
import { mixOf, newSong, removeChannel, type DrumNames } from "./song";

const names: DrumNames = { kick: "Bombo", snare: "Caja", clap: "Palmas", hat: "Hi-hat", openHat: "Hi-hat abierto", rim: "Aro" };

describe("MIDI knob links", () => {
  it("a control drives one target and a target has one control", () => {
    let list: MidiBinding[] = [];
    list = bind(list, "Teclado", 21, { kind: "bpm" });
    list = bind(list, "Teclado", 22, { kind: "swing" });
    // Same knob to another target: moves it.
    list = bind(list, "Teclado", 21, { kind: "master" });
    expect(list).toHaveLength(2);
    expect(findBinding(list, "Teclado", 21)?.target).toEqual({ kind: "master" });
    // Same target from another knob/device: the old link goes.
    list = bind(list, "Pads", 1, { kind: "swing" });
    expect(findBinding(list, "Teclado", 22)).toBeUndefined();
    expect(findBinding(list, "Pads", 1)?.target).toEqual({ kind: "swing" });
    expect(unbind(list, { kind: "swing" })).toHaveLength(1);
  });

  it("target keys round-trip and saved junk is dropped", () => {
    for (const t of [{ kind: "bpm" }, { kind: "delay", channelId: "c3" }, { kind: "record" }] as const) {
      expect(parseTargetKey(targetKey(t))).toEqual(t);
    }
    expect(parseTargetKey("volume")).toBeNull();
    expect(
      normalizeBindings([
        { device: "A", cc: 7, target: { kind: "volume", channelId: "c1" } },
        { device: "A", cc: 300, target: { kind: "bpm" } },
        { device: 3, cc: 1, target: { kind: "bpm" } },
        { device: "A", cc: 2, target: { kind: "nope" } },
        null,
      ]),
    ).toEqual([{ device: "A", cc: 7, target: { kind: "volume", channelId: "c1" } }]);
    expect(normalizeBindings("x")).toEqual([]);
  });

  it("knobs set tempo, swing and master volume over their range", () => {
    const s = newSong(names);
    expect(applyKnob(s, { kind: "bpm" }, 0)?.bpm).toBe(60);
    expect(applyKnob(s, { kind: "bpm" }, 127)?.bpm).toBe(180);
    expect(applyKnob(s, { kind: "swing" }, 127)?.swing).toBe(1);
    expect(applyKnob(s, { kind: "master" }, 0)?.masterVolume).toBe(0);
    expect(applyKnob(s, { kind: "play" }, 127)).toBeNull();
  });

  it("channel knobs change the mix of the pattern being edited", () => {
    const s = newSong(names);
    const ch = s.channels[0].id;
    const vol = applyKnob(s, { kind: "volume", channelId: ch }, 127)!;
    expect(mixOf(vol, s.currentPatternId, ch).volume).toBe(1);
    expect(vol.channels[0].volume).toBe(s.channels[0].volume); // audio-clip mix untouched
    const eco = applyKnob(s, { kind: "delay", channelId: ch }, 64)!;
    expect(mixOf(eco, s.currentPatternId, ch).fx.delay).toBeCloseTo(0.5, 2);
    // Same value again: no change (no undo step per MIDI message).
    expect(applyKnob(eco, { kind: "delay", channelId: ch }, 64)).toBeNull();
    // Deleted channel: ignored.
    expect(applyKnob(removeChannel(s, ch), { kind: "reverb", channelId: ch }, 100)).toBeNull();
  });
});
