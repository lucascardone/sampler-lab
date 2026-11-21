// Keyboard helpers shared by the Samples and Studio shortcuts.

/** True when the key goes into a text field (so shortcuts must not steal it). */
export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return true;
  if (el.tagName !== "INPUT") return false;
  // Sliders and checkboxes don't take text: Space should still play/stop from them.
  const type = (el as HTMLInputElement).type;
  return !["range", "checkbox", "radio", "button"].includes(type);
}
