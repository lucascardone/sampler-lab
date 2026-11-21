import { describe, expect, it } from "vitest";
import { expandIncludes, joinInside, parseNote, parseSfz, pickZone, zonesToLoad } from "./sfz";

describe("sfz", () => {
  it("note names", () => {
    expect(parseNote("c4")).toBe(60);
    expect(parseNote("A4")).toBe(69);
    expect(parseNote("f#3")).toBe(54);
    expect(parseNote("eb2")).toBe(39);
    expect(parseNote("c-1")).toBe(0);
    expect(parseNote("72")).toBe(72);
    expect(parseNote("h2")).toBeNull();
  });

  it("regions inherit from group/global, with default_path and file names with spaces", () => {
    const zones = parseSfz(`
      // a comment
      <control> default_path=Samples\\Grand/
      <global> ampeg_release=0.6
      <group> lovel=1 hivel=64 volume=-3
      <region> sample=Piano C4 soft.wav lokey=58 hikey=62 pitch_keycenter=c4
      <region> sample=Piano E4 soft.wav lokey=63 hikey=66 pitch_keycenter=64 tune=-12
      <group> lovel=65 hivel=127
      <region> sample=Piano C4 loud.wav lokey=58 hikey=62 pitch_keycenter=60
    `);
    expect(zones).toHaveLength(3);
    expect(zones[0]).toEqual({
      file: "Samples/Grand/Piano C4 soft.wav",
      lo: 58,
      hi: 62,
      root: 60,
      loVel: 1,
      hiVel: 64,
      tuneCents: 0,
      gainDb: -3,
      release: 0.6,
    });
    expect(zones[1].tuneCents).toBe(-12);
    expect(zones[2].gainDb).toBe(0); // a new group resets group opcodes
    expect(zones[2].loVel).toBe(65);
  });

  it("key= sets range and root; #define works; unknown opcodes are ignored", () => {
    const zones = parseSfz(`#define $KICK 36
      <region> sample=kick.wav key=$KICK loop_mode=one_shot cutoff=500
      <region>sample=snare.wav key=d2`);
    expect(zones.map((z) => [z.file, z.lo, z.hi, z.root])).toEqual([
      ["kick.wav", 36, 36, 36],
      ["snare.wav", 38, 38, 38],
    ]);
  });

  it("picks the zone for a note, and the nearest one outside every range", () => {
    const zones = parseSfz("<region> sample=a.wav lokey=48 hikey=59 pitch_keycenter=54\n<region> sample=b.wav lokey=60 hikey=71 pitch_keycenter=66");
    expect(pickZone(zones, 50)?.file).toBe("a.wav");
    expect(pickZone(zones, 60)?.file).toBe("b.wav");
    expect(pickZone(zones, 90)?.file).toBe("b.wav");
    expect(pickZone(zones, 10)?.file).toBe("a.wav");
    expect(pickZone([], 60)).toBeUndefined();
  });

  it("loads one velocity layer per key range", () => {
    const zones = parseSfz(`
      <region> sample=c-soft.wav lokey=58 hikey=62 hivel=50
      <region> sample=c-mid.wav lokey=58 hikey=62 lovel=51 hivel=100
      <region> sample=c-loud.wav lokey=58 hikey=62 lovel=101
      <region> sample=e.wav lokey=63 hikey=66`);
    expect(zonesToLoad(zones).map((z) => z.file)).toEqual(["c-mid.wav", "e.wav"]);
  });

  it("pastes #include files relative to the top file, skipping missing ones and loops", async () => {
    const files: Record<string, string> = {
      "legato/sus.sfz": "<region> sample=..\\Samples\\a.wav key=40",
      "legato/loop.sfz": '#include "legato/loop.sfz"\n<region> sample=b.wav key=41',
    };
    const read = async (rel: string) => {
      if (!(rel in files)) throw new Error("404");
      return files[rel];
    };
    const text = await expandIncludes('<global> volume=-2\n#include "legato/sus.sfz"\n#include "gone.sfz"\n  #include "legato\\loop.sfz"', read);
    const zones = parseSfz(text);
    expect(zones.map((z) => z.file)).toEqual(["../Samples/a.wav", "b.wav"]);
    expect(zones[0].gainDb).toBe(-2);
    expect(joinInside("Programs", "../Samples/a.wav")).toBe("Samples/a.wav");
    expect(joinInside("", "../x.wav")).toBeNull();
  });

  it("plays only the default keyswitch, without release triggers or built-in waves", () => {
    const zones = parseSfz(`
      <global> sw_default=25
      <group> sw_last=26
      <region> sample=sus.wav key=40
      <group> sw_last=25
      <region> sample=stac.wav key=40
      <region> sample=stac-rel.wav key=40 trigger=release
      <group>
      <region> sample=noise.wav key=41
      <region> sample=*sine key=42`);
    expect(zones.map((z) => z.file)).toEqual(["stac.wav", "noise.wav"]);
    // No sw_default: the lowest switch.
    expect(parseSfz("<group> sw_last=c2\n<region> sample=a.wav\n<group> sw_last=b1\n<region> sample=b.wav").map((z) => z.file)).toEqual(["b.wav"]);
  });
});
