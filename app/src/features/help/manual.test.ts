import md from "./manual.md?raw";
import { describe, expect, it } from "vitest";
import { blocks } from "./Markdown";
import { parseManual } from "./manual";


describe("manual", () => {
  it("has a PC part and a phone part, each with sections", () => {
    const parts = parseManual(md);
    expect(parts.map((p) => p.title)).toEqual(["En la PC", "En el celu"]);
    expect(parts[0].sections.length).toBeGreaterThan(10);
    expect(parts[1].sections.map((s) => s.title)).toContain("Conectarse");
    for (const p of parts) for (const s of p.sections) expect(s.body.length, s.title).toBeGreaterThan(40);
  });

  it("section ids are unique, plain slugs", () => {
    const ids = parseManual(md).flatMap((p) => p.sections.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("en-la-pc-que-es-sampler-lab");
  });

  it("splits paragraphs and lists", () => {
    expect(blocks("Hola **vos**.\n\n- uno\n- dos\n\n1. a\n2. b")).toEqual([
      { kind: "p", text: "Hola **vos**." },
      { kind: "ul", items: ["uno", "dos"] },
      { kind: "ol", items: ["a", "b"] },
    ]);
  });

  it("mentions every phone control the UI shows", () => {
    const phone = parseManual(md)[1].sections.map((s) => s.body).join("\n");
    for (const word of ["Pads", "Grabar", "Pasos", "Sonidos", "Agregar", "Escuchar", "Borrar", "deshacer"]) expect(phone).toContain(word);
  });

  it("explains playing from different homes with the words the UI shows", () => {
    const home = parseManual(md)[0].sections.find((s) => s.title === "Tocar desde distintas casas");
    expect(home).toBeDefined();
    for (const word of ["Amigos en otra casa", "Invitar a alguien de otra casa", "Copiar la invitación", "Me mandaron una invitación (otra casa)", "SL-"]) expect(home!.body).toContain(word);
  });

  it('explains "Tocar juntos" with the words the UI shows', () => {
    const pc = parseManual(md)[0];
    const jam = pc.sections.find((s) => s.title === "Tocar con amigos");
    expect(jam).toBeDefined();
    for (const word of ["Tocar juntos", "Abrir una sala", "Unirme a una sala", "Que suene este", "Traer un sonido mío", "Retraso de mis parlantes", "Salir de la sala", "Cerrar la sala"])
      expect(jam!.body).toContain(word);
  });
});
