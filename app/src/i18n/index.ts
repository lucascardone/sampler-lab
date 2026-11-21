// i18n setup. To add English: create en.json with the same keys, add it to `resources`,
// and pick the language (e.g. from a setting or navigator.language).
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import es from "./es.json";

i18n.use(initReactI18next).init({
  resources: { es: { translation: es } },
  lng: "es",
  fallbackLng: "es",
  interpolation: { escapeValue: false }, // React already escapes
});

export default i18n;
